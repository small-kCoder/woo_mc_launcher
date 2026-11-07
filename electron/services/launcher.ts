import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import type { InstallProgress, JavaInfo, LaunchState } from '../../src/types/ipc';
import type { StoredAccount } from './accounts';
import { getAccountById, updateMicrosoftAccount } from './accounts';
import { refreshMicrosoftAccount } from './auth/microsoft';
import { getConfig } from './config';
import { AppError, fail } from './errors';
import { logLine } from './logger';
import { optimizeMemory } from './memoryOptimizer';
import { resolveJava } from './java';
import { ensureVersionDependencies } from './installer';
import { buildLaunchPlan, type LaunchAccount, type LaunchPlan } from './launchPlan';
import { emitGameLine, emitLaunchPhase } from './gameEvents';
import { watchGameWindow } from './gameWindow';
import { getLogsDir } from './paths';
import { assertVersionId, getGameDirectory, isVersionInstalled, readVersionJson } from './versions';

/** 进入游戏后常见的启动日志标志 */
const RUNNING_MARKER = /Setting user:|Sound engine started|Started render thread|Backend library/;
/** 窗口迟迟未出现时更新提示文案的阈值（不再据此判定“运行中”） */
const WINDOW_HINT_MS = 30_000;
/** 进程退出后延迟关闭日志句柄，避免尾部输出丢失 */
const LOG_CLOSE_DELAY_MS = 500;
/** 日志行缓存上限，用于失败时展示末 20 行 */
const LOG_RECENT_LIMIT = 200;
/** 失败时返回的日志行数 */
const LOG_TAIL_LINES = 20;
/** 日志事件节流：100ms 一批，约 10 条/秒 */
const LOG_FLUSH_INTERVAL_MS = 100;
/** 正版令牌提前刷新阈值 */
const TOKEN_REFRESH_THRESHOLD_MS = 120_000;
/** 结束进程树的最长等待时间 */
const KILL_TIMEOUT_MS = 3_000;
/** 下载进度在总进度中的区间（5%–95%） */
const PROGRESS_START = 5;
const PROGRESS_RANGE = 90;

const pad = (value: number): string => String(value).padStart(2, '0');

function buildLogFileName(date: Date): string {
  const y = date.getFullYear();
  const md = `${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `launch-${y}${md}-${hms}.log`;
}

/** 打码命令行与输出中的访问令牌 */
function redact(text: string, secrets: string[]): string {
  let result = text.replace(/--accessToken\s+\S+/g, '--accessToken ***');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      result = result.split(secret).join('***');
    }
  }
  return result
    .replace(/(accessToken|access_token)(["'\s:=]+)([^\s"'&,}]+)/gi, '$1$2***')
    .replace(/Authorization["'\s:=]+Bearer\s+\S+/gi, 'Authorization: Bearer ***');
}

/** 生成命令行日志时对 --accessToken 的下一个参数打码 */
function redactArgs(args: string[], secrets: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === '--accessToken') {
      result.push(current, '***');
      index += 1;
      continue;
    }
    result.push(redact(current, secrets));
  }
  return result;
}

function normalizeError(error: unknown, fallbackCode = 'LAUNCH_FAILED', fallbackMessage = '启动失败，请稍后重试'): { code: string; message: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { code: fallbackCode, message: error.message };
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function emitToRenderer(channel: 'launch:state' | 'launch:progress' | 'launch:log', payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/* ------------------------------ 日志写入 ------------------------------ */

/** 单次启动的独立日志文件写入器 */
class LaunchLogWriter {
  readonly file: string;
  private readonly stream: fs.WriteStream;
  private readonly recent: string[] = [];

  constructor() {
    const dir = getLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, buildLogFileName(new Date()));
    this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
    // 写入失败只影响日志，不阻断游戏
    this.stream.on('error', () => undefined);
  }

  writeLine(line: string): void {
    const text = line.replace(/\r?\n/g, ' ');
    this.recent.push(text);
    if (this.recent.length > LOG_RECENT_LIMIT) {
      this.recent.shift();
    }
    if (!this.stream.destroyed) {
      this.stream.write(`${text}\n`);
    }
  }

  tail(count: number): string[] {
    return this.recent.slice(-count);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stream.destroyed) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
    });
  }
}

/* ------------------------------ 日志事件节流 ------------------------------ */

let logQueue: string[] = [];
let logTimer: NodeJS.Timeout | null = null;

function flushLogQueue(): void {
  if (logTimer) {
    clearTimeout(logTimer);
    logTimer = null;
  }
  if (logQueue.length === 0) {
    return;
  }
  const lines = logQueue;
  logQueue = [];
  emitToRenderer('launch:log', { lines, text: lines.join('\n') });
}

function queueLogLine(line: string): void {
  logQueue.push(line);
  if (!logTimer) {
    logTimer = setTimeout(flushLogQueue, LOG_FLUSH_INTERVAL_MS);
  }
}

/* ------------------------------ 状态 ------------------------------ */

interface LaunchSession {
  versionId: string;
  java: JavaInfo;
  log: LaunchLogWriter;
  controller: AbortController;
  child: ChildProcess | null;
  pid: number | null;
  cancelRequested: boolean;
  runningMarked: boolean;
  finished: boolean;
  // [原代码]: runningTimer: NodeJS.Timeout | null;
  /** 等待窗口出现超过阈值时更新提示文案的计时器 */
  hintTimer: NodeJS.Timeout | null;
  /** 轮询游戏窗口的 PowerShell 助手 */
  windowWatch: { cancel: () => void } | null;
  /** 是否已用启动日志标志更新过“窗口已出现”提示 */
  markerHinted: boolean;
}

let activeSession: LaunchSession | null = null;
let currentState: LaunchState = { phase: 'idle', percent: 0, taskText: '空闲' };
/** 是否因游戏窗口无法激活而主动最小化了启动器（退出时自动恢复） */
let launcherMinimizedForGame = false;

function setState(next: LaunchState, session?: LaunchSession): void {
  currentState = next;
  emitToRenderer('launch:state', next);
  emitLaunchPhase(next.phase);
  if (session) {
    const detail = next.detailText ? ` - ${next.detailText}` : '';
    session.log.writeLine(`[状态] ${next.phase} ${next.percent}% ${next.taskText}${detail}`);
  }
}

/** 仅更新快照并通过 launch:progress 推送，避免高频 launch:state */
function updateProgress(session: LaunchSession, percent: number, taskText: string, bytesPerSecond = 0): void {
  // [原代码]: currentState = { ...currentState, percent, taskText };
  currentState = { ...currentState, percent, taskText, bytesPerSecond };
  emitToRenderer('launch:progress', {
    percent,
    taskText,
    phase: currentState.phase,
    versionId: session.versionId,
    bytesPerSecond
  });
}

function completeSession(session: LaunchSession, next: LaunchState): void {
  if (session.finished) {
    return;
  }
  session.finished = true;
  // [原代码]: if (session.runningTimer) { clearTimeout(session.runningTimer); session.runningTimer = null; }
  if (session.hintTimer) {
    clearTimeout(session.hintTimer);
    session.hintTimer = null;
  }
  if (session.windowWatch) {
    session.windowWatch.cancel();
    session.windowWatch = null;
  }
  // 因激活失败而最小化的启动器，在游戏结束后恢复
  if (launcherMinimizedForGame) {
    launcherMinimizedForGame = false;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.show();
    }
  }
  if (activeSession === session) {
    activeSession = null;
  }
  setState(next, session);
  flushLogQueue();
  // 延迟关闭，等待 stdout/stderr 尾部数据落盘
  setTimeout(() => {
    void session.log.close();
  }, LOG_CLOSE_DELAY_MS);
}

function failSession(session: LaunchSession, error: unknown): void {
  const normalized = normalizeError(error);
  const logTail = session.log.tail(LOG_TAIL_LINES);
  const next: LaunchState = {
    phase: 'failed',
    percent: currentState.percent,
    taskText: '启动失败',
    versionId: session.versionId,
    java: session.java,
    error: { code: normalized.code, message: normalized.message, logTail }
  };
  session.log.writeLine(`[错误] ${normalized.message}`);
  completeSession(session, next);
  logLine(`启动失败：${session.versionId}（${normalized.message}）`);
}

/**
 * 启动失败时由 IPC 层调用，保证 UI 收到 failed。
 * 已有启动会话时不覆盖当前状态，避免重复启动的提示覆盖运行中状态。
 */
export function emitLaunchFailureState(code: string, message: string): void {
  if (activeSession) {
    return;
  }
  const next: LaunchState = {
    phase: 'failed',
    percent: 0,
    taskText: '启动失败',
    error: { code, message }
  };
  currentState = next;
  emitToRenderer('launch:state', next);
  logLine(`启动失败：${message}`);
}

/* ------------------------------ 启动流水线 ------------------------------ */

function toLaunchAccount(account: StoredAccount): LaunchAccount {
  if (account.type === 'microsoft') {
    return {
      name: account.name,
      uuid: account.uuid,
      accessToken: account.accessToken,
      userType: 'msa',
      xuid: account.xuid,
      clientId: ''
    };
  }
  return {
    name: account.name,
    uuid: account.uuid,
    // 离线账户无需真实令牌，使用官方启动器的占位值
    accessToken: '0',
    userType: 'legacy'
  };
}

function throwIfCancelled(session: LaunchSession): void {
  if (session.cancelRequested || session.controller.signal.aborted) {
    fail('LAUNCH_CANCELLED', '启动已取消');
  }
}

/** 启动前刷新即将过期的微软令牌，失败提示重新登录 */
async function prepareAccount(session: LaunchSession, account: StoredAccount): Promise<StoredAccount> {
  if (account.type !== 'microsoft') {
    return account;
  }
  if (account.expiresAt - Date.now() >= TOKEN_REFRESH_THRESHOLD_MS) {
    return account;
  }
  session.log.writeLine('[启动器] 登录令牌即将过期，正在自动刷新');
  let refreshed: StoredAccount;
  try {
    refreshed = await refreshMicrosoftAccount(account);
  } catch {
    fail('AUTH_EXPIRED', '登录状态已过期，请重新登录');
  }
  const updated = updateMicrosoftAccount(account.id, {
    name: refreshed.name,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    xuid: refreshed.xuid,
    skinHeadDataUrl: refreshed.skinHeadDataUrl,
    hasProfile: refreshed.hasProfile
  });
  session.log.writeLine('[启动器] 登录令牌刷新完成');
  return updated;
}

/** 结束进程树：taskkill 超时 3 秒，失败时由调用方兜底 */
function killProcessTree(pid: number, session: LaunchSession): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: KILL_TIMEOUT_MS },
      (error) => {
        if (error) {
          session.log.writeLine(`[警告] 结束游戏进程失败：${error.message}`);
        }
        resolve();
      }
    );
  });
}

function markRunning(session: LaunchSession, reason: string): void {
  if (session.finished || session.cancelRequested || session.runningMarked) {
    return;
  }
  session.runningMarked = true;
  // [原代码]: if (session.runningTimer) { clearTimeout(session.runningTimer); session.runningTimer = null; }
  if (session.hintTimer) {
    clearTimeout(session.hintTimer);
    session.hintTimer = null;
  }
  if (session.windowWatch) {
    session.windowWatch.cancel();
    session.windowWatch = null;
  }
  session.log.writeLine(`[启动器] 判定游戏已进入运行状态（${reason}）`);
  setState(
    {
      phase: 'running',
      percent: 100,
      taskText: '游戏运行中',
      versionId: session.versionId,
      java: session.java,
      startedAt: Date.now()
    },
    session
  );
}

function handleOutputLine(session: LaunchSession, line: string, secrets: string[]): void {
  const raw = line.replace(/\r$/, '');
  const safe = redact(raw, secrets);
  session.log.writeLine(safe);
  queueLogLine(safe);
  emitGameLine(raw);
  // [原代码]: if (!session.runningMarked && RUNNING_MARKER.test(raw)) { markRunning(session, '检测到游戏启动标志'); }
  // 日志标志只说明窗口/渲染已开始，不能代表窗口已经可见；
  // 这里仅更新等待提示，真正进入 running 由窗口检测回调触发。
  if (!session.runningMarked && !session.markerHinted && RUNNING_MARKER.test(raw)) {
    session.markerHinted = true;
    session.log.writeLine('[启动器] 已出现游戏启动日志标志，等待窗口显示');
    setState(
      {
        phase: 'launching',
        percent: 96,
        taskText: '正在启动游戏',
        detailText: '游戏窗口已出现，正在加载界面',
        versionId: session.versionId,
        java: session.java
      },
      session
    );
  }
}

/** 按行处理 stdout/stderr，保留半行缓冲直到下一次输出或流结束 */
function attachStream(session: LaunchSession, stream: NodeJS.ReadableStream | null, secrets: string[]): void {
  if (!stream) {
    return;
  }
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) {
        handleOutputLine(session, line, secrets);
      }
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      handleOutputLine(session, buffer, secrets);
      buffer = '';
    }
  });
}

function finishAfterExit(session: LaunchSession, code: number | null, signal: NodeJS.Signals | null): void {
  if (session.finished) {
    return;
  }
  const base = { versionId: session.versionId, java: session.java };
  if (session.cancelRequested) {
    session.log.writeLine('[启动器] 游戏进程已结束（用户取消）');
    completeSession(session, {
      ...base,
      phase: 'exited',
      percent: 100,
      taskText: '游戏已结束',
      detailText: '启动已取消',
      exitCode: null
    });
    return;
  }
  if (code === 0) {
    session.log.writeLine('[启动器] 游戏进程正常退出');
    completeSession(session, {
      ...base,
      phase: 'exited',
      percent: 100,
      taskText: '游戏已退出',
      detailText: '退出码 0',
      exitCode: 0
    });
    return;
  }
  // [原代码]: const reason = code === null ? `游戏进程被终止${signal ? `（${signal}）` : ''}` : `游戏异常退出（退出码 ${code}）`;
  // Windows 返回的 4294967295 是 -1 的无符号表示，先转为有符号整数再展示
  const signedCode = code === null ? null : code > 0x7fffffff ? code - 0x100000000 : code;
  const reason =
    signedCode === null
      ? `游戏进程被终止${signal ? `（${signal}）` : ''}`
      : signedCode === -1
        ? '游戏进程被强制结束（退出码 -1）'
        : `游戏异常退出（退出码 ${signedCode}）`;
  const logTail = session.log.tail(LOG_TAIL_LINES);
  session.log.writeLine(`[错误] ${reason}`);
  completeSession(session, {
    ...base,
    phase: 'failed',
    percent: currentState.percent,
    taskText: '启动失败',
    detailText: reason,
    exitCode: signedCode,
    error: { code: 'LAUNCH_EXIT_ERROR', message: reason, logTail }
  });
  logLine(`启动失败：${session.versionId}（${reason}）`);
}

function spawnGame(session: LaunchSession, plan: LaunchPlan, account: LaunchAccount): void {
  const secrets = [account.accessToken];
  fs.mkdirSync(path.join(plan.cwd, 'versions', session.versionId, 'natives'), { recursive: true });
  session.log.writeLine(`[启动器] 工作目录：${plan.cwd}`);
  session.log.writeLine(`[启动器] 命令行：${redactArgs(plan.args, secrets).join(' ')}`);

  let child: ChildProcess;
  try {
    child = spawn(plan.javaPath, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new AppError('LAUNCH_SPAWN_FAILED', `无法启动游戏进程：${normalizeError(error).message}`);
  }

  session.child = child;
  session.pid = child.pid ?? null;
  session.log.writeLine(`[启动器] 游戏进程已创建，pid=${session.pid ?? '未知'}`);
  attachStream(session, child.stdout, secrets);
  attachStream(session, child.stderr, secrets);

  child.once('error', (error) => {
    if (session.finished) {
      return;
    }
    failSession(session, new AppError('LAUNCH_SPAWN_FAILED', `无法启动游戏进程：${error.message}`));
  });

  child.once('close', (code, signal) => {
    finishAfterExit(session, code, signal);
  });

  // [原代码]: session.runningTimer = setTimeout(() => { markRunning(session, '等待超时兜底'); }, RUNNING_FALLBACK_MS);
  // 窗口尚未出现时只更新提示，不再提前宣称“游戏运行中”
  session.hintTimer = setTimeout(() => {
    if (session.finished || session.cancelRequested || session.runningMarked) {
      return;
    }
    session.log.writeLine('[警告] 游戏窗口尚未出现，仍在等待');
    setState(
      {
        phase: 'launching',
        percent: 96,
        taskText: '正在启动游戏',
        detailText: '游戏窗口尚未出现，首次加载可能较慢',
        versionId: session.versionId,
        java: session.java
      },
      session
    );
  }, WINDOW_HINT_MS);
  session.hintTimer.unref?.();

  // 轮询真实窗口：出现后切到前台，激活失败则最小化启动器
  if (session.pid) {
    session.windowWatch = watchGameWindow({
      pid: session.pid,
      onFound: (activated) => {
        if (session.finished || session.cancelRequested) {
          return;
        }
        session.log.writeLine(`[启动器] 检测到游戏窗口（${activated ? '已切到前台' : '未能切到前台'}）`);
        if (!activated) {
          session.log.writeLine('[启动器] 未能激活游戏窗口，已最小化启动器以便查看游戏');
          launcherMinimizedForGame = true;
          for (const win of BrowserWindow.getAllWindows()) {
            win.minimize();
          }
        }
        markRunning(session, '检测到游戏窗口');
      },
      onError: (message) => {
        session.log.writeLine(`[警告] 游戏窗口检测失败：${message}`);
      }
    });
  }
}

async function runPipeline(session: LaunchSession, initialAccount: StoredAccount, memoryMb: number): Promise<void> {
  try {
    const account = await prepareAccount(session, initialAccount);
    throwIfCancelled(session);

    const versionJson = readVersionJson(session.versionId);
    const requiredMajor = versionJson.javaVersion?.majorVersion;
    if (typeof requiredMajor === 'number' && Number.isInteger(requiredMajor) && session.java.major < requiredMajor) {
      const warning = `Java ${session.java.version} 低于版本建议的 Java ${requiredMajor}，仍将尝试启动`;
      session.log.writeLine(`[警告] ${warning}`);
      logLine(`启动警告：${session.versionId} ${warning}`);
    }

    const launchAccount = toLaunchAccount(account);
    const plan = buildLaunchPlan({
      versionId: session.versionId,
      versionJson,
      gameDir: getGameDirectory(),
      javaPath: session.java.path,
      account: launchAccount,
      memoryMb,
      launcherName: 'WooLauncher',
      launcherVersion: app.getVersion()
    });

    const launchConfig = getConfig();
    if (launchConfig.memoryOptimizeOnLaunch) {
      session.log.writeLine('[启动器] 正在执行启动前内存优化');
      setState(
        {
          phase: 'preparing',
          percent: 5,
          taskText: '正在优化内存',
          detailText: '整理系统工作集，可能延长启动时间',
          versionId: session.versionId,
          java: session.java
        },
        session
      );
      try {
        const result = await optimizeMemory();
        session.log.writeLine(
          `[启动器] 内存优化完成：释放 ${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB` +
            `（${result.elapsedMs}ms，整理 ${result.trimmedProcesses} 个进程）`
        );
      } catch (error) {
        session.log.writeLine(
          `[警告] 内存优化失败：${error instanceof Error ? error.message : '未知错误'}`
        );
      }
    }

    session.log.writeLine('[启动器] 正在检查游戏文件完整性');
    setState(
      {
        phase: 'downloading',
        percent: PROGRESS_START,
        taskText: '正在检查游戏文件',
        versionId: session.versionId,
        java: session.java
      },
      session
    );

    let inDownloading = false;
    await ensureVersionDependencies(
      session.versionId,
      (progress: InstallProgress) => {
        if (session.finished || session.cancelRequested) {
          return;
        }
        const mapped = Math.min(95, Math.max(PROGRESS_START, PROGRESS_START + Math.round(progress.percent * (PROGRESS_RANGE / 100))));
        if (!inDownloading) {
          inDownloading = true;
          currentState = {
            phase: 'downloading',
            percent: mapped,
            taskText: progress.taskText,
            versionId: session.versionId,
            java: session.java,
            bytesPerSecond: progress.bytesPerSecond ?? 0
          };
          emitToRenderer('launch:state', currentState);
        } else {
          updateProgress(session, mapped, progress.taskText, progress.bytesPerSecond ?? 0);
        }
      },
      session.controller.signal
    );
    throwIfCancelled(session);

    setState(
      {
        phase: 'launching',
        percent: 96,
        taskText: '正在启动游戏',
        detailText: '等待游戏窗口出现',
        versionId: session.versionId,
        java: session.java
      },
      session
    );

    throwIfCancelled(session);
    spawnGame(session, plan, launchAccount);
  } catch (error) {
    if (session.finished) {
      return;
    }
    if (session.cancelRequested || session.controller.signal.aborted) {
      session.log.writeLine('[启动器] 启动已取消');
      completeSession(session, {
        phase: 'idle',
        percent: 0,
        taskText: '已取消',
        versionId: session.versionId,
        java: session.java
      });
      return;
    }
    failSession(session, error);
  }
}

/* ------------------------------ 对外接口 ------------------------------ */

/** 是否有启动或运行中的会话 */
export function isLaunching(): boolean {
  return activeSession !== null;
}

/** 最新状态快照 */
export function getLaunchState(): LaunchState {
  return { ...currentState };
}

/**
 * 开始启动：同步完成参数、账户、Java 校验后立即返回，进度与结果通过事件推送。
 * 重复调用抛出“游戏已在启动或运行中”。
 */
export function startLaunch(versionId: string): void {
  try {
    const id = assertVersionId(versionId);
    if (activeSession) {
      fail('LAUNCH_IN_PROGRESS', '游戏已在启动或运行中');
    }
    if (!isVersionInstalled(id)) {
      fail('VERSION_NOT_INSTALLED', '该版本尚未安装完整，请先安装');
    }

    const config = getConfig();
    if (!config.selectedAccountId) {
      fail('ACCOUNT_NOT_SELECTED', '尚未选择账户，请先选择账户');
    }
    const account = getAccountById(config.selectedAccountId);
    if (!account) {
      fail('ACCOUNT_NOT_FOUND', '账户不存在，请重新选择账户');
    }

    const java = resolveJava();
    if (!java) {
      fail('JAVA_NOT_FOUND', '未检测到 Java，请手动选择 Java 路径');
    }

    const session: LaunchSession = {
      versionId: id,
      java,
      log: new LaunchLogWriter(),
      controller: new AbortController(),
      child: null,
      pid: null,
      cancelRequested: false,
      runningMarked: false,
      finished: false,
      // [原代码]: runningTimer: null
      hintTimer: null,
      windowWatch: null,
      markerHinted: false
    };
    activeSession = session;
    logLine(`开始启动：${id}，Java ${java.version}（${java.source}）`);
    session.log.writeLine(`[启动器] 版本 ${id}，Java ${java.version}（${java.source}）：${java.path}`);
    setState(
      {
        phase: 'preparing',
        percent: 5,
        taskText: '正在检查游戏文件',
        versionId: id,
        java
      },
      session
    );

    void runPipeline(session, account, config.memoryMb);
  } catch (error) {
    const normalized = normalizeError(error, 'LAUNCH_FAILED', '启动失败，请稍后重试');
    // 已有会话时只拒绝，不用 failed 覆盖正在运行的状态
    if (!activeSession) {
      emitLaunchFailureState(normalized.code, normalized.message);
    } else {
      logLine(`启动请求被拒绝：${normalized.message}`);
    }
    throw error instanceof AppError ? error : new AppError(normalized.code, normalized.message);
  }
}

/**
 * 取消启动：下载阶段中止并回到 idle；运行阶段先结束进程树再回到 exited。
 * 进程结束后台执行，不阻塞调用方，最长等待 3 秒。
 */
export function cancelLaunch(): void {
  const session = activeSession;
  if (!session || session.finished) {
    return;
  }
  session.cancelRequested = true;

  if (session.child && session.pid !== null) {
    session.log.writeLine(`[启动器] 收到取消请求，正在结束游戏进程树（pid=${session.pid}）`);
    logLine(`请求取消启动：${session.versionId}（pid ${session.pid}）`);
    const exitState: LaunchState = {
      phase: 'exited',
      percent: 100,
      taskText: '游戏已结束',
      detailText: '启动已取消',
      versionId: session.versionId,
      java: session.java,
      startedAt: currentState.startedAt,
      exitCode: null
    };
    void killProcessTree(session.pid, session).then(() => {
      completeSession(session, exitState);
    });
    // taskkill 异常或 limbo 时兜底，保证 3 秒内回到 exited
    setTimeout(() => {
      completeSession(session, exitState);
    }, KILL_TIMEOUT_MS);
    return;
  }

  session.log.writeLine('[启动器] 收到取消请求，正在中止启动流程');
  logLine(`请求取消启动：${session.versionId}`);
  completeSession(session, {
    phase: 'idle',
    percent: 0,
    taskText: '已取消',
    versionId: session.versionId,
    java: session.java
  });
  session.controller.abort();
}

import crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, net as electronNet } from 'electron';
import type { MultiplayerState } from '../../src/types/ipc';
import { getConfig } from './config';
import { AppError, fail } from './errors';
import { onLaunchPhase } from './gameEvents';
import { getLaunchState, startLaunch } from './launcher';
import { logLine } from './logger';
import { getRoot } from './paths';
import { upsertRoomServer } from './serverList';

/** EasyTier 内核与 CLI 路径 */
const EASYTIER_DIR = path.join(getRoot(), 'easytier-windows-x86_64');
const EASYTIER_CORE = path.join(EASYTIER_DIR, 'easytier-core.exe');
const EASYTIER_CLI = path.join(EASYTIER_DIR, 'easytier-cli.exe');
/** 固定虚拟 IP 与 RPC/监听端口 */
const HOST_VIRTUAL_IP = '10.144.144.1';
const HOST_RPC = '127.0.0.1:15888';
const GUEST_RPC = '127.0.0.1:15889';
const GUEST_LISTEN = '21010';
const HEARTBEAT_MS = 30_000;
const PEER_TIMEOUT_MS = 30_000;
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const SERVER_ENTRY_PREFIX = 'WOO 联机';
const PORT_MONITOR_MS = 1_000;

const DEFAULT_PEERS = ['tcp://et1.fuis.top:11010', 'tcp://225284.xyz:11010'];

interface RoomInfo {
  code: string;
  versionId: string;
  networkName: string;
  networkSecret: string;
  hostVirtualIp: string;
  hostLanIp: string;
  gamePort: number;
  hostName: string;
}

interface HostSession {
  sessionId: string;
  versionId: string;
  hostName: string;
  networkName: string;
  networkSecret: string;
  hostLanIp: string;
  /** 当前用于登记/心跳/注销的房间服务基础地址 */
  roomBase: string;
  /** 用户填写并需要监测的局域网端口 */
  targetPort: number;
  child: ChildProcess | null;
  code: string | null;
  lanPort: number | null;
  monitor: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  unsubPhase: () => void;
  stopping: boolean;
}

interface GuestSession {
  code: string;
  versionId: string;
  localPort: number;
  child: ChildProcess | null;
  unsubPhase: () => void;
  stopping: boolean;
}

let state: MultiplayerState = { phase: 'idle' };
let host: HostSession | null = null;
let guest: GuestSession | null = null;

function emitState(next: MultiplayerState): void {
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('multiplayer:state', state);
    }
  }
}

export function getMultiplayerState(): MultiplayerState {
  return { ...state };
}

function getPeers(): string[] {
  const raw = process.env.EASETIER_PEERS;
  if (raw && raw.trim().length > 0) {
    return raw.trim().split(/\s+/);
  }
  return DEFAULT_PEERS;
}

function ensureEasyTier(): void {
  if (!fs.existsSync(EASYTIER_CORE)) {
    fail('MULTIPLAYER_NO_EASYTIER', `未找到 EasyTier 内核：${EASYTIER_CORE}`);
  }
}

function isGameStopped(phase: string): boolean {
  return phase === 'idle' || phase === 'exited' || phase === 'failed';
}

function getHostLan(): { ip: string; cidr: string } {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (item): item is os.NetworkInterfaceInfo =>
        item !== undefined && item.family === 'IPv4' && !item.internal
    )
    .map((item) => item.address);
  const preferred =
    addresses.find((address) => address.startsWith('192.168.')) ??
    addresses.find((address) => address.startsWith('10.')) ??
    addresses.find((address) => /^172\.(1[6-9]|2\d|3[01])\./.test(address)) ??
    addresses[0];
  if (!preferred) {
    fail('MULTIPLAYER_NO_LAN', '未找到可用的局域网 IP，无法开放联机');
  }
  return { ip: preferred, cidr: `${preferred}/32` };
}

/** 当前配置下的房间服务地址：优先当前通道，再尝试另一通道 */
function roomServiceBases(): string[] {
  const config = getConfig();
  const order: string[] = [];
  const current = config.serverChannel === 'channel2' ? config.channel2Url : config.channel1Url;
  const other = config.serverChannel === 'channel2' ? config.channel1Url : config.channel2Url;
  if (current) {
    order.push(current.replace(/\/+$/, ''));
  }
  if (other && other !== current) {
    order.push(other.replace(/\/+$/, ''));
  }
  return order;
}

/** 探测可用的房间服务，返回首个健康检查通过的基础地址 */
async function resolveRoomServiceBase(): Promise<string | null> {
  for (const base of roomServiceBases()) {
    try {
      const response = await netFetchRetry(`${base}/health`, { method: 'GET' }, 3_000);
      if (response.ok) {
        return base;
      }
    } catch {
      // 尝试下一个通道
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 房间服务请求：部分网络首次 TLS 会被重置，失败后重试一次 */
async function netFetchRetry(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await electronNet.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await sleep(350);
      }
    }
  }
  throw lastError;
}

function spawnCore(args: string[], secretEnv: Record<string, string>): ChildProcess {
  const child = spawn(EASYTIER_CORE, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...secretEnv }
  });
  const logChunk = (prefix: string) => (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim().length > 0) {
        logLine(`[EasyTier] ${prefix}${line.trim()}`);
      }
    }
  };
  child.stdout?.on('data', logChunk(''));
  child.stderr?.on('data', logChunk('[err] '));
  child.on('error', (error) => logLine(`[EasyTier] 启动失败：${error.message}`));
  return child;
}

function killChild(child: ChildProcess | null): void {
  if (!child || child.killed) {
    return;
  }
  try {
    child.kill();
  } catch {
    // 进程可能已退出
  }
}

function probePort(port: number, hostName = '127.0.0.1', timeout = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostName, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function waitForPort(port: number, attempts = 8): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    if (await probePort(port)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function findFreePort(preferred: number): Promise<number> {
  const tryListen = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(null));
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const actual = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(actual));
      });
    });
  const preferredPort = await tryListen(preferred);
  if (preferredPort) {
    return preferredPort;
  }
  const randomPort = await tryListen(0);
  if (randomPort) {
    return randomPort;
  }
  throw new AppError('MULTIPLAYER_NO_PORT', '无法分配本地端口');
}

/** 通过 easytier-cli 确认房主虚拟 IP 已出现在 peer 列表 */
async function waitForHostPeer(hostVirtualIp: string): Promise<void> {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!guest) {
      fail('MULTIPLAYER_PROCESS_EXITED', 'P2P 进程已退出，请检查权限或防火墙设置');
    }
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          EASYTIER_CLI,
          ['-p', GUEST_RPC, '-o', 'json', 'peer'],
          { windowsHide: true, timeout: 5_000 },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout);
          }
        );
      });
      if (output.includes(hostVirtualIp)) {
        return;
      }
    } catch {
      // EasyTier 尚未就绪，继续等待
    }
    await sleep(1_000);
  }
  fail('MULTIPLAYER_PEER_TIMEOUT', 'P2P 连接超时，请检查双方网络、防火墙或稍后重试');
}

async function fetchRoomFrom(base: string, code: string): Promise<RoomInfo> {
  const response = await netFetchRetry(
    `${base.replace(/\/+$/, '')}/rooms/${code}`,
    { method: 'GET' },
    5_000
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (
    typeof data.versionId !== 'string' ||
    typeof data.networkName !== 'string' ||
    typeof data.networkSecret !== 'string' ||
    typeof data.hostVirtualIp !== 'string' ||
    typeof data.hostLanIp !== 'string' ||
    typeof data.gamePort !== 'number'
  ) {
    throw new Error('房间数据不完整');
  }
  return {
    code,
    versionId: data.versionId,
    networkName: data.networkName,
    networkSecret: data.networkSecret,
    hostVirtualIp: data.hostVirtualIp,
    hostLanIp: data.hostLanIp,
    gamePort: data.gamePort,
    hostName: typeof data.hostName === 'string' ? data.hostName : '房主'
  };
}

/** 依次尝试当前通道与另一通道解析房间 */
async function resolveRoom(code: string): Promise<RoomInfo> {
  const order = roomServiceBases();
  let lastError = '';
  for (const base of order) {
    try {
      return await fetchRoomFrom(base, code);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logLine(`房间 ${code} 解析失败（${base}）：${lastError}`);
    }
  }
  fail('MULTIPLAYER_ROOM_NOT_FOUND', `无法解析房间号 ${code}，请确认房主已开局域网且房间仍有效`);
}

/** 登记/更新房间：依次尝试通道，成功后记录使用的服务地址 */
async function registerRoom(session: HostSession, port: number): Promise<string> {
  const bases = roomServiceBases();
  let lastError = '';
  for (const base of bases) {
    try {
      const response = await netFetchRetry(
        `${base}/rooms`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            versionId: session.versionId,
            networkName: session.networkName,
            networkSecret: session.networkSecret,
            hostVirtualIp: HOST_VIRTUAL_IP,
            hostLanIp: session.hostLanIp,
            gamePort: port,
            hostName: session.hostName
          })
        },
        8_000
      );
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof data.code !== 'string') {
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
      }
      session.roomBase = base;
      session.code = data.code;
      return data.code;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logLine(`登记房间失败（${base}）：${lastError}`);
    }
  }
  throw new Error(lastError || '联机服务不可用');
}

function startHeartbeat(session: HostSession): void {
  if (session.heartbeat) {
    clearInterval(session.heartbeat);
  }
  session.heartbeat = setInterval(() => {
    if (session.stopping || !session.code) {
      return;
    }
    void (async () => {
      try {
        const response = await electronNet.fetch(
          `${session.roomBase}/rooms/${session.code}/heartbeat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: session.sessionId }),
            signal: AbortSignal.timeout(5_000)
          }
        );
        if (response.ok) {
          return;
        }
        logLine(`房间心跳失败：HTTP ${response.status}`);
        if (response.status === 404 && session.lanPort) {
          const code = await registerRoom(session, session.lanPort);
          emitState({
            phase: 'ready',
            roomCode: code,
            versionId: session.versionId,
            lanPort: session.lanPort,
            message: '房间已重新登记，等待好友加入'
          });
        }
      } catch (error) {
        logLine(`房间心跳失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, HEARTBEAT_MS);
  session.heartbeat.unref?.();
}

async function closeRoom(session: HostSession): Promise<void> {
  if (!session.code) {
    return;
  }
  try {
    await electronNet.fetch(`${session.roomBase}/rooms/${session.code}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
      signal: AbortSignal.timeout(5_000)
    });
  } catch (error) {
    logLine(`注销房间失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function stopHost(message?: string): Promise<void> {
  const session = host;
  if (!session) {
    return;
  }
  session.stopping = true;
  host = null;
  session.unsubPhase();
  if (session.monitor) {
    clearInterval(session.monitor);
    session.monitor = null;
  }
  if (session.heartbeat) {
    clearInterval(session.heartbeat);
    session.heartbeat = null;
  }
  await closeRoom(session);
  killChild(session.child);
  emitState({ phase: 'idle', message });
}

/** 每秒探测用户填写的局域网端口，开放后登记房间 */
function startPortMonitor(session: HostSession): void {
  if (session.monitor) {
    clearInterval(session.monitor);
  }
  let checking = false;
  session.monitor = setInterval(() => {
    if (session.stopping || session.lanPort || session.code || checking) {
      return;
    }
    checking = true;
    void (async () => {
      try {
        if (await probePort(session.targetPort)) {
          if (!session.stopping && !session.lanPort) {
            void handleLanPort(session, session.targetPort);
          }
        }
      } finally {
        checking = false;
      }
    })();
  }, PORT_MONITOR_MS);
  session.monitor.unref?.();
}

async function handleLanPort(session: HostSession, port: number): Promise<void> {
  if (session.stopping || session.lanPort) {
    return;
  }
  if (!(await waitForPort(port))) {
    logLine(`局域网端口 ${port} 探测失败，忽略`);
    return;
  }
  session.lanPort = port;
  emitState({
    phase: 'waiting-lan',
    versionId: session.versionId,
    targetPort: session.targetPort,
    lanPort: port,
    message: '正在登记联机房间…'
  });
  try {
    const code = await registerRoom(session, port);
    emitState({
      phase: 'ready',
      roomCode: code,
      versionId: session.versionId,
      targetPort: session.targetPort,
      lanPort: port,
      message: '房间已就绪，等待好友加入'
    });
    startHeartbeat(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`登记联机房间失败：${message}`);
    await stopHost();
    emitState({ phase: 'error', message: '联机服务暂不可用，请检查网络后重试' });
  }
}

export async function startHost(port: number): Promise<MultiplayerState> {
  if (host || guest) {
    fail('MULTIPLAYER_BUSY', '已有联机会话，请先关闭');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('MULTIPLAYER_INVALID_PORT', '端口号需为 1-65535 的整数');
  }
  ensureEasyTier();
  const config = getConfig();
  if (!config.selectedVersionId) {
    fail('MULTIPLAYER_NO_VERSION', '请先选择游戏版本');
  }
  const roomBase = await resolveRoomServiceBase();
  if (!roomBase) {
    fail('MULTIPLAYER_SERVICE_UNAVAILABLE', '联机服务暂不可用，请检查网络后重试');
  }

  const versionId = config.selectedVersionId;
  const lan = getHostLan();
  const sessionId = crypto.randomUUID();
  const networkName = `woo-${sessionId.replace(/-/g, '').slice(0, 10)}`;
  const networkSecret = crypto.randomBytes(24).toString('hex');
  const peers = getPeers();
  const args = [
    '--no-tun',
    'true',
    '-i',
    HOST_VIRTUAL_IP,
    '-n',
    lan.cidr,
    ...peers.flatMap((peer) => ['-p', peer]),
    '-r',
    HOST_RPC,
    '--hostname',
    'woo-host'
  ];
  const child = spawnCore(args, {
    ET_NETWORK_NAME: networkName,
    ET_NETWORK_SECRET: networkSecret
  });

  const session: HostSession = {
    sessionId,
    versionId,
    hostName: os.hostname().slice(0, 64) || '房主',
    networkName,
    networkSecret,
    hostLanIp: lan.ip,
    roomBase,
    targetPort: port,
    child,
    code: null,
    lanPort: null,
    monitor: null,
    heartbeat: null,
    unsubPhase: () => undefined,
    stopping: false
  };
  host = session;

  const launchPhase = getLaunchState().phase;
  const waitingLan = launchPhase === 'running';
  emitState({
    phase: waitingLan ? 'waiting-lan' : 'waiting-game',
    versionId,
    targetPort: port,
    message: waitingLan
      ? `正在监测端口 ${port}，请在游戏内按 Esc → 对局域网开放（端口填 ${port}）`
      : `等待启动游戏，请点击主界面“启动游戏”；开局域网时端口填 ${port}`,
    startedAt: Date.now()
  });

  startPortMonitor(session);
  session.unsubPhase = onLaunchPhase((phase) => {
    if (phase === 'running' && state.phase === 'waiting-game') {
      emitState({
        phase: 'waiting-lan',
        versionId: session.versionId,
        targetPort: session.targetPort,
        message: `正在监测端口 ${session.targetPort}，请在游戏内按 Esc → 对局域网开放（端口填 ${session.targetPort}）`
      });
    }
    if (isGameStopped(phase) && !session.stopping) {
      void stopHost('游戏已结束，联机房间已关闭');
    }
  });
  child.on('exit', (code) => {
    logLine(`[EasyTier] 房主进程退出 code=${code}`);
    if (!session.stopping) {
      void (async () => {
        await stopHost();
        emitState({
          phase: 'error',
          versionId: session.versionId,
          message: 'P2P 进程已退出，请检查权限或防火墙设置'
        });
      })();
    }
  });

  return getMultiplayerState();
}

async function stopGuest(message?: string): Promise<void> {
  const session = guest;
  if (!session) {
    return;
  }
  session.stopping = true;
  guest = null;
  session.unsubPhase();
  killChild(session.child);
  emitState({ phase: 'idle', message });
}

export async function joinRoom(rawCode: string): Promise<MultiplayerState> {
  const code = rawCode.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) {
    fail('MULTIPLAYER_INVALID_CODE', '房间号需为 6 位字母或数字');
  }
  if (host || guest) {
    fail('MULTIPLAYER_BUSY', '已有联机会话，请先关闭');
  }
  ensureEasyTier();
  if (!isGameStopped(getLaunchState().phase)) {
    fail('MULTIPLAYER_GAME_RUNNING', '请先退出游戏再加入房间');
  }

  const room = await resolveRoom(code);
  const config = getConfig();
  if (config.selectedVersionId !== room.versionId) {
    fail(
      'MULTIPLAYER_VERSION_MISMATCH',
      `房主使用 ${room.versionId}，请先切换为相同版本再加入`
    );
  }

  const localPort = await findFreePort(25565);
  emitState({
    phase: 'joining',
    roomCode: code,
    versionId: room.versionId,
    message: '正在建立 P2P 连接…',
    startedAt: Date.now()
  });

  const peers = getPeers();
  const args = [
    '--no-tun',
    'true',
    '-d',
    '10.144.144.0/24',
    ...peers.flatMap((peer) => ['-p', peer]),
    '--port-forward',
    `tcp://127.0.0.1:${localPort}/${room.hostLanIp}:${room.gamePort}`,
    '-l',
    GUEST_LISTEN,
    '-r',
    GUEST_RPC,
    '--hostname',
    'woo-guest'
  ];
  const child = spawnCore(args, {
    ET_NETWORK_NAME: room.networkName,
    ET_NETWORK_SECRET: room.networkSecret
  });

  const session: GuestSession = {
    code,
    versionId: room.versionId,
    localPort,
    child,
    unsubPhase: () => undefined,
    stopping: false
  };
  guest = session;
  session.unsubPhase = onLaunchPhase((phase) => {
    if (isGameStopped(phase) && !session.stopping && state.phase === 'ready') {
      void stopGuest('游戏已结束，联机已关闭');
    }
  });
  child.on('exit', (exitCode) => {
    logLine(`[EasyTier] 访客进程退出 code=${exitCode}`);
    if (!session.stopping) {
      void (async () => {
        await stopGuest();
        emitState({
          phase: 'error',
          roomCode: code,
          message: 'P2P 进程已退出，请检查权限或防火墙设置'
        });
      })();
    }
  });

  try {
    await waitForHostPeer(room.hostVirtualIp);
    emitState({
      phase: 'connecting',
      roomCode: code,
      versionId: room.versionId,
      message: '正在写入服务器列表…'
    });
    await upsertRoomServer(`${SERVER_ENTRY_PREFIX} ${code}`, `127.0.0.1:${localPort}`);
    emitState({
      phase: 'connecting',
      roomCode: code,
      versionId: room.versionId,
      message: '正在启动游戏…'
    });
    startLaunch(room.versionId);
    emitState({
      phase: 'ready',
      roomCode: code,
      versionId: room.versionId,
      message: '已加入房间，多人游戏中可见'
    });
    return getMultiplayerState();
  } catch (error) {
    await stopGuest();
    const message = error instanceof Error ? error.message : String(error);
    emitState({ phase: 'error', roomCode: code, message });
    throw error;
  }
}

/** 关闭当前联机会话（房主与访客互斥，清理两边） */
export async function leaveMultiplayer(): Promise<void> {
  await stopHost();
  await stopGuest();
  if (state.phase !== 'idle') {
    emitState({ phase: 'idle' });
  }
}

/** 应用退出时同步清理 EasyTier 进程 */
export function stopMultiplayerOnExit(): void {
  if (host) {
    host.stopping = true;
    if (host.heartbeat) {
      clearInterval(host.heartbeat);
    }
    killChild(host.child);
    host = null;
  }
  if (guest) {
    guest.stopping = true;
    killChild(guest.child);
    guest = null;
  }
}

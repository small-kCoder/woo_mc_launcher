import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import type { DownloadSource, InitialState } from '../../src/types/ipc';
import {
  listAccountSummaries,
  logoutMicrosoft,
  removeAccount,
  saveOfflineAccount,
  setActiveAccount,
  startMicrosoftLogin
} from '../services/accounts';
import { cancelMicrosoftLogin } from '../services/auth/microsoft';
import { getConfig, updateConfig } from '../services/config';
import { fail } from '../services/errors';
import {
  cancelInstall,
  fetchManifest,
  startFabricInstall,
  startInstall,
  type ManifestKind
} from '../services/installer';
import { fetchFabricLoaders } from '../services/fabric';
import { listDetectedJavas, resetJavaResolution, resolveJava, setJavaPath } from '../services/java';
import { cancelLaunch, emitLaunchFailureState, startLaunch } from '../services/launcher';
import { getRecentLines, logLine } from '../services/logger';
import { optimizeMemory } from '../services/memoryOptimizer';
import {
  deleteMod,
  getModsSnapshot,
  importMods,
  openModsDirectory,
  setModEnabled
} from '../services/mods';
import {
  checkModUpdates,
  installMissingModDependencies,
  installOnlineMod,
  searchOnlineMods,
  updateOnlineMod
} from '../services/modrinth';
import { getLogsDir } from '../services/paths';
import { checkServer } from '../services/serverCheck';
import { getMultiplayerState, joinRoom, leaveMultiplayer, startHost } from '../services/multiplayer';
import { getSystemStats } from '../services/systemStats';
import { assertVersionId } from '../services/versions';
import { isVersionInstalled, listVersions } from '../services/versionChain';

/** 日志尾部读取的行数范围 */
const LOG_TAIL_MIN = 1;
const LOG_TAIL_MAX = 200;
const LOG_TAIL_DEFAULT = 50;
/** 账户标识长度上限 */
const ACCOUNT_ID_MAX_LENGTH = 128;
/** 离线用户名最小长度 */
const OFFLINE_NAME_MIN_LENGTH = 3;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return '操作失败';
}

/** 统一包装 ipcMain.handle：记录日志并把异常转为渲染进程可见的错误消息 */
function safeHandle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      logLine(`IPC ${channel} 失败：${errorMessage(error)}`);
      throw new Error(errorMessage(error));
    }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 行数参数 clamp 到 1-200，非法输入使用默认值 */
function clampLogLines(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : LOG_TAIL_DEFAULT;
  return Math.min(LOG_TAIL_MAX, Math.max(LOG_TAIL_MIN, parsed));
}

/** 账户标识参数校验 */
function requireAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('ACCOUNT_INVALID_ID', '账户标识不能为空');
  }
  if (value.length > ACCOUNT_ID_MAX_LENGTH) {
    fail('ACCOUNT_INVALID_ID', `账户标识长度不能超过 ${ACCOUNT_ID_MAX_LENGTH} 个字符`);
  }
  return value;
}

/** 离线用户名参数校验（正则细节由账户服务再次校验） */
function requireOfflineName(value: unknown): string {
  if (typeof value !== 'string' || value.length < OFFLINE_NAME_MIN_LENGTH) {
    fail('AUTH_INVALID_OFFLINE_NAME', `用户名至少需要 ${OFFLINE_NAME_MIN_LENGTH} 个字符`);
  }
  return value;
}

/** 窗口控制与外链打开（Task 1 已有能力的收拢） */
function registerWindowIpc(): void {
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return false;
    }
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });

  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // 外链仅允许 https，其余协议一律拒绝
  ipcMain.handle('shell:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') {
      return false;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:') {
      return false;
    }
    await shell.openExternal(parsed.toString());
    return true;
  });
}

/** 版本清单类型白名单 */
const MANIFEST_KINDS: readonly ManifestKind[] = ['release', 'snapshot', 'all'];
const DOWNLOAD_SOURCES: readonly DownloadSource[] = ['official', 'channel1', 'channel2'];

/** 校验下载源参数：缺省为官方，非法值直接报错 */
function parseDownloadSource(raw: unknown): DownloadSource {
  if (raw === undefined || raw === null) {
    return 'official';
  }
  if (typeof raw !== 'string' || !DOWNLOAD_SOURCES.includes(raw as DownloadSource)) {
    fail('DOWNLOAD_SOURCE_INVALID', '下载源参数不正确');
  }
  return raw as DownloadSource;
}

/** 本任务实现的基础 IPC：初始化、配置、Java、日志 */
function registerCoreIpc(): void {
  safeHandle('app:init', () => {
    const config = getConfig();
    const accounts = listAccountSummaries();
    // [原代码]: accounts: [], activeAccount: null,
    const activeAccount = config.selectedAccountId
      ? accounts.find((account) => account.id === config.selectedAccountId) ?? null
      : null;
    const state: InitialState = {
      config,
      accounts,
      activeAccount,
      // [原代码]: versions: [],
      versions: listVersions(),
      java: resolveJava(),
      appVersion: app.getVersion(),
      paths: { gameDir: config.gameDir, logsDir: getLogsDir() }
    };
    return state;
  });

  safeHandle('config:get', () => getConfig());

  safeHandle('config:update', (_event, patch) => {
    if (!isPlainObject(patch)) {
      fail('CONFIG_INVALID_PATCH', '配置参数格式不正确');
    }
    // Java 路径变化时让下一次解析重新执行
    if ('javaPath' in patch) {
      resetJavaResolution();
    }
    return updateConfig(patch);
  });

  safeHandle('java:resolve', () => resolveJava());
  safeHandle('java:list', () => listDetectedJavas());

  safeHandle('java:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: '选择 Java 可执行文件',
      properties: ['openFile'],
      filters: [{ name: 'Java 可执行文件', extensions: ['exe'] }]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return setJavaPath(result.filePaths[0]);
  });

  safeHandle('java:set', (_event, javaPath) => {
    if (typeof javaPath !== 'string') {
      fail('JAVA_PATH_INVALID', 'Java 路径必须为字符串');
    }
    return setJavaPath(javaPath);
  });

  safeHandle('logs:open-folder', async () => {
    const result = await shell.openPath(getLogsDir());
    if (result) {
      throw new Error(`无法打开日志目录：${result}`);
    }
  });

  safeHandle('logs:read-tail', (_event, lines) => getRecentLines(clampLogLines(lines)));
}

/** 系统资源监视与内存优化 */
function registerSystemIpc(): void {
  safeHandle('system:stats', () => getSystemStats());
  safeHandle('system:optimize', () => optimizeMemory());
}

/** 服务端连接检查（启动时由渲染进程调用） */
function registerServerIpc(): void {
  safeHandle('server:check', (_event, url) => {
    if (typeof url !== 'string') {
      return { ok: false, url: '', latencyMs: 0, message: '服务端地址参数不正确' };
    }
    return checkServer(url);
  });
}

/** 模组：列表、启用/禁用、删除、打开目录与导入 */
function registerModsIpc(): void {
  safeHandle('mods:list', () => getModsSnapshot());

  safeHandle('mods:set-enabled', (_event, fileName, enabled) => {
    if (typeof fileName !== 'string' || fileName.length === 0 || typeof enabled !== 'boolean') {
      fail('MOD_INVALID_NAME', '模组参数不正确');
    }
    return setModEnabled(fileName, enabled);
  });

  safeHandle('mods:remove', (_event, fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      fail('MOD_INVALID_NAME', '模组参数不正确');
    }
    return deleteMod(fileName);
  });

  safeHandle('mods:install-dependencies', (_event, modIds) => {
    if (!Array.isArray(modIds) || modIds.some((item) => typeof item !== 'string')) {
      fail('MOD_DEP_EMPTY', '依赖参数不正确');
    }
    return installMissingModDependencies(modIds as string[]);
  });

  safeHandle('mods:search-online', (_event, query, offset) => {
    const keyword = typeof query === 'string' ? query : '';
    const pageOffset = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
    return searchOnlineMods(keyword, pageOffset);
  });

  safeHandle('mods:install-online', (_event, projectId) => {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      fail('MOD_DEP_EMPTY', '模组标识不正确');
    }
    return installOnlineMod(projectId);
  });

  safeHandle('mods:check-updates', () => checkModUpdates());

  safeHandle('mods:update', (_event, fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      fail('MOD_INVALID_NAME', '模组文件名不合法');
    }
    return updateOnlineMod(fileName);
  });

  safeHandle('mods:open-folder', () => openModsDirectory());

  safeHandle('mods:import', async (event, paths) => {
    // 传入路径时直接导入（拖拽/联调复用）；否则打开系统文件选择框
    if (Array.isArray(paths)) {
      if (paths.some((item) => typeof item !== 'string')) {
        fail('MODS_IMPORT_INVALID', '模组路径参数不正确');
      }
      return importMods(paths as string[]);
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: '导入模组',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '模组文件', extensions: ['jar'] }]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { imported: [], skipped: [], canceled: true };
    }
    return importMods(result.filePaths);
  });
}

/** 账户相关 IPC：离线保存、切换、删除、微软登录与退出 */
function registerAccountIpc(): void {
  safeHandle('accounts:save-offline', (_event, name) => saveOfflineAccount(requireOfflineName(name)));

  safeHandle('accounts:set-active', (_event, id) => {
    setActiveAccount(requireAccountId(id));
  });

  safeHandle('accounts:remove', (_event, id) => {
    removeAccount(requireAccountId(id));
  });

  // 登录在后台进行，状态通过 auth:event 推送，立即返回
  safeHandle('accounts:login-microsoft', () => {
    startMicrosoftLogin();
  });

  safeHandle('accounts:cancel-login', () => {
    cancelMicrosoftLogin();
  });

  safeHandle('accounts:logout-microsoft', () => {
    logoutMicrosoft();
  });
}

/** 版本扫描与安装 IPC：安装进度与结果通过 install:progress / versions:changed 推送 */
function registerVersionIpc(): void {
  safeHandle('versions:list', () => listVersions());

  safeHandle('versions:manifest', (_event, kind, source) => {
    if (typeof kind !== 'string' || !MANIFEST_KINDS.includes(kind as ManifestKind)) {
      fail('MANIFEST_INVALID_KIND', '版本类型参数不正确');
    }
    return fetchManifest(kind as ManifestKind, parseDownloadSource(source));
  });

  // 安装后台执行，立即返回；重复调用由 installer 抛“正在安装中”
  safeHandle('versions:install', (_event, versionId, source) => {
    if (typeof versionId !== 'string') {
      fail('VERSION_INVALID_ID', '版本号格式不正确');
    }
    startInstall(versionId, parseDownloadSource(source));
  });

  safeHandle('versions:cancel-install', () => cancelInstall());

  safeHandle('fabric:loaders', (_event, gameVersion) => {
    if (typeof gameVersion !== 'string' || gameVersion.length === 0 || gameVersion.length > 64) {
      fail('FABRIC_INVALID_VERSION', 'Minecraft 版本不合法');
    }
    return fetchFabricLoaders(gameVersion);
  });

  safeHandle('fabric:install', (_event, gameVersion, loaderVersion, source) => {
    if (
      typeof gameVersion !== 'string' ||
      typeof loaderVersion !== 'string' ||
      gameVersion.length === 0 ||
      loaderVersion.length === 0
    ) {
      fail('FABRIC_INVALID_VERSION', 'Fabric 安装参数不合法');
    }
    startFabricInstall(gameVersion, loaderVersion, parseDownloadSource(source));
  });
}

/** 启动流水线 IPC：参数校验后立即返回，状态与日志通过事件推送 */
function registerLaunchIpc(): void {
  safeHandle('launch:start', (_event, versionId) => {
    if (typeof versionId !== 'string') {
      const code = 'VERSION_INVALID_ID';
      const message = '版本号格式不正确';
      emitLaunchFailureState(code, message);
      fail(code, message);
    }
    const id = assertVersionId(versionId);
    if (!isVersionInstalled(id)) {
      const code = 'VERSION_NOT_INSTALLED';
      const message = '该版本尚未安装完整，请先安装';
      emitLaunchFailureState(code, message);
      fail(code, message);
    }
    startLaunch(id);
  });

  safeHandle('launch:cancel', () => cancelLaunch());
}

/** P2P 联机 IPC：房间状态通过 multiplayer:state 事件推送 */
function registerMultiplayerIpc(): void {
  safeHandle('multiplayer:start-host', (_event, port) => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail('MULTIPLAYER_INVALID_PORT', '端口号需为 1-65535 的整数');
    }
    return startHost(port);
  });
  safeHandle('multiplayer:join', (_event, code) => {
    if (typeof code !== 'string' || !/^[A-Z0-9]{6}$/.test(code.trim().toUpperCase())) {
      fail('MULTIPLAYER_INVALID_CODE', '房间号需为 6 位字母或数字');
    }
    return joinRoom(code);
  });
  safeHandle('multiplayer:leave', () => leaveMultiplayer());
  safeHandle('multiplayer:get-state', () => getMultiplayerState());
}

/** 注册全部 IPC：本任务为基础能力，后续任务在此追加模块 */
export function registerAllIpc(): void {
  registerWindowIpc();
  registerCoreIpc();
  registerAccountIpc();
  // [原代码]: // Task 7：版本与安装（versions:list / versions:manifest / versions:install / versions:cancel-install，事件 install:progress、versions:changed）
  registerVersionIpc();
  // [原代码]: // Task 8：启动流水线（launch:start / launch:cancel，事件 launch:state、launch:log、launch:progress）
  registerLaunchIpc();
  registerModsIpc();
  registerSystemIpc();
  registerServerIpc();
  registerMultiplayerIpc();
}

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  AppConfig,
  FabricLoaderInfo,
  JavaInfo,
  LauncherApi,
  LauncherEventChannel,
  ModDependencyInstallResult,
  ModImportResult,
  ModsSnapshot
} from '../src/types/ipc';

/** 允许渲染进程订阅的事件通道白名单 */
const ALLOWED_EVENT_CHANNELS: readonly LauncherEventChannel[] = [
  'launch:progress',
  'launch:state',
  'launch:log',
  'install:progress',
  'auth:event',
  'versions:changed',
  'system:stats',
  'multiplayer:state'
];

function isAllowedChannel(channel: string): channel is LauncherEventChannel {
  return (ALLOWED_EVENT_CHANNELS as readonly string[]).includes(channel);
}

/** 从附加参数读取应用版本（sandbox 下无法直接访问 app 模块） */
function readAppVersion(): string {
  const prefix = '--launcher-app-version=';
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const launcher: LauncherApi = {
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close')
  },
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
  platform: process.platform,
  appVersion: readAppVersion(),
  /** 订阅白名单内的事件，返回取消订阅函数 */
  on: (channel: LauncherEventChannel, callback: (payload: unknown) => void): (() => void) => {
    if (!isAllowedChannel(channel)) {
      throw new Error(`不允许订阅通道: ${channel}`);
    }
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },

  init: () => ipcRenderer.invoke('app:init'),

  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    update: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('config:update', patch)
  },

  accounts: {
    saveOffline: (name: string) => ipcRenderer.invoke('accounts:save-offline', name),
    setActive: (id: string): Promise<void> => ipcRenderer.invoke('accounts:set-active', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    loginMicrosoft: (): Promise<void> => ipcRenderer.invoke('accounts:login-microsoft'),
    cancelMicrosoftLogin: (): Promise<void> => ipcRenderer.invoke('accounts:cancel-login'),
    logoutMicrosoft: (): Promise<void> => ipcRenderer.invoke('accounts:logout-microsoft')
  },

  versions: {
    list: () => ipcRenderer.invoke('versions:list'),
    manifest: (kind, source) => ipcRenderer.invoke('versions:manifest', kind, source),
    install: (versionId: string, source) => ipcRenderer.invoke('versions:install', versionId, source),
    cancelInstall: (): Promise<void> => ipcRenderer.invoke('versions:cancel-install')
  },

  fabric: {
    loaders: (gameVersion: string): Promise<FabricLoaderInfo[]> =>
      ipcRenderer.invoke('fabric:loaders', gameVersion),
    install: (gameVersion: string, loaderVersion: string, source?: string): Promise<void> =>
      ipcRenderer.invoke('fabric:install', gameVersion, loaderVersion, source)
  },

  java: {
    list: (): Promise<JavaInfo[]> => ipcRenderer.invoke('java:list'),
    pick: (): Promise<JavaInfo | null> => ipcRenderer.invoke('java:pick'),
    set: (javaPath: string): Promise<JavaInfo> => ipcRenderer.invoke('java:set', javaPath)
  },

  mods: {
    list: (): Promise<ModsSnapshot> => ipcRenderer.invoke('mods:list'),
    import: (paths?: string[]): Promise<ModImportResult> => ipcRenderer.invoke('mods:import', paths),
    setEnabled: (fileName: string, enabled: boolean): Promise<ModsSnapshot> =>
      ipcRenderer.invoke('mods:set-enabled', fileName, enabled),
    remove: (fileName: string): Promise<ModsSnapshot> => ipcRenderer.invoke('mods:remove', fileName),
    installDependencies: (modIds: string[]): Promise<ModDependencyInstallResult> =>
      ipcRenderer.invoke('mods:install-dependencies', modIds),
    openFolder: (): Promise<void> => ipcRenderer.invoke('mods:open-folder'),
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  },

  system: {
    stats: () => ipcRenderer.invoke('system:stats'),
    optimize: () => ipcRenderer.invoke('system:optimize')
  },

  server: {
    check: (url: string) => ipcRenderer.invoke('server:check', url)
  },

  multiplayer: {
    startHost: (port: number) => ipcRenderer.invoke('multiplayer:start-host', port),
    join: (code: string) => ipcRenderer.invoke('multiplayer:join', code),
    leave: (): Promise<void> => ipcRenderer.invoke('multiplayer:leave'),
    getState: () => ipcRenderer.invoke('multiplayer:get-state')
  },

  launch: (versionId: string): Promise<void> => ipcRenderer.invoke('launch:start', versionId),
  cancelLaunch: (): Promise<void> => ipcRenderer.invoke('launch:cancel'),

  openLogsFolder: (): Promise<void> => ipcRenderer.invoke('logs:open-folder'),
  readLogTail: (lines?: number): Promise<string[]> => ipcRenderer.invoke('logs:read-tail', lines),

  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close')
  }
};

contextBridge.exposeInMainWorld('launcher', launcher);

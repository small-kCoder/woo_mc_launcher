/**
 * 渲染进程与主进程共享的 IPC 契约类型。
 * 主进程与 preload 通过类型导入使用，不参与运行时。
 */

export type AccountMode = 'offline' | 'microsoft';

/** 服务端访问通道：1 = Cloudflare 免费入口，2 = 第三方入口 */
export type ServerChannel = 'channel1' | 'channel2';

/** 下载源：官方 / 通道1 / 通道2（通道源仅提供清单、版本 JSON 与 client.jar） */
export type DownloadSource = 'official' | ServerChannel;

export interface OfflineAccount {
  type: 'offline';
  id: string;
  name: string;
  uuid: string;
}

export interface MicrosoftAccountSummary {
  type: 'microsoft';
  id: string;
  name: string;
  uuid: string;
  /** 已裁切的头部 data URL，可直接用于 img */
  skinHeadDataUrl?: string;
  hasProfile: boolean;
}

export type AccountSummary = OfflineAccount | MicrosoftAccountSummary;

export interface AppConfig {
  gameDir: string;
  selectedAccountId: string | null;
  selectedVersionId: string | null;
  memoryMb: number;
  javaPath: string | null;
  accountMode: AccountMode;
  /** 启动游戏前自动进行内存优化 */
  memoryOptimizeOnLaunch: boolean;
  /** 当前生效的服务端通道 */
  serverChannel: ServerChannel;
  /** 通道1：Cloudflare 免费入口（基础地址，不含 /health） */
  channel1Url: string;
  /** 通道2：第三方入口（基础地址，不含 /health）；留空表示未配置 */
  channel2Url: string;
}

export interface VersionSummary {
  id: string;
  type: string;
  releaseTime: string;
  installed: boolean;
  javaMajor?: number;
}

export interface ManifestVersion {
  id: string;
  type: 'release' | 'snapshot' | string;
  releaseTime: string;
  installed: boolean;
}

export interface JavaInfo {
  path: string;
  version: string;
  major: number;
  source: 'config' | 'bundled' | 'system';
}

export type LaunchPhase = 'idle' | 'preparing' | 'downloading' | 'launching' | 'running' | 'exited' | 'failed';

export interface LaunchState {
  phase: LaunchPhase;
  percent: number;
  taskText: string;
  detailText?: string;
  versionId?: string;
  java?: JavaInfo;
  startedAt?: number;
  exitCode?: number | null;
  /** 当前下载速度（字节/秒），仅下载阶段有效 */
  bytesPerSecond?: number;
  error?: { code: string; message: string; logTail?: string[] };
}

export interface InstallProgress {
  versionId: string;
  percent: number;
  taskText: string;
  done: boolean;
  cancelled?: boolean;
  /** 当前下载速度（字节/秒），仅下载阶段有效 */
  bytesPerSecond?: number;
  error?: { code: string; message: string };
}

export interface AuthEvent {
  kind: 'device-code' | 'status' | 'success' | 'error' | 'cancelled';
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  message?: string;
  account?: MicrosoftAccountSummary;
}

/** 已导入的模组文件 */
export interface ModFile {
  name: string;
  size: number;
  /** ISO 时间 */
  modifiedAt: string;
}

/** 模组导入结果：成功与跳过的文件名 */
export interface ModImportResult {
  imported: string[];
  skipped: string[];
  /** 用户在文件选择对话框中取消 */
  canceled?: boolean;
}

/** 实时系统资源占用 */
export interface SystemStats {
  /** 0-100 */
  cpuPercent: number;
  /** 0-100 */
  memoryPercent: number;
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
}

/** 一次内存优化的结果 */
export interface MemoryOptimizeResult {
  freedBytes: number;
  elapsedMs: number;
  trimmedProcesses: number;
}

/** 服务端连接检查结果 */
export interface ServerCheckResult {
  ok: boolean;
  /** 规范化后的基础地址 */
  url: string;
  latencyMs: number;
  status?: number;
  message?: string;
}

/** P2P 联机阶段 */
export type MultiplayerPhase =
  | 'idle'
  | 'waiting-game'
  | 'waiting-lan'
  | 'ready'
  | 'joining'
  | 'connecting'
  | 'error';

export interface MultiplayerState {
  phase: MultiplayerPhase;
  /** 房主：局域网就绪后由服务器分配的房间号 */
  roomCode?: string;
  versionId?: string;
  /** 房主：手动填写并监测的局域网端口 */
  targetPort?: number;
  /** 房主：已确认开放的局域网端口 */
  lanPort?: number;
  /** 状态说明或错误文案 */
  message?: string;
  startedAt?: number;
}

export interface InitialState {
  config: AppConfig;
  accounts: AccountSummary[];
  activeAccount: AccountSummary | null;
  versions: VersionSummary[];
  java: JavaInfo | null;
  appVersion: string;
  paths: { gameDir: string; logsDir: string };
}

/** 渲染进程允许订阅的事件通道（白名单） */
export type LauncherEventChannel =
  | 'launch:progress'
  | 'launch:state'
  | 'launch:log'
  | 'install:progress'
  | 'auth:event'
  | 'versions:changed'
  | 'system:stats'
  | 'multiplayer:state';

/** preload 暴露到 window.launcher 的完整 API */
export interface LauncherApi {
  /** 兼容旧调用方（Task 1 临时页面），后续由 win 取代 */
  windowControls: LauncherWindowControls;
  openExternal: (url: string) => Promise<boolean>;
  platform: string;
  appVersion: string;
  on: (channel: LauncherEventChannel, callback: (payload: unknown) => void) => () => void;
  init: () => Promise<InitialState>;
  config: {
    get: () => Promise<AppConfig>;
    update: (patch: Partial<AppConfig>) => Promise<AppConfig>;
  };
  accounts: {
    saveOffline: (name: string) => Promise<AccountSummary>;
    setActive: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    loginMicrosoft: () => Promise<void>;
    cancelMicrosoftLogin: () => Promise<void>;
    logoutMicrosoft: () => Promise<void>;
  };
  versions: {
    list: () => Promise<VersionSummary[]>;
    manifest: (kind: 'release' | 'snapshot' | 'all', source?: DownloadSource) => Promise<ManifestVersion[]>;
    install: (versionId: string, source?: DownloadSource) => Promise<void>;
    cancelInstall: () => Promise<void>;
  };
  java: {
    list: () => Promise<JavaInfo[]>;
    pick: () => Promise<JavaInfo | null>;
    set: (path: string) => Promise<JavaInfo>;
  };
  mods: {
    list: () => Promise<ModFile[]>;
    /** 不传 paths 时打开文件选择对话框；传入 paths 时直接导入（供拖拽/测试复用） */
    import: (paths?: string[]) => Promise<ModImportResult>;
  };
  system: {
    stats: () => Promise<SystemStats>;
    /** 立即执行一次内存优化（面板按钮与启动前自动优化共用） */
    optimize: () => Promise<MemoryOptimizeResult>;
  };
  server: {
    /** 检查服务端 GET <url>/health，超时 5 秒 */
    check: (url: string) => Promise<ServerCheckResult>;
  };
  multiplayer: {
    /** 房主：填写局域网端口后启动 EasyTier 并监测该端口 */
    startHost: (port: number) => Promise<MultiplayerState>;
    /** 访客：解析房间号、建立 P2P、写入服务器列表并启动游戏 */
    join: (code: string) => Promise<MultiplayerState>;
    /** 关闭联机房间并清理 EasyTier 进程 */
    leave: () => Promise<void>;
    getState: () => Promise<MultiplayerState>;
  };
  launch: (versionId: string) => Promise<void>;
  cancelLaunch: () => Promise<void>;
  openLogsFolder: () => Promise<void>;
  readLogTail: (lines?: number) => Promise<string[]>;
  win: LauncherWindowControls;
}

export interface LauncherWindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
}

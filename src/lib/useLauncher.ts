import { createContext, useContext } from 'react';
import type {
  AccountMode,
  AccountSummary,
  AppConfig,
  JavaInfo,
  VersionSummary
} from '../types/ipc';

/** 渲染进程共享的启动器状态与配置写入方法 */
export interface LauncherContextValue {
  ready: boolean;
  initError: string | null;
  config: AppConfig | null;
  accounts: AccountSummary[];
  activeAccount: AccountSummary | null;
  versions: VersionSummary[];
  java: JavaInfo | null;
  paths: { gameDir: string; logsDir: string } | null;
  appVersion: string;
  reload: () => Promise<void>;
  setAccountMode: (mode: AccountMode) => Promise<void>;
  setSelectedAccount: (id: string) => Promise<void>;
  setSelectedVersion: (id: string) => Promise<void>;
  setAccounts: (accounts: AccountSummary[], activeId: string | null) => void;
  setVersions: (versions: VersionSummary[]) => void;
  setJava: (java: JavaInfo | null) => void;
  refreshConfig: () => Promise<void>;
}

export const LauncherContext = createContext<LauncherContextValue | null>(null);

/** 读取启动器上下文；必须在 LauncherProvider 内使用 */
export function useLauncher(): LauncherContextValue {
  const value = useContext(LauncherContext);
  if (!value) {
    throw new Error('useLauncher 必须在 LauncherProvider 内使用');
  }
  return value;
}

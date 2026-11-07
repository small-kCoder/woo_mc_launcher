import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AccountMode,
  AccountSummary,
  AppConfig,
  InitialState,
  JavaInfo,
  VersionSummary
} from '../types/ipc';
import { LauncherContext, type LauncherContextValue } from '../lib/useLauncher';

/** 从异常中提取可展示的中文错误信息 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return '启动器初始化失败';
}

interface LauncherProviderProps {
  children: ReactNode;
}

/**
 * 启动器全局状态：挂载时调用 window.launcher.init() 拉取初始状态。
 * 账户与版本的写入统一走 config.update，并同步更新本地配置。
 */
export default function LauncherProvider({ children }: LauncherProviderProps): JSX.Element {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [accounts, setAccountsState] = useState<AccountSummary[]>([]);
  const [versions, setVersionsState] = useState<VersionSummary[]>([]);
  const [java, setJavaState] = useState<JavaInfo | null>(null);
  const [paths, setPaths] = useState<{ gameDir: string; logsDir: string } | null>(null);
  const [appVersion, setAppVersion] = useState('');

  /** 应用 init 返回的完整初始状态 */
  const applyInitialState = useCallback((state: InitialState) => {
    setConfig(state.config);
    setAccountsState(state.accounts);
    setVersionsState(state.versions);
    setJavaState(state.java);
    setPaths(state.paths);
    setAppVersion(state.appVersion);
  }, []);

  const load = useCallback(async () => {
    const api = window.launcher;
    if (!api) {
      setInitError('未检测到启动器运行环境');
      setReady(true);
      return;
    }
    try {
      const state = await api.init();
      applyInitialState(state);
      setInitError(null);
    } catch (error) {
      setInitError(toErrorMessage(error));
    } finally {
      setReady(true);
    }
  }, [applyInitialState]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 根据选中账户 id 查找，失配时回退到与当前模式一致的首个账户 */
  const activeAccount = useMemo<AccountSummary | null>(() => {
    if (accounts.length === 0) {
      return null;
    }
    const selectedId = config?.selectedAccountId ?? null;
    if (selectedId) {
      const selected = accounts.find((item) => item.id === selectedId);
      if (selected) {
        return selected;
      }
    }
    const mode: AccountMode = config?.accountMode ?? 'offline';
    return accounts.find((item) => item.type === mode) ?? null;
  }, [accounts, config]);

  /** 通过 IPC 更新配置并把结果写回本地 */
  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const next = await api.config.update(patch);
    setConfig(next);
  }, []);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  // 全局状态同步：版本变更与登录成功统一在此刷新，页面与弹窗不再各自重复调用
  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const offVersions = api.on('versions:changed', () => {
      void reload();
    });
    const offAuth = api.on('auth:event', (payload) => {
      if ((payload as { kind?: string }).kind === 'success') {
        void reload();
      }
    });
    return () => {
      offVersions();
      offAuth();
    };
  }, [reload]);

  const setAccountMode = useCallback(
    async (mode: AccountMode) => {
      await updateConfig({ accountMode: mode });
    },
    [updateConfig]
  );

  const setSelectedAccount = useCallback(
    async (id: string) => {
      await updateConfig({ selectedAccountId: id });
    },
    [updateConfig]
  );

  const setSelectedVersion = useCallback(
    async (id: string) => {
      await updateConfig({ selectedVersionId: id });
    },
    [updateConfig]
  );

  const setAccounts = useCallback((nextAccounts: AccountSummary[], activeId: string | null) => {
    setAccountsState(nextAccounts);
    setConfig((prev) => (prev ? { ...prev, selectedAccountId: activeId } : prev));
  }, []);

  const setVersions = useCallback((nextVersions: VersionSummary[]) => {
    setVersionsState(nextVersions);
  }, []);

  const setJava = useCallback((nextJava: JavaInfo | null) => {
    setJavaState(nextJava);
  }, []);

  const refreshConfig = useCallback(async () => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const next = await api.config.get();
    setConfig(next);
  }, []);

  const value = useMemo<LauncherContextValue>(
    () => ({
      ready,
      initError,
      config,
      accounts,
      activeAccount,
      versions,
      java,
      paths,
      appVersion,
      reload,
      setAccountMode,
      setSelectedAccount,
      setSelectedVersion,
      setAccounts,
      setVersions,
      setJava,
      refreshConfig
    }),
    [
      ready,
      initError,
      config,
      accounts,
      activeAccount,
      versions,
      java,
      paths,
      appVersion,
      reload,
      setAccountMode,
      setSelectedAccount,
      setSelectedVersion,
      setAccounts,
      setVersions,
      setJava,
      refreshConfig
    ]
  );

  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

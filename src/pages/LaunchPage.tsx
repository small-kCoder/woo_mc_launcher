import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, LogOut } from 'lucide-react';
import AccountAvatar from '../components/AccountAvatar';
import AccountMenu from '../components/AccountMenu';
import InstallDialog from '../components/InstallDialog';
import JavaDialog from '../components/JavaDialog';
import LaunchButton from '../components/LaunchButton';
import LaunchErrorDialog from '../components/LaunchErrorDialog';
import LoginDialog from '../components/LoginDialog';
import ProgressBar from '../components/ProgressBar';
import SegmentedControl from '../components/SegmentedControl';
import Toast from '../components/Toast';
import VersionSelect from '../components/VersionSelect';
import { useLauncher } from '../lib/useLauncher';
import { showToast } from '../lib/toast';
import { DURATIONS, EASE_OUT_CURVE } from '../lib/motion';
import { shortUuid } from '../lib/format';
import { toUserMessage } from '../lib/errorText';
import type {
  AccountMode,
  AccountSummary,
  JavaInfo,
  LaunchState,
  VersionSummary
} from '../types/ipc';

/** 离线用户名规范：3-16 位字母、数字或下划线 */
const OFFLINE_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const OFFLINE_NAME_ERROR = '用户名需为 3–16 位字母、数字或下划线';

const MODE_OPTIONS = [
  { value: 'offline' as const, label: '离线' },
  { value: 'microsoft' as const, label: '正版' }
];

const SOURCE_LABELS: Record<JavaInfo['source'], string> = {
  config: '手动',
  bundled: '自带',
  system: '系统'
};

const INITIAL_LAUNCH_STATE: LaunchState = { phase: 'idle', percent: 0, taskText: '' };

/** preparing 阶段在主进程仅持续十几毫秒，UI 至少保留该时长以便用户感知 */
const PREPARING_MIN_MS = 350;

/** 跨页面切换保留最新启动状态，返回启动页时不会丢回 idle */
let latestLaunchState: LaunchState = INITIAL_LAUNCH_STATE;

function errorMessage(error: unknown): string {
  return toUserMessage(error, '操作失败，请稍后重试');
}

/** 监听系统“减少动态效果”偏好，用于关闭头像倾斜 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** 当前模式下的账户：优先选中项，否则回退到该模式首个账户 */
function resolveModeAccount(
  activeAccount: AccountSummary | null,
  accounts: AccountSummary[],
  mode: AccountMode
): AccountSummary | null {
  if (activeAccount?.type === mode) {
    return activeAccount;
  }
  return accounts.find((account) => account.type === mode) ?? null;
}

/**
 * 启动页：分段账户模式、头像卡、账户区、进度条、大启动按钮、
 * 版本选择器与当前 Java 文案。页面本身不使用整块玻璃面板。
 */
export default function LaunchPage(): JSX.Element {
  const {
    config,
    accounts,
    activeAccount,
    versions,
    java,
    reload,
    setAccountMode,
    setSelectedAccount,
    setSelectedVersion,
    refreshConfig
  } = useLauncher();

  const reducedMotion = usePrefersReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  const [nameInput, setNameInput] = useState('');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [javaOpen, setJavaOpen] = useState(false);
  const [launchState, setLaunchState] = useState<LaunchState>(latestLaunchState);
  const lastPhaseRef = useRef<LaunchState['phase']>(latestLaunchState.phase);
  const preparingAtRef = useRef<number | null>(null);
  const pendingLaunchRef = useRef<LaunchState | null>(null);
  const holdTimerRef = useRef<number | null>(null);

  const mode: AccountMode = config?.accountMode ?? 'offline';
  const modeAccount = resolveModeAccount(activeAccount, accounts, mode);
  const offlineAccount = activeAccount?.type === 'offline' ? activeAccount : accounts.find((a) => a.type === 'offline') ?? null;
  const microsoftAccount = modeAccount?.type === 'microsoft' ? modeAccount : null;

  // 离线账户切换时同步输入框；用户输入过程中不会被覆盖
  useEffect(() => {
    setNameInput(offlineAccount?.name ?? '');
  }, [offlineAccount?.id, offlineAccount?.name]);

  const trimmedName = nameInput.trim();
  const nameValid = OFFLINE_NAME_PATTERN.test(trimmedName);
  const showNameError = trimmedName.length > 0 && !nameValid;

  const selectedVersionId = config?.selectedVersionId ?? null;
  const effectiveVersion: VersionSummary | null =
    versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null;

  // 记住上次选择；选中项失效时回退到首个版本
  useEffect(() => {
    if (versions.length === 0) {
      return;
    }
    if (!selectedVersionId || !versions.some((version) => version.id === selectedVersionId)) {
      void setSelectedVersion(versions[0].id);
    }
  }, [versions, selectedVersionId, setSelectedVersion]);

  // 订阅启动状态：状态机以 launch:state 为准，progress 仅更新百分比
  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const commitState = (state: LaunchState) => {
      const previous = lastPhaseRef.current;
      lastPhaseRef.current = state.phase;
      latestLaunchState = state;
      setLaunchState(state);

      if (state.phase === 'exited' && previous !== 'exited') {
        if (state.detailText?.includes('取消')) {
          showToast({ type: 'info', message: '已取消' });
        } else if (typeof state.exitCode === 'number') {
          showToast({ type: 'info', message: `游戏已退出（退出码 ${state.exitCode}）` });
        } else {
          showToast({ type: 'info', message: '游戏已结束' });
        }
      }
      if (state.phase === 'idle' && previous !== 'idle' && state.taskText === '已取消') {
        showToast({ type: 'info', message: '已取消' });
      }
    };

    const flushPending = () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      const pending = pendingLaunchRef.current;
      pendingLaunchRef.current = null;
      if (pending) {
        preparingAtRef.current = null;
        // 保留延迟期间通过 launch:progress 更新的百分比
        commitState({ ...pending, percent: latestLaunchState.percent });
      }
    };

    const offState = api.on('launch:state', (payload) => {
      const state = payload as LaunchState;

      if (state.phase === 'preparing') {
        preparingAtRef.current = Date.now();
      }
      if (state.phase === 'downloading' && preparingAtRef.current !== null) {
        const elapsed = Date.now() - preparingAtRef.current;
        if (elapsed < PREPARING_MIN_MS) {
          pendingLaunchRef.current = state;
          if (holdTimerRef.current !== null) {
            window.clearTimeout(holdTimerRef.current);
          }
          holdTimerRef.current = window.setTimeout(flushPending, PREPARING_MIN_MS - elapsed);
          return;
        }
      }
      if (state.phase !== 'preparing') {
        preparingAtRef.current = null;
      }
      flushPending();
      commitState(state);
    });
    const offProgress = api.on('launch:progress', (payload) => {
      const progress = payload as { percent?: number; bytesPerSecond?: number };
      if (typeof progress.percent !== 'number') {
        return;
      }
      setLaunchState((prev) => {
        // [原代码]: const next = { ...prev, percent: progress.percent as number };
        const next = {
          ...prev,
          percent: progress.percent as number,
          bytesPerSecond: typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : prev.bytesPerSecond
        };
        latestLaunchState = next;
        return next;
      });
    });
    // versions:changed 由 LauncherProvider 统一 reload，页面不重复订阅
    return () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      pendingLaunchRef.current = null;
      preparingAtRef.current = null;
      offState();
      offProgress();
    };
  }, []);

  /** 保存离线账户并设为选中 */
  const persistOffline = useCallback(
    async (name: string): Promise<AccountSummary | null> => {
      const api = window.launcher;
      if (!api) {
        showToast({ type: 'error', message: '未检测到启动器运行环境' });
        return null;
      }
      try {
        const saved = await api.accounts.saveOffline(name);
        await reload();
        await setSelectedAccount(saved.id);
        return saved;
      } catch (saveError) {
        showToast({ type: 'error', message: errorMessage(saveError) });
        return null;
      }
    },
    [reload, setSelectedAccount]
  );

  const handleNameBlur = () => {
    if (nameValid && trimmedName !== offlineAccount?.name) {
      void persistOffline(trimmedName);
    }
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    }
  };

  /** 切换账户模式，并同步选中目标模式下的账户 */
  const handleModeChange = async (nextMode: AccountMode) => {
    if (nextMode === mode) {
      return;
    }
    setAccountMenuOpen(false);
    try {
      await setAccountMode(nextMode);
      const target = accounts.find((account) => account.type === nextMode);
      if (target) {
        await setSelectedAccount(target.id);
      } else {
        // 目标模式没有账户时清空选中，避免侧栏显示另一模式的账户
        await window.launcher?.config.update({ selectedAccountId: null });
        await refreshConfig();
      }
    } catch (modeError) {
      showToast({ type: 'error', message: errorMessage(modeError) });
    }
  };

  const handleSelectAccount = async (accountId: string) => {
    try {
      await setSelectedAccount(accountId);
      const account = accounts.find((item) => item.id === accountId);
      if (account?.type === 'offline') {
        setNameInput(account.name);
      }
    } catch (selectError) {
      showToast({ type: 'error', message: errorMessage(selectError) });
    }
  };

  const handleLogout = async () => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    try {
      await api.accounts.logoutMicrosoft();
      await reload();
      showToast({ type: 'info', message: '已退出登录' });
    } catch (logoutError) {
      showToast({ type: 'error', message: errorMessage(logoutError) });
    }
  };

  const launchDisabledReason: string | null = !effectiveVersion
    ? '请先安装版本'
    : mode === 'offline'
      ? !nameValid
        ? '请先登录'
        : null
      : !microsoftAccount
        ? '请先登录'
        : null;

  const progressActive = ['preparing', 'downloading', 'launching', 'running'].includes(launchState.phase);
  const progressValue =
    launchState.phase === 'running'
      ? 100
      : launchState.phase === 'downloading' || launchState.phase === 'launching'
        ? launchState.percent
        : null;

  const handleLaunch = async () => {
    const api = window.launcher;
    if (!api || !effectiveVersion) {
      if (!effectiveVersion) {
        showToast({ type: 'error', message: '请先安装游戏版本' });
      }
      return;
    }

    if (mode === 'offline') {
      if (!nameValid) {
        showToast({ type: 'error', message: OFFLINE_NAME_ERROR });
        return;
      }
      if (!offlineAccount || offlineAccount.name !== trimmedName) {
        const saved = await persistOffline(trimmedName);
        if (!saved) {
          return;
        }
      }
    } else if (!microsoftAccount) {
      showToast({ type: 'error', message: '请先登录 Microsoft 账户' });
      return;
    }

    try {
      await api.launch(effectiveVersion.id);
    } catch (launchError) {
      showToast({ type: 'error', message: toUserMessage(launchError, '启动失败，请稍后重试') });
    }
  };

  const handleCancelLaunch = () => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    void api.cancelLaunch().catch((cancelError: unknown) => {
      showToast({ type: 'error', message: errorMessage(cancelError) });
    });
  };

  const avatarAccount = useMemo<AccountSummary | null>(() => {
    return mode === 'offline' ? offlineAccount : microsoftAccount;
  }, [mode, offlineAccount, microsoftAccount]);

  const javaLabel = java
    ? `当前 Java：${java.version}（${SOURCE_LABELS[java.source] ?? java.source}）`
    : '未检测到 Java，点击选择';

  return (
    <div className="page-root" style={{ padding: '12px 16px' }}>
      <div style={{ width: 340, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <SegmentedControl
          options={MODE_OPTIONS}
          value={mode}
          onChange={(next) => void handleModeChange(next)}
          width={220}
          height={34}
          ariaLabel="账户模式"
        />

        {/* 头像卡：页面唯一带 backdrop-filter 的玻璃层 */}
        <motion.div
          className="glass"
          whileHover={reducedMotion ? undefined : { rotateX: -2, rotateY: 2, y: -2 }}
          transition={{ duration: DURATIONS.base, ease: EASE_OUT_CURVE }}
          style={{
            width: 208,
            height: 208,
            marginTop: 12,
            flex: 'none',
            borderRadius: 'var(--radius-xl)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transformPerspective: 900,
            boxShadow:
              '0 22px 46px rgba(2, 6, 16, 0.5), 0 0 44px rgba(106, 168, 255, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.2)'
          }}
        >
          <AccountAvatar account={avatarAccount} size={176} />
        </motion.div>

        {/* 账户区：离线输入框或微软账户信息 */}
        <div
          ref={accountRef}
          style={{
            position: 'relative',
            width: 320,
            marginTop: 12,
            flex: 'none',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {mode === 'offline' ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 40,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--glass-border)',
                  background: 'var(--glass-bg)',
                  overflow: 'hidden'
                }}
              >
                <input
                  ref={inputRef}
                  value={nameInput}
                  maxLength={16}
                  aria-label="离线用户名"
                  aria-invalid={showNameError}
                  spellCheck={false}
                  onChange={(event) => setNameInput(event.target.value)}
                  onBlur={handleNameBlur}
                  onKeyDown={handleNameKeyDown}
                  placeholder="输入用户名"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: '100%',
                    padding: '0 12px',
                    border: 0,
                    outline: 'none',
                    background: 'transparent',
                    color: 'var(--text-1)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-md)'
                  }}
                />
                <button
                  type="button"
                  className="focus-ring"
                  aria-label="账户列表"
                  aria-expanded={accountMenuOpen}
                  onClick={() => setAccountMenuOpen((value) => !value)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: '100%',
                    flex: 'none',
                    padding: 0,
                    border: 0,
                    borderLeft: '1px solid rgba(255, 255, 255, 0.06)',
                    background: 'transparent',
                    color: 'var(--text-2)',
                    cursor: 'pointer'
                  }}
                >
                  <ChevronDown
                    size={14}
                    strokeWidth={1.8}
                    style={{
                      transform: accountMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform var(--dur-base) var(--ease-out)'
                    }}
                  />
                </button>
              </div>

              <AccountMenu
                open={accountMenuOpen}
                mode="offline"
                accounts={accounts.filter((account) => account.type === 'offline')}
                activeId={offlineAccount?.id ?? null}
                anchorRef={accountRef}
                onSelect={(id) => void handleSelectAccount(id)}
                onCreateOffline={() => {
                  setNameInput('');
                  setAccountMenuOpen(false);
                  window.setTimeout(() => inputRef.current?.focus(), 0);
                }}
                onLogin={() => setLoginOpen(true)}
                onClose={() => setAccountMenuOpen(false)}
              />
            </>
          ) : microsoftAccount ? (
            <>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 40
                }}
              >
                <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, lineHeight: '20px' }}>
                  {microsoftAccount.name}
                </span>
                <span className="text-3 num" style={{ fontSize: 'var(--fs-xs)', lineHeight: '16px' }}>
                  {shortUuid(microsoftAccount.uuid)}
                  {microsoftAccount.hasProfile ? ' · 档案正常' : ' · 档案缺失'}
                </span>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="focus-ring"
                onClick={() => setLoginOpen(true)}
                style={{
                  height: 40,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid rgba(106, 168, 255, 0.4)',
                  background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.26), rgba(106, 168, 255, 0.1))',
                  color: 'var(--text-1)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-md)',
                  cursor: 'pointer'
                }}
              >
                登录 Microsoft 账户
              </button>
            </>
          )}

          <div style={{ minHeight: 16, marginTop: 4, textAlign: 'center' }}>
            {mode === 'offline' ? (
              showNameError ? (
                <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-xs)', lineHeight: '16px' }}>
                  {OFFLINE_NAME_ERROR}
                </span>
              ) : null
            ) : microsoftAccount ? (
              <button
                type="button"
                onClick={() => void handleLogout()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: 0,
                  border: 0,
                  background: 'transparent',
                  color: 'var(--text-3)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-xs)',
                  cursor: 'pointer'
                }}
              >
                <LogOut size={11} strokeWidth={1.8} />
                退出登录
              </button>
            ) : (
              <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: '16px' }}>
                使用设备码在浏览器中完成登录
              </span>
            )}
          </div>
        </div>

        <div style={{ marginTop: 10, flex: 'none' }}>
          <ProgressBar value={progressValue} active={progressActive} width={320} />
        </div>

        <div style={{ marginTop: 12, flex: 'none' }}>
          <LaunchButton
            state={launchState}
            disabled={launchDisabledReason !== null}
            idleText={launchDisabledReason ?? '启动游戏'}
            onClick={() => void handleLaunch()}
            onCancel={handleCancelLaunch}
          />
        </div>

        <div style={{ marginTop: 12, flex: 'none' }}>
          <VersionSelect
            versions={versions}
            selectedId={effectiveVersion?.id ?? null}
            java={java}
            onSelect={(id) => {
              void setSelectedVersion(id).catch((selectError: unknown) => {
                showToast({ type: 'error', message: errorMessage(selectError) });
              });
            }}
            onInstall={() => setInstallOpen(true)}
            disabled={launchState.phase === 'preparing' || launchState.phase === 'launching' || launchState.phase === 'running'}
          />
        </div>

        <button
          type="button"
          onClick={() => setJavaOpen(true)}
          style={{
            height: 16,
            marginTop: 8,
            padding: 0,
            border: 0,
            background: 'transparent',
            color: java ? 'var(--text-3)' : 'var(--warning)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-xs)',
            lineHeight: '16px',
            cursor: 'pointer'
          }}
        >
          {javaLabel}
        </button>
      </div>

      <Toast />
      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
      <JavaDialog open={javaOpen} onClose={() => setJavaOpen(false)} />
      <LaunchErrorDialog fallbackVersionId={effectiveVersion?.id ?? null} />
    </div>
  );
}

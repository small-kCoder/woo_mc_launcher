import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, RefreshCw, Search } from 'lucide-react';
import ProgressBar from './ProgressBar';
import SegmentedControl from './SegmentedControl';
import { useLauncher } from '../lib/useLauncher';
import { showToast } from '../lib/toast';
import { formatReleaseDate, formatSpeed, versionTypeSuffix } from '../lib/format';
import { toUserMessage } from '../lib/errorText';
import type { DownloadSource, InstallProgress, ManifestVersion } from '../types/ipc';

type ManifestKind = 'release' | 'snapshot' | 'all';
type InstallStatus = 'idle' | 'installing' | 'done' | 'failed' | 'cancelled';

interface InstallStatusState {
  status: InstallStatus;
  percent: number;
  taskText: string;
  versionId: string | null;
  message: string;
  /** 实时下载速度（字节/秒） */
  bytesPerSecond: number;
}

const FILTER_OPTIONS = [
  { value: 'release' as const, label: '正式版' },
  { value: 'snapshot' as const, label: '快照' },
  { value: 'all' as const, label: '全部' }
];

/** 下载源：官方 / 通道1 / 通道2 */
const SOURCE_OPTIONS = [
  { value: 'official' as const, label: '官方' },
  { value: 'channel1' as const, label: '通道1' },
  { value: 'channel2' as const, label: '通道2' }
];

const DOWNLOAD_SOURCE_LABEL: Record<DownloadSource, string> = {
  official: '官方',
  channel1: '通道1',
  channel2: '通道2'
};

const IDLE_INSTALL: InstallStatusState = {
  status: 'idle',
  percent: 0,
  taskText: '',
  versionId: null,
  message: '',
  bytesPerSecond: 0
};

/** 列表行高：弹窗内紧凑，下载页稍宽松但仍保持密度 */
const ROW_HEIGHT = { compact: 44, page: 46 } as const;

interface VersionBrowserProps {
  variant?: keyof typeof ROW_HEIGHT;
  /** 安装状态变化（弹窗用它禁用关闭） */
  onInstallingChange?: (installing: boolean) => void;
  /** 安装成功回调，下载页用于提示与刷新 */
  onInstalled?: (versionId: string) => void;
  /** 紧凑模式下安装完成后的“完成”按钮回调（关闭弹窗） */
  onDone?: () => void;
  style?: CSSProperties;
}

function errorMessage(error: unknown): string {
  return toUserMessage(error, '操作失败，请稍后重试');
}

/**
 * 官方版本浏览器：筛选、搜索、已安装标记、安装进度与取消。
 * 同时被“安装新版本”弹窗与下载页复用，保证两处行为一致。
 */
export default function VersionBrowser({
  variant = 'compact',
  onInstallingChange,
  onInstalled,
  onDone,
  style
}: VersionBrowserProps): JSX.Element {
  const { config, setSelectedVersion } = useLauncher();
  const [kind, setKind] = useState<ManifestKind>('release');
  /** 下载源：下载页默认官方，切换页面重新挂载后仍回到官方 */
  const [source, setSource] = useState<DownloadSource>('official');
  const [manifest, setManifest] = useState<ManifestVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallStatusState>(IDLE_INSTALL);

  const selectRef = useRef(setSelectedVersion);
  const configRef = useRef(config);
  const installedRef = useRef(onInstalled);
  const installingChangeRef = useRef(onInstallingChange);
  const doneHandledRef = useRef(false);
  selectRef.current = setSelectedVersion;
  configRef.current = config;
  installedRef.current = onInstalled;
  installingChangeRef.current = onInstallingChange;

  const installing = install.status === 'installing';
  const rowHeight = ROW_HEIGHT[variant];

  useEffect(() => {
    installingChangeRef.current?.(installing);
  }, [installing]);

  const loadManifest = useCallback(async (targetKind: ManifestKind, targetSource: DownloadSource) => {
    const api = window.launcher;
    if (!api) {
      setLoadError('未检测到启动器运行环境');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const list = await api.versions.manifest(targetKind, targetSource);
      setManifest(list);
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : null));
    } catch (loadFailure) {
      setManifest(null);
      setLoadError(toUserMessage(loadFailure, '无法获取版本清单，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次挂载、筛选或下载源切换时加载对应清单
  useEffect(() => {
    let disposed = false;
    setManifest(null);
    setLoading(true);
    setLoadError(null);
    const api = window.launcher;
    if (!api) {
      setLoading(false);
      setLoadError('未检测到启动器运行环境');
      return;
    }
    api.versions
      .manifest(kind, source)
      .then((list) => {
        if (disposed) {
          return;
        }
        setManifest(list);
        setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : null));
      })
      .catch((loadFailure: unknown) => {
        if (!disposed) {
          setLoadError(toUserMessage(loadFailure, '无法获取版本清单，请稍后重试'));
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [kind, source]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 150);
    return () => window.clearTimeout(timer);
  }, [search]);

  // 安装进度：仅当前安装的版本匹配时更新
  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const unsubscribe = api.on('install:progress', (payload) => {
      const progress = payload as InstallProgress;
      setInstall((prev) => {
        if (!prev.versionId || prev.versionId !== progress.versionId) {
          return prev;
        }
        if (progress.done) {
          if (progress.cancelled) {
            return { ...prev, status: 'cancelled', message: '安装已取消', bytesPerSecond: 0 };
          }
          if (progress.error) {
            return { ...prev, status: 'failed', message: progress.error.message, bytesPerSecond: 0 };
          }
          return { ...prev, status: 'done', percent: 100, message: '安装完成', bytesPerSecond: 0 };
        }
        return {
          ...prev,
          status: 'installing',
          percent: progress.percent,
          taskText: progress.taskText,
          bytesPerSecond: progress.bytesPerSecond ?? 0
        };
      });

      if (!progress.done) {
        return;
      }
      if (progress.cancelled) {
        showToast({ type: 'info', message: '安装已取消' });
        return;
      }
      if (progress.error) {
        showToast({ type: 'error', message: `安装失败：${progress.error.message}` });
        return;
      }

      // 本组件内的清单标记为已安装，避免再手动刷新
      setManifest((prev) =>
        prev ? prev.map((item) => (item.id === progress.versionId ? { ...item, installed: true } : item)) : prev
      );
      if (!doneHandledRef.current) {
        doneHandledRef.current = true;
        showToast({ type: 'success', message: `版本 ${progress.versionId} 安装完成` });
        installedRef.current?.(progress.versionId);
        // 启动页尚未选择版本时自动选中新安装的版本
        if (!configRef.current?.selectedVersionId) {
          void selectRef.current(progress.versionId);
        }
      }
    });
    return unsubscribe;
  }, []);

  const handleStartInstall = async (versionId: string) => {
    const api = window.launcher;
    if (!api) {
      setInstall({ ...IDLE_INSTALL, status: 'failed', message: '未检测到启动器运行环境' });
      return;
    }
    doneHandledRef.current = false;
    setInstall({
      status: 'installing',
      percent: 0,
      taskText: '正在准备安装…',
      versionId,
      message: '',
      bytesPerSecond: 0
    });
    try {
      await api.versions.install(versionId, source);
    } catch (installFailure) {
      const message = toUserMessage(installFailure, '安装失败，请稍后重试');
      setInstall((prev) => (prev.status === 'installing' ? { ...prev, status: 'failed', message } : prev));
      showToast({ type: 'error', message: `安装失败：${message}` });
    }
  };

  const handleCancelInstall = async () => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    setInstall((prev) => (prev.status === 'installing' ? { ...prev, taskText: '正在取消安装…' } : prev));
    try {
      await api.versions.cancelInstall();
    } catch (cancelFailure) {
      showToast({ type: 'error', message: errorMessage(cancelFailure) });
    }
  };

  const visibleVersions = (manifest ?? []).filter((item) =>
    debouncedSearch ? item.id.toLowerCase().includes(debouncedSearch) : true
  );
  const selected = manifest?.find((item) => item.id === selectedId) ?? null;

  const renderStatus = (): JSX.Element | null => {
    if (install.status === 'installing') {
      const speed = formatSpeed(install.bytesPerSecond);
      return (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProgressBar value={install.percent} width={variant === 'page' ? 180 : 140} />
          <span
            className="text-3"
            style={{
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              fontSize: 'var(--fs-xs)'
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {install.taskText || '正在安装…'}（{Math.round(install.percent)}%）
            </span>
            {speed && (
              <span className="num" style={{ flex: 'none', color: 'var(--accent)' }}>
                {speed}
              </span>
            )}
          </span>
        </div>
      );
    }
    if (install.status === 'done') {
      return <span style={{ color: 'var(--success)', fontSize: 'var(--fs-sm)' }}>安装完成</span>;
    }
    if (install.status === 'failed') {
      return <span style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{install.message}</span>;
    }
    if (install.status === 'cancelled') {
      return (
        <span className="text-3" style={{ fontSize: 'var(--fs-sm)' }}>
          安装已取消
        </span>
      );
    }
    return (
      <span className="text-3" style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xs)' }}>
        仅支持 1.7.10 及以后的原版版本，
        {source === 'official'
          ? '资源来自 Mojang 官方源'
          : `${DOWNLOAD_SOURCE_LABEL[source]}提供清单/版本 JSON/client.jar，依赖库与资源仍来自 Mojang`}
      </span>
    );
  };

  const actionButtonStyle: CSSProperties = {
    flex: 'none',
    height: 32,
    padding: '0 22px',
    borderRadius: 'var(--radius-pill)',
    border: '1px solid rgba(106, 168, 255, 0.4)',
    background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
    color: 'var(--text-1)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--fs-sm)',
    cursor: 'pointer'
  };

  const renderAction = (): JSX.Element => {
    if (install.status === 'installing') {
      return (
        <button
          type="button"
          className="focus-ring"
          onClick={() => void handleCancelInstall()}
          style={{
            flex: 'none',
            height: 32,
            padding: '0 18px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid rgba(255, 107, 107, 0.42)',
            background: 'rgba(255, 107, 107, 0.12)',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)',
            cursor: 'pointer'
          }}
        >
          取消安装
        </button>
      );
    }
    if (install.status === 'done' && variant === 'compact') {
      return (
        <button type="button" className="focus-ring glass-sheen glass-interactive" onClick={onDone} style={actionButtonStyle}>
          完成
        </button>
      );
    }
    return (
      <button
        type="button"
        className="focus-ring glass-sheen glass-interactive"
        disabled={!selected}
        onClick={() => {
          if (selected) {
            void handleStartInstall(selected.id);
          }
        }}
        style={{
          ...actionButtonStyle,
          cursor: !selected ? 'not-allowed' : 'pointer',
          opacity: selected ? 1 : 0.55
        }}
      >
        {selected?.installed ? '重新安装' : '下载并安装'}
      </button>
    );
  };

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', ...style }}>
      {/* 筛选、下载源与刷新 */}
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', rowGap: 8, marginBottom: 8 }}>
        <SegmentedControl
          options={FILTER_OPTIONS}
          value={kind}
          onChange={(next) => setKind(next)}
          width={variant === 'page' ? 240 : 208}
          height={variant === 'page' ? 32 : 30}
          ariaLabel="版本类型筛选"
          disabled={installing}
        />
        {variant === 'page' && (
          <>
            <span className="text-3" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
              下载源
            </span>
            <SegmentedControl
              options={SOURCE_OPTIONS}
              value={source}
              onChange={(next) => setSource(next)}
              width={210}
              height={32}
              ariaLabel="下载源选择"
              disabled={installing}
            />
          </>
        )}
        <button
          type="button"
          className="focus-ring"
          aria-label="刷新版本清单"
          disabled={loading || installing}
          onClick={() => void loadManifest(kind, source)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            marginLeft: 'auto',
            flex: 'none',
            padding: 0,
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--glass-border)',
            background: 'rgba(255, 255, 255, 0.06)',
            color: 'var(--text-2)',
            cursor: loading || installing ? 'not-allowed' : 'pointer'
          }}
        >
          <RefreshCw size={13} strokeWidth={1.8} />
        </button>
      </div>

      {/* 搜索 */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: variant === 'page' ? 34 : 32,
          padding: '0 12px',
          borderRadius: 'var(--radius-pill)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg-inset)',
          marginBottom: 10
        }}
      >
        <Search size={13} strokeWidth={1.8} style={{ flex: 'none', color: 'var(--text-3)' }} />
        <input
          value={search}
          disabled={installing}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索版本号"
          aria-label="搜索版本号"
          style={{
            flex: 1,
            minWidth: 0,
            height: '100%',
            border: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)'
          }}
        />
      </div>

      {/* 版本列表 */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          paddingRight: 4
        }}
      >
        {loading && (
          <p className="text-3" style={{ padding: 8, fontSize: 'var(--fs-sm)' }}>
            正在获取版本清单…
          </p>
        )}

        {!loading && loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
            <span style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{loadError}</span>
            <button
              type="button"
              className="focus-ring"
              onClick={() => void loadManifest(kind, source)}
              style={{
                height: 26,
                padding: '0 12px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-xs)',
                cursor: 'pointer'
              }}
            >
              重试
            </button>
          </div>
        )}

        {!loading && !loadError && manifest && visibleVersions.length === 0 && (
          <p className="text-3" style={{ padding: 8, fontSize: 'var(--fs-sm)' }}>
            没有匹配的版本
          </p>
        )}

        {!loading &&
          !loadError &&
          visibleVersions.map((version) => {
            const active = version.id === selectedId;
            return (
              <button
                key={version.id}
                type="button"
                disabled={installing}
                onClick={() => setSelectedId(version.id)}
                className={`list-row focus-ring${active ? ' is-selected' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  minHeight: rowHeight,
                  padding: '6px 12px',
                  flex: 'none',
                  border: active ? '1px solid rgba(106, 168, 255, 0.66)' : '1px solid transparent',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-1)',
                  fontFamily: 'var(--font-ui)',
                  textAlign: 'left',
                  cursor: installing ? 'not-allowed' : 'pointer'
                }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    className="num"
                    style={{
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      fontSize: variant === 'page' ? 'var(--fs-md)' : 'var(--fs-sm)'
                    }}
                  >
                    {version.id}
                  </span>
                  <span
                    className="text-3"
                    style={{
                      flex: 'none',
                      padding: '1px 7px',
                      borderRadius: 'var(--radius-pill)',
                      border: '1px solid var(--glass-border)',
                      fontSize: 'var(--fs-xs)'
                    }}
                  >
                    {versionTypeSuffix(version.type)}
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
                  {version.installed && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '1px 7px',
                        borderRadius: 'var(--radius-pill)',
                        border: '1px solid rgba(61, 220, 151, 0.3)',
                        background: 'rgba(61, 220, 151, 0.1)',
                        color: 'var(--success)',
                        fontSize: 'var(--fs-xs)'
                      }}
                    >
                      <Check size={12} strokeWidth={2} />
                      已安装
                    </span>
                  )}
                  <span className="text-3 num" style={{ fontSize: 'var(--fs-xs)' }}>
                    {formatReleaseDate(version.releaseTime)}
                  </span>
                </span>
              </button>
            );
          })}
      </div>

      {/* 底部状态与操作 */}
      <div
        style={{
          flex: 'none',
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}
      >
        {renderStatus()}
        {renderAction()}
      </div>
    </div>
  );
}

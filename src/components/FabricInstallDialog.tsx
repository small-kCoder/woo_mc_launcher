import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Layers, Search } from 'lucide-react';
import Dialog from './Dialog';
import ProgressBar from './ProgressBar';
import SegmentedControl from './SegmentedControl';
import { useLauncher } from '../lib/useLauncher';
import { showToast } from '../lib/toast';
import { formatSpeed } from '../lib/format';
import { toUserMessage } from '../lib/errorText';
import type {
  DownloadSource,
  FabricLoaderInfo,
  InstallProgress,
  ManifestVersion
} from '../types/ipc';

const SOURCE_OPTIONS = [
  { value: 'official' as const, label: '官方' },
  { value: 'channel1' as const, label: '通道1' },
  { value: 'channel2' as const, label: '通道2' }
];

type InstallStatus = 'idle' | 'installing' | 'done' | 'failed' | 'cancelled';

interface InstallState {
  status: InstallStatus;
  percent: number;
  taskText: string;
  bytesPerSecond: number;
  error: string;
}

const IDLE_INSTALL: InstallState = {
  status: 'idle',
  percent: 0,
  taskText: '',
  bytesPerSecond: 0,
  error: ''
};

interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
}

interface DropdownProps {
  label: string;
  value: string;
  options: DropdownOption[];
  loading?: boolean;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  onChange: (value: string) => void;
}

/** 弹窗内下拉：按钮 + 浮层列表，可选搜索，避免原生 select 破坏视觉 */
function Dropdown({
  label,
  value,
  options,
  loading = false,
  disabled = false,
  searchable = false,
  searchPlaceholder = '搜索',
  onChange
}: DropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  const selected = options.find((item) => item.value === value) ?? null;
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? options.filter((item) => item.value.toLowerCase().includes(keyword) || item.label.toLowerCase().includes(keyword))
    : options;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}>{label}</label>
      <button
        type="button"
        className="focus-ring glass-interactive"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || loading}
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          height: 38,
          marginTop: 6,
          padding: '0 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg-inset)',
          color: selected ? 'var(--text-1)' : 'var(--text-3)',
          fontFamily: 'var(--font-ui)',
          fontSize: 'var(--fs-sm)',
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          opacity: disabled || loading ? 0.6 : 1
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? '正在加载…' : selected?.label ?? '请选择'}
        </span>
        <ChevronDown size={14} strokeWidth={1.8} style={{ flex: 'none', color: 'var(--text-3)' }} />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 40,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 190,
            overflow: 'hidden',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--glass-border)',
            background: 'var(--glass-bg-strong)',
            boxShadow: 'var(--glass-shadow)'
          }}
        >
          {searchable && (
            <div
              style={{
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 10px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
              }}
            >
              <Search size={13} strokeWidth={1.8} style={{ color: 'var(--text-3)' }} />
              <input
                value={query}
                autoFocus
                placeholder={searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--text-1)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-xs)'
                }}
              />
            </div>
          )}
          <div style={{ minHeight: 0, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div className="text-3" style={{ padding: '12px 10px', fontSize: 'var(--fs-xs)' }}>
                没有匹配项
              </div>
            )}
            {filtered.slice(0, 200).map((item) => (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={item.value === value}
                onClick={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  height: 32,
                  padding: '0 10px',
                  border: 'none',
                  background: item.value === value ? 'rgba(106, 168, 255, 0.16)' : 'transparent',
                  color: 'var(--text-1)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-xs)',
                  textAlign: 'left',
                  cursor: 'pointer'
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.label}
                </span>
                {item.hint && (
                  <span className="text-3" style={{ flex: 'none', fontSize: 10 }}>
                    {item.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface FabricInstallDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Fabric 在线安装：选择原版版本与 Loader 版本，自动补齐原版并生成继承版本。
 */
export default function FabricInstallDialog({ open, onClose }: FabricInstallDialogProps): JSX.Element {
  const { config, versions, setSelectedVersion } = useLauncher();
  const [manifest, setManifest] = useState<ManifestVersion[] | null>(null);
  const [manifestError, setManifestError] = useState('');
  const [manifestLoading, setManifestLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [source, setSource] = useState<DownloadSource>('official');
  const [mcVersion, setMcVersion] = useState('');
  const [loaders, setLoaders] = useState<FabricLoaderInfo[] | null>(null);
  const [loaderError, setLoaderError] = useState('');
  const [loadersLoading, setLoadersLoading] = useState(false);
  const [loaderVersion, setLoaderVersion] = useState('');
  const [install, setInstall] = useState<InstallState>(IDLE_INSTALL);

  const expectedId =
    mcVersion && loaderVersion ? `${mcVersion}-fabric-${loaderVersion}` : '';
  const expectedIdRef = useRef(expectedId);
  expectedIdRef.current = expectedId;

  useEffect(() => {
    if (!open) {
      return;
    }
    setInstall(IDLE_INSTALL);
    setManifestError('');
    setLoaderError('');
  }, [open]);

  // 版本清单：跟随下载源刷新；默认选中当前版本的基版本或最新正式版
  useEffect(() => {
    if (!open || install.status === 'installing') {
      return;
    }
    const api = window.launcher;
    if (!api) {
      setManifestError('未检测到启动器运行环境');
      return;
    }
    let cancelled = false;
    setManifestLoading(true);
    setManifestError('');
    void api.versions
      .manifest('release', source)
      .then((list) => {
        if (cancelled) {
          return;
        }
        setManifest(list);
        setMcVersion((current) => {
          if (current && list.some((item) => item.id === current)) {
            return current;
          }
          const selected = versions.find((item) => item.id === config?.selectedVersionId);
          const preferred = selected?.baseVersion ?? selected?.id ?? '';
          if (preferred && list.some((item) => item.id === preferred)) {
            return preferred;
          }
          return list[0]?.id ?? '';
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setManifestError(toUserMessage(error, '无法获取版本列表'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setManifestLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, source, reloadToken, install.status, versions, config?.selectedVersionId]);

  // Loader 列表：随所选 MC 版本刷新，默认最新稳定版
  useEffect(() => {
    if (!open || !mcVersion) {
      setLoaders(null);
      setLoaderVersion('');
      return;
    }
    const api = window.launcher;
    if (!api) {
      return;
    }
    let cancelled = false;
    setLoadersLoading(true);
    setLoaderError('');
    void api.fabric
      .loaders(mcVersion)
      .then((list) => {
        if (cancelled) {
          return;
        }
        setLoaders(list);
        setLoaderVersion((current) => {
          if (current && list.some((item) => item.version === current)) {
            return current;
          }
          return list.find((item) => item.stable)?.version ?? list[0]?.version ?? '';
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setLoaders(null);
          setLoaderVersion('');
          setLoaderError(toUserMessage(error, '无法获取 Fabric 版本列表'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadersLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, mcVersion]);

  // 安装进度：只处理当前目标版本，完成后自动选中
  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const off = api.on('install:progress', (payload) => {
      const progress = payload as InstallProgress;
      if (!expectedIdRef.current || progress.versionId !== expectedIdRef.current) {
        return;
      }
      const next: InstallState = {
        status: progress.done
          ? progress.error
            ? 'failed'
            : progress.cancelled
              ? 'cancelled'
              : 'done'
          : 'installing',
        percent: progress.percent,
        taskText: progress.taskText,
        bytesPerSecond: progress.bytesPerSecond ?? 0,
        error: progress.error?.message ?? ''
      };
      setInstall(next);
      if (next.status === 'done') {
        showToast({ type: 'success', message: `Fabric 版本 ${progress.versionId} 安装完成` });
        void setSelectedVersion(progress.versionId);
      }
    });
    return off;
  }, [setSelectedVersion]);

  const installing = install.status === 'installing';
  const canSubmit =
    Boolean(mcVersion && loaderVersion) &&
    !manifestLoading &&
    !loadersLoading &&
    install.status !== 'installing' &&
    install.status !== 'done';

  const startInstall = async (): Promise<void> => {
    const api = window.launcher;
    if (!api || !canSubmit) {
      return;
    }
    setInstall({
      status: 'installing',
      percent: 0,
      taskText: '准备安装',
      bytesPerSecond: 0,
      error: ''
    });
    try {
      await api.fabric.install(mcVersion, loaderVersion, source);
    } catch (error) {
      setInstall({
        status: 'failed',
        percent: 0,
        taskText: '',
        bytesPerSecond: 0,
        error: toUserMessage(error, '启动 Fabric 安装失败')
      });
    }
  };

  const cancelInstall = async (): Promise<void> => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    try {
      await api.versions.cancelInstall();
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '取消安装失败') });
    }
  };

  const mcOptions: DropdownOption[] = (manifest ?? []).map((item) => ({
    value: item.id,
    label: item.id,
    hint: item.installed ? '已安装' : ''
  }));
  const loaderOptions: DropdownOption[] = (loaders ?? []).map((item) => ({
    value: item.version,
    label: item.version,
    hint: item.stable ? '稳定' : ''
  }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="安装 Fabric"
      width="min(460px, 92vw)"
      height={470}
      dismissible={!installing}
    >
      {install.status === 'idle' && (
        <>
          <p className="text-3" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.7 }}>
            选择 Minecraft 原版版本与 Fabric Loader。原版未安装时会先自动补齐，Fabric 版本将与原版共用文件。
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 16 }}>
            <Dropdown
              label="Minecraft 版本"
              value={mcVersion}
              options={mcOptions}
              loading={manifestLoading}
              searchable
              searchPlaceholder="搜索正式版版本"
              onChange={setMcVersion}
            />
            <Dropdown
              label="Fabric Loader"
              value={loaderVersion}
              options={loaderOptions}
              loading={loadersLoading}
              searchable
              searchPlaceholder="搜索 Loader 版本"
              onChange={setLoaderVersion}
            />

            <div>
              <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}>
                原版下载源
              </label>
              <div style={{ marginTop: 6 }}>
                <SegmentedControl
                  options={SOURCE_OPTIONS}
                  value={source}
                  onChange={setSource}
                  width="100%"
                  ariaLabel="原版下载源"
                />
              </div>
            </div>
          </div>

          {(manifestError || loaderError || install.error) && (
            <p style={{ marginTop: 10, color: 'var(--danger)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
              {manifestError || loaderError || install.error}
            </p>
          )}

          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {manifestError ? (
              <button
                type="button"
                className="focus-ring"
                onClick={() => setReloadToken((value) => value + 1)}
                style={{
                  height: 30,
                  padding: '0 14px',
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid var(--glass-border)',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: 'var(--text-2)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-xs)',
                  cursor: 'pointer'
                }}
              >
                重试
              </button>
            ) : (
              <span />
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="focus-ring glass-interactive"
                onClick={onClose}
                style={{
                  height: 32,
                  padding: '0 18px',
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid var(--glass-border)',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: 'var(--text-2)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-sm)',
                  cursor: 'pointer'
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="focus-ring glass-sheen glass-interactive"
                disabled={!canSubmit}
                onClick={() => void startInstall()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 32,
                  padding: '0 22px',
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid rgba(106, 168, 255, 0.4)',
                  background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
                  color: 'var(--text-1)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-sm)',
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                  opacity: canSubmit ? 1 : 0.6
                }}
              >
                <Layers size={14} strokeWidth={1.8} />
                安装
              </button>
            </div>
          </div>
        </>
      )}

      {installing && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ProgressBar value={install.percent} width={320} />
            <span className="num" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-1)' }}>
              {install.percent}%
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
              {install.taskText || '正在安装…'}
            </span>
            {install.bytesPerSecond > 0 && (
              <span className="text-3 num" style={{ fontSize: 'var(--fs-xs)' }}>
                {formatSpeed(install.bytesPerSecond)}
              </span>
            )}
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="focus-ring"
              onClick={() => void cancelInstall()}
              style={{
                height: 32,
                padding: '0 18px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--text-2)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-sm)',
                cursor: 'pointer'
              }}
            >
              取消安装
            </button>
          </div>
        </div>
      )}

      {install.status === 'done' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: '1px solid rgba(77, 208, 143, 0.4)',
              background: 'rgba(77, 208, 143, 0.14)',
              color: 'var(--success)'
            }}
          >
            <Check size={20} strokeWidth={2} />
          </span>
          <span style={{ fontSize: 'var(--fs-md)', color: 'var(--text-1)' }}>Fabric 安装完成</span>
          <span className="text-3 num" style={{ fontSize: 'var(--fs-sm)' }}>
            {expectedId}
          </span>
          <button
            type="button"
            className="focus-ring glass-sheen glass-interactive"
            onClick={onClose}
            style={{
              marginTop: 8,
              height: 32,
              padding: '0 24px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(106, 168, 255, 0.4)',
              background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer'
            }}
          >
            完成
          </button>
        </div>
      )}

      {(install.status === 'failed' || install.status === 'cancelled') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: install.status === 'failed' ? 'var(--danger)' : 'var(--text-2)', lineHeight: 1.6 }}>
            {install.status === 'cancelled' ? '安装已取消' : install.error || 'Fabric 安装失败'}
          </span>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button
              type="button"
              className="focus-ring"
              onClick={() => setInstall(IDLE_INSTALL)}
              style={{
                height: 32,
                padding: '0 18px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--text-2)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-sm)',
                cursor: 'pointer'
              }}
            >
              返回
            </button>
            <button
              type="button"
              className="focus-ring"
              onClick={onClose}
              style={{
                height: 32,
                padding: '0 18px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-sm)',
                cursor: 'pointer'
              }}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

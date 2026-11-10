import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  Download,
  FileArchive,
  FolderOpen,
  Globe,
  Package,
  RefreshCw,
  Search,
  Trash2,
  Upload
} from 'lucide-react';
import Dialog from '../components/Dialog';
import GlassPanel from '../components/ui/GlassPanel';
import ModDetailDialog from '../components/ModDetailDialog';
import OnlineModsDialog from '../components/OnlineModsDialog';
import SegmentedControl from '../components/SegmentedControl';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import { formatFileSize } from '../lib/format';
import { useLauncher } from '../lib/useLauncher';
import type { ModFile, ModsSnapshot } from '../types/ipc';

type ModFilter = 'all' | 'enabled' | 'disabled';

const FILTER_OPTIONS = [
  { value: 'all' as const, label: '全部' },
  { value: 'enabled' as const, label: '已启用' },
  { value: 'disabled' as const, label: '已禁用' }
];

function displayNameOf(mod: ModFile): string {
  return mod.metadata?.name ?? mod.fileName.replace(/\.disabled$/i, '');
}

function matchesKeyword(mod: ModFile, keyword: string): boolean {
  if (!keyword) {
    return true;
  }
  const metadata = mod.metadata;
  return (
    displayNameOf(mod).toLowerCase().includes(keyword) ||
    mod.fileName.toLowerCase().includes(keyword) ||
    (metadata?.id.toLowerCase().includes(keyword) ?? false) ||
    (metadata?.version?.toLowerCase().includes(keyword) ?? false)
  );
}

/**
 * 模组管理：启用/禁用、删除、拖拽导入、Fabric 元数据与缺失依赖提示。
 * 支持按当前版本隔离到 versions/<id>/mods。
 */
export default function ModsPage(): JSX.Element {
  const { config, versions, refreshConfig } = useLauncher();
  const [snapshot, setSnapshot] = useState<ModsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<ModFilter>('all');
  const [search, setSearch] = useState('');
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [detailMod, setDetailMod] = useState<ModFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModFile | null>(null);
  const [isolationPending, setIsolationPending] = useState(false);
  const [installingDeps, setInstallingDeps] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const loadMods = useCallback(async () => {
    const api = window.launcher;
    if (!api) {
      setLoading(false);
      setLoadError('未检测到启动器运行环境');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setSnapshot(await api.mods.list());
    } catch (error) {
      setSnapshot(null);
      setLoadError(toUserMessage(error, '读取模组目录失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMods();
  }, [loadMods, config?.modsIsolated, config?.selectedVersionId]);

  const mods = snapshot?.mods ?? [];
  const enabledCount = mods.filter((mod) => mod.enabled).length;
  const keyword = search.trim().toLowerCase();
  const filteredMods = mods.filter((mod) => {
    if (filter === 'enabled' && !mod.enabled) {
      return false;
    }
    if (filter === 'disabled' && mod.enabled) {
      return false;
    }
    return matchesKeyword(mod, keyword);
  });

  const enabledMissingIds = Array.from(
    new Set(
      mods
        .filter((mod) => mod.enabled)
        .flatMap((mod) => mod.metadata?.missing ?? [])
    )
  );

  const currentVersion = versions.find((item) => item.id === config?.selectedVersionId) ?? null;
  const isFabricVersion =
    currentVersion?.loader === 'fabric' || (currentVersion?.id ?? '').includes('-fabric-');
  const isolated = config?.modsIsolated ?? false;
  const isolatedVersionId = snapshot?.versionId ?? null;

  const runImport = async (paths?: string[]): Promise<void> => {
    const api = window.launcher;
    if (!api || importing) {
      return;
    }
    setImporting(true);
    try {
      const result = await api.mods.import(paths);
      if (result.canceled) {
        return;
      }
      if (result.imported.length > 0) {
        showToast({ type: 'success', message: `已导入 ${result.imported.length} 个模组` });
      }
      if (result.skipped.length > 0) {
        showToast({ type: 'info', message: `${result.skipped.length} 个文件被跳过（仅支持 .jar）` });
      }
      await loadMods();
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '导入模组失败') });
    } finally {
      setImporting(false);
    }
  };

  const handleToggleEnabled = async (mod: ModFile): Promise<void> => {
    const api = window.launcher;
    if (!api || pendingFile) {
      return;
    }
    setPendingFile(mod.fileName);
    try {
      setSnapshot(await api.mods.setEnabled(mod.fileName, !mod.enabled));
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '切换模组状态失败') });
    } finally {
      setPendingFile(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    const api = window.launcher;
    const target = deleteTarget;
    if (!api || !target) {
      return;
    }
    setDeleteTarget(null);
    try {
      setSnapshot(await api.mods.remove(target.fileName));
      showToast({ type: 'success', message: '模组已移入回收站' });
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '删除模组失败') });
    }
  };

  /** 一键安装缺失依赖：Modrinth 自动匹配兼容当前版本的 Fabric 模组并递归安装前置 */
  const handleInstallDependencies = async (ids: string[]): Promise<void> => {
    const api = window.launcher;
    if (!api || installingDeps || ids.length === 0) {
      return;
    }
    setInstallingDeps(true);
    try {
      const result = await api.mods.installDependencies(ids);
      if (result.installed.length > 0) {
        showToast({
          type: 'success',
          message: `已安装 ${result.installed.length} 个依赖：${result.installed
            .slice(0, 3)
            .map((item) => item.name || item.id)
            .join('、')}`
        });
      }
      if (result.failed.length > 0) {
        showToast({
          type: 'info',
          message: `${result.failed.length} 个依赖未能安装：${result.failed
            .slice(0, 3)
            .map((item) => item.id)
            .join('、')}`
        });
      }
      const next = await api.mods.list();
      setSnapshot(next);
      setDetailMod((previous) =>
        previous ? next.mods.find((item) => item.fileName === previous.fileName) ?? null : null
      );
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '安装依赖失败') });
    } finally {
      setInstallingDeps(false);
    }
  };

  const handleOpenFolder = async (): Promise<void> => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    try {
      await api.mods.openFolder();
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '打开模组目录失败') });
    }
  };

  const handleToggleIsolation = async (): Promise<void> => {
    const api = window.launcher;
    if (!api || isolationPending) {
      return;
    }
    setIsolationPending(true);
    try {
      await api.config.update({ modsIsolated: !isolated });
      await refreshConfig();
      await loadMods();
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '切换版本隔离失败') });
    } finally {
      setIsolationPending(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const api = window.launcher;
    if (!api) {
      return;
    }
    const paths: string[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const filePath = api.mods.pathForFile(file);
        if (filePath) {
          paths.push(filePath);
        }
      } catch {
        // 非本地文件时忽略
      }
    }
    if (paths.length === 0) {
      showToast({ type: 'info', message: '未检测到可导入的本地文件' });
      return;
    }
    void runImport(paths);
  };

  const renderList = (): JSX.Element => {
    if (loading) {
      return (
        <p className="text-3" style={{ padding: 8, fontSize: 'var(--fs-sm)' }}>
          正在读取模组列表…
        </p>
      );
    }
    if (loadError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
          <span style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{loadError}</span>
          <button
            type="button"
            className="focus-ring"
            onClick={() => void loadMods()}
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
      );
    }
    if (mods.length === 0) {
      return (
        <div
          style={{
            flex: 1,
            minHeight: 160,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            color: 'var(--text-2)'
          }}
        >
          <Package size={38} strokeWidth={1.4} aria-hidden="true" style={{ opacity: 0.45 }} />
          <span style={{ fontSize: 'var(--fs-md)' }}>还没有模组</span>
          <span className="text-3" style={{ fontSize: 'var(--fs-sm)' }}>
            把 .jar 拖到这里，或点击右上角“导入模组”
          </span>
        </div>
      );
    }
    if (filteredMods.length === 0) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '40px 12px',
            color: 'var(--text-3)'
          }}
        >
          <Search size={24} strokeWidth={1.5} aria-hidden="true" style={{ opacity: 0.5 }} />
          <span style={{ fontSize: 'var(--fs-sm)' }}>没有匹配的模组</span>
          <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
            换个关键词或筛选条件
          </span>
        </div>
      );
    }
    return (
      <>
        {filteredMods.map((mod) => {
          const metadata = mod.metadata;
          const missing = metadata?.missing ?? [];
          return (
            <div
              key={mod.fileName}
              className="list-row"
              role="button"
              tabIndex={0}
              onClick={() => setDetailMod(mod)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setDetailMod(mod);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                minHeight: 52,
                padding: '6px 10px',
                flex: 'none',
                border: '1px solid transparent',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                cursor: 'pointer',
                opacity: mod.enabled ? 1 : 0.58
              }}
            >
              <FileArchive
                size={16}
                strokeWidth={1.7}
                aria-hidden="true"
                style={{ flex: 'none', color: mod.enabled ? 'var(--accent)' : 'var(--text-3)' }}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      fontSize: 'var(--fs-sm)',
                      textDecoration: mod.enabled ? 'none' : 'line-through'
                    }}
                  >
                    {displayNameOf(mod)}
                  </span>
                  {metadata?.version && (
                    <span className="text-3 num" style={{ flex: 'none', fontSize: 10 }}>
                      v{metadata.version}
                    </span>
                  )}
                  {metadata && (
                    <span
                      style={{
                        flex: 'none',
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-pill)',
                        border: '1px solid rgba(106, 168, 255, 0.28)',
                        background: 'var(--accent-soft)',
                        color: 'var(--accent)',
                        fontSize: 10
                      }}
                    >
                      Fabric
                    </span>
                  )}
                  {!mod.enabled && (
                    <span className="text-3" style={{ flex: 'none', fontSize: 10 }}>
                      已禁用
                    </span>
                  )}
                  {missing.length > 0 && (
                    <span
                      style={{
                        flex: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-pill)',
                        border: '1px solid rgba(255, 103, 119, 0.3)',
                        background: 'rgba(255, 103, 119, 0.1)',
                        color: 'var(--danger)',
                        fontSize: 10
                      }}
                      title={`缺少依赖：${missing.join('、')}`}
                    >
                      <AlertTriangle size={10} strokeWidth={2} />
                      缺失依赖 {missing.length}
                    </span>
                  )}
                </div>
                <span
                  className="text-3"
                  title={mod.fileName}
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    fontSize: 10
                  }}
                >
                  {metadata ? `${metadata.id} · ${mod.fileName}` : mod.fileName}
                </span>
              </div>
              <span className="text-3 num" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
                {formatFileSize(mod.size)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={mod.enabled}
                aria-label={mod.enabled ? '禁用模组' : '启用模组'}
                disabled={pendingFile === mod.fileName}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleToggleEnabled(mod);
                }}
                style={{
                  flex: 'none',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: pendingFile === mod.fileName ? 'wait' : 'pointer',
                  opacity: pendingFile === mod.fileName ? 0.6 : 1
                }}
              >
                <span
                  style={{
                    position: 'relative',
                    display: 'block',
                    width: 34,
                    height: 18,
                    borderRadius: 999,
                    border: '1px solid var(--glass-border)',
                    background: mod.enabled ? 'rgba(77, 208, 143, 0.22)' : 'rgba(255, 255, 255, 0.06)',
                    transition: 'background var(--dur-fast) var(--ease-out)'
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      left: mod.enabled ? 18 : 2,
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: mod.enabled ? 'var(--success)' : 'var(--text-3)',
                      transition: 'left var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)'
                    }}
                  />
                </span>
              </button>
              <button
                type="button"
                className="focus-ring"
                aria-label="删除模组"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget(mod);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  flex: 'none',
                  padding: 0,
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: 'var(--text-3)',
                  cursor: 'pointer'
                }}
                title="移入回收站"
              >
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div
      style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', padding: '14px 16px', position: 'relative' }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          dragDepth.current += 1;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      <GlassPanel
        layer="base"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '18px 20px 16px',
          gap: 12
        }}
      >
        <header style={{ flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 600, letterSpacing: '0.02em' }}>模组管理</h1>
            <p
              className="text-3"
              title={snapshot?.directory}
              style={{
                marginTop: 4,
                fontSize: 'var(--fs-xs)',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis'
              }}
            >
              目录：{snapshot?.directory ?? '读取中…'}
            </p>
          </div>

          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
              按版本隔离
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isolated}
              aria-label="切换模组版本隔离"
              disabled={isolationPending}
              onClick={() => void handleToggleIsolation()}
              style={{
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: isolationPending ? 'wait' : 'pointer',
                opacity: isolationPending ? 0.6 : 1
              }}
            >
              <span
                style={{
                  position: 'relative',
                  display: 'block',
                  width: 34,
                  height: 18,
                  borderRadius: 999,
                  border: '1px solid var(--glass-border)',
                  background: isolated ? 'rgba(106, 168, 255, 0.22)' : 'rgba(255, 255, 255, 0.06)',
                  transition: 'background var(--dur-fast) var(--ease-out)'
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: isolated ? 18 : 2,
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: isolated ? 'var(--accent)' : 'var(--text-3)',
                    transition: 'left var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)'
                  }}
                />
              </span>
            </button>
          </div>

          <span
            className="text-3"
            style={{
              flex: 'none',
              padding: '3px 10px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.05)',
              fontSize: 'var(--fs-xs)'
            }}
          >
            已启用 {enabledCount} / {mods.length}
          </span>

          <button
            type="button"
            className="focus-ring"
            aria-label="打开模组目录"
            onClick={() => void handleOpenFolder()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              flex: 'none',
              padding: 0,
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-2)',
              cursor: 'pointer'
            }}
            title="打开模组目录"
          >
            <FolderOpen size={13} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            className="focus-ring"
            aria-label="刷新模组列表"
            disabled={loading || importing}
            onClick={() => void loadMods()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              flex: 'none',
              padding: 0,
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-2)',
              cursor: loading || importing ? 'not-allowed' : 'pointer'
            }}
          >
            <RefreshCw size={13} strokeWidth={1.8} />
          </button>

          {enabledMissingIds.length > 0 && (
            <button
              type="button"
              className="focus-ring glass-interactive"
              disabled={installingDeps}
              onClick={() => void handleInstallDependencies(enabledMissingIds)}
              title={`缺少依赖：${enabledMissingIds.join('、')}`}
              style={{
                flex: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 14px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid rgba(255, 193, 94, 0.4)',
                background: 'rgba(255, 193, 94, 0.12)',
                color: 'var(--warning)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-xs)',
                cursor: installingDeps ? 'wait' : 'pointer',
                opacity: installingDeps ? 0.6 : 1
              }}
            >
              <Download size={13} strokeWidth={1.8} />
              {installingDeps ? '正在安装依赖…' : `一键安装缺失依赖（${enabledMissingIds.length}）`}
            </button>
          )}

          <button
            type="button"
            className="focus-ring glass-interactive"
            onClick={() => setOnlineOpen(true)}
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 14px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-xs)',
              cursor: 'pointer'
            }}
          >
            <Globe size={13} strokeWidth={1.8} />
            在线模组
          </button>

          <button
            type="button"
            className="focus-ring glass-sheen glass-interactive"
            disabled={importing || loading}
            onClick={() => void runImport()}
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 14px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(106, 168, 255, 0.4)',
              background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-xs)',
              cursor: importing || loading ? 'not-allowed' : 'pointer',
              opacity: importing || loading ? 0.6 : 1
            }}
          >
            <Upload size={13} strokeWidth={1.8} />
            {importing ? '正在导入…' : '导入模组'}
          </button>
        </header>

        {isolated && !isolatedVersionId && (
          <div
            className="text-3"
            style={{ flex: 'none', fontSize: 'var(--fs-xs)', color: 'var(--warning)', lineHeight: 1.5 }}
          >
            已开启版本隔离，但当前未选择版本，暂用全局 mods 目录。
          </div>
        )}

        {!isFabricVersion && (
          <div
            style={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--fs-xs)',
              lineHeight: 1.5,
              color: config?.selectedVersionId ? 'var(--warning)' : 'var(--text-3)'
            }}
          >
            <AlertTriangle size={12} strokeWidth={1.8} aria-hidden="true" />
            {config?.selectedVersionId
              ? `当前版本 ${config.selectedVersionId} 不是 Fabric，模组不会生效；请到下载页安装 Fabric 版本。`
              : '当前未选择版本，模组不会生效；请先在启动页选择或安装 Fabric 版本。'}
          </div>
        )}

        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', rowGap: 8 }}>
          <div style={{ position: 'relative', flex: '0 0 220px', minWidth: 160 }}>
            <Search
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-3)'
              }}
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索名称、ID 或版本"
              style={{
                width: '100%',
                height: 30,
                padding: '0 10px 0 30px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'var(--glass-bg-inset)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-xs)',
                outline: 'none'
              }}
            />
          </div>
          <SegmentedControl
            options={FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
            width={210}
            height={30}
            ariaLabel="模组筛选"
          />
          <span className="text-3" style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)' }}>
            显示 {filteredMods.length} 个
          </span>
        </div>

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
          {renderList()}
        </div>

        <div
          className="text-3"
          style={{
            flex: 'none',
            paddingTop: 8,
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 1.5
          }}
        >
          禁用会重命名为 .jar.disabled；删除会移入系统回收站。缺少依赖的模组可能无法正常加载。
        </div>
      </GlassPanel>

      {dragging && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 18,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-lg)',
            border: '1px dashed rgba(106, 168, 255, 0.55)',
            background: 'rgba(8, 16, 34, 0.72)',
            color: 'var(--text-1)',
            fontSize: 'var(--fs-md)',
            pointerEvents: 'none'
          }}
        >
          松开鼠标导入模组
        </div>
      )}

      <ModDetailDialog
        open={Boolean(detailMod)}
        mod={detailMod}
        directory={snapshot?.directory ?? null}
        installing={installingDeps}
        onInstallMissing={(ids) => void handleInstallDependencies(ids)}
        onClose={() => setDetailMod(null)}
      />

      <OnlineModsDialog
        open={onlineOpen}
        onClose={() => setOnlineOpen(false)}
        onChanged={() => void loadMods()}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="删除模组"
        width="min(400px, 90vw)"
        height={210}
      >
        <p className="text-3" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.7 }}>
          将
          <span style={{ color: 'var(--text-1)' }}>
            {deleteTarget ? displayNameOf(deleteTarget) : ''}
          </span>
          移入系统回收站？之后可以从回收站恢复。
        </p>
        <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 12 }}>
          <button
            type="button"
            className="focus-ring glass-interactive"
            onClick={() => setDeleteTarget(null)}
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
            className="focus-ring"
            onClick={() => void handleDelete()}
            style={{
              height: 32,
              padding: '0 20px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(255, 103, 119, 0.4)',
              background: 'rgba(255, 103, 119, 0.16)',
              color: 'var(--danger)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer'
            }}
          >
            删除
          </button>
        </div>
      </Dialog>
    </div>
  );
}

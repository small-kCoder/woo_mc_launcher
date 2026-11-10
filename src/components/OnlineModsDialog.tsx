import { useCallback, useEffect, useState } from 'react';
import { Download, Package, RefreshCw, Search } from 'lucide-react';
import Dialog from './Dialog';
import SegmentedControl from './SegmentedControl';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import type { ModUpdateInfo, OnlineModHit } from '../types/ipc';

type OnlineTab = 'search' | 'updates';

const TAB_OPTIONS = [
  { value: 'search' as const, label: '搜索模组' },
  { value: 'updates' as const, label: '可更新' }
];

/** 下载量展示：超过一万用万/亿单位 */
function formatDownloads(value: number): string {
  if (value >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(1)} 亿`;
  }
  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(1)} 万`;
  }
  return String(value);
}

interface OnlineModsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 安装或更新成功后刷新本地模组列表 */
  onChanged: () => void;
}

/**
 * 在线模组：通过 Modrinth（失败回退 MCIM 镜像）搜索并安装，
 * 自动限定当前游戏版本与 Fabric；同时检测通过启动器安装的模组更新。
 */
export default function OnlineModsDialog({
  open,
  onClose,
  onChanged
}: OnlineModsDialogProps): JSX.Element {
  const [tab, setTab] = useState<OnlineTab>('search');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hits, setHits] = useState<OnlineModHit[]>([]);
  const [total, setTotal] = useState(0);
  const [gameVersion, setGameVersion] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [updates, setUpdates] = useState<ModUpdateInfo[] | null>(null);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updatingFile, setUpdatingFile] = useState<string | null>(null);

  const runSearch = useCallback(
    async (keyword: string, offset: number): Promise<void> => {
      const api = window.launcher;
      if (!api) {
        setError('未检测到启动器运行环境');
        return;
      }
      setLoading(true);
      setError('');
      try {
        const result = await api.mods.searchOnline(keyword, offset);
        setGameVersion(result.gameVersion);
        setTotal(result.total);
        setHits((previous) => (offset === 0 ? result.hits : [...previous, ...result.hits]));
      } catch (searchError) {
        if (offset === 0) {
          setHits([]);
          setTotal(0);
        }
        setError(toUserMessage(searchError, '搜索模组失败'));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const runUpdateCheck = useCallback(async (): Promise<void> => {
    const api = window.launcher;
    if (!api) {
      setError('未检测到启动器运行环境');
      return;
    }
    setUpdatesLoading(true);
    setError('');
    try {
      const result = await api.mods.checkUpdates();
      setUpdates(result.updates);
      setGameVersion(result.gameVersion);
    } catch (checkError) {
      setUpdates([]);
      setError(toUserMessage(checkError, '检查更新失败'));
    } finally {
      setUpdatesLoading(false);
    }
  }, []);

  // 打开时按当前页签加载；关闭后重置，避免展示过期数据
  useEffect(() => {
    if (!open) {
      return;
    }
    setTab('search');
    setQuery('');
    setHits([]);
    setTotal(0);
    setError('');
    setUpdates(null);
    void runSearch('', 0);
  }, [open, runSearch]);

  useEffect(() => {
    if (!open || tab !== 'updates' || updates !== null || updatesLoading) {
      return;
    }
    void runUpdateCheck();
  }, [open, tab, updates, updatesLoading, runUpdateCheck]);

  const handleInstall = async (hit: OnlineModHit): Promise<void> => {
    const api = window.launcher;
    if (!api || installingId) {
      return;
    }
    setInstallingId(hit.projectId);
    try {
      const result = await api.mods.installOnline(hit.projectId);
      if (result.installed.length > 0) {
        showToast({
          type: 'success',
          message: `已安装 ${result.installed[0].name} ${result.installed[0].version}`
        });
        setHits((previous) =>
          previous.map((item) =>
            item.projectId === hit.projectId
              ? { ...item, installedVersion: result.installed[0].version }
              : item
          )
        );
        onChanged();
      }
      if (result.failed.length > 0) {
        showToast({
          type: 'info',
          message: `${result.failed.length} 个前置未能安装：${result.failed
            .slice(0, 3)
            .map((item) => item.id)
            .join('、')}`
        });
      }
    } catch (installError) {
      showToast({ type: 'error', message: toUserMessage(installError, '安装模组失败') });
    } finally {
      setInstallingId(null);
    }
  };

  const handleUpdate = async (update: ModUpdateInfo): Promise<void> => {
    const api = window.launcher;
    if (!api || updatingFile) {
      return;
    }
    setUpdatingFile(update.fileName);
    try {
      const result = await api.mods.updateMod(update.fileName);
      showToast({
        type: 'success',
        message: `已更新 ${update.title} 到 ${result.installed[0]?.version ?? update.latestVersion}`
      });
      setUpdates((previous) => (previous ?? []).filter((item) => item.fileName !== update.fileName));
      onChanged();
    } catch (updateError) {
      showToast({ type: 'error', message: toUserMessage(updateError, '更新模组失败') });
    } finally {
      setUpdatingFile(null);
    }
  };

  const renderSearch = (): JSX.Element => (
    <>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
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
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void runSearch(query, 0);
              }
            }}
            placeholder="搜索模组名称，例如 sodium、iris"
            style={{
              width: '100%',
              height: 32,
              padding: '0 10px 0 30px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'var(--glass-bg-inset)',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              outline: 'none'
            }}
          />
        </div>
        <button
          type="button"
          className="focus-ring glass-interactive"
          disabled={loading}
          onClick={() => void runSearch(query, 0)}
          style={{
            flex: 'none',
            height: 32,
            padding: '0 18px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid rgba(106, 168, 255, 0.4)',
            background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.3), rgba(76, 141, 255, 0.16))',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)',
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1
          }}
        >
          {loading ? '搜索中…' : '搜索'}
        </button>
      </div>

      <div className="text-3" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
        {gameVersion ? `筛选：Minecraft ${gameVersion} · Fabric` : '请先选择游戏版本'}
        {total > 0 ? ` · 共 ${total} 个结果` : ''}
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
        {hits.length === 0 && !loading && (
          <div
            style={{
              flex: 1,
              minHeight: 160,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'var(--text-3)'
            }}
          >
            <Package size={32} strokeWidth={1.4} aria-hidden="true" style={{ opacity: 0.45 }} />
            <span style={{ fontSize: 'var(--fs-sm)' }}>没有结果</span>
            <span style={{ fontSize: 'var(--fs-xs)' }}>换个关键词，或确认当前版本为 Fabric</span>
          </div>
        )}

        {hits.map((hit) => (
          <div
            key={hit.projectId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minHeight: 66,
              padding: '8px 10px',
              flex: 'none',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid transparent',
              background: 'rgba(255, 255, 255, 0.03)'
            }}
            className="list-row"
          >
            <span
              style={{
                flex: 'none',
                width: 38,
                height: 38,
                borderRadius: 10,
                overflow: 'hidden',
                background: 'rgba(255, 255, 255, 0.06)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {hit.iconUrl ? (
                <img
                  src={hit.iconUrl}
                  alt=""
                  width={38}
                  height={38}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  style={{ objectFit: 'cover' }}
                />
              ) : (
                <Package size={18} strokeWidth={1.6} aria-hidden="true" style={{ color: 'var(--text-3)' }} />
              )}
            </span>

            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    fontSize: 'var(--fs-sm)',
                    fontWeight: 600,
                    color: 'var(--text-1)'
                  }}
                >
                  {hit.title}
                </span>
                {hit.installedVersion && (
                  <span
                    style={{
                      flex: 'none',
                      padding: '1px 6px',
                      borderRadius: 'var(--radius-pill)',
                      border: '1px solid rgba(77, 208, 143, 0.3)',
                      background: 'rgba(77, 208, 143, 0.12)',
                      color: 'var(--success)',
                      fontSize: 10
                    }}
                  >
                    已安装 {hit.installedVersion}
                  </span>
                )}
              </div>
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  fontSize: 'var(--fs-xs)',
                  lineHeight: 1.5,
                  color: 'var(--text-3)'
                }}
              >
                {hit.description || '没有简介'}
              </span>
              <span className="text-3 num" style={{ fontSize: 10 }}>
                {hit.author || '未知作者'} · {formatDownloads(hit.downloads)} 次下载
                {hit.categories.length > 0 ? ` · ${hit.categories.join(' / ')}` : ''}
              </span>
            </div>

            <button
              type="button"
              className="focus-ring glass-interactive"
              disabled={installingId !== null}
              onClick={() => void handleInstall(hit)}
              style={{
                flex: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 28,
                padding: '0 14px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid rgba(106, 168, 255, 0.4)',
                background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.3), rgba(76, 141, 255, 0.16))',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-xs)',
                cursor: installingId !== null ? 'not-allowed' : 'pointer',
                opacity: installingId !== null && installingId !== hit.projectId ? 0.5 : 1
              }}
            >
              <Download size={12} strokeWidth={1.8} />
              {installingId === hit.projectId
                ? '安装中…'
                : hit.installedVersion
                  ? '重装'
                  : '安装'}
            </button>
          </div>
        ))}
      </div>

      {hits.length > 0 && hits.length < total && (
        <div style={{ flex: 'none', display: 'flex', justifyContent: 'center', paddingTop: 4 }}>
          <button
            type="button"
            className="focus-ring"
            disabled={loading}
            onClick={() => void runSearch(query, hits.length)}
            style={{
              height: 28,
              padding: '0 18px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-2)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-xs)',
              cursor: loading ? 'wait' : 'pointer'
            }}
          >
            {loading ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </>
  );

  const renderUpdates = (): JSX.Element => (
    <>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="text-3" style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xs)', lineHeight: 1.6 }}>
          仅检测通过启动器安装或更新过的模组；手动放入的 jar 不会出现在这里。
        </span>
        <button
          type="button"
          className="focus-ring"
          aria-label="检查更新"
          disabled={updatesLoading}
          onClick={() => void runUpdateCheck()}
          style={{
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            padding: 0,
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--glass-border)',
            background: 'rgba(255, 255, 255, 0.06)',
            color: 'var(--text-2)',
            cursor: updatesLoading ? 'wait' : 'pointer'
          }}
        >
          <RefreshCw size={13} strokeWidth={1.8} />
        </button>
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
        {updatesLoading && (
          <p className="text-3" style={{ padding: 8, fontSize: 'var(--fs-sm)' }}>
            正在检查更新…
          </p>
        )}
        {!updatesLoading && updates !== null && updates.length === 0 && (
          <div
            style={{
              flex: 1,
              minHeight: 160,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'var(--text-3)'
            }}
          >
            <Package size={32} strokeWidth={1.4} aria-hidden="true" style={{ opacity: 0.45 }} />
            <span style={{ fontSize: 'var(--fs-sm)' }}>没有可更新的模组</span>
            <span style={{ fontSize: 'var(--fs-xs)' }}>
              {gameVersion ? `已按 Minecraft ${gameVersion} 检查` : ''}
            </span>
          </div>
        )}

        {(updates ?? []).map((update) => (
          <div
            key={update.fileName}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minHeight: 56,
              padding: '8px 10px',
              flex: 'none',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid transparent',
              background: 'rgba(255, 255, 255, 0.03)'
            }}
          >
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  fontSize: 'var(--fs-sm)',
                  fontWeight: 600,
                  color: 'var(--text-1)'
                }}
              >
                {update.title}
              </span>
              <span className="text-3 num" style={{ fontSize: 'var(--fs-xs)' }}>
                {update.installedVersion} → {update.latestVersion}
              </span>
            </div>
            <button
              type="button"
              className="focus-ring glass-interactive"
              disabled={updatingFile !== null}
              onClick={() => void handleUpdate(update)}
              style={{
                flex: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 28,
                padding: '0 14px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid rgba(106, 168, 255, 0.4)',
                background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.3), rgba(76, 141, 255, 0.16))',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-xs)',
                cursor: updatingFile !== null ? 'not-allowed' : 'pointer',
                opacity: updatingFile !== null && updatingFile !== update.fileName ? 0.5 : 1
              }}
            >
              <Download size={12} strokeWidth={1.8} />
              {updatingFile === update.fileName ? '更新中…' : '更新'}
            </button>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="在线模组"
      width="min(900px, 94vw)"
      height="min(560px, 88vh)"
      dismissible={installingId === null && updatingFile === null}
    >
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <SegmentedControl
          options={TAB_OPTIONS}
          value={tab}
          onChange={(value) => {
            setTab(value);
            setError('');
          }}
          width={220}
          height={30}
          ariaLabel="在线模组页签"
        />
        <span className="text-3" style={{ marginLeft: 'auto', fontSize: 10 }}>
          数据来源 Modrinth / 国内镜像
        </span>
      </div>

      {error && (
        <p style={{ flex: 'none', marginBottom: 8, color: 'var(--danger)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
          {error}
        </p>
      )}

      {tab === 'search' ? renderSearch() : renderUpdates()}
    </Dialog>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { FileArchive, Package, RefreshCw, Upload } from 'lucide-react';
import GlassPanel from '../components/ui/GlassPanel';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import { formatFileSize, formatReleaseDate } from '../lib/format';
import type { ModFile } from '../types/ipc';

/**
 * 模组管理：仅支持把 .jar 模组文件导入到游戏目录的 mods 文件夹，并列出已导入文件。
 */
export default function ModsPage(): JSX.Element {
  const [mods, setMods] = useState<ModFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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
      const list = await api.mods.list();
      setMods(list);
    } catch (error) {
      setMods(null);
      setLoadError(toUserMessage(error, '读取模组目录失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMods();
  }, [loadMods]);

  const handleImport = async () => {
    const api = window.launcher;
    if (!api || importing) {
      return;
    }
    setImporting(true);
    try {
      const result = await api.mods.import();
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

  const modCount = mods?.length ?? 0;

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', padding: '14px 16px' }}>
      <GlassPanel
        layer="base"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '18px 20px 16px',
          gap: 14
        }}
      >
        <header style={{ flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 600, letterSpacing: '0.02em' }}>模组管理</h1>
            <p className="text-3" style={{ marginTop: 4, fontSize: 'var(--fs-sm)' }}>
              将 .jar 模组导入到游戏目录的 mods 文件夹
            </p>
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
            已导入 {modCount} 个
          </span>
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
          <button
            type="button"
            className="focus-ring glass-sheen glass-interactive"
            disabled={importing || loading}
            onClick={() => void handleImport()}
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 16px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(106, 168, 255, 0.4)',
              background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              cursor: importing || loading ? 'not-allowed' : 'pointer',
              opacity: importing || loading ? 0.6 : 1
            }}
          >
            <Upload size={14} strokeWidth={1.8} />
            {importing ? '正在导入…' : '导入模组'}
          </button>
        </header>

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
              正在读取模组列表…
            </p>
          )}

          {!loading && loadError && (
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
          )}

          {!loading && !loadError && modCount === 0 && (
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
                点击右上角“导入模组”选择 .jar 文件
              </span>
            </div>
          )}

          {!loading &&
            !loadError &&
            (mods ?? []).map((mod) => (
              <div
                key={mod.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  minHeight: 46,
                  padding: '6px 12px',
                  flex: 'none',
                  border: '1px solid transparent',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-1)',
                  fontFamily: 'var(--font-ui)'
                }}
                className="list-row"
              >
                <FileArchive
                  size={16}
                  strokeWidth={1.7}
                  aria-hidden="true"
                  style={{ flex: 'none', color: 'var(--accent)' }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    fontSize: 'var(--fs-sm)'
                  }}
                >
                  {mod.name}
                </span>
                <span className="text-3 num" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
                  {formatFileSize(mod.size)}
                </span>
                <span className="text-3 num" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
                  {formatReleaseDate(mod.modifiedAt)}
                </span>
              </div>
            ))}
        </div>

        <div
          className="text-3"
          style={{
            flex: 'none',
            paddingTop: 10,
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 1.5
          }}
        >
          模组需要对应的模组加载器（Fabric / Forge）才会生效；当前启动器仅支持原版版本。
        </div>
      </GlassPanel>
    </div>
  );
}

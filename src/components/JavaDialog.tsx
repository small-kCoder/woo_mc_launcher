import { useCallback, useEffect, useState } from 'react';
import { Check, FolderOpen } from 'lucide-react';
import Dialog from './Dialog';
import { useLauncher } from '../lib/useLauncher';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import type { JavaInfo } from '../types/ipc';

const SOURCE_LABELS: Record<JavaInfo['source'], string> = {
  config: '手动',
  bundled: '自带',
  system: '系统'
};

interface JavaDialogProps {
  open: boolean;
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return toUserMessage(error, '操作失败，请稍后重试');
}

/**
 * Java 选择弹窗：列出已探测 JVM（路径 / 版本 / 来源），
 * 支持切换当前 Java 与浏览 java.exe。
 */
export default function JavaDialog({ open, onClose }: JavaDialogProps): JSX.Element | null {
  const { java, setJava } = useLauncher();
  const [list, setList] = useState<JavaInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const api = window.launcher;
    if (!api) {
      setError('未检测到启动器运行环境');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.java.list();
      setList(result);
      setSelectedPath((current) => current ?? result[0]?.path ?? null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    setList(null);
    setError(null);
    setSelectedPath(null);
    void loadList();
  }, [open, loadList]);

  const handleUseSelected = async () => {
    const api = window.launcher;
    if (!api || !selectedPath) {
      return;
    }
    setBusy(true);
    try {
      const info = await api.java.set(selectedPath);
      setJava(info);
      showToast({ type: 'success', message: `已切换到 Java ${info.version}` });
      onClose();
    } catch (setError) {
      showToast({ type: 'error', message: errorMessage(setError) });
    } finally {
      setBusy(false);
    }
  };

  const handleBrowse = async () => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    setBusy(true);
    try {
      const info = await api.java.pick();
      if (info) {
        setJava(info);
        showToast({ type: 'success', message: `已切换到 Java ${info.version}` });
        onClose();
      }
    } catch (pickError) {
      showToast({ type: 'error', message: errorMessage(pickError) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="选择 Java" width={520} height={440}>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading && (
          <p className="text-3" style={{ fontSize: 'var(--fs-sm)' }}>
            正在探测可用 Java…
          </p>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{error}</span>
            <button
              type="button"
              className="focus-ring"
              onClick={() => void loadList()}
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

        {!loading && !error && list && list.length === 0 && (
          <p className="text-3" style={{ fontSize: 'var(--fs-sm)' }}>
            未检测到可用的 Java，请浏览选择 java.exe
          </p>
        )}

        {list?.map((item) => {
          const active = item.path === selectedPath;
          return (
            <button
              key={item.path}
              type="button"
              className={`list-row focus-ring${active ? ' is-selected' : ''}`}
              onClick={() => setSelectedPath(item.path)}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 4,
                width: '100%',
                padding: '9px 12px',
                border: '1px solid var(--glass-border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                textAlign: 'left',
                cursor: 'pointer'
              }}
            >
              <span
                title={item.path}
                style={{ gridColumn: '1 / 2', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontSize: 'var(--fs-sm)' }}
              >
                {item.path}
              </span>
              <span className="text-3" style={{ gridColumn: '2 / 3', fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>
                {SOURCE_LABELS[item.source] ?? item.source}
              </span>
              <span className="text-3" style={{ gridColumn: '1 / 2', fontSize: 'var(--fs-xs)' }}>
                {item.version}（Java {item.major}）
              </span>
              {active && (
                <Check
                  size={13}
                  strokeWidth={2}
                  style={{ gridColumn: '2 / 3', gridRow: '2 / 3', color: 'var(--accent)', justifySelf: 'end' }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div
        style={{
          flex: 'none',
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
          当前 Java：{java ? `${java.version}（${SOURCE_LABELS[java.source] ?? java.source}）` : '未检测到'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="focus-ring"
            disabled={busy}
            onClick={() => void handleBrowse()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 14px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            <FolderOpen size={14} strokeWidth={1.8} />
            浏览 java.exe
          </button>
          <button
            type="button"
            className="focus-ring glass-sheen glass-interactive"
            disabled={busy || !selectedPath}
            onClick={() => void handleUseSelected()}
            style={{
              marginLeft: 'auto',
              height: 32,
              padding: '0 18px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(106, 168, 255, 0.4)',
              background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              cursor: busy || !selectedPath ? 'not-allowed' : 'pointer'
            }}
          >
            使用该 Java
          </button>
        </div>
      </div>
    </Dialog>
  );
}

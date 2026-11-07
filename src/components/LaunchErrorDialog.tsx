import { useCallback, useEffect, useRef, useState } from 'react';
import { Coffee, FolderOpen, RotateCcw } from 'lucide-react';
import Dialog from './Dialog';
import JavaDialog from './JavaDialog';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import type { LaunchState } from '../types/ipc';

/** 失败对话框展示的日志行数 */
const LOG_TAIL_LINES = 20;

interface LaunchErrorDialogProps {
  /** 失败事件缺少 versionId 时用于重试的兜底版本 */
  fallbackVersionId?: string | null;
}

const SECONDARY_BUTTON_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 32,
  padding: '0 14px',
  borderRadius: 'var(--radius-pill)',
  border: '1px solid var(--glass-border)',
  background: 'rgba(255, 255, 255, 0.06)',
  color: 'var(--text-1)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer'
} as const;

/**
 * 启动失败对话框：订阅 launch:state，仅在进入 failed 时自动弹出一次。
 * 提供查看日志、选择 Java（复用 JavaDialog）与重试；关闭后本地忽略，不重复弹窗。
 */
export default function LaunchErrorDialog({ fallbackVersionId }: LaunchErrorDialogProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [failedState, setFailedState] = useState<LaunchState | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [javaOpen, setJavaOpen] = useState(false);

  const lastPhaseRef = useRef<LaunchState['phase'] | null>(null);
  const dismissedRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    const off = api.on('launch:state', (payload) => {
      const state = payload as LaunchState;
      const previous = lastPhaseRef.current;
      lastPhaseRef.current = state.phase;

      if (state.phase !== 'failed') {
        // 重试或重新启动时关闭失败对话框
        if (openRef.current && state.phase === 'preparing') {
          setOpen(false);
        }
        return;
      }
      // 同一失败状态的重复广播不再弹窗；关闭后保持本地忽略
      if (previous === 'failed' && dismissedRef.current) {
        return;
      }
      dismissedRef.current = false;
      setFailedState(state);
      setOpen(true);
      const tail = state.error?.logTail;
      if (Array.isArray(tail) && tail.length > 0) {
        setLogLines(tail.slice(-LOG_TAIL_LINES));
        return;
      }
      // 早期失败（版本不存在等）没有日志尾部，回退到主进程最近日志
      void api
        .readLogTail(LOG_TAIL_LINES)
        .then((lines) => setLogLines(Array.isArray(lines) ? lines.slice(-LOG_TAIL_LINES) : []))
        .catch(() => setLogLines([]));
    });
    return off;
  }, []);

  const handleClose = useCallback(() => {
    dismissedRef.current = true;
    setOpen(false);
  }, []);

  const handleViewLogs = () => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    void api.openLogsFolder().catch((error: unknown) => {
      showToast({ type: 'error', message: toUserMessage(error, '无法打开日志目录') });
    });
  };

  const handleChooseJava = () => {
    dismissedRef.current = true;
    setOpen(false);
    setJavaOpen(true);
  };

  const handleJavaClose = () => {
    setJavaOpen(false);
    // 选择完 Java 后回到失败对话框，便于直接重试
    setOpen(true);
  };

  const handleRetry = () => {
    const api = window.launcher;
    const versionId = failedState?.versionId ?? fallbackVersionId ?? null;
    if (!api || !versionId) {
      showToast({ type: 'error', message: '无法确定要重试的版本' });
      return;
    }
    dismissedRef.current = true;
    setOpen(false);
    // 让下一次 failed 事件即使紧随其后也能重新弹出
    lastPhaseRef.current = 'preparing';
    void api.launch(versionId).catch((error: unknown) => {
      showToast({ type: 'error', message: toUserMessage(error, '启动失败，请稍后重试') });
    });
  };

  const reason = failedState?.error?.message || failedState?.detailText || '启动过程出现异常';

  return (
    <>
      <Dialog open={open} onClose={handleClose} title="启动失败" width={520} height={380}>
        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p
            role="alert"
            style={{
              flex: 'none',
              color: 'var(--danger)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              lineHeight: 1.6,
              wordBreak: 'break-word'
            }}
          >
            {reason}
          </p>

          <span className="text-3" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
            最近 {LOG_TAIL_LINES} 行日志
          </span>
          <div
            aria-label="启动日志"
            style={{
              flex: '0 0 120px',
              minHeight: 120,
              maxHeight: 120,
              height: 120,
              overflowY: 'auto',
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              background: 'rgba(5, 9, 17, 0.58)',
              color: 'var(--text-2)',
              fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 'var(--fs-xs)',
              lineHeight: 1.5,
              userSelect: 'text'
            }}
          >
            {logLines.length > 0 ? (
              logLines.map((line, index) => (
                <div key={`${index}-${line}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {line}
                </div>
              ))
            ) : (
              <span className="text-3">暂无日志内容</span>
            )}
          </div>

          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto' }}>
            <button type="button" className="focus-ring" style={SECONDARY_BUTTON_STYLE} onClick={handleViewLogs}>
              <FolderOpen size={14} strokeWidth={1.8} />
              查看日志
            </button>
            <button type="button" className="focus-ring" style={SECONDARY_BUTTON_STYLE} onClick={handleChooseJava}>
              <Coffee size={14} strokeWidth={1.8} />
              选择 Java
            </button>
            <button
              type="button"
              className="focus-ring glass-sheen glass-interactive"
              disabled={!(failedState?.versionId ?? fallbackVersionId)}
              onClick={handleRetry}
              style={{
                marginLeft: 'auto',
                height: 32,
                padding: '0 20px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid rgba(106, 168, 255, 0.4)',
                background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-sm)',
                cursor: failedState?.versionId ?? fallbackVersionId ? 'pointer' : 'not-allowed'
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RotateCcw size={14} strokeWidth={1.8} />
                重试
              </span>
            </button>
            <button type="button" className="focus-ring" style={SECONDARY_BUTTON_STYLE} onClick={handleClose}>
              关闭
            </button>
          </div>
        </div>
      </Dialog>

      <JavaDialog open={javaOpen} onClose={handleJavaClose} />
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { formatDuration, formatSpeed } from '../lib/format';
import type { LaunchState } from '../types/ipc';

interface LaunchButtonProps {
  state: LaunchState;
  /** 由页面层判断：无版本或无可用账户时禁用 */
  disabled?: boolean;
  /** idle 状态下的文案：无版本/无账户时显示“请先安装版本 / 请先登录” */
  idleText?: string;
  onClick: () => void;
  onCancel?: () => void;
}

/** 启动中阶段：按钮禁用，且不可再次触发启动 */
const BUSY_PHASES: readonly LaunchState['phase'][] = ['preparing', 'downloading', 'launching', 'running'];

/** 主标题与副标题随启动状态机变化 */
function resolveContent(
  state: LaunchState,
  idleText: string,
  elapsedMs: number
): { title: string; subtitle: string } {
  const percent = Math.round(Math.max(0, Math.min(100, state.percent)));
  switch (state.phase) {
    case 'preparing':
      // [原代码]: return { title: '正在准备…', subtitle: '正在检查游戏文件' };
      return { title: '正在准备…', subtitle: state.detailText || '正在检查游戏文件' };
    case 'downloading': {
      // [原代码]: return { title: `正在补全 ${percent}%`, subtitle: '完成后将自动继续启动' };
      const speed = formatSpeed(state.bytesPerSecond);
      return { title: `正在补全 ${percent}%`, subtitle: speed ? `下载速度 ${speed}` : '完成后将自动继续启动' };
    }
    case 'launching':
      // [原代码]: return { title: `正在启动 ${percent}%`, subtitle: '等待游戏窗口出现' };
      return { title: `正在启动 ${percent}%`, subtitle: state.detailText || '等待游戏窗口出现' };
    case 'running':
      return { title: '游戏运行中', subtitle: formatDuration(elapsedMs) };
    case 'failed':
      return { title: '启动游戏', subtitle: '上次启动失败，可重新尝试' };
    case 'exited':
      return { title: '启动游戏', subtitle: '游戏已退出' };
    default:
      return { title: idleText, subtitle: state.taskText || '准备就绪' };
  }
}

/**
 * 大启动按钮：320×76，主色渐变玻璃；hover 高光扫过并轻微上浮。
 * 下载阶段在按钮右侧浮出小号“取消”按钮。
 */
export default function LaunchButton({
  state,
  disabled = false,
  idleText = '启动游戏',
  onClick,
  onCancel
}: LaunchButtonProps): JSX.Element {
  const busy = BUSY_PHASES.includes(state.phase);
  const isRunning = state.phase === 'running';
  const [now, setNow] = useState(() => Date.now());
  // running 开始时记录起点，避免事件缺失 startedAt 时计时随每次渲染归零
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isRunning) {
      startedAtRef.current = null;
      return;
    }
    startedAtRef.current = state.startedAt ?? Date.now();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, state.startedAt]);

  const elapsed = isRunning && startedAtRef.current !== null ? now - startedAtRef.current : 0;
  const { title, subtitle } = resolveContent(state, idleText, elapsed);
  const buttonDisabled = disabled || busy;
  // 仅“无账户/无版本”的禁用需要弱化视觉；启动中禁用仍保留进度观感
  const weakDisabled = disabled && !busy;
  const showCancel = state.phase === 'downloading' && onCancel !== undefined;
  const buttonBackground = weakDisabled
    ? 'rgba(255, 255, 255, 0.06)'
    : 'linear-gradient(180deg, rgba(106, 168, 255, 0.56), rgba(76, 141, 255, 0.3))';

  return (
    <div style={{ width: 320, flex: 'none' }}>
      <div style={{ position: 'relative', width: 320, height: 76 }}>
        <button
          type="button"
          disabled={buttonDisabled}
          aria-busy={busy}
          onClick={onClick}
          className={`launch-button focus-ring glass-sheen${buttonDisabled ? '' : ' glass-interactive'}`}
          style={{
            position: 'relative',
            width: 320,
            height: 76,
            padding: 0,
            overflow: 'hidden',
            borderRadius: 'var(--radius-lg)',
            border: weakDisabled
              ? '1px solid rgba(255, 255, 255, 0.12)'
              : '1px solid rgba(255, 255, 255, 0.24)',
            // [原代码]: background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.56), rgba(76, 141, 255, 0.3))',
            background: buttonBackground,
            boxShadow: weakDisabled
              ? 'inset 0 1px 0 rgba(255, 255, 255, 0.1)'
              : '0 18px 38px rgba(2, 6, 16, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
            // [原代码]: color: 'var(--text-1)',
            color: weakDisabled ? 'var(--text-3)' : 'var(--text-1)',
            fontFamily: 'var(--font-ui)',
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: '0.06em',
            cursor: buttonDisabled ? 'not-allowed' : 'pointer',
            // [原代码]: opacity: disabled && !busy ? 0.55 : 1
            opacity: weakDisabled ? 0.8 : 1,
            filter: weakDisabled ? 'saturate(0.35)' : undefined
          }}
        >
          <span style={{ position: 'relative', zIndex: 1 }}>{title}</span>
        </button>

        {showCancel && (
          <button
            type="button"
            className="focus-ring"
            onClick={onCancel}
            style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 2,
              height: 24,
              padding: '0 10px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(255, 255, 255, 0.24)',
              background: 'rgba(5, 9, 17, 0.42)',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-xs)',
              cursor: 'pointer'
            }}
          >
            取消
          </button>
        )}
      </div>

      <div
        className="text-3"
        style={{
          height: 16,
          marginTop: 4,
          textAlign: 'center',
          fontSize: 'var(--fs-sm)',
          lineHeight: '16px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {subtitle}
      </div>
    </div>
  );
}

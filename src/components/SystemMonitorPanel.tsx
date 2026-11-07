import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import GlassPanel from './ui/GlassPanel';
import { useLauncher } from '../lib/useLauncher';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import { formatFileSize } from '../lib/format';
import type { MemoryOptimizeResult, SystemStats } from '../types/ipc';

interface GaugeProps {
  label: string;
  percent: number;
  gradientId: string;
  detail?: string;
}

/** 半圆弧仪表：轨道半透明，进度使用蓝到青的线性渐变 */
const GAUGE_RADIUS = 46;
const GAUGE_LENGTH = Math.PI * GAUGE_RADIUS;

function Gauge({ label, percent, gradientId, detail }: GaugeProps): JSX.Element {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, textAlign: 'center' }}>
      <svg
        viewBox="0 0 120 86"
        width="100%"
        style={{ display: 'block', maxWidth: 120, margin: '0 auto' }}
        aria-label={`${label} ${percent}%`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--accent)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--aurora-teal)' }} />
          </linearGradient>
        </defs>
        <path
          d="M 14 72 A 46 46 0 0 1 106 72"
          fill="none"
          stroke="rgba(255, 255, 255, 0.12)"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d="M 14 72 A 46 46 0 0 1 106 72"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${GAUGE_LENGTH} ${GAUGE_LENGTH}`}
          strokeDashoffset={GAUGE_LENGTH * (1 - Math.max(0, Math.min(100, percent)) / 100)}
          style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }}
        />
        <text
          x="60"
          y="58"
          textAnchor="middle"
          fill="var(--text-1)"
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 17,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {percent}%
        </text>
      </svg>
      <span
        className="text-3"
        style={{ display: 'block', marginTop: -6, fontSize: 'var(--fs-xs)' }}
      >
        {label}
      </span>
      {detail && (
        <span
          className="text-3 num"
          style={{ display: 'block', marginTop: 1, fontSize: 'var(--fs-xs)', opacity: 0.75 }}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

/** 判断事件数据是否是合法的资源占用对象 */
function isSystemStats(value: unknown): value is SystemStats {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const stats = value as Record<string, unknown>;
  return (
    typeof stats.cpuPercent === 'number' &&
    typeof stats.memoryPercent === 'number' &&
    typeof stats.usedBytes === 'number' &&
    typeof stats.totalBytes === 'number'
  );
}

/**
 * 资源监视面板：实时 CPU / 内存占用（主进程每秒推送），
 * 下方“内存优化”按钮用于开启启动游戏前的自动内存优化。
 */
export default function SystemMonitorPanel(): JSX.Element {
  const { config, refreshConfig } = useLauncher();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [optimizing, setOptimizing] = useState(false);

  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    let disposed = false;
    void api.system
      .stats()
      .then((value) => {
        if (!disposed && isSystemStats(value)) {
          setStats(value);
        }
      })
      .catch(() => undefined);
    const off = api.on('system:stats', (payload) => {
      if (isSystemStats(payload)) {
        setStats(payload);
      }
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const enabled = config?.memoryOptimizeOnLaunch ?? false;
  const cpuPercent = stats?.cpuPercent ?? 0;
  const memoryPercent = stats?.memoryPercent ?? 0;
  const memoryDetail =
    stats && stats.totalBytes > 0
      ? `${formatFileSize(stats.usedBytes)} / ${formatFileSize(stats.totalBytes)}`
      : undefined;

  const handleToggle = async () => {
    const api = window.launcher;
    if (!api || optimizing) {
      return;
    }
    const next = !enabled;
    setOptimizing(true);
    try {
      await api.config.update({ memoryOptimizeOnLaunch: next });
      await refreshConfig();
      if (next) {
        const result: MemoryOptimizeResult = await api.system.optimize();
        showToast({
          type: 'success',
          message: `内存优化完成，释放 ${formatFileSize(result.freedBytes)}`
        });
      } else {
        showToast({ type: 'info', message: '已关闭启动时自动内存优化' });
      }
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, '内存优化失败') });
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <GlassPanel
      layer="base"
      style={{
        height: 268,
        flex: 'none',
        padding: 14,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>资源监视</h2>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 9px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid rgba(61, 220, 151, 0.3)',
            background: 'rgba(61, 220, 151, 0.1)',
            color: 'var(--success)',
            fontSize: 'var(--fs-xs)'
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--success)' }}
          />
          实时
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Gauge label="CPU" percent={cpuPercent} gradientId="gauge-cpu" />
        <Gauge label="内存" percent={memoryPercent} gradientId="gauge-memory" detail={memoryDetail} />
      </div>

      <button
        type="button"
        className={`focus-ring${optimizing ? '' : ' glass-interactive'}`}
        disabled={optimizing}
        onClick={() => void handleToggle()}
        style={{
          marginTop: 'auto',
          height: 30,
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          borderRadius: 'var(--radius-pill)',
          border: enabled ? '1px solid rgba(106, 168, 255, 0.5)' : '1px solid var(--glass-border)',
          background: enabled
            ? 'linear-gradient(180deg, rgba(106, 168, 255, 0.26), rgba(76, 141, 255, 0.14))'
            : 'rgba(255, 255, 255, 0.06)',
          color: enabled ? 'var(--text-1)' : 'var(--text-2)',
          fontFamily: 'var(--font-ui)',
          fontSize: 'var(--fs-sm)',
          cursor: optimizing ? 'not-allowed' : 'pointer',
          opacity: optimizing ? 0.7 : 1
        }}
      >
        <Zap size={13} strokeWidth={1.8} aria-hidden="true" />
        {optimizing ? '正在优化…' : enabled ? '内存优化 · 已开启' : '内存优化'}
      </button>
      <span
        className="text-3"
        style={{ display: 'block', marginTop: 5, textAlign: 'center', fontSize: 'var(--fs-xs)' }}
      >
        {enabled ? '启动游戏前自动优化，可能延长启动时间' : '点击开启，启动游戏时自动优化内存'}
      </span>
    </GlassPanel>
  );
}

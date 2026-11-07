import { motion } from 'framer-motion';

interface ProgressBarProps {
  /** 0-100；null 表示不确定态（缓慢移动的条纹） */
  value: number | null;
  /** false 时整体透明（idle） */
  active?: boolean;
  width?: number;
}

const STRIPES =
  'repeating-linear-gradient(115deg, var(--accent) 0 7px, rgba(255, 255, 255, 0.36) 7px 14px)';

/**
 * 进度条：320×8 轨道 + 斜纹填充。
 * 确定态仅用 scaleX 过渡；不确定态让条纹层平移，不触发布局。
 */
export default function ProgressBar({ value, active = true, width = 320 }: ProgressBarProps): JSX.Element {
  const clamped = value === null ? null : Math.max(0, Math.min(100, value));

  return (
    <div
      aria-hidden={!active}
      style={{
        position: 'relative',
        width,
        height: 8,
        flex: 'none',
        overflow: 'hidden',
        borderRadius: 'var(--radius-pill)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        background: 'var(--glass-bg-inset)',
        opacity: active ? 1 : 0,
        transition: 'opacity var(--dur-fast) var(--ease-out)'
      }}
    >
      {clamped === null ? (
        active && (
          <motion.div
            initial={{ x: '-120%' }}
            animate={{ x: '320%' }}
            transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '40%',
              borderRadius: 'var(--radius-pill)',
              background: STRIPES,
              willChange: 'transform'
            }}
          />
        )
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'var(--radius-pill)',
            background: STRIPES,
            transform: `scaleX(${clamped / 100})`,
            transformOrigin: 'left center',
            transition: 'transform var(--dur-base) var(--ease-out)'
          }}
        />
      )}
    </div>
  );
}

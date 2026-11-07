import { useId } from 'react';
import { motion } from 'framer-motion';
import { SPRING } from '../lib/motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  width?: number | string;
  height?: number;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * 通用玻璃分段控件：受控，滑块用 layoutId 在同一实例内平滑滑动。
 * 不添加 backdrop-filter，避免叠加模糊层。
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  width = 220,
  height = 34,
  ariaLabel = '分段选择',
  disabled = false
}: SegmentedControlProps<T>): JSX.Element {
  const layoutId = `segmented-slider-${useId()}`;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        display: 'flex',
        width: typeof width === 'number' ? `${width}px` : width,
        height,
        padding: 3,
        flex: 'none',
        borderRadius: 'var(--radius-pill)',
        border: '1px solid var(--glass-border)',
        background: 'var(--glass-bg)',
        boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.28)',
        opacity: disabled ? 0.55 : 1
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            className="focus-ring"
            onClick={() => {
              if (!disabled && option.value !== value) {
                onChange(option.value);
              }
            }}
            style={{
              position: 'relative',
              zIndex: 1,
              flex: '1 1 0',
              minWidth: 0,
              padding: 0,
              border: 0,
              borderRadius: 'var(--radius-pill)',
              background: 'transparent',
              color: active ? 'var(--text-1)' : 'var(--text-3)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-sm)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              transition: 'color var(--dur-fast) var(--ease-out)'
            }}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                initial={false}
                transition={SPRING}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: -1,
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid rgba(106, 168, 255, 0.34)',
                  background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.26), rgba(106, 168, 255, 0.12))',
                  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)'
                }}
              />
            )}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

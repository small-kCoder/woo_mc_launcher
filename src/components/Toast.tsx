import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { DURATIONS, EASE_OUT_CURVE } from '../lib/motion';
import { subscribeToasts, type ToastItem, type ToastType } from '../lib/toast';

const TOAST_COLORS: Record<ToastType, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  info: 'var(--accent)'
};

const TOAST_ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info
} as const;

/**
 * 全局 Toast 堆叠：底部居中，最多 3 条。
 * 面板使用 --glass-bg-strong 而无 backdrop-filter，避免叠加模糊层。
 */
export default function Toast(): JSX.Element | null {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  return createPortal(
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 20,
        zIndex: 'var(--z-toast)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none'
      }}
    >
      <AnimatePresence initial={false}>
        {items.map((item) => {
          const Icon = TOAST_ICONS[item.type];
          return (
            <motion.div
              key={item.id}
              role="status"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: DURATIONS.base, ease: EASE_OUT_CURVE }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                maxWidth: 420,
                padding: '9px 16px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border-strong)',
                background: 'var(--glass-bg-strong)',
                boxShadow: 'var(--glass-shadow)',
                color: 'var(--text-1)',
                fontSize: 'var(--fs-sm)',
                pointerEvents: 'auto'
              }}
            >
              <Icon size={15} strokeWidth={1.9} style={{ flex: 'none', color: TOAST_COLORS[item.type] }} />
              <span>{item.message}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>,
    document.body
  );
}

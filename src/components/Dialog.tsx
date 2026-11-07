import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { DURATIONS, EASE_OUT_CURVE } from '../lib/motion';

/** 可聚焦元素选择器：用于最小焦点陷阱 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  /** 关闭回调；遮罩点击、关闭按钮与 Esc 均触发 */
  onClose: () => void;
  title: string;
  width?: number | string;
  height?: number | string;
  /** 是否允许通过遮罩 / Esc / 关闭按钮关闭；安装中传 false */
  dismissible?: boolean;
  children: ReactNode;
}

/**
 * 通用弹窗容器：深色遮罩（无模糊）+ 居中玻璃面板，
 * 打开时聚焦面板、Tab 不逃逸，关闭后还原焦点。
 */
export default function Dialog({
  open,
  onClose,
  title,
  width = 560,
  height = 440,
  dismissible = true,
  children
}: DialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  // 兜底卸载：极端情况下退场动画的回调可能不触发，超时后强制移除 portal，避免透明遮罩残留
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), 340);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 等面板挂载后再聚焦，避免 focus 丢失
    const timer = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      previous?.focus();
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (!dismissible) {
        return;
      }
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement
    );
    if (nodes.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey) {
      if (document.activeElement === first || document.activeElement === panel) {
        event.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open && !mounted) {
    return null;
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: DURATIONS.fast, ease: EASE_OUT_CURVE }}
          onMouseDown={(event) => {
            if (dismissible && event.target === event.currentTarget) {
              onClose();
            }
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 'var(--z-dialog)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            // [原代码]: background: 'rgba(2, 6, 16, 0.62)'
            background: 'var(--overlay-bg)'
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            className="glass-dialog"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: DURATIONS.base, ease: EASE_OUT_CURVE }}
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              width: typeof width === 'number' ? `${width}px` : width,
              height: typeof height === 'number' ? `${height}px` : height,
              maxWidth: '92vw',
              maxHeight: '88vh',
              overflow: 'hidden',
              outline: 'none',
              borderRadius: 'var(--radius-lg)'
              // [原代码]: border: '1px solid var(--glass-border-strong)'
              // [原代码]: background: 'var(--glass-bg-strong)'
              // [原代码]: boxShadow: 'var(--glass-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
            }}
          >
            <header
              style={{
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '14px 18px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
              }}
            >
              <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>{title}</h2>
              {dismissible && (
                <button
                  type="button"
                  className="focus-ring"
                  aria-label="关闭弹窗"
                  onClick={onClose}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    padding: 0,
                    border: '1px solid transparent',
                    borderRadius: 'var(--radius-xs)',
                    background: 'transparent',
                    color: 'var(--text-2)',
                    cursor: 'pointer'
                  }}
                >
                  <X size={15} strokeWidth={2} />
                </button>
              )}
            </header>

            <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', padding: 18 }}>
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

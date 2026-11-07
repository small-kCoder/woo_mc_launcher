import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { DURATIONS, EASE_OUT_CURVE } from '../lib/motion';
import { versionTypeSuffix } from '../lib/format';
import type { JavaInfo, VersionSummary } from '../types/ipc';

interface VersionSelectProps {
  versions: VersionSummary[];
  selectedId: string | null;
  java: JavaInfo | null;
  onSelect: (versionId: string) => void;
  onInstall: () => void;
  disabled?: boolean;
}

/**
 * 版本选择器：260×34 玻璃胶囊，点击展开已安装版本浮层。
 * 浮层无 backdrop-filter，Esc 或点击外部关闭。
 */
export default function VersionSelect({
  versions,
  selectedId,
  java,
  onSelect,
  onInstall,
  disabled = false
}: VersionSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selected = versions.find((item) => item.id === selectedId) ?? null;

  return (
    <div ref={rootRef} style={{ position: 'relative', width: 260, flex: 'none' }}>
      <button
        type="button"
        className="focus-ring"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: 260,
          height: 34,
          padding: '0 12px',
          borderRadius: 'var(--radius-pill)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg)',
          color: selected ? 'var(--text-1)' : 'var(--text-3)',
          fontFamily: 'var(--font-ui)',
          fontSize: 'var(--fs-sm)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            title={selected?.id ?? undefined}
            style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
          >
            {selected ? `${selected.id} ${versionTypeSuffix(selected.type)}` : '未安装任何版本'}
          </span>
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          style={{
            flex: 'none',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform var(--dur-base) var(--ease-out)'
          }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            className="glass-flyout"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: DURATIONS.base, ease: EASE_OUT_CURVE }}
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: 0,
              zIndex: 30,
              width: 260,
              maxHeight: 232,
              overflowY: 'auto',
              padding: 6,
              borderRadius: 'var(--radius-md)'
              // [原代码]: border: '1px solid var(--glass-border-strong)'
              // [原代码]: background: 'linear-gradient(var(--glass-bg-strong), var(--glass-bg-strong)), var(--glass-bg-inset)'
              // [原代码]: boxShadow: 'var(--glass-shadow)'
            }}
          >
            {versions.length === 0 ? (
              <p className="text-3" style={{ padding: '10px 8px', fontSize: 'var(--fs-sm)' }}>
                未安装任何版本
              </p>
            ) : (
              versions.map((version) => {
                const active = version.id === selectedId;
                const javaLabel = version.javaMajor
                  ? `Java ${version.javaMajor}`
                  : java
                    ? `Java ${java.version}`
                    : '';
                return (
                  <button
                    key={version.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`list-row focus-ring${active ? ' is-selected' : ''}`}
                    onClick={() => {
                      onSelect(version.id);
                      setOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 8px',
                      border: '1px solid transparent',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text-1)',
                      fontFamily: 'var(--font-ui)',
                      fontSize: 'var(--fs-sm)',
                      textAlign: 'left',
                      cursor: 'pointer'
                    }}
                  >
                    <span style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis'
                        }}
                      >
                        {version.id}
                      </span>
                      <span className="text-3" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
                        {versionTypeSuffix(version.type)}
                      </span>
                    </span>
                    {javaLabel && (
                      <span className="text-3" style={{ flex: 'none', fontSize: 'var(--fs-xs)' }}>
                        {javaLabel}
                      </span>
                    )}
                    {active && <Check size={13} strokeWidth={2} style={{ flex: 'none', color: 'var(--accent)' }} />}
                  </button>
                );
              })
            )}

            <hr className="hairline" style={{ margin: '6px 0' }} />

            <button
              type="button"
              className="list-row focus-ring"
              onClick={() => {
                setOpen(false);
                onInstall();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px',
                border: 0,
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-2)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-sm)',
                textAlign: 'left',
                cursor: 'pointer'
              }}
            >
              <Plus size={14} strokeWidth={1.8} />
              安装新版本
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useEffect, useRef, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, LogIn, UserPlus } from 'lucide-react';
import AccountAvatar from './AccountAvatar';
import { DURATIONS, EASE_OUT_CURVE } from '../lib/motion';
import type { AccountMode, AccountSummary } from '../types/ipc';

interface AccountMenuProps {
  open: boolean;
  mode: AccountMode;
  accounts: AccountSummary[];
  activeId: string | null;
  /** 触发区域（输入框容器），点击该区域不触发“点击外部关闭” */
  anchorRef?: RefObject<HTMLElement>;
  onSelect: (accountId: string) => void;
  onCreateOffline: () => void;
  onLogin: () => void;
  onClose: () => void;
}

/**
 * 账户下拉浮层：当前模式下已保存账户列表 + 底部新建/登录入口。
 * 无 backdrop-filter，样式与版本浮层一致。
 */
export default function AccountMenu({
  open,
  mode,
  accounts,
  activeId,
  anchorRef,
  onSelect,
  onCreateOffline,
  onLogin,
  onClose
}: AccountMenuProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef?.current?.contains(target)) {
        return;
      }
      if (rootRef.current && !rootRef.current.contains(target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  return (
    <div ref={rootRef}>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="glass-flyout"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: DURATIONS.base, ease: EASE_OUT_CURVE }}
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: 0,
              zIndex: 30,
              width: 320,
              maxHeight: 238,
              overflowY: 'auto',
              padding: 6,
              borderRadius: 'var(--radius-md)'
              // [原代码]: border: '1px solid var(--glass-border-strong)'
              // [原代码]: background: 'linear-gradient(var(--glass-bg-strong), var(--glass-bg-strong)), var(--glass-bg-inset)'
              // [原代码]: boxShadow: 'var(--glass-shadow)'
            }}
          >
            {accounts.length === 0 ? (
              <p className="text-3" style={{ padding: '10px 8px', fontSize: 'var(--fs-sm)' }}>
                暂无已保存账户
              </p>
            ) : (
              accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  role="menuitem"
                  className={`list-row focus-ring${account.id === activeId ? ' is-selected' : ''}`}
                  onClick={() => {
                    onSelect(account.id);
                    onClose();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '6px 8px',
                    border: '1px solid transparent',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-1)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-sm)',
                    textAlign: 'left',
                    cursor: 'pointer'
                  }}
                >
                  <AccountAvatar account={account} size={28} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    {account.name}
                  </span>
                  {account.id === activeId && (
                    <Check size={13} strokeWidth={2} style={{ flex: 'none', color: 'var(--accent)' }} />
                  )}
                </button>
              ))
            )}

            <hr className="hairline" style={{ margin: '6px 0' }} />

            {mode === 'offline' && (
              <button
                type="button"
                role="menuitem"
                className="list-row focus-ring"
                onClick={() => {
                  onCreateOffline();
                  onClose();
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
                <UserPlus size={14} strokeWidth={1.8} />
                新建离线账户
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              className="list-row focus-ring"
              onClick={() => {
                onLogin();
                onClose();
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
              <LogIn size={14} strokeWidth={1.8} />
              登录新账户
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

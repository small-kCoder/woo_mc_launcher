import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import Dialog from './Dialog';
import { showToast } from '../lib/toast';
import { formatDuration } from '../lib/format';
import { toUserMessage } from '../lib/errorText';
import type { AuthEvent } from '../types/ipc';

type LoginPhase = 'starting' | 'waiting' | 'error';

interface LoginDialogProps {
  open: boolean;
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return toUserMessage(error, '微软账户登录失败，请重试');
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
 * 微软设备码登录弹窗：展示验证码、复制、打开验证页面与倒计时；
 * 成功关闭并刷新，失败可重试，取消与手动关闭都会中止登录流程。
 */
export default function LoginDialog({ open, onClose }: LoginDialogProps): JSX.Element | null {
  const [phase, setPhase] = useState<LoginPhase>('starting');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [expiresIn, setExpiresIn] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  const finishedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const startLogin = useCallback(async () => {
    const api = window.launcher;
    finishedRef.current = false;
    setPhase('starting');
    setUserCode('');
    setVerificationUri('');
    setExpiresIn(0);
    setStartedAt(0);
    setMessage('');
    setCopied(false);
    if (!api) {
      setPhase('error');
      setMessage('未检测到启动器运行环境');
      return;
    }
    try {
      await api.accounts.loginMicrosoft();
    } catch (loginError) {
      setPhase('error');
      setMessage(errorMessage(loginError));
    }
  }, []);

  // 订阅需要在发起登录之前建立，避免错过 device-code 事件
  useEffect(() => {
    if (!open) {
      return;
    }
    const api = window.launcher;
    if (!api) {
      setPhase('error');
      setMessage('未检测到启动器运行环境');
      return;
    }

    const unsubscribe = api.on('auth:event', (payload) => {
      const event = payload as AuthEvent;
      if (event.kind === 'device-code') {
        setPhase('waiting');
        setUserCode(event.userCode ?? '');
        setVerificationUri(event.verificationUri ?? '');
        setExpiresIn(event.expiresIn ?? 0);
        setStartedAt(Date.now());
        return;
      }
      if (event.kind === 'success') {
        finishedRef.current = true;
        showToast({ type: 'success', message: '登录成功' });
        // 账户与配置刷新由 LauncherProvider 统一订阅 auth:event 完成，避免重复 reload
        onCloseRef.current();
        return;
      }
      if (event.kind === 'error') {
        setPhase('error');
        setMessage(event.message ?? '微软账户登录失败，请重试');
        return;
      }
      if (event.kind === 'cancelled') {
        finishedRef.current = true;
        onCloseRef.current();
      }
    });

    void startLogin();

    return () => {
      unsubscribe();
      if (!finishedRef.current) {
        void api.accounts.cancelMicrosoftLogin().catch(() => undefined);
      }
    };
  }, [open, startLogin]);

  // 过期倒计时：仅等待态运行，每秒刷新一次剩余秒数
  useEffect(() => {
    if (phase !== 'waiting' || expiresIn <= 0 || startedAt <= 0) {
      return;
    }
    const update = () => {
      const seconds = Math.max(0, Math.round(expiresIn - (Date.now() - startedAt) / 1000));
      setRemaining(seconds);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [phase, expiresIn, startedAt]);

  const requestClose = () => {
    if (!finishedRef.current) {
      finishedRef.current = true;
      void window.launcher?.accounts.cancelMicrosoftLogin().catch(() => undefined);
    }
    onClose();
  };

  const handleCopy = async () => {
    if (!userCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(userCode);
    } catch {
      // 剪贴板 API 不可用时退回 execCommand
      const textarea = document.createElement('textarea');
      textarea.value = userCode;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleOpenPage = async () => {
    if (!verificationUri) {
      return;
    }
    try {
      await window.launcher.openExternal(verificationUri);
    } catch (openError) {
      showToast({ type: 'error', message: errorMessage(openError) });
    }
  };

  return (
    <Dialog open={open} onClose={requestClose} title="登录 Microsoft 账户" width={480} height={340}>
      <AnimatePresence mode="wait" initial={false}>
        {phase === 'starting' && (
          <motion.div
            key="starting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
          >
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ duration: 1.2, ease: 'linear', repeat: Infinity }}
              style={{ display: 'inline-flex', color: 'var(--accent)' }}
            >
              <Loader2 size={18} strokeWidth={2} />
            </motion.span>
            <span className="text-2" style={{ fontSize: 'var(--fs-sm)' }}>
              正在获取验证码…
            </span>
          </motion.div>
        )}

        {phase === 'waiting' && (
          <motion.div
            key="waiting"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}
          >
            <p className="text-2" style={{ fontSize: 'var(--fs-sm)' }}>
              在浏览器中输入以下验证码完成登录
            </p>

            <div
              style={{
                padding: '10px 20px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid rgba(106, 168, 255, 0.3)',
                // [原代码]: background: 'var(--accent-soft)',
                background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.16), rgba(10, 16, 28, 0.5))',
                boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
                color: 'var(--text-1)',
                fontFamily: 'ui-monospace, Consolas, monospace',
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '0.16em',
                textShadow: '0 0 18px rgba(106, 168, 255, 0.45)'
              }}
            >
              {userCode || '— — — — —'}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="focus-ring" style={SECONDARY_BUTTON_STYLE} onClick={() => void handleCopy()}>
                {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
                {copied ? '已复制' : '复制代码'}
              </button>
              <button
                type="button"
                className="focus-ring"
                disabled={!verificationUri}
                style={SECONDARY_BUTTON_STYLE}
                onClick={() => void handleOpenPage()}
              >
                <ExternalLink size={14} strokeWidth={1.8} />
                打开登录页面
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ duration: 1.4, ease: 'linear', repeat: Infinity }}
                style={{ display: 'inline-flex', color: 'var(--text-3)' }}
              >
                <Loader2 size={14} strokeWidth={1.8} />
              </motion.span>
              <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
                {remaining > 0 ? `等待授权，剩余 ${formatDuration(remaining * 1000)}` : '验证码已过期，请重试'}
              </span>
            </div>

            <button
              type="button"
              className="focus-ring"
              onClick={requestClose}
              style={{ border: 0, background: 'transparent', color: 'var(--text-3)', fontSize: 'var(--fs-xs)', cursor: 'pointer' }}
            >
              取消登录
            </button>
          </motion.div>
        )}

        {phase === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}
          >
            <AlertCircle size={28} strokeWidth={1.6} style={{ color: 'var(--danger)' }} />
            <p style={{ color: 'var(--text-1)', fontSize: 'var(--fs-sm)', textAlign: 'center', maxWidth: 340 }}>{message}</p>
            <button
              type="button"
              className="focus-ring"
              onClick={() => void startLogin()}
              style={{
                ...SECONDARY_BUTTON_STYLE,
                height: 34,
                padding: '0 20px',
                border: '1px solid rgba(106, 168, 255, 0.4)'
              }}
            >
              重试
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </Dialog>
  );
}

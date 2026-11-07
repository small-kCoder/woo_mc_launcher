import { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog';
import { toUserMessage } from '../lib/errorText';

const DEFAULT_PORT = 25565;

interface StartMultiplayerDialogProps {
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}

/** 开启联机：填写游戏内“对局域网开放”使用的端口，启动器持续监测 */
export default function StartMultiplayerDialog({
  open,
  onClose,
  onStarted
}: StartMultiplayerDialogProps): JSX.Element {
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPort(String(DEFAULT_PORT));
    setError('');
    setPending(false);
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const handleSubmit = async () => {
    if (pending) {
      return;
    }
    const api = window.launcher;
    if (!api) {
      setError('未检测到启动器运行环境');
      return;
    }
    const value = Number(port.trim());
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      setError('端口号需为 1-65535 的整数');
      return;
    }
    setPending(true);
    setError('');
    try {
      await api.multiplayer.startHost(value);
      onStarted();
    } catch (startError) {
      setError(toUserMessage(startError, '启动联机失败'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="开启联机" width="min(420px, 90vw)" height={300} dismissible={!pending}>
      <p className="text-3" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.7 }}>
        填写游戏内「对局域网开放」时使用的端口。启动器会持续监测该端口，端口开放后自动登记房间并显示房间号。
      </p>

      <label
        htmlFor="multiplayer-port-input"
        style={{ display: 'block', marginTop: 14, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}
      >
        局域网端口
      </label>
      <input
        id="multiplayer-port-input"
        ref={inputRef}
        value={port}
        disabled={pending}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setPort(event.target.value.replace(/[^\d]/g, '').slice(0, 5));
          setError('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder="例如 25565"
        style={{
          marginTop: 6,
          height: 40,
          width: '100%',
          padding: '0 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg-inset)',
          color: 'var(--text-1)',
          fontFamily: 'var(--font-mono, var(--font-ui))',
          fontSize: 20,
          fontWeight: 600,
          letterSpacing: '0.08em',
          outline: 'none'
        }}
      />

      {error ? (
        <p style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>{error}</p>
      ) : (
        <p style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
          游戏内端口需与此处一致；若游戏已在运行，可直接填写已开放的端口。
        </p>
      )}

      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 12 }}>
        <button
          type="button"
          className="focus-ring glass-interactive"
          disabled={pending}
          onClick={onClose}
          style={{
            height: 32,
            padding: '0 18px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--glass-border)',
            background: 'rgba(255, 255, 255, 0.06)',
            color: 'var(--text-2)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)',
            cursor: pending ? 'not-allowed' : 'pointer'
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="focus-ring glass-sheen glass-interactive"
          disabled={pending}
          onClick={() => void handleSubmit()}
          style={{
            height: 32,
            padding: '0 22px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid rgba(106, 168, 255, 0.4)',
            background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)',
            cursor: pending ? 'not-allowed' : 'pointer',
            opacity: pending ? 0.6 : 1
          }}
        >
          {pending ? '正在启动…' : '开始监测'}
        </button>
      </div>
    </Dialog>
  );
}

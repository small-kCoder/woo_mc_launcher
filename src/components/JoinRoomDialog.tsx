import { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog';
import { toUserMessage } from '../lib/errorText';

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

interface JoinRoomDialogProps {
  open: boolean;
  onClose: () => void;
  onJoined: () => void;
}

/** 加入联机房间：输入 6 位房间号，提交后由主进程建立 P2P 并启动游戏 */
export default function JoinRoomDialog({ open, onClose, onJoined }: JoinRoomDialogProps): JSX.Element {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCode('');
    setError('');
    setPending(false);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
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
    const normalized = code.trim().toUpperCase();
    if (!ROOM_CODE_RE.test(normalized)) {
      setError('房间号需为 6 位字母或数字');
      return;
    }
    setPending(true);
    setError('');
    try {
      await api.multiplayer.join(normalized);
      onJoined();
    } catch (joinError) {
      setError(toUserMessage(joinError, '加入房间失败'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="加入联机房间" width="min(420px, 90vw)" height={260} dismissible={!pending}>
      <p className="text-3" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.7 }}>
        请输入房主提供的 6 位房间号。加入前请先退出游戏，房间会出现在多人游戏列表中。
      </p>

      <label
        htmlFor="room-code-input"
        style={{ display: 'block', marginTop: 14, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}
      >
        房间号
      </label>
      <input
        id="room-code-input"
        ref={inputRef}
        value={code}
        disabled={pending}
        maxLength={6}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
          setError('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder="例如 A1B2C3"
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
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          outline: 'none'
        }}
      />

      {error && (
        <p style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>{error}</p>
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
          {pending ? '正在连接…' : '加入房间'}
        </button>
      </div>
    </Dialog>
  );
}

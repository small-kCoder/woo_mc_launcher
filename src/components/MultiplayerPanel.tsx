import { useEffect, useState, type CSSProperties } from 'react';
import { Copy, Users } from 'lucide-react';
import GlassPanel from './ui/GlassPanel';
import JoinRoomDialog from './JoinRoomDialog';
import StartMultiplayerDialog from './StartMultiplayerDialog';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import type { MultiplayerPhase, MultiplayerState } from '../types/ipc';

const ACTION_BUTTON_STYLE: CSSProperties = {
  height: 28,
  padding: '0 12px',
  flex: 'none',
  borderRadius: 'var(--radius-pill)',
  border: '1px solid var(--glass-border)',
  background: 'rgba(255, 255, 255, 0.06)',
  color: 'var(--text-2)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer'
};

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...ACTION_BUTTON_STYLE,
  border: '1px solid rgba(106, 168, 255, 0.42)',
  background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.3), rgba(76, 141, 255, 0.16))',
  color: 'var(--text-1)'
};

const PHASE_LABEL: Record<MultiplayerPhase, { label: string; color: string }> = {
  idle: { label: '未开启', color: 'var(--text-3)' },
  'waiting-game': { label: '等待游戏', color: 'var(--warning)' },
  'waiting-lan': { label: '等待开局域网', color: 'var(--warning)' },
  ready: { label: '房间已就绪', color: 'var(--success)' },
  joining: { label: '解析房间', color: 'var(--accent)' },
  connecting: { label: '建立 P2P', color: 'var(--accent)' },
  error: { label: '联机失败', color: 'var(--danger)' }
};

function isBusyPhase(phase: MultiplayerPhase): boolean {
  return phase === 'joining' || phase === 'connecting';
}

export default function MultiplayerPanel(): JSX.Element {
  const [state, setState] = useState<MultiplayerState>({ phase: 'idle' });
  const [joinOpen, setJoinOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const api = window.launcher;
    if (!api) {
      return;
    }
    let disposed = false;
    void api.multiplayer
      .getState()
      .then((current) => {
        if (!disposed) {
          setState(current);
        }
      })
      .catch(() => undefined);
    const off = api.on('multiplayer:state', (payload) => {
      const next = payload as MultiplayerState;
      if (next && typeof next.phase === 'string') {
        setState(next);
        if (next.phase === 'error' && next.message) {
          showToast({ type: 'error', message: next.message });
        }
      }
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const runAction = async (action: () => Promise<unknown>, fallback: string) => {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      await action();
    } catch (error) {
      showToast({ type: 'error', message: toUserMessage(error, fallback) });
    } finally {
      setPending(false);
    }
  };

  const handleLeave = () =>
    runAction(async () => {
      const api = window.launcher;
      if (!api) {
        return;
      }
      await api.multiplayer.leave();
      setState({ phase: 'idle' });
    }, '关闭联机失败');

  const handleCopy = async () => {
    if (!state.roomCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(state.roomCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      showToast({ type: 'success', message: `房间号 ${state.roomCode} 已复制` });
    } catch {
      showToast({ type: 'error', message: '复制失败，请手动选择房间号' });
    }
  };

  const phase = state.phase;
  const meta = PHASE_LABEL[phase];
  const busy = isBusyPhase(phase);
  const disabled = pending || busy;

  const renderBody = (): JSX.Element => {
    if (phase === 'idle') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.6 }}>
            P2P 直连，不占用服务器流量
          </span>
          <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.6 }}>
            房主先启动联机，好友再用房间号加入
          </span>
        </div>
      );
    }
    if (phase === 'waiting-game') {
      return (
        <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.7 }}>
          等待启动游戏。请点击主界面的“启动游戏”，开局域网时端口填
          {state.targetPort ?? '—'}；启动器会持续监测该端口。
        </span>
      );
    }
    if (phase === 'waiting-lan') {
      return (
        <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.7 }}>
          正在监测端口 <span className="num">{state.targetPort ?? '—'}</span>。请在游戏内按 Esc →
          对局域网开放，端口填相同数值。
        </span>
      );
    }
    if (phase === 'ready' && state.roomCode) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
            房间号
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              className="num"
              style={{
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '0.18em',
                lineHeight: 1,
                color: 'var(--text-1)',
                userSelect: 'all'
              }}
            >
              {state.roomCode}
            </span>
            <button
              type="button"
              className="focus-ring glass-interactive"
              onClick={() => void handleCopy()}
              aria-label="复制房间号"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                flex: 'none',
                padding: 0,
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: copied ? 'var(--success)' : 'var(--text-2)',
                cursor: 'pointer'
              }}
            >
              <Copy size={13} strokeWidth={1.8} />
            </button>
          </div>
          <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.6 }}>
            {state.message ?? '等待好友加入'}
            {state.versionId ? ` · ${state.versionId}` : ''}
          </span>
        </div>
      );
    }
    if (busy) {
      return (
        <span className="text-3" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.7 }}>
          {state.message ?? '正在连接…'}
          {state.roomCode ? `（房间 ${state.roomCode}）` : ''}
        </span>
      );
    }
    return (
      <span style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.7, color: 'var(--danger)' }}>
        {state.message ?? '联机失败，请重试'}
      </span>
    );
  };

  const showActions = phase !== 'idle';

  return (
    <GlassPanel
      layer="base"
      style={{
        flex: '1 1 auto',
        minHeight: 0,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>联机</h2>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 9px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--glass-border)',
            background: 'rgba(255, 255, 255, 0.05)',
            color: 'var(--text-3)',
            fontSize: 'var(--fs-xs)'
          }}
        >
          <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: meta.color }} />
          {meta.label}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
        {phase === 'idle' ? (
          <>
            <button
              type="button"
              className="focus-ring glass-sheen glass-interactive"
              disabled={disabled}
              onClick={() => setStartOpen(true)}
              style={{ ...PRIMARY_BUTTON_STYLE, opacity: disabled ? 0.6 : 1 }}
            >
              启动联机
            </button>
            <button
              type="button"
              className="focus-ring glass-interactive"
              disabled={disabled}
              onClick={() => setJoinOpen(true)}
              style={ACTION_BUTTON_STYLE}
            >
              加入联机
            </button>
          </>
        ) : (
          <>
            {phase === 'ready' ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--success)'
                }}
              >
                <Users size={13} strokeWidth={1.8} aria-hidden="true" />
                P2P 房间已开启
              </span>
            ) : (
              <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
                {busy ? '连接中，请稍候' : state.message ?? '联机进行中'}
              </span>
            )}
            <button
              type="button"
              className="focus-ring"
              disabled={pending}
              onClick={() => void handleLeave()}
              style={{ ...ACTION_BUTTON_STYLE, marginLeft: 'auto', opacity: pending ? 0.6 : 1 }}
            >
              关闭联机
            </button>
          </>
        )}
      </div>

      <div style={{ marginTop: 14, minHeight: 0, overflowY: 'auto' }}>{renderBody()}</div>

      {state.lanPort !== undefined && phase === 'ready' && (
        <span className="text-3 num" style={{ marginTop: 'auto', fontSize: 'var(--fs-xs)', opacity: 0.7 }}>
          局域网端口 {state.lanPort}
        </span>
      )}

      <JoinRoomDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoined={() => setJoinOpen(false)}
      />
      <StartMultiplayerDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onStarted={() => setStartOpen(false)}
      />
    </GlassPanel>
  );
}

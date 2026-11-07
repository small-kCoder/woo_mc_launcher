import { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import Dialog from './Dialog';
import { useLauncher } from '../lib/useLauncher';
import { showToast } from '../lib/toast';
import { toUserMessage } from '../lib/errorText';
import type { ServerChannel, ServerCheckResult } from '../types/ipc';

/** 启动后延迟检查，避免与首屏动画争抢资源 */
const STARTUP_CHECK_DELAY_MS = 900;

type ChannelStatus = 'idle' | 'checking' | 'ok' | 'fail';

interface ChannelMeta {
  id: ServerChannel;
  label: string;
  type: string;
}

const CHANNELS: ChannelMeta[] = [
  { id: 'channel1', label: '通道1', type: 'Cloudflare 免费入口' },
  { id: 'channel2', label: '通道2', type: '第三方入口' }
];

function otherChannel(channel: ServerChannel): ServerChannel {
  return channel === 'channel1' ? 'channel2' : 'channel1';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * 启动连接检查：优先通道1，失败自动切通道2；两个都失败时弹窗，
 * 可切换通道、编辑各自地址并重试，当前通道持久化到 config.serverChannel。
 */
export default function ServerConnectionGuard(): JSX.Element | null {
  const { config, refreshConfig } = useLauncher();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ServerChannel>('channel1');
  const [urls, setUrls] = useState<Record<ServerChannel, string>>({ channel1: '', channel2: '' });
  const [status, setStatus] = useState<Record<ServerChannel, ChannelStatus>>({
    channel1: 'idle',
    channel2: 'idle'
  });
  const [errors, setErrors] = useState<Record<ServerChannel, string>>({ channel1: '', channel2: '' });
  const [checking, setChecking] = useState(false);
  const checkedRef = useRef(false);
  const dialogTokenRef = useRef(0);

  useEffect(() => {
    if (!config || checkedRef.current) {
      return;
    }
    const api = window.launcher;
    if (!api) {
      return;
    }
    const timer = window.setTimeout(async () => {
      checkedRef.current = true;
      const channel1 = config.channel1Url;
      const channel2 = config.channel2Url;
      setUrls({ channel1, channel2 });
      setSelected(channel1 ? 'channel1' : channel2 ? 'channel2' : config.serverChannel);

      const order: ServerChannel[] = [];
      if (channel1) {
        order.push('channel1');
      }
      if (channel2) {
        order.push('channel2');
      }

      let winner: ServerChannel | null = null;
      let result: ServerCheckResult | null = null;
      for (const channel of order) {
        const url = channel === 'channel1' ? channel1 : channel2;
        setStatus((prev) => ({ ...prev, [channel]: 'checking' }));
        try {
          const checked = await api.server.check(url);
          if (checked.ok) {
            winner = channel;
            result = checked;
            setStatus((prev) => ({ ...prev, [channel]: 'ok' }));
            break;
          }
          setStatus((prev) => ({ ...prev, [channel]: 'fail' }));
          setErrors((prev) => ({ ...prev, [channel]: checked.message ?? '连接失败' }));
        } catch (error) {
          setStatus((prev) => ({ ...prev, [channel]: 'fail' }));
          setErrors((prev) => ({ ...prev, [channel]: toUserMessage(error, '连接服务端失败') }));
        }
      }

      if (winner && result) {
        if (config.serverChannel !== winner) {
          try {
            await api.config.update({ serverChannel: winner });
            await refreshConfig();
          } catch {
            // 持久化失败不影响本次连接结果
          }
        }
        const message =
          winner === 'channel1'
            ? `通道1已连接 · ${result.latencyMs}ms`
            : channel1
              ? `通道1不可用，已切换到通道2 · ${result.latencyMs}ms`
              : `通道2已连接 · ${result.latencyMs}ms`;
        showToast({ type: 'success', message });
        return;
      }

      if (order.length === 0) {
        setErrors({
          channel1: '通道1地址未配置',
          channel2: '通道2地址未配置'
        });
      }
      setOpen(true);
    }, STARTUP_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [config]);

  const handleClose = () => {
    dialogTokenRef.current += 1;
    setChecking(false);
    setOpen(false);
  };

  const handleRetry = async () => {
    const api = window.launcher;
    if (!api || checking) {
      return;
    }

    const channel1 = urls.channel1.trim().replace(/\/+$/, '');
    const channel2 = urls.channel2.trim().replace(/\/+$/, '');
    const selectedUrl = selected === 'channel1' ? channel1 : channel2;

    if (!selectedUrl && !channel1 && !channel2) {
      setErrors({ channel1: '请至少填写一个通道地址', channel2: '请至少填写一个通道地址' });
      return;
    }
    if (channel1 && !isHttpUrl(channel1)) {
      setErrors((prev) => ({ ...prev, channel1: '通道1地址需以 http:// 或 https:// 开头' }));
      return;
    }
    if (channel2 && !isHttpUrl(channel2)) {
      setErrors((prev) => ({ ...prev, channel2: '通道2地址需以 http:// 或 https:// 开头' }));
      return;
    }
    if (selectedUrl && !isHttpUrl(selectedUrl)) {
      setErrors((prev) => ({ ...prev, [selected]: '地址需以 http:// 或 https:// 开头' }));
      return;
    }

    const token = dialogTokenRef.current;
    let succeeded = false;
    setChecking(true);
    setErrors({ channel1: '', channel2: '' });
    setStatus({ channel1: 'idle', channel2: 'idle' });
    try {
      // 保存两个通道地址，保证即使暂时离线，下次启动也会用新地址
      await api.config.update({ channel1Url: channel1, channel2Url: channel2 });
      await refreshConfig();

      const order: ServerChannel[] = [];
      if (selectedUrl) {
        order.push(selected);
      }
      const other = otherChannel(selected);
      const otherUrl = other === 'channel1' ? channel1 : channel2;
      if (otherUrl && !order.includes(other)) {
        order.push(other);
      }

      let winner: ServerChannel | null = null;
      let result: ServerCheckResult | null = null;
      for (const channel of order) {
        const url = channel === 'channel1' ? channel1 : channel2;
        setStatus((prev) => ({ ...prev, [channel]: 'checking' }));
        try {
          const checked = await api.server.check(url);
          if (checked.ok) {
            winner = channel;
            result = checked;
            setStatus((prev) => ({ ...prev, [channel]: 'ok' }));
            break;
          }
          setStatus((prev) => ({ ...prev, [channel]: 'fail' }));
          setErrors((prev) => ({ ...prev, [channel]: checked.message ?? '连接失败' }));
        } catch (error) {
          setStatus((prev) => ({ ...prev, [channel]: 'fail' }));
          setErrors((prev) => ({ ...prev, [channel]: toUserMessage(error, '连接服务端失败') }));
        }
      }

      if (winner && result) {
        succeeded = true;
        if (token !== dialogTokenRef.current) {
          return;
        }
        try {
          await api.config.update({ serverChannel: winner });
          await refreshConfig();
        } catch {
          // 通道已连通，持久化失败不阻断本次切换
        }
        setSelected(winner);
        setChecking(false);
        setOpen(false);
        showToast({
          type: 'success',
          message:
            winner === selected
              ? `通道${winner === 'channel1' ? '1' : '2'}已连接 · ${result.latencyMs}ms`
              : `已切换到通道${winner === 'channel1' ? '1' : '2'} · ${result.latencyMs}ms`
        });
        return;
      }

      if (token === dialogTokenRef.current) {
        setErrors((prev) => {
          const nextSelected = prev[selected] || '连接失败';
          return { ...prev, [selected]: nextSelected };
        });
      }
    } catch (retryError) {
      if (token === dialogTokenRef.current) {
        setErrors((prev) => ({ ...prev, [selected]: toUserMessage(retryError, '连接服务端失败') }));
      }
    } finally {
      if (!succeeded && token === dialogTokenRef.current) {
        setChecking(false);
      }
    }
  };

  const selectedMeta = CHANNELS.find((item) => item.id === selected) ?? CHANNELS[0];
  const otherMeta = CHANNELS.find((item) => item.id === otherChannel(selected)) ?? CHANNELS[1];
  const otherStatus = status[otherChannel(selected)];
  const selectedUrl = urls[selected];
  const selectedError = errors[selected];

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="无法连接服务端"
      width="min(500px, 90vw)"
      height={400}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <AlertCircle
          size={18}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{ flex: 'none', marginTop: 2, color: 'var(--danger)' }}
        />
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 'var(--fs-sm)' }}>两个通道都未能连接，请确认服务已启动或网络可访问。</p>
          <p className="text-3" style={{ marginTop: 4, fontSize: 'var(--fs-xs)' }}>
            启动时优先检查通道1，失败会自动切换到通道2。
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
        {CHANNELS.map((channel) => {
          const active = channel.id === selected;
          const state = status[channel.id];
          const dotColor =
            state === 'ok' ? 'var(--success)' : state === 'fail' ? 'var(--danger)' : 'var(--text-3)';
          return (
            <button
              key={channel.id}
              type="button"
              disabled={checking}
              onClick={() => setSelected(channel.id)}
              className="focus-ring"
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                border: active ? '1px solid rgba(106, 168, 255, 0.6)' : '1px solid var(--glass-border)',
                background: active ? 'rgba(106, 168, 255, 0.16)' : 'rgba(255, 255, 255, 0.05)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                cursor: checking ? 'not-allowed' : 'pointer',
                textAlign: 'left'
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)' }}>
                {channel.label}
                {state !== 'idle' && (
                  <span
                    aria-hidden="true"
                    style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor }}
                  />
                )}
              </span>
              <span className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
                {channel.type}
              </span>
            </button>
          );
        })}
      </div>

      <label
        htmlFor="channel-url-input"
        style={{ display: 'block', marginTop: 12, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}
      >
        {selectedMeta.label}地址
      </label>
      <input
        id="channel-url-input"
        value={selectedUrl}
        disabled={checking}
        onChange={(event) => {
          const value = event.target.value;
          setUrls((prev) => ({ ...prev, [selected]: value }));
          setErrors((prev) => ({ ...prev, [selected]: '' }));
          setStatus((prev) => ({ ...prev, [selected]: 'idle' }));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void handleRetry();
          }
        }}
        placeholder={selected === 'channel1' ? 'https://www.k-cloud.cc.cd' : 'http://127.0.0.1:8080'}
        spellCheck={false}
        style={{
          marginTop: 6,
          height: 36,
          width: '100%',
          padding: '0 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg-inset)',
          color: 'var(--text-1)',
          fontFamily: 'var(--font-mono, var(--font-ui))',
          fontSize: 'var(--fs-sm)',
          outline: 'none'
        }}
      />

      {selectedError && (
        <p style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
          {selectedError}
        </p>
      )}

      {(otherStatus === 'fail' || otherStatus === 'ok') && (
        <p className="text-3" style={{ marginTop: 6, fontSize: 'var(--fs-xs)' }}>
          {otherMeta.label}：{otherStatus === 'ok' ? '连接正常' : errors[otherChannel(selected)] || '连接失败'}
        </p>
      )}

      <div
        style={{
          marginTop: 'auto',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          paddingTop: 12
        }}
      >
        <button
          type="button"
          className="focus-ring glass-interactive"
          onClick={handleClose}
          style={{
            height: 32,
            padding: '0 18px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--glass-border)',
            background: 'rgba(255, 255, 255, 0.06)',
            color: 'var(--text-2)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)',
            cursor: 'pointer'
          }}
        >
          忽略
        </button>
        <button
          type="button"
          className="focus-ring glass-sheen glass-interactive"
          disabled={checking}
          onClick={() => void handleRetry()}
          style={{
            height: 32,
            padding: '0 22px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid rgba(106, 168, 255, 0.4)',
            background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.34), rgba(76, 141, 255, 0.2))',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-sm)',
            cursor: checking ? 'not-allowed' : 'pointer',
            opacity: checking ? 0.6 : 1
          }}
        >
          {checking ? '正在连接…' : '重试'}
        </button>
      </div>
    </Dialog>
  );
}

import { net } from 'electron';
import type { ServerCheckResult } from '../../src/types/ipc';
import { logLine } from './logger';
import { normalizeServerUrl } from './serverUrl';

/** 健康检查超时 */
const CHECK_TIMEOUT_MS = 5000;

/** Chromium 网络栈（net.fetch）的错误码映射：部分网络会重置 Node/curl 的 TLS 握手，但 Chromium 可正常连通 */
const NET_ERROR_MAPPING: Record<string, string> = {
  'net::ERR_CONNECTION_REFUSED': '连接被拒绝，服务端可能未启动',
  'net::ERR_NAME_NOT_RESOLVED': '无法解析服务端域名，请检查地址',
  'net::ERR_NAME_RESOLUTION_FAILED': '无法解析服务端域名，请检查地址',
  'net::ERR_CONNECTION_TIMED_OUT': '连接超时，请检查网络或地址',
  'net::ERR_TIMED_OUT': '连接超时，请检查网络或地址',
  'net::ERR_CONNECTION_RESET': '连接被服务端重置',
  'net::ERR_CONNECTION_CLOSED': '连接被服务端关闭',
  'net::ERR_INTERNET_DISCONNECTED': '网络未连接',
  'net::ERR_ADDRESS_UNREACHABLE': '无法访问该主机，请检查网络',
  'net::ERR_NETWORK_ACCESS_DENIED': '网络访问被拒绝，请检查防火墙',
  'net::ERR_CERT_DATE_INVALID': 'HTTPS 证书已过期或尚未生效',
  'net::ERR_CERT_AUTHORITY_INVALID': 'HTTPS 证书不受信任'
};

/** 把底层网络错误转换为可读提示 */
function describeConnectionError(error: unknown): string {
  if (!(error instanceof Error)) {
    return '无法连接服务端';
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return '连接超时（5 秒）';
  }
  const message = error.message ?? '';
  const netCode = message.match(/net::ERR_[A-Z_]+/)?.[0];
  if (netCode && NET_ERROR_MAPPING[netCode]) {
    return NET_ERROR_MAPPING[netCode];
  }
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  const code = cause?.code ?? '';
  const mapping: Record<string, string> = {
    ECONNREFUSED: '连接被拒绝，服务端可能未启动',
    ENOTFOUND: '无法解析服务端域名，请检查地址',
    EAI_AGAIN: '域名解析暂时失败，请检查网络',
    ETIMEDOUT: '连接超时，请检查网络或地址',
    UND_ERR_CONNECT_TIMEOUT: '连接超时，请检查网络或地址',
    ECONNRESET: '连接被服务端重置',
    EHOSTUNREACH: '无法访问该主机，请检查网络',
    ENETUNREACH: '网络不可达，请检查网络',
    CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 证书不受信任'
  };
  if (code && mapping[code]) {
    return mapping[code];
  }
  return message && message !== 'fetch failed' ? message : '无法连接服务端';
}

/**
 * 检查服务端连接：请求 <baseUrl>/health，2xx 视为在线。
 * 不抛异常，所有失败都以结构化结果返回，便于弹窗展示与重试。
 */
export async function checkServer(rawUrl: string): Promise<ServerCheckResult> {
  const url = normalizeServerUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      url: String(rawUrl ?? '').slice(0, 512),
      latencyMs: 0,
      message: '地址格式不正确，需以 http:// 或 https:// 开头，且不能包含查询参数'
    };
  }

  const first = await requestHealth(url);
  // 部分网络的首次 TLS 连接会被重置，紧接着重试即可成功
  if (first.result.ok || !first.retryable) {
    return first.result;
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  const second = await requestHealth(url);
  return second.result;
}

/** 首次连接被重置时的重试间隔 */
const RETRY_DELAY_MS = 350;

/** 可安全重试的网络层错误：拒连 / 解析失败 / 超时不重试，避免加倍等待 */
const RETRYABLE_NET_CODES = new Set([
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_NETWORK_CHANGED'
]);

function isRetryableNetError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = error.message.match(/net::ERR_[A-Z_]+/)?.[0];
  return Boolean(code && RETRYABLE_NET_CODES.has(code));
}

async function requestHealth(url: string): Promise<{ result: ServerCheckResult; retryable: boolean }> {
  const startedAt = Date.now();
  try {
    // [原代码]: const response = await fetch(`${url}/health`, { ... })
    // 改用 Chromium 网络栈：部分网络会重置 Node/curl 的 TLS 握手，Chromium 不受影响
    const response = await net.fetch(`${url}/health`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { 'User-Agent': 'woo-mc-launcher/server-check' }
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        retryable: false,
        result: {
          ok: false,
          url,
          latencyMs,
          status: response.status,
          message: `服务端返回 HTTP ${response.status}`
        }
      };
    }
    return { retryable: false, result: { ok: true, url, latencyMs, status: response.status } };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = describeConnectionError(error);
    // 记录底层错误，便于排查 TLS/代理等网络层问题（界面仍展示可读文案）
    logLine(`服务端检查失败 ${url}/health：${message}${error instanceof Error && error.message !== message ? `（${error.message}）` : ''}`);
    return { retryable: isRetryableNetError(error), result: { ok: false, url, latencyMs, message } };
  }
}

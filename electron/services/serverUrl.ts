const MAX_SERVER_URL_LENGTH = 2048;

/**
 * 规范化服务端基础地址：仅允许 http/https，去掉末尾斜杠，
 * 不允许携带查询串或 hash（健康检查会拼上 /health）。
 */
export function normalizeServerUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SERVER_URL_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname || parsed.search || parsed.hash) {
      return null;
    }
    return trimmed.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

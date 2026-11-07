import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, nativeImage } from 'electron';
import type { AuthEvent } from '../../../src/types/ipc';
import type { StoredMicrosoftAccount } from '../accounts';
import { AppError, fail } from '../errors';
import { logLine } from '../logger';
import { getSkinsDir } from '../paths';

/**
 * 微软身份平台 OAuth 参数（便携启动器固定值）。
 * 使用 Minecraft 官方启动器的公开客户端 ID：旧 ID 00000000-402b-4cd3-a82b-c45ab2f1d3f7
 * 已被微软停用（AADSTS700016），实测此 ID 可正常申请设备码。
 */
const CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const OAUTH_SCOPE = 'XboxLive.signin offline_access';

const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBOX_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const HTTP_TIMEOUT_MS = 15000;
const SKIN_TIMEOUT_MS = 10000;
const SKIN_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_MS = 5000;
const ERROR_DETAIL_MAX_LENGTH = 200;

/** XSTS 常见错误码的中文原因 */
const XSTS_ERROR_MESSAGES: Record<string, string> = {
  '2148916233': '该 Microsoft 账户没有 Xbox 账户，请先创建 Xbox 档案',
  '2148916238': '儿童账户需要家长同意后才能登录',
  '2148916227': '该账户已被 Xbox Live 封禁',
  '2148916235': '当前地区不支持 Xbox Live 登录'
};

/** 登录成功后交给账户服务落库的结果，token 仅存在于主进程 */
export interface MicrosoftLoginResult {
  name: string;
  uuid: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  xuid?: string;
  hasProfile: boolean;
  skinHeadDataUrl?: string;
}

/** 微软登录流程抛出的错误：错误事件已由本模块转发，上层无需重复提示 */
export class MicrosoftAuthError extends AppError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'MicrosoftAuthError';
  }
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

interface TokenSuccess {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface XboxAuthResponse {
  Token?: string;
  DisplayClaims?: { xui?: Array<{ uhs?: string }> };
}

interface MinecraftLoginResponse {
  access_token?: string;
  expires_in?: number;
}

interface MinecraftProfileResponse {
  id?: string;
  name?: string;
  skins?: Array<{ state?: string; url?: string }>;
}

interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
}

/** 同一时刻只允许一个登录流程 */
let loginRunning = false;
let cancelRequested = false;
let loginAbort: AbortController | null = null;
/** 进程内的头像 data URL 缓存，键为 uuid + 皮肤地址 */
const skinHeadCache = new Map<string, string>();

/** 向所有渲染窗口广播登录事件 */
export function emitAuthEvent(event: AuthEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('auth:event', event);
    }
  }
}

/** 是否已有登录流程在运行 */
export function isMicrosoftLoginRunning(): boolean {
  return loginRunning;
}

/** 取消当前登录：中止网络请求并通知渲染进程 */
export function cancelMicrosoftLogin(): void {
  if (!loginRunning || cancelRequested) {
    return;
  }
  cancelRequested = true;
  loginAbort?.abort();
  logLine('微软登录已取消');
  emitAuthEvent({ kind: 'cancelled' });
}

/** 打码日志中的令牌字段 */
function redactSecrets(text: string): string {
  return text.replace(/(access_token|refresh_token|id_token|RpsTicket)(["'\s:=]+)([^\s"'&,}]+)/gi, '$1$2***');
}

/** 从响应体提取可读错误原因 */
function extractErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '未知错误';
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['error_description', 'error', 'message', 'Message', 'IdentityErrorCode']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim().slice(0, ERROR_DETAIL_MAX_LENGTH);
        }
        if (typeof value === 'number') {
          return String(value);
        }
      }
    }
  } catch {
    // 非 JSON 响应按原文截断
  }
  return trimmed.slice(0, ERROR_DETAIL_MAX_LENGTH);
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    fail('AUTH_BAD_RESPONSE', `${label}返回数据格式不正确`);
  }
}

/**
 * 统一 HTTP 请求：15 秒超时、外部取消联动，非 2xx 由调用方按业务处理。
 * 网络错误与超时转换为中文错误。
 */
async function httpRequest(
  url: string,
  init: RequestInit,
  label: string,
  signal?: AbortSignal,
  timeoutMs: number = HTTP_TIMEOUT_MS
): Promise<HttpResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relayAbort = (): void => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text, headers: response.headers };
  } catch (error) {
    if (timedOut) {
      fail('AUTH_TIMEOUT', `${label}超时，请检查网络后重试`);
    }
    if (signal?.aborted) {
      fail('AUTH_CANCELLED', '登录已取消');
    }
    logLine(`${label}请求失败：${redactSecrets(error instanceof Error ? error.message : '未知错误')}`);
    throw new AppError('AUTH_NETWORK_ERROR', `${label}失败，请检查网络连接`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function throwIfCancelled(): void {
  if (cancelRequested) {
    fail('AUTH_CANCELLED', '登录已取消');
  }
}

/** 第 1 步：申请设备码 */
async function requestDeviceCode(signal: AbortSignal): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: OAUTH_SCOPE });
  const response = await httpRequest(
    DEVICE_CODE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString()
    },
    '获取微软设备码',
    signal
  );
  if (!response.ok) {
    fail('AUTH_DEVICE_CODE_FAILED', `获取设备码失败：${extractErrorDetail(response.text)}`);
  }
  const data = parseJson<DeviceCodeResponse>(response.text, '设备码接口');
  if (!data.device_code || !data.user_code || !data.verification_uri || typeof data.expires_in !== 'number') {
    fail('AUTH_BAD_RESPONSE', '设备码返回数据不完整，请稍后重试');
  }
  return data;
}

/** 第 2 步：按 interval 轮询 token 端点 */
async function pollForToken(device: DeviceCodeResponse, signal: AbortSignal): Promise<TokenSuccess> {
  const intervalSeconds =
    typeof device.interval === 'number' && device.interval > 0 ? device.interval : DEFAULT_POLL_INTERVAL_SECONDS;
  let intervalMs = intervalSeconds * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (true) {
    if (Date.now() >= deadline) {
      fail('AUTH_DEVICE_CODE_EXPIRED', '设备码已过期，请重新登录');
    }
    await sleep(intervalMs, signal);
    throwIfCancelled();

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: device.device_code
    });
    const response = await httpRequest(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString()
      },
      '轮询登录状态',
      signal
    );

    if (response.ok) {
      const data = parseJson<TokenSuccess>(response.text, '令牌接口');
      if (!data.access_token || typeof data.expires_in !== 'number') {
        fail('AUTH_BAD_RESPONSE', '令牌返回数据不完整，请重新登录');
      }
      return data;
    }

    let errorCode = '';
    try {
      const parsed = JSON.parse(response.text) as { error?: string };
      errorCode = typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
      errorCode = '';
    }
    if (errorCode === 'authorization_pending') {
      continue;
    }
    if (errorCode === 'slow_down') {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    if (errorCode === 'expired_token') {
      fail('AUTH_DEVICE_CODE_EXPIRED', '设备码已过期，请重新登录');
    }
    if (errorCode === 'authorization_declined' || errorCode === 'access_denied') {
      fail('AUTH_LOGIN_DECLINED', '登录授权已被拒绝，请重新登录并同意授权');
    }
    fail('AUTH_TOKEN_FAILED', `登录失败：${extractErrorDetail(response.text)}`);
  }
}

/** 第 3 步：Xbox Live 用户认证 */
async function authenticateXbox(msAccessToken: string, signal?: AbortSignal): Promise<string> {
  const response = await httpRequest(
    XBOX_AUTH_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${msAccessToken}`
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT'
      })
    },
    'Xbox Live 认证',
    signal
  );
  if (!response.ok) {
    fail('AUTH_XBOX_FAILED', `Xbox Live 认证失败：${extractErrorDetail(response.text)}`);
  }
  const data = parseJson<XboxAuthResponse>(response.text, 'Xbox Live 认证');
  if (!data.Token) {
    fail('AUTH_BAD_RESPONSE', 'Xbox Live 认证返回数据不完整');
  }
  return data.Token;
}

/** 从 XSTS 响应头或响应体中找出已知错误码 */
function findXstsErrorCode(headers: Headers, text: string): string | null {
  const headerCode = (headers.get('x-err') ?? '').trim();
  if (headerCode && XSTS_ERROR_MESSAGES[headerCode]) {
    return headerCode;
  }
  for (const code of Object.keys(XSTS_ERROR_MESSAGES)) {
    if (text.includes(code)) {
      return code;
    }
  }
  const matched = text.match(/"(?:IdentityErrorCode|XErr)"\s*:\s*"?(\d{7,})/i);
  return matched ? matched[1] : null;
}

/** 第 4 步：XSTS 授权，返回 XSTS Token 与用户哈希 uhs */
async function authorizeXsts(xblToken: string, signal?: AbortSignal): Promise<{ token: string; uhs: string }> {
  const response = await httpRequest(
    XSTS_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
        RelyingParty: 'http://xsts.auth.xboxlive.com',
        TokenType: 'JWT'
      })
    },
    'XSTS 授权',
    signal
  );
  if (!response.ok) {
    const errorCode = findXstsErrorCode(response.headers, response.text);
    const reason = errorCode ? XSTS_ERROR_MESSAGES[errorCode] : extractErrorDetail(response.text);
    fail(errorCode ? `AUTH_XSTS_${errorCode}` : 'AUTH_XSTS_FAILED', `XSTS 授权失败：${reason}`);
  }
  const data = parseJson<XboxAuthResponse>(response.text, 'XSTS 授权');
  const uhs = data.DisplayClaims?.xui?.[0]?.uhs;
  if (!data.Token || !uhs) {
    fail('AUTH_BAD_RESPONSE', 'XSTS 授权返回数据不完整');
  }
  return { token: data.Token, uhs };
}

/** 第 5 步：用 XSTS 令牌登录 Minecraft 服务 */
async function loginWithXbox(
  xsts: { token: string; uhs: string },
  signal?: AbortSignal
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await httpRequest(
    MINECRAFT_LOGIN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identityToken: `XBL3.0 x=${xsts.uhs};${xsts.token}` })
    },
    'Minecraft 登录',
    signal
  );
  if (!response.ok) {
    fail('AUTH_MINECRAFT_FAILED', `Minecraft 登录失败：${extractErrorDetail(response.text)}`);
  }
  const data = parseJson<MinecraftLoginResponse>(response.text, 'Minecraft 登录');
  if (!data.access_token || typeof data.expires_in !== 'number') {
    fail('AUTH_BAD_RESPONSE', 'Minecraft 登录返回数据不完整');
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** 第 6 步：读取 Minecraft 档案与当前皮肤地址 */
async function fetchProfile(
  accessToken: string,
  signal?: AbortSignal
): Promise<{ uuid: string; name: string; skinUrl?: string }> {
  const response = await httpRequest(
    MINECRAFT_PROFILE_URL,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    },
    '获取 Minecraft 档案',
    signal
  );
  if (response.status === 401 || response.status === 404) {
    fail('AUTH_NO_PROFILE', '该账户未拥有 Minecraft，或游戏档案不可用');
  }
  if (!response.ok) {
    fail('AUTH_PROFILE_FAILED', `获取 Minecraft 档案失败：${extractErrorDetail(response.text)}`);
  }
  const data = parseJson<MinecraftProfileResponse>(response.text, 'Minecraft 档案');
  if (!data.id || !data.name) {
    fail('AUTH_BAD_RESPONSE', 'Minecraft 档案数据不完整');
  }
  const activeSkin = data.skins?.find((skin) => skin.state === 'ACTIVE' && typeof skin.url === 'string');
  return { uuid: data.id.toLowerCase(), name: data.name, skinUrl: activeSkin?.url };
}

/** 下载皮肤 PNG，限制 1MB 与 10 秒超时 */
async function downloadSkin(skinUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SKIN_TIMEOUT_MS);
  try {
    const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png' } });
    if (!response.ok) {
      throw new AppError('SKIN_HTTP_ERROR', `皮肤下载失败（HTTP ${response.status}）`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > SKIN_MAX_BYTES) {
      throw new AppError('SKIN_TOO_LARGE', '皮肤文件超过 1MB');
    }
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (timedOut) {
      throw new AppError('SKIN_TIMEOUT', '皮肤下载超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 裁切 8×8 头部正面并转 data URL，失败返回 undefined */
function cropSkinHead(buffer: Buffer): string | undefined {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      return undefined;
    }
    const head = image.crop({ x: 8, y: 8, width: 8, height: 8 });
    return head.isEmpty() ? undefined : head.toDataURL();
  } catch {
    return undefined;
  }
}

/** 读取本地缓存的皮肤文件作为下载失败时的兜底 */
function readCachedSkinHead(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    return cropSkinHead(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/**
 * 下载并裁切正版皮肤头部；失败不阻塞登录，允许返回 undefined。
 * 皮肤文件缓存到 data/skins/<uuid>.png。
 */
async function fetchSkinHead(uuid: string, skinUrl?: string): Promise<string | undefined> {
  if (!skinUrl) {
    return undefined;
  }
  const normalizedUrl = skinUrl.startsWith('http:') ? `https:${skinUrl.slice('http:'.length)}` : skinUrl;
  const cacheKey = `${uuid}|${normalizedUrl}`;
  const cached = skinHeadCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const file = path.join(getSkinsDir(), `${uuid}.png`);
  try {
    const buffer = await downloadSkin(normalizedUrl);
    fs.mkdirSync(getSkinsDir(), { recursive: true });
    fs.writeFileSync(file, buffer);
    const dataUrl = cropSkinHead(buffer);
    if (dataUrl) {
      skinHeadCache.set(cacheKey, dataUrl);
    }
    return dataUrl;
  } catch (error) {
    logLine(`获取正版皮肤头像失败：${error instanceof Error ? error.message : '未知错误'}`);
    return readCachedSkinHead(file);
  }
}

/**
 * 发起微软设备码登录。成功后返回账户数据（token 仅留在主进程），
 * 取消时返回 null；其余错误在广播 error 事件后抛出。
 */
export async function loginMicrosoft(): Promise<MicrosoftLoginResult | null> {
  if (loginRunning) {
    fail('AUTH_LOGIN_IN_PROGRESS', '正在登录中');
  }
  loginRunning = true;
  cancelRequested = false;
  loginAbort = new AbortController();
  const signal = loginAbort.signal;

  try {
    logLine('开始微软设备码登录');
    const device = await requestDeviceCode(signal);
    throwIfCancelled();
    logLine(`微软设备码：${device.user_code}，验证地址：${device.verification_uri}`);
    emitAuthEvent({
      kind: 'device-code',
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: device.expires_in
    });

    const tokens = await pollForToken(device, signal);
    throwIfCancelled();
    logLine('已获取 Microsoft 令牌，开始 Xbox Live 认证');

    const xblToken = await authenticateXbox(tokens.access_token ?? '', signal);
    throwIfCancelled();
    logLine('Xbox Live 认证成功，开始 XSTS 授权');

    const xsts = await authorizeXsts(xblToken, signal);
    throwIfCancelled();
    logLine('XSTS 授权成功，开始 Minecraft 登录');

    const minecraft = await loginWithXbox(xsts, signal);
    throwIfCancelled();
    logLine('Minecraft 登录成功，开始读取游戏档案');

    const profile = await fetchProfile(minecraft.accessToken, signal);
    throwIfCancelled();
    logLine(`已获取 Minecraft 档案：${profile.name}`);

    const skinHeadDataUrl = await fetchSkinHead(profile.uuid, profile.skinUrl);
    throwIfCancelled();
    return {
      name: profile.name,
      uuid: profile.uuid,
      accessToken: minecraft.accessToken,
      refreshToken: tokens.refresh_token ?? '',
      expiresAt: Date.now() + minecraft.expiresIn * 1000,
      xuid: xsts.uhs,
      hasProfile: true,
      skinHeadDataUrl
    };
  } catch (error) {
    if (cancelRequested) {
      logLine('微软登录流程已中止');
      return null;
    }
    const message = error instanceof AppError ? error.message : '微软登录失败，请稍后重试';
    logLine(`微软登录失败：${redactSecrets(message)}`);
    emitAuthEvent({ kind: 'error', message });
    throw new MicrosoftAuthError(error instanceof AppError ? error.code : 'AUTH_LOGIN_FAILED', message);
  } finally {
    loginRunning = false;
    loginAbort = null;
  }
}

/** 用 refresh_token 换新 Microsoft 令牌 */
async function refreshMsToken(refreshToken: string): Promise<TokenSuccess> {
  if (!refreshToken) {
    fail('AUTH_EXPIRED', '登录状态已过期，请重新登录');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken
  });
  const response = await httpRequest(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString()
    },
    '刷新登录令牌'
  );
  if (!response.ok) {
    fail('AUTH_EXPIRED', '登录状态已过期，请重新登录');
  }
  const data = parseJson<TokenSuccess>(response.text, '刷新令牌接口');
  if (!data.access_token) {
    fail('AUTH_EXPIRED', '登录状态已过期，请重新登录');
  }
  return data;
}

/**
 * 刷新微软账户令牌并重走 Xbox/XSTS/Minecraft 链路。
 * 任何失败都转换为 AUTH_EXPIRED，供启动前调用方提示重新登录。
 */
export async function refreshMicrosoftAccount(account: StoredMicrosoftAccount): Promise<StoredMicrosoftAccount> {
  try {
    logLine(`开始刷新微软账户令牌：${account.name}`);
    const tokens = await refreshMsToken(account.refreshToken);
    const xblToken = await authenticateXbox(tokens.access_token ?? '');
    const xsts = await authorizeXsts(xblToken);
    const minecraft = await loginWithXbox(xsts);
    const profile = await fetchProfile(minecraft.accessToken);
    const skinHeadDataUrl = await fetchSkinHead(profile.uuid, profile.skinUrl);
    logLine(`微软账户令牌刷新成功：${profile.name}`);
    return {
      ...account,
      name: profile.name,
      uuid: profile.uuid,
      accessToken: minecraft.accessToken,
      refreshToken: tokens.refresh_token ?? account.refreshToken,
      expiresAt: Date.now() + minecraft.expiresIn * 1000,
      xuid: xsts.uhs,
      hasProfile: true,
      skinHeadDataUrl: skinHeadDataUrl ?? account.skinHeadDataUrl
    };
  } catch (error) {
    logLine(`刷新微软账户令牌失败：${redactSecrets(error instanceof Error ? error.message : '未知错误')}`);
    fail('AUTH_EXPIRED', '登录状态已过期，请重新登录');
  }
}

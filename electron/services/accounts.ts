import fs from 'node:fs';
import path from 'node:path';
import type { AccountSummary, MicrosoftAccountSummary } from '../../src/types/ipc';
import { loginMicrosoft, MicrosoftAuthError, emitAuthEvent, isMicrosoftLoginRunning, type MicrosoftLoginResult } from './auth/microsoft';
import { validateOfflineName, offlineUuid } from './auth/offline';
import { getConfig, updateConfig } from './config';
import { fail } from './errors';
import { logLine } from './logger';
import { getAccountsFile, getDataDir } from './paths';

/** 账户标识前缀与长度约束 */
const OFFLINE_ID_PREFIX = 'offline:';
const MICROSOFT_ID_PREFIX = 'microsoft:';
const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 64;
const TOKEN_MAX_LENGTH = 8192;
const SKIN_DATA_URL_MAX_LENGTH = 2 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface StoredMicrosoftAccount {
  type: 'microsoft';
  id: string;
  name: string;
  uuid: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  xuid?: string;
  skinHeadDataUrl?: string;
  hasProfile: boolean;
}

export interface StoredOfflineAccount {
  type: 'offline';
  id: string;
  name: string;
  uuid: string;
}

export type StoredAccount = StoredMicrosoftAccount | StoredOfflineAccount;

/** Task 8 刷新后回写的字段集合 */
export type MicrosoftAccountPatch = Partial<
  Pick<StoredMicrosoftAccount, 'name' | 'accessToken' | 'refreshToken' | 'expiresAt' | 'xuid' | 'skinHeadDataUrl' | 'hasProfile'>
>;

interface AccountsFile {
  version: 1;
  accounts: StoredAccount[];
}

/** 内存缓存，避免每次 IPC 都读盘 */
let cachedAccounts: StoredAccount[] | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneAccounts(accounts: StoredAccount[]): StoredAccount[] {
  return accounts.map((account) => ({ ...account }));
}

function normalizeUuid(value: string): string | null {
  const lower = value.toLowerCase();
  return UUID_PATTERN.test(lower) ? lower : null;
}

function isValidName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= NAME_MIN_LENGTH && value.length <= NAME_MAX_LENGTH;
}

/** 校验并规范化磁盘中的单个账户，非法条目直接丢弃 */
function normalizeStoredAccount(value: unknown): StoredAccount | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (!isValidName(value.name) || typeof value.uuid !== 'string') {
    return null;
  }
  const uuid = normalizeUuid(value.uuid);
  if (!uuid) {
    return null;
  }
  if (value.type === 'offline') {
    return {
      type: 'offline',
      id: `${OFFLINE_ID_PREFIX}${uuid}`,
      name: value.name,
      uuid
    };
  }
  if (value.type === 'microsoft') {
    const accessToken = value.accessToken;
    const refreshToken = value.refreshToken;
    const expiresAt = value.expiresAt;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      return null;
    }
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return null;
    }
    return {
      type: 'microsoft',
      id: `${MICROSOFT_ID_PREFIX}${uuid}`,
      name: value.name,
      uuid,
      accessToken,
      refreshToken,
      expiresAt,
      xuid: typeof value.xuid === 'string' ? value.xuid : undefined,
      skinHeadDataUrl: typeof value.skinHeadDataUrl === 'string' ? value.skinHeadDataUrl : undefined,
      hasProfile: value.hasProfile === true
    };
  }
  return null;
}

/** 备份损坏的账户文件，供用户排查 */
function backupBrokenAccounts(file: string): void {
  const backup = path.join(getDataDir(), 'accounts.broken.json');
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.copyFileSync(file, backup);
  } catch (error) {
    logLine(`备份损坏的账户文件失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
}

/** 读取账户文件；文件损坏时备份并返回空列表 */
export function loadAccounts(): StoredAccount[] {
  if (cachedAccounts) {
    return cloneAccounts(cachedAccounts);
  }
  const file = getAccountsFile();
  if (!fs.existsSync(file)) {
    cachedAccounts = [];
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : isPlainObject(parsed) && Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [];
    const accounts = rawList
      .map(normalizeStoredAccount)
      .filter((account): account is StoredAccount => account !== null);
    cachedAccounts = accounts;
    return cloneAccounts(accounts);
  } catch (error) {
    logLine(`账户文件损坏，已回退为空账户列表：${error instanceof Error ? error.message : '未知错误'}`);
    backupBrokenAccounts(file);
    cachedAccounts = [];
    return [];
  }
}

/** 原子写入账户文件：先写临时文件再替换 */
function persistAccounts(accounts: StoredAccount[]): void {
  const file = getAccountsFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.tmp`;
    const payload: AccountsFile = { version: 1, accounts };
    fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpFile, file);
  } catch (error) {
    logLine(`保存账户失败：${error instanceof Error ? error.message : '未知错误'}`);
    fail('ACCOUNTS_WRITE_FAILED', '保存账户失败，请检查磁盘权限');
  }
  cachedAccounts = accounts;
}

function toMicrosoftSummary(account: StoredMicrosoftAccount): MicrosoftAccountSummary {
  const summary: MicrosoftAccountSummary = {
    type: 'microsoft',
    id: account.id,
    name: account.name,
    uuid: account.uuid,
    hasProfile: account.hasProfile
  };
  if (account.skinHeadDataUrl) {
    summary.skinHeadDataUrl = account.skinHeadDataUrl;
  }
  return summary;
}

function toSummary(account: StoredAccount): AccountSummary {
  if (account.type === 'offline') {
    return { type: 'offline', id: account.id, name: account.name, uuid: account.uuid };
  }
  return toMicrosoftSummary(account);
}

/** 脱敏的账户列表，正版账户不含 token */
export function listAccountSummaries(): AccountSummary[] {
  return loadAccounts().map(toSummary);
}

/** 保存离线账户，同名（忽略大小写）去重后返回摘要 */
export function saveOfflineAccount(name: string): AccountSummary {
  validateOfflineName(name);
  const uuid = offlineUuid(name);
  const id = `${OFFLINE_ID_PREFIX}${uuid}`;
  const accounts = loadAccounts();
  const existing = accounts.find(
    (account) => account.type === 'offline' && account.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    return toSummary(existing);
  }
  const account: StoredOfflineAccount = { type: 'offline', id, name, uuid };
  const index = accounts.findIndex((item) => item.id === id);
  if (index >= 0) {
    accounts[index] = account;
  } else {
    accounts.push(account);
  }
  persistAccounts(accounts);
  logLine(`已保存离线账户：${name}`);
  return toSummary(account);
}

export function getAccountById(id: string): StoredAccount | null {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  const account = loadAccounts().find((item) => item.id === id);
  return account ? { ...account } : null;
}

/** 账户被删除时同步清理配置中的选中项 */
function clearSelectedAccount(id: string): void {
  const config = getConfig();
  if (config.selectedAccountId === id) {
    updateConfig({ selectedAccountId: null });
  }
}

export function removeAccount(id: string): void {
  const accounts = loadAccounts();
  const index = accounts.findIndex((item) => item.id === id);
  if (index < 0) {
    fail('ACCOUNT_NOT_FOUND', '账户不存在');
  }
  const [removed] = accounts.splice(index, 1);
  persistAccounts(accounts);
  clearSelectedAccount(id);
  logLine(`已删除账户：${removed.name}`);
}

/** 切换当前账户，同时写入账户模式 */
export function setActiveAccount(id: string): void {
  const account = getAccountById(id);
  if (!account) {
    fail('ACCOUNT_NOT_FOUND', '账户不存在');
  }
  updateConfig({ selectedAccountId: id, accountMode: account.type });
}

/** 仅主进程使用：读取微软账户完整凭据（含 token） */
export function getMicrosoftCredentials(id: string): StoredMicrosoftAccount | null {
  const account = getAccountById(id);
  if (!account || account.type !== 'microsoft') {
    return null;
  }
  return { ...account };
}

/** Task 8 在刷新成功后回写 token 与头像等字段，id/uuid 不可变更 */
export function updateMicrosoftAccount(id: string, patch: MicrosoftAccountPatch): StoredMicrosoftAccount {
  if (!isPlainObject(patch)) {
    fail('ACCOUNT_INVALID_PATCH', '账户更新参数格式不正确');
  }
  const accounts = loadAccounts();
  const index = accounts.findIndex((item) => item.type === 'microsoft' && item.id === id);
  if (index < 0) {
    fail('ACCOUNT_NOT_FOUND', '微软账户不存在');
  }
  const current = accounts[index] as StoredMicrosoftAccount;
  const next: StoredMicrosoftAccount = { ...current };

  if ('name' in patch) {
    if (!isValidName(patch.name)) {
      fail('ACCOUNT_INVALID_NAME', '账户名称长度不合法');
    }
    next.name = patch.name;
  }
  if ('accessToken' in patch) {
    if (typeof patch.accessToken !== 'string' || patch.accessToken.length === 0 || patch.accessToken.length > TOKEN_MAX_LENGTH) {
      fail('ACCOUNT_INVALID_TOKEN', '访问令牌格式不正确');
    }
    next.accessToken = patch.accessToken;
  }
  if ('refreshToken' in patch) {
    if (typeof patch.refreshToken !== 'string' || patch.refreshToken.length > TOKEN_MAX_LENGTH) {
      fail('ACCOUNT_INVALID_TOKEN', '刷新令牌格式不正确');
    }
    next.refreshToken = patch.refreshToken;
  }
  if ('expiresAt' in patch) {
    if (typeof patch.expiresAt !== 'number' || !Number.isFinite(patch.expiresAt)) {
      fail('ACCOUNT_INVALID_EXPIRES', '令牌过期时间格式不正确');
    }
    next.expiresAt = patch.expiresAt;
  }
  if ('xuid' in patch) {
    if (patch.xuid !== undefined && typeof patch.xuid !== 'string') {
      fail('ACCOUNT_INVALID_XUID', 'XUID 格式不正确');
    }
    next.xuid = patch.xuid;
  }
  if ('skinHeadDataUrl' in patch) {
    const value = patch.skinHeadDataUrl;
    if (value !== undefined && (typeof value !== 'string' || value.length > SKIN_DATA_URL_MAX_LENGTH)) {
      fail('ACCOUNT_INVALID_SKIN', '皮肤头像数据格式不正确');
    }
    next.skinHeadDataUrl = value;
  }
  if ('hasProfile' in patch) {
    if (typeof patch.hasProfile !== 'boolean') {
      fail('ACCOUNT_INVALID_PROFILE_FLAG', '档案状态格式不正确');
    }
    next.hasProfile = patch.hasProfile;
  }

  accounts[index] = next;
  persistAccounts(accounts);
  logLine(`已更新微软账户：${next.name}`);
  return { ...next };
}

/** 登录成功后落库：同一 Minecraft UUID 覆盖原记录 */
function saveMicrosoftAccount(result: MicrosoftLoginResult): StoredMicrosoftAccount {
  const uuid = normalizeUuid(result.uuid);
  if (!uuid) {
    fail('ACCOUNT_INVALID_UUID', '微软账户 UUID 格式不正确');
  }
  if (!isValidName(result.name)) {
    fail('ACCOUNT_INVALID_NAME', '微软账户名称长度不合法');
  }
  const id = `${MICROSOFT_ID_PREFIX}${uuid}`;
  const account: StoredMicrosoftAccount = {
    type: 'microsoft',
    id,
    name: result.name,
    uuid,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    xuid: result.xuid,
    skinHeadDataUrl: result.skinHeadDataUrl,
    hasProfile: result.hasProfile
  };
  const accounts = loadAccounts();
  const index = accounts.findIndex((item) => item.id === id);
  if (index >= 0) {
    accounts[index] = account;
  } else {
    accounts.push(account);
  }
  persistAccounts(accounts);
  return { ...account };
}

/** 后台发起微软登录，立即返回；进度与结果通过 auth:event 推送 */
export function startMicrosoftLogin(): void {
  if (isMicrosoftLoginRunning()) {
    fail('AUTH_LOGIN_IN_PROGRESS', '正在登录中');
  }
  void loginMicrosoft()
    .then((result) => {
      if (!result) {
        return;
      }
      const account = saveMicrosoftAccount(result);
      setActiveAccount(account.id);
      logLine(`微软账户登录成功：${account.name}`);
      emitAuthEvent({ kind: 'success', account: toMicrosoftSummary(account) });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '微软账户登录失败';
      logLine(`微软账户登录失败：${message}`);
      // 登录流程自身已经广播过错误，仅补充落库等后续阶段的提示
      if (!(error instanceof MicrosoftAuthError)) {
        emitAuthEvent({ kind: 'error', message });
      }
    });
}

/** 退出微软账户：未指定 id 时移除当前选中的正版账户 */
export function logoutMicrosoft(id?: string): void {
  const targetId = id ?? getConfig().selectedAccountId;
  if (!targetId) {
    return;
  }
  const account = getAccountById(targetId);
  if (!account || account.type !== 'microsoft') {
    return;
  }
  removeAccount(account.id);
  logLine(`已退出微软账户：${account.name}`);
}

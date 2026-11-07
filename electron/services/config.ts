import fs from 'node:fs';
import path from 'node:path';
import type { AccountMode, AppConfig } from '../../src/types/ipc';
import { fail } from './errors';
import { logLine } from './logger';
import { normalizeServerUrl } from './serverUrl';
import { getConfigFile, getDataDir, getGameDir } from './paths';

/** 内存允许范围（MB） */
const MEMORY_MIN_MB = 512;
const MEMORY_MAX_MB = 8192;
const MEMORY_DEFAULT_MB = 2048;
/** 路径与标识长度上限，避免异常输入写入配置 */
const PATH_MAX_LENGTH = 4096;
const ID_MAX_LENGTH = 64;

let cachedConfig: AppConfig | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccountMode(value: unknown): value is AccountMode {
  return value === 'offline' || value === 'microsoft';
}

/** 默认通道地址：1 = Cloudflare 免费入口，2 = 第三方 FRP 入口 */
const DEFAULT_CHANNEL1_URL = 'https://www.k-cloud.cc.cd';
// [原代码]: const DEFAULT_CHANNEL2_URL = 'http://127.0.0.1:8080';
const DEFAULT_CHANNEL2_URL = 'http://uk.frp.one:64731';

function readChannelUrl(raw: unknown, fallback: string): string {
  // 显式留空表示该通道未配置
  if (typeof raw === 'string' && raw.trim() === '') {
    return '';
  }
  return normalizeServerUrl(raw) ?? fallback;
}

export function getDefaultConfig(): AppConfig {
  return {
    gameDir: getGameDir(),
    selectedAccountId: null,
    selectedVersionId: null,
    memoryMb: MEMORY_DEFAULT_MB,
    javaPath: null,
    accountMode: 'offline',
    memoryOptimizeOnLaunch: false,
    serverChannel: 'channel1',
    channel1Url: DEFAULT_CHANNEL1_URL,
    channel2Url: DEFAULT_CHANNEL2_URL
  };
}

/** 把磁盘内容与默认值逐字段合并：非法字段回退默认值 */
function mergeConfig(raw: unknown): AppConfig {
  const base = getDefaultConfig();
  if (!isPlainObject(raw)) {
    return base;
  }
  const gameDir =
    typeof raw.gameDir === 'string' && raw.gameDir.length <= PATH_MAX_LENGTH && path.isAbsolute(raw.gameDir)
      ? path.normalize(raw.gameDir)
      : base.gameDir;
  const memoryMb =
    typeof raw.memoryMb === 'number' &&
    Number.isInteger(raw.memoryMb) &&
    raw.memoryMb >= MEMORY_MIN_MB &&
    raw.memoryMb <= MEMORY_MAX_MB
      ? raw.memoryMb
      : base.memoryMb;
  const selectedAccountId =
    typeof raw.selectedAccountId === 'string' && raw.selectedAccountId.length <= ID_MAX_LENGTH ? raw.selectedAccountId : null;
  const selectedVersionId =
    typeof raw.selectedVersionId === 'string' && raw.selectedVersionId.length <= ID_MAX_LENGTH ? raw.selectedVersionId : null;
  const javaPath =
    typeof raw.javaPath === 'string' && raw.javaPath.length <= PATH_MAX_LENGTH && path.isAbsolute(raw.javaPath)
      ? path.normalize(raw.javaPath)
      : null;
  const accountMode = isAccountMode(raw.accountMode) ? raw.accountMode : base.accountMode;
  const memoryOptimizeOnLaunch =
    typeof raw.memoryOptimizeOnLaunch === 'boolean' ? raw.memoryOptimizeOnLaunch : base.memoryOptimizeOnLaunch;
  // 迁移旧版 serverUrl：作为通道2（本地）地址；通道1固定为 Cloudflare 入口
  const channel1Url = readChannelUrl(raw.channel1Url, DEFAULT_CHANNEL1_URL);
  const channel2Url = readChannelUrl(
    raw.channel2Url,
    readChannelUrl(raw.serverUrl, DEFAULT_CHANNEL2_URL)
  );
  const serverChannel: AppConfig['serverChannel'] =
    raw.serverChannel === 'channel2' ? 'channel2' : 'channel1';
  return {
    gameDir,
    selectedAccountId,
    selectedVersionId,
    memoryMb,
    javaPath,
    accountMode,
    memoryOptimizeOnLaunch,
    serverChannel,
    channel1Url,
    channel2Url
  };
}

/** 原子写入：先写 .tmp 再替换，避免中断产生半截文件 */
function writeConfigFile(config: AppConfig): void {
  const file = getConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpFile, file);
}

/** 备份损坏的配置文件，供用户排查 */
function backupBrokenConfig(file: string): void {
  const backup = path.join(getDataDir(), 'config.broken.json');
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.copyFileSync(file, backup);
  } catch {
    // 备份失败不影响回退默认值
  }
}

function loadConfig(): AppConfig {
  const defaults = getDefaultConfig();
  const file = getConfigFile();
  if (!fs.existsSync(file)) {
    try {
      writeConfigFile(defaults);
    } catch (error) {
      logLine(`写入默认配置失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
    return defaults;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return mergeConfig(parsed);
  } catch (error) {
    logLine(`配置文件损坏，已回退默认值：${error instanceof Error ? error.message : '未知错误'}`);
    backupBrokenConfig(file);
    try {
      writeConfigFile(defaults);
    } catch (writeError) {
      logLine(`重建配置失败：${writeError instanceof Error ? writeError.message : '未知错误'}`);
    }
    return defaults;
  }
}

/** 读取配置（带内存缓存），返回副本避免外部修改缓存 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return { ...cachedConfig };
}

function validateNullableId(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail('CONFIG_INVALID_ID', `${label}必须为字符串或 null`);
  }
  if (value.length > ID_MAX_LENGTH) {
    fail('CONFIG_INVALID_ID', `${label}长度不能超过 ${ID_MAX_LENGTH} 个字符`);
  }
  return value;
}

/**
 * 更新配置：校验类型与范围后原子写入，返回最新配置。
 * patch 中未包含的字段保持原值，未知字段忽略。
 */
export function updateConfig(patch: unknown): AppConfig {
  if (!isPlainObject(patch)) {
    fail('CONFIG_INVALID_PATCH', '配置参数格式不正确');
  }
  const next: AppConfig = { ...getConfig() };

  if ('gameDir' in patch) {
    const value = patch.gameDir;
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail('CONFIG_INVALID_GAME_DIR', '游戏目录必须为非空字符串');
    }
    if (value.length > PATH_MAX_LENGTH) {
      fail('CONFIG_INVALID_GAME_DIR', `游戏目录长度不能超过 ${PATH_MAX_LENGTH} 个字符`);
    }
    if (!path.isAbsolute(value)) {
      fail('CONFIG_INVALID_GAME_DIR', '游戏目录必须是绝对路径');
    }
    const dir = path.normalize(value);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      fail('CONFIG_GAME_DIR_CREATE_FAILED', '无法创建游戏目录，请检查路径与权限');
    }
    next.gameDir = dir;
  }

  if ('selectedAccountId' in patch) {
    next.selectedAccountId = validateNullableId(patch.selectedAccountId, '账户标识');
  }

  if ('selectedVersionId' in patch) {
    next.selectedVersionId = validateNullableId(patch.selectedVersionId, '版本标识');
  }

  if ('memoryMb' in patch) {
    const value = patch.memoryMb;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      fail('CONFIG_INVALID_MEMORY', '内存大小必须为整数');
    }
    if (value < MEMORY_MIN_MB || value > MEMORY_MAX_MB) {
      fail('CONFIG_INVALID_MEMORY', `内存大小需在 ${MEMORY_MIN_MB} 到 ${MEMORY_MAX_MB} MB 之间`);
    }
    next.memoryMb = value;
  }

  if ('javaPath' in patch) {
    const value = patch.javaPath;
    if (value === null) {
      next.javaPath = null;
    } else if (typeof value !== 'string') {
      fail('CONFIG_INVALID_JAVA_PATH', 'Java 路径必须为字符串或 null');
    } else {
      if (value.length > PATH_MAX_LENGTH) {
        fail('CONFIG_INVALID_JAVA_PATH', `Java 路径长度不能超过 ${PATH_MAX_LENGTH} 个字符`);
      }
      if (!path.isAbsolute(value)) {
        fail('CONFIG_INVALID_JAVA_PATH', 'Java 路径必须是绝对路径');
      }
      next.javaPath = path.normalize(value);
    }
  }

  if ('accountMode' in patch) {
    const value = patch.accountMode;
    if (!isAccountMode(value)) {
      fail('CONFIG_INVALID_ACCOUNT_MODE', '账户模式只能是 offline 或 microsoft');
    }
    next.accountMode = value;
  }

  if ('memoryOptimizeOnLaunch' in patch) {
    const value = patch.memoryOptimizeOnLaunch;
    if (typeof value !== 'boolean') {
      fail('CONFIG_INVALID_MEMORY_OPTIMIZE', '内存优化开关必须为布尔值');
    }
    next.memoryOptimizeOnLaunch = value;
  }

  if ('serverChannel' in patch) {
    const value = patch.serverChannel;
    if (value !== 'channel1' && value !== 'channel2') {
      fail('CONFIG_INVALID_SERVER_CHANNEL', '服务端通道只能是 channel1 或 channel2');
    }
    next.serverChannel = value;
  }

  if ('channel1Url' in patch) {
    const value = patch.channel1Url;
    if (typeof value !== 'string') {
      fail('CONFIG_INVALID_CHANNEL_URL', '通道1地址必须为字符串');
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      next.channel1Url = '';
    } else {
      const normalized = normalizeServerUrl(trimmed);
      if (!normalized) {
        fail('CONFIG_INVALID_CHANNEL_URL', '通道1地址格式不正确，需以 http:// 或 https:// 开头');
      }
      next.channel1Url = normalized;
    }
  }

  if ('channel2Url' in patch) {
    const value = patch.channel2Url;
    if (typeof value !== 'string') {
      fail('CONFIG_INVALID_CHANNEL_URL', '通道2地址必须为字符串');
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      next.channel2Url = '';
    } else {
      const normalized = normalizeServerUrl(trimmed);
      if (!normalized) {
        fail('CONFIG_INVALID_CHANNEL_URL', '通道2地址格式不正确，需以 http:// 或 https:// 开头');
      }
      next.channel2Url = normalized;
    }
  }

  try {
    writeConfigFile(next);
  } catch (error) {
    logLine(`保存配置失败：${error instanceof Error ? error.message : '未知错误'}`);
    fail('CONFIG_WRITE_FAILED', '保存配置失败，请检查磁盘权限');
  }
  cachedConfig = next;
  return { ...next };
}

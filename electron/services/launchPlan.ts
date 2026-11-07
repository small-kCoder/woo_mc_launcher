import path from 'node:path';
import type { VersionJson, VersionLibrary, VersionRule } from './versions';
import { fail } from './errors';
import { getCurrentArch, ruleAllows } from './libraryRules';

/** 版本 id 规则与 versions.ts 保持一致，避免路径穿越 */
const VERSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_LAUNCHER_NAME = 'WooLauncher';
/** 内存允许范围与 config.ts 保持一致（MB） */
const MEMORY_MIN_MB = 512;
const MEMORY_MAX_MB = 8192;
const CLASSPATH_SEPARATOR = ';';
const USER_PROPERTIES = '{}';
const JAVA_LIBRARY_PATH_FLAG = '-Djava.library.path=';

/** 启动时需要的账户数据，由调用方（launcher）从账户服务读取 */
export interface LaunchAccount {
  name: string;
  uuid: string;
  accessToken: string;
  userType: 'legacy' | 'msa';
  xuid?: string;
  clientId?: string;
}

export interface BuildLaunchPlanOptions {
  versionId: string;
  versionJson: VersionJson;
  gameDir: string;
  javaPath: string;
  account: LaunchAccount;
  memoryMb: number;
  launcherName?: string;
  launcherVersion?: string;
}

export interface LaunchPlan {
  javaPath: string;
  args: string[];
  cwd: string;
  classpath: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(code, message);
  }
  return value;
}

/** 解析库文件相对路径，拒绝越界片段；失败返回 null */
function resolveArtifactPath(gameDir: string, library: VersionLibrary): string | null {
  const artifact = library.downloads?.artifact;
  if (!artifact || typeof artifact.path !== 'string' || artifact.path.length === 0) {
    return null;
  }
  const segments = artifact.path.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null;
  }
  return path.join(gameDir, 'libraries', ...segments);
}

/** 处理 arguments 数组：字符串直接用，对象按 rules 过滤后展开 value */
function collectArguments(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      result.push(entry);
      continue;
    }
    if (!isPlainObject(entry)) {
      continue;
    }
    const rules = Array.isArray(entry.rules) ? (entry.rules as VersionRule[]) : undefined;
    if (!ruleAllows(rules, getCurrentArch())) {
      continue;
    }
    const value = entry.value;
    if (typeof value === 'string') {
      result.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          result.push(item);
        }
      }
    }
  }
  return result;
}

/** 日志配置文件名：与安装器的命名规则保持一致 */
function resolveLoggingFileId(versionJson: VersionJson): string | null {
  const file = versionJson.logging?.client?.file;
  if (!file || typeof file.url !== 'string' || file.url.length === 0) {
    return null;
  }
  const id = typeof file.id === 'string' ? file.id : '';
  if (/^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..')) {
    return id;
  }
  try {
    const name = path.posix.basename(new URL(file.url).pathname);
    return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..') ? name : null;
  } catch {
    return null;
  }
}

/** 旧版参数模板按空白切分；替换后含空白的值用引号包裹，避免 spawn 参数被拆散 */
function buildLegacyArguments(template: string, replacements: Record<string, string>): string[] {
  return template
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const value = substitutePlaceholders(token, replacements);
      return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
    });
}

function substitutePlaceholders(token: string, replacements: Record<string, string>): string {
  return token.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => replacements[key] ?? '');
}

/**
 * 构建启动计划（纯函数：不读盘、不探测、不启动进程）。
 * 1.13+ 使用 arguments.jvm / arguments.game；1.7.10–1.12.2 使用 minecraftArguments。
 */
export function buildLaunchPlan(options: BuildLaunchPlanOptions): LaunchPlan {
  const versionId = requireText(options.versionId, 'LAUNCH_INVALID_VERSION_ID', '版本号不能为空');
  if (!VERSION_ID_PATTERN.test(versionId) || versionId.includes('..')) {
    fail('LAUNCH_INVALID_VERSION_ID', '版本号包含非法字符');
  }

  const gameDir = requireText(options.gameDir, 'LAUNCH_INVALID_GAME_DIR', '游戏目录不能为空');
  if (!path.isAbsolute(gameDir)) {
    fail('LAUNCH_INVALID_GAME_DIR', '游戏目录必须是绝对路径');
  }
  const javaPath = requireText(options.javaPath, 'LAUNCH_INVALID_JAVA', 'Java 路径不能为空');
  if (!path.isAbsolute(javaPath)) {
    fail('LAUNCH_INVALID_JAVA', 'Java 路径必须是绝对路径');
  }

  const memoryMb = options.memoryMb;
  if (!Number.isInteger(memoryMb) || memoryMb < MEMORY_MIN_MB || memoryMb > MEMORY_MAX_MB) {
    fail('LAUNCH_INVALID_MEMORY', `内存大小需在 ${MEMORY_MIN_MB} 到 ${MEMORY_MAX_MB} MB 之间`);
  }

  const json = options.versionJson;
  const mainClass = requireText(json.mainClass, 'LAUNCH_INVALID_VERSION', '版本缺少主类信息，无法启动');
  const assetIndex = json.assetIndex;
  if (!assetIndex || typeof assetIndex.id !== 'string' || assetIndex.id.length === 0) {
    fail('LAUNCH_INVALID_VERSION', '版本缺少资源索引信息，无法启动');
  }
  const assetIndexId = assetIndex.id;
  const assetsName = typeof json.assets === 'string' && json.assets.length > 0 ? json.assets : assetIndexId;
  const versionType = typeof json.type === 'string' && json.type.length > 0 ? json.type : 'release';

  const account = options.account;
  if (!isPlainObject(account)) {
    fail('LAUNCH_INVALID_ACCOUNT', '账户信息不完整，请重新选择账户');
  }
  const accountName = requireText(account.name, 'LAUNCH_INVALID_ACCOUNT', '账户名称缺失，请重新选择账户');
  const accountUuid = requireText(account.uuid, 'LAUNCH_INVALID_ACCOUNT', '账户 UUID 缺失，请重新选择账户');
  const accessToken = requireText(account.accessToken, 'LAUNCH_ACCOUNT_TOKEN_MISSING', '账户令牌缺失，请重新登录');
  if (account.userType !== 'legacy' && account.userType !== 'msa') {
    fail('LAUNCH_INVALID_ACCOUNT', '账户类型不合法，请重新选择账户');
  }

  /* ------------------------------ 路径与 classpath ------------------------------ */
  const versionDir = path.join(gameDir, 'versions', versionId);
  const nativesDir = path.join(versionDir, 'natives');
  const librariesDir = path.join(gameDir, 'libraries');
  const assetsDir = path.join(gameDir, 'assets');
  const clientJar = path.join(versionDir, `${versionId}.jar`);

  const libraries: VersionLibrary[] = Array.isArray(json.libraries)
    ? json.libraries.filter((item): item is VersionLibrary => isPlainObject(item))
    : [];
  const classpathEntries: string[] = [];
  const seen = new Set<string>();
  for (const library of libraries) {
    if (!ruleAllows(library.rules, getCurrentArch())) {
      continue;
    }
    const artifactPath = resolveArtifactPath(gameDir, library);
    if (!artifactPath) {
      continue;
    }
    const key = artifactPath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    classpathEntries.push(artifactPath);
  }
  classpathEntries.push(clientJar);
  const classpath = classpathEntries.join(CLASSPATH_SEPARATOR);

  const replacements: Record<string, string> = {
    natives_directory: nativesDir,
    classpath,
    classpath_separator: CLASSPATH_SEPARATOR,
    library_directory: librariesDir,
    launcher_name: options.launcherName ?? DEFAULT_LAUNCHER_NAME,
    launcher_version: options.launcherVersion ?? '',
    version_name: versionId,
    game_directory: gameDir,
    assets_root: assetsDir,
    assets_index_name: assetsName,
    auth_player_name: accountName,
    auth_uuid: accountUuid,
    auth_access_token: accessToken,
    user_type: account.userType,
    version_type: versionType,
    user_properties: USER_PROPERTIES,
    clientid: account.clientId ?? '',
    auth_xuid: account.xuid ?? '',
    primary_jar: clientJar
  };

  /* ------------------------------ JVM 公共参数 ------------------------------ */
  const baseJvm: string[] = [
    `-Xmx${memoryMb}m`,
    '-Xms512m',
    `${JAVA_LIBRARY_PATH_FLAG}${nativesDir}`
  ];

  const loggingFile = resolveLoggingFileId(json);
  if (loggingFile) {
    const loggingPath = path.join(assetsDir, 'log_configs', loggingFile);
    const argument = json.logging?.client?.argument;
    const flag =
      typeof argument === 'string' && argument.includes('${path}')
        ? argument.replace(/\$\{path\}/g, loggingPath)
        : `-Dlog4j.configurationFile=${loggingPath}`;
    baseJvm.push(flag);
  }

  /* ------------------------------ 参数组装 ------------------------------ */
  const args: string[] = [...baseJvm];

  if (Array.isArray(json.arguments?.jvm) || Array.isArray(json.arguments?.game)) {
    const jvmArgs = collectArguments(json.arguments?.jvm).map((token) =>
      substitutePlaceholders(token, replacements)
    );
    const gameArgs = collectArguments(json.arguments?.game).map((token) =>
      substitutePlaceholders(token, replacements)
    );

    // 1.13+ 固定追加账号相关参数（模板已包含时不重复，避免同名参数出现两次）
    // [原代码]: 无条件追加空字符串，离线账户会产出 `--clientId  --xuid ` 空参数
    if (account.clientId && !gameArgs.includes('--clientId')) {
      gameArgs.push('--clientId', account.clientId);
    }
    if (account.xuid && !gameArgs.includes('--xuid')) {
      gameArgs.push('--xuid', account.xuid);
    }
    if (!gameArgs.includes('--userProperties')) {
      gameArgs.push('--userProperties', USER_PROPERTIES);
    }
    if (!gameArgs.includes('--userType')) {
      gameArgs.push('--userType', account.userType);
    }
    // 个别版本的 jvm 数组缺少 -cp 时补齐，避免找不到主类
    if (!jvmArgs.includes('-cp') && !jvmArgs.includes('-classpath')) {
      jvmArgs.push('-cp', classpath);
    }

    // [原代码]: 直接 args.push(...jvmArgs, mainClass, ...gameArgs)
    // 版本模板里自带 `--clientId ${clientid}` / `--xuid ${auth_xuid}`；
    // 离线账户替换后是空字符串，这里移除整组空参数，避免向游戏传递无值选项
    for (const flag of ['--clientId', '--xuid']) {
      let index = gameArgs.indexOf(flag);
      while (index !== -1) {
        if (gameArgs[index + 1] === '') {
          gameArgs.splice(index, 2);
        } else {
          index = gameArgs.indexOf(flag, index + 2);
        }
      }
    }

    args.push(...jvmArgs, mainClass, ...gameArgs);
    return { javaPath, args, cwd: gameDir, classpath };
  }

  const template =
    typeof json.minecraftArguments === 'string' && json.minecraftArguments.trim().length > 0
      ? json.minecraftArguments
      : null;
  if (!template) {
    fail('LAUNCH_INVALID_VERSION', '版本缺少启动参数模板，无法启动');
  }
  const legacyArgs = buildLegacyArguments(template, replacements);
  args.push('-cp', classpath, mainClass, ...legacyArgs);
  return { javaPath, args, cwd: gameDir, classpath };
}

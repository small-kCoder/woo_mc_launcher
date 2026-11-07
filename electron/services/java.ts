import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { JavaInfo } from '../../src/types/ipc';
import { getConfig, updateConfig } from './config';
import { fail } from './errors';
import { getRuntimeJavaDir } from './paths';

/** 探测版本时的超时（毫秒） */
const PROBE_TIMEOUT_MS = 3000;
/** Java 路径长度上限 */
const PATH_MAX_LENGTH = 4096;
const JAVA_EXE_NAME = 'java.exe';

interface JavaVersion {
  version: string;
  major: number;
}

/** 按真实路径缓存版本探测结果，避免重复启动子进程 */
const versionCache = new Map<string, JavaVersion | null>();
/** resolveJava 的结果缓存；undefined 表示尚未解析 */
let resolvedJava: JavaInfo | null | undefined;

function normalizeKey(javaPath: string): string {
  return path.resolve(javaPath).toLowerCase();
}

/** 从 -version 输出中解析版本号，如 27.0.1 / 1.8.0_391 */
function parseVersionText(text: string): JavaVersion | null {
  const match = text.match(/version\s+"([^"]+)"/i);
  if (!match) {
    return null;
  }
  const version = match[1].trim();
  const segments = version.split(/[._\-+]/);
  let major = Number.parseInt(segments[0] ?? '', 10);
  // 1.8.0_391 这类旧式版本号取第二段
  if (major === 1 && segments.length > 1) {
    major = Number.parseInt(segments[1] ?? '', 10);
  }
  if (!Number.isInteger(major) || major <= 0) {
    return null;
  }
  return { version, major };
}

/** 执行 java -version 读取版本，失败或超时返回 null */
function readVersion(javaPath: string): JavaVersion | null {
  const key = normalizeKey(javaPath);
  if (versionCache.has(key)) {
    return versionCache.get(key) ?? null;
  }
  let version: JavaVersion | null = null;
  try {
    const result = spawnSync(javaPath, ['-version'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true
    });
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    version = parseVersionText(output);
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

/** 构建 JavaInfo；文件不存在或无法取版本时返回 null */
function buildInfo(javaPath: string, source: JavaInfo['source']): JavaInfo | null {
  if (!fs.existsSync(javaPath)) {
    return null;
  }
  const version = readVersion(javaPath);
  if (!version) {
    return null;
  }
  return { path: javaPath, version: version.version, major: version.major, source };
}

/** 读取注册表 JavaSoft 下的 JavaHome，失败静默 */
function readRegistryJavaHomes(): string[] {
  if (process.platform !== 'win32') {
    return [];
  }
  const keys = ['HKLM\\SOFTWARE\\JavaSoft\\JDK', 'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit'];
  const homes: string[] = [];
  for (const key of keys) {
    try {
      const output = execFileSync('reg', ['query', key, '/s', '/v', 'JavaHome'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true
      });
      for (const line of output.split(/\r?\n/)) {
        const matched = line.match(/JavaHome\s+REG_SZ\s+(.+)$/);
        if (matched) {
          homes.push(matched[1].trim());
        }
      }
    } catch {
      // 键不存在或读取失败时静默跳过
    }
  }
  return homes;
}

/** 列出目录下的子目录，读取失败返回空数组 */
function listSubdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 按 JAVA_HOME、注册表、Program Files 的顺序收集系统 Java 候选路径 */
function collectSystemCandidates(): string[] {
  const candidates: string[] = [];
  const addHome = (home: string | undefined | null): void => {
    if (!home) {
      return;
    }
    const normalized = home.trim().replace(/^"|"$/g, '');
    if (normalized.length === 0) {
      return;
    }
    const exe = path.join(normalized, 'bin', JAVA_EXE_NAME);
    if (fs.existsSync(exe)) {
      candidates.push(exe);
    }
  };

  addHome(process.env.JAVA_HOME);
  for (const home of readRegistryJavaHomes()) {
    addHome(home);
  }

  const programRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'];
  for (const root of programRoots) {
    if (!root) {
      continue;
    }
    for (const sub of listSubdirs(path.join(root, 'Java'))) {
      addHome(sub);
    }
  }

  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = normalizeKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 自带运行时（runtime/java）信息，缺失时返回 null */
export function getBundledJavaInfo(): JavaInfo | null {
  return buildInfo(path.join(getRuntimeJavaDir(), 'bin', JAVA_EXE_NAME), 'bundled');
}

/**
 * 解析要使用的 Java：用户配置 → 自带运行时 → 系统探测。
 * 结果带缓存，配置变化时由 resetJavaResolution 清除。
 */
export function resolveJava(): JavaInfo | null {
  if (resolvedJava !== undefined) {
    return resolvedJava ? { ...resolvedJava } : null;
  }

  const configured = (() => {
    try {
      return getConfig().javaPath;
    } catch {
      return null;
    }
  })();
  if (configured) {
    const info = buildInfo(configured, 'config');
    if (info) {
      resolvedJava = info;
      return { ...info };
    }
  }

  const bundled = getBundledJavaInfo();
  if (bundled) {
    resolvedJava = bundled;
    return { ...bundled };
  }

  for (const exe of collectSystemCandidates()) {
    const info = buildInfo(exe, 'system');
    if (info) {
      resolvedJava = info;
      return { ...info };
    }
  }

  resolvedJava = null;
  return null;
}

/** 列出所有探测到的 Java（配置项 / 自带 / 系统） */
export async function listDetectedJavas(): Promise<JavaInfo[]> {
  const result: JavaInfo[] = [];
  const seen = new Set<string>();
  const push = (info: JavaInfo | null): void => {
    if (!info) {
      return;
    }
    const key = normalizeKey(info.path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(info);
  };

  const configured = (() => {
    try {
      return getConfig().javaPath;
    } catch {
      return null;
    }
  })();
  if (configured) {
    push(buildInfo(configured, 'config'));
  }
  push(getBundledJavaInfo());
  for (const exe of collectSystemCandidates()) {
    push(buildInfo(exe, 'system'));
  }
  return result;
}

/** 设置并持久化自定义 Java 路径，校验文件存在且能读取版本 */
export async function setJavaPath(input: string): Promise<JavaInfo> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    fail('JAVA_PATH_INVALID', 'Java 路径不能为空');
  }
  if (input.length > PATH_MAX_LENGTH) {
    fail('JAVA_PATH_INVALID', `Java 路径长度不能超过 ${PATH_MAX_LENGTH} 个字符`);
  }
  if (!path.isAbsolute(input)) {
    fail('JAVA_PATH_INVALID', 'Java 路径必须是绝对路径');
  }
  const target = path.normalize(input);
  let exists = false;
  try {
    exists = fs.statSync(target).isFile();
  } catch {
    exists = false;
  }
  if (!exists) {
    fail('JAVA_NOT_FOUND', '指定的 java.exe 不存在');
  }
  const info = buildInfo(target, 'config');
  if (!info) {
    fail('JAVA_VERSION_UNAVAILABLE', '无法获取该 Java 的版本信息，请确认文件可执行');
  }
  updateConfig({ javaPath: target });
  resolvedJava = info;
  return { ...info };
}

/** 清除 resolveJava 的结果缓存（配置中的 Java 路径变化后调用） */
export function resetJavaResolution(): void {
  resolvedJava = undefined;
}

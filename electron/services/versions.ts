import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config';
import { fail } from './errors';
import { getGameDir } from './paths';

/** 版本 id 允许的字符集：禁止 / \ .. 等路径穿越字符 */
const VERSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface VersionRule {
  action?: string;
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

export interface VersionDownload {
  path?: string;
  sha1?: string;
  size?: number;
  url?: string;
}

export interface VersionLibrary {
  name?: string;
  rules?: VersionRule[];
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
  /** Fabric 等加载器的 Maven 基础地址与校验信息（不含 downloads.artifact） */
  url?: string;
  sha1?: string;
  size?: number;
  downloads?: {
    artifact?: VersionDownload;
    classifiers?: Record<string, VersionDownload>;
  };
}

/** 版本 JSON 中本项目会用到的字段，其余字段保留为未知 */
export interface VersionJson {
  id?: string;
  type?: string;
  releaseTime?: string;
  mainClass?: string;
  inheritsFrom?: string;
  assets?: string;
  assetIndex?: VersionDownload & { id?: string; totalSize?: number; virtual?: boolean };
  downloads?: { client?: VersionDownload };
  libraries?: VersionLibrary[];
  logging?: {
    client?: {
      argument?: string;
      type?: string;
      file?: VersionDownload & { id?: string };
    };
  };
  minecraftArguments?: string;
  arguments?: Record<string, unknown>;
  javaVersion?: { majorVersion?: number };
  /** 启动器写入的加载器元数据（Fabric 等） */
  woo?: {
    loader?: string;
    loaderVersion?: string;
    gameVersion?: string;
  };
  [key: string]: unknown;
}

/** 当前生效的游戏目录（来自配置，缺失时回退便携默认目录） */
export function getGameDirectory(): string {
  try {
    const configured = getConfig().gameDir;
    if (configured) {
      return path.normalize(configured);
    }
  } catch {
    // 配置读取失败时使用默认目录
  }
  return getGameDir();
}

/**
 * 校验版本 id：只允许字母、数字、点、下划线与连字符，且禁止路径穿越。
 * 非法输入抛出中文错误，供 IPC 层直接透传。
 */
export function assertVersionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('VERSION_INVALID_ID', '版本号不能为空');
  }
  if (!VERSION_ID_PATTERN.test(value) || value.includes('..')) {
    fail('VERSION_INVALID_ID', '版本号包含非法字符');
  }
  return value;
}

export function getVersionDir(id: string): string {
  return path.join(getGameDirectory(), 'versions', assertVersionId(id));
}

export function getVersionJsonPath(id: string): string {
  const safeId = assertVersionId(id);
  return path.join(getGameDirectory(), 'versions', safeId, `${safeId}.json`);
}

export function getVersionJarPath(id: string): string {
  const safeId = assertVersionId(id);
  return path.join(getGameDirectory(), 'versions', safeId, `${safeId}.jar`);
}

/**
 * 把目标路径限制在游戏目录内：normalize 后校验前缀，越界抛错。
 * 用于所有下载/解压目标路径，防止版本 JSON 中的路径造成目录穿越。
 */
export function assertInsideGameDir(target: string, gameDir: string = getGameDirectory()): string {
  const root = path.resolve(gameDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  const escapes = relative.startsWith('..') || path.isAbsolute(relative);
  // Windows 路径大小写不敏感，统一用小写前缀兜底判断
  const lowerRoot = root.toLowerCase();
  const lowerResolved = resolved.toLowerCase();
  const prefixOk =
    lowerResolved === lowerRoot ||
    lowerResolved.startsWith(`${lowerRoot}${path.sep}`) ||
    lowerResolved.startsWith(`${lowerRoot}/`);
  if (escapes || !prefixOk) {
    fail('INSTALL_PATH_ESCAPE', '路径超出游戏目录范围，已拒绝操作');
  }
  return resolved;
}

/** 读取并解析版本 JSON；文件缺失或损坏时给出中文错误 */
export function readVersionJson(id: string): VersionJson {
  const file = getVersionJsonPath(id);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail('VERSION_NOT_FOUND', '版本文件不存在，请先安装该版本');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('VERSION_JSON_INVALID', '版本文件已损坏，请重新安装该版本');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('VERSION_JSON_INVALID', '版本文件已损坏，请重新安装该版本');
  }
  return parsed as VersionJson;
}



import fs from 'node:fs';
import path from 'node:path';
import type { VersionSummary } from '../../src/types/ipc';
import { getConfig } from './config';
import { fail } from './errors';
import { logLine } from './logger';
import { getGameDir } from './paths';

/** 版本 id 允许的字符集：禁止 / \ .. 等路径穿越字符 */
const VERSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_TYPES = new Set(['release', 'snapshot', 'old_beta', 'old_alpha']);

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

/** 版本 id 是否可用于路径拼接（扫描时静默过滤，不抛错） */
function isValidVersionId(value: string): boolean {
  return VERSION_ID_PATTERN.test(value) && !value.includes('..');
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

/** 尝试解析版本 JSON，失败返回 null（用于幂等跳过判断） */
function tryReadVersionJson(file: string): VersionJson | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as VersionJson;
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 版本是否安装完整：扫描器只认 <id>.json 与 <id>.jar 同时存在，
 * 半装目录（只有其中之一）不视为已安装。
 */
export function isVersionInstalled(id: string): boolean {
  let safeId: string;
  try {
    safeId = assertVersionId(id);
  } catch {
    return false;
  }
  const jsonFile = getVersionJsonPath(safeId);
  const jarFile = getVersionJarPath(safeId);
  if (!isFile(jsonFile) || !isFile(jarFile)) {
    return false;
  }
  return tryReadVersionJson(jsonFile) !== null;
}

/** 从版本 JSON 提取版本类型，未知类型归为 unknown */
function normalizeType(value: unknown): string {
  return typeof value === 'string' && VERSION_TYPES.has(value) ? value : 'unknown';
}

/** 扫描版本目录并返回摘要，releaseTime 倒序 */
export function listVersions(): VersionSummary[] {
  const gameDir = getGameDirectory();
  const versionsDir = path.join(gameDir, 'versions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: VersionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!isValidVersionId(entry.name)) {
      logLine(`忽略非法版本目录：${entry.name}`);
      continue;
    }
    const jsonFile = path.join(versionsDir, entry.name, `${entry.name}.json`);
    const jarFile = path.join(versionsDir, entry.name, `${entry.name}.jar`);
    if (!isFile(jsonFile)) {
      // 没有版本 JSON 的半装目录无法展示，但仍可在安装时被覆盖
      continue;
    }
    const json = tryReadVersionJson(jsonFile);
    if (!json) {
      logLine(`版本文件损坏，已跳过：${entry.name}`);
      continue;
    }
    if (!isFile(jarFile)) {
      // 半装目录（缺少 jar）不进入版本列表，但仍可在安装时被覆盖
      logLine(`忽略半装版本目录：${entry.name}`);
      continue;
    }
    let mtime: Date;
    try {
      mtime = fs.statSync(jsonFile).mtime;
    } catch {
      mtime = new Date(0);
    }
    const releaseTimeRaw = json.releaseTime;
    const releaseTime =
      typeof releaseTimeRaw === 'string' && Number.isFinite(Date.parse(releaseTimeRaw))
        ? new Date(releaseTimeRaw).toISOString()
        : mtime.toISOString();
    const javaMajor = json.javaVersion?.majorVersion;
    const summary: VersionSummary = {
      id: entry.name,
      type: normalizeType(json.type),
      releaseTime,
      installed: true
    };
    if (typeof javaMajor === 'number' && Number.isInteger(javaMajor) && javaMajor > 0) {
      summary.javaMajor = javaMajor;
    }
    summaries.push(summary);
  }

  summaries.sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime));
  return summaries;
}

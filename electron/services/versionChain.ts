import fs from 'node:fs';
import path from 'node:path';
import type { VersionSummary } from '../../src/types/ipc';
import { fail } from './errors';
import { logLine } from './logger';
import {
  assertVersionId,
  getGameDirectory,
  getVersionDir,
  getVersionJarPath,
  getVersionJsonPath,
  readVersionJson,
  type VersionJson,
  type VersionLibrary
} from './versions';

/** 继承链最大层数：原版 + 最多 3 层加载器/整合层 */
const MAX_INHERIT_DEPTH = 4;
const VERSION_TYPES = new Set(['release', 'snapshot', 'old_beta', 'old_alpha']);

export interface ResolvedVersion {
  /** 请求的版本 id（子版本） */
  id: string;
  /** 合并父版本后的完整 JSON */
  json: VersionJson;
  /** 继承链最末端的原版 id */
  rootId: string;
  /** 继承顺序：[根原版, ..., 当前版本] */
  chain: string[];
  /** 根原版客户端 jar */
  clientJarPath: string;
  /** 根原版 natives 目录 */
  nativesDir: string;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function libraryKey(library: VersionLibrary): string {
  if (typeof library.name === 'string' && library.name.length > 0) {
    const parts = library.name.split(':');
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}`;
    }
    return library.name;
  }
  const artifactPath = library.downloads?.artifact?.path;
  return typeof artifactPath === 'string' && artifactPath.length > 0
    ? artifactPath
    : JSON.stringify(library);
}

/** 父依赖在前、子依赖在后；同名 group:artifact 由子版本覆盖 */
function mergeLibraries(
  parent: VersionLibrary[] | undefined,
  child: VersionLibrary[] | undefined
): VersionLibrary[] {
  const parentList = Array.isArray(parent) ? parent : [];
  const childList = Array.isArray(child) ? child : [];
  const childKeys = new Set(childList.map(libraryKey));
  return [...parentList.filter((item) => !childKeys.has(libraryKey(item))), ...childList];
}

function argumentList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** jvm 参数父+子拼接；game 参数子版本为空时沿用父版本，否则父+子 */
function mergeArguments(
  parent: Record<string, unknown> | undefined,
  child: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!parent && !child) {
    return undefined;
  }
  const parentJvm = argumentList(parent?.jvm);
  const childJvm = argumentList(child?.jvm);
  const parentGame = argumentList(parent?.game);
  const childGame = argumentList(child?.game);
  return {
    ...(parent ?? {}),
    ...(child ?? {}),
    jvm: [...parentJvm, ...childJvm],
    game: childGame.length > 0 ? [...parentGame, ...childGame] : parentGame
  };
}

function mergeVersionJson(parent: VersionJson, child: VersionJson, childId: string): VersionJson {
  return {
    ...parent,
    ...child,
    id: childId,
    type: typeof child.type === 'string' ? child.type : parent.type,
    releaseTime: child.releaseTime ?? parent.releaseTime,
    mainClass: child.mainClass ?? parent.mainClass,
    inheritsFrom: undefined,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: child.downloads ?? parent.downloads,
    logging: child.logging ?? parent.logging,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    libraries: mergeLibraries(parent.libraries, child.libraries),
    arguments: mergeArguments(parent.arguments, child.arguments)
  };
}

interface InternalChain {
  json: VersionJson;
  rootId: string;
  chain: string[];
}

function resolveInternal(id: string, seen: Set<string>, depth: number): InternalChain {
  const safeId = assertVersionId(id);
  if (seen.has(safeId)) {
    fail('VERSION_CHAIN_CYCLE', '版本继承关系存在循环，无法启动');
  }
  if (depth >= MAX_INHERIT_DEPTH) {
    fail('VERSION_CHAIN_TOO_DEEP', '版本继承层数过多，无法启动');
  }
  seen.add(safeId);
  const json = readVersionJson(safeId);
  const parentRaw = json.inheritsFrom;
  if (typeof parentRaw === 'string' && parentRaw.length > 0) {
    let parentId: string;
    try {
      parentId = assertVersionId(parentRaw);
    } catch {
      fail('VERSION_CHAIN_INVALID', '版本继承信息不合法，无法启动');
    }
    const parent = resolveInternal(parentId, seen, depth + 1);
    return {
      json: mergeVersionJson(parent.json, json, safeId),
      rootId: parent.rootId,
      chain: [...parent.chain, safeId]
    };
  }
  return { json, rootId: safeId, chain: [safeId] };
}

/**
 * 解析版本继承链并合并 JSON。
 * 适用于原版版本与 Fabric 等继承版本；缺失父版本时抛出中文错误。
 */
export function resolveVersionChain(id: string): ResolvedVersion {
  const safeId = assertVersionId(id);
  const resolved = resolveInternal(safeId, new Set(), 0);
  return {
    id: safeId,
    json: resolved.json,
    rootId: resolved.rootId,
    chain: resolved.chain,
    clientJarPath: getVersionJarPath(resolved.rootId),
    nativesDir: path.join(getVersionDir(resolved.rootId), 'natives')
  };
}

/** 版本是否安装完整：JSON 可解析且继承链根原版 jar 存在 */
export function isVersionInstalled(id: string): boolean {
  try {
    return isFile(resolveVersionChain(id).clientJarPath);
  } catch {
    return false;
  }
}

function normalizeType(value: unknown): string {
  return typeof value === 'string' && VERSION_TYPES.has(value) ? value : 'unknown';
}

function readWooMetadata(json: VersionJson): { loader?: 'fabric'; baseVersion?: string } {
  const woo = json.woo;
  if (typeof woo !== 'object' || woo === null || Array.isArray(woo)) {
    return {};
  }
  const result: { loader?: 'fabric'; baseVersion?: string } = {};
  if (woo.loader === 'fabric') {
    result.loader = 'fabric';
  }
  if (typeof woo.gameVersion === 'string' && woo.gameVersion.length > 0) {
    result.baseVersion = woo.gameVersion;
  }
  return result;
}

/** 扫描版本目录：支持没有独立 jar 的继承版本，releaseTime 倒序 */
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
    let safeId: string;
    try {
      safeId = assertVersionId(entry.name);
    } catch {
      logLine(`忽略非法版本目录：${entry.name}`);
      continue;
    }
    if (!isFile(getVersionJsonPath(safeId))) {
      continue;
    }
    let resolved: ResolvedVersion;
    try {
      resolved = resolveVersionChain(safeId);
    } catch (error) {
      logLine(
        `版本无法解析，已跳过：${safeId}（${error instanceof Error ? error.message : String(error)}）`
      );
      continue;
    }
    if (!isFile(resolved.clientJarPath)) {
      logLine(`忽略半装版本目录：${safeId}`);
      continue;
    }
    let mtime: Date;
    try {
      mtime = fs.statSync(getVersionJsonPath(safeId)).mtime;
    } catch {
      mtime = new Date(0);
    }
    const releaseTimeRaw = resolved.json.releaseTime;
    const releaseTime =
      typeof releaseTimeRaw === 'string' && Number.isFinite(Date.parse(releaseTimeRaw))
        ? new Date(releaseTimeRaw).toISOString()
        : mtime.toISOString();
    const javaMajor = resolved.json.javaVersion?.majorVersion;
    const summary: VersionSummary = {
      id: safeId,
      type: normalizeType(resolved.json.type),
      releaseTime,
      installed: true
    };
    if (typeof javaMajor === 'number' && Number.isInteger(javaMajor) && javaMajor > 0) {
      summary.javaMajor = javaMajor;
    }
    const woo = readWooMetadata(resolved.json);
    if (woo.loader) {
      summary.loader = woo.loader;
    }
    if (woo.baseVersion) {
      summary.baseVersion = woo.baseVersion;
    } else if (resolved.rootId !== safeId) {
      summary.baseVersion = resolved.rootId;
    }
    summaries.push(summary);
  }

  summaries.sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime));
  return summaries;
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import type {
  ModDependency,
  ModFile,
  ModImportResult,
  ModMetadata,
  ModsSnapshot
} from '../../src/types/ipc';
import { getConfig } from './config';
import { fail } from './errors';
import { logLine } from './logger';
import { getGameDirectory, getVersionDir } from './versions';
import {
  listZipEntryNames,
  readZipEntry,
  readZipEntryText,
  readZipEntryTextFromBuffer
} from './zipText';
import { removeInstallRecord } from './modStore';

/** 单次导入的文件数量与单文件大小上限 */
const MAX_IMPORT_FILES = 50;
const MAX_MOD_BYTES = 512 * 1024 * 1024;
const METADATA_CACHE_LIMIT = 500;
/** 这些依赖由游戏/加载器/Java 提供，不参与缺失检查 */
const BUILTIN_DEPENDENCIES = new Set(['minecraft', 'fabricloader', 'java']);
/** 嵌套模组（Fabric 的 jar-in-jar）扫描限制 */
const NESTED_JAR_PREFIX = 'META-INF/jars/';
const MAX_NESTED_JARS = 40;
const MAX_NESTED_JAR_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;

interface ModsContext {
  directory: string;
  versionId: string | null;
}

interface RawMetadata {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  authors: string[];
  requires: Array<{ id: string; requirement?: string }>;
  /** 该模组额外提供的模块 id（fabric.mod.json 的 provides） */
  provides: string[];
}

interface CachedMetadata {
  mtimeMs: number;
  size: number;
  raw: RawMetadata | null;
}

interface ScannedMod {
  fileName: string;
  fullPath: string;
  enabled: boolean;
  size: number;
  modifiedAt: string;
  stat: fs.Stats;
}

const metadataCache = new Map<string, CachedMetadata>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJarName(name: string): boolean {
  return name.toLowerCase().endsWith('.jar');
}

function isDisabledJarName(name: string): boolean {
  return name.toLowerCase().endsWith('.jar.disabled');
}

/** 当前模组目录：按版本隔离且已选择版本时使用 versions/<id>/mods */
function getModsContext(): ModsContext {
  const config = getConfig();
  if (config.modsIsolated && config.selectedVersionId) {
    try {
      return {
        directory: path.join(getVersionDir(config.selectedVersionId), 'mods'),
        versionId: config.selectedVersionId
      };
    } catch {
      // 版本 id 非法时回退全局目录
    }
  }
  return {
    directory: path.join(getGameDirectory(), 'mods'),
    versionId: null
  };
}

export function getModsDirectory(): string {
  return getModsContext().directory;
}

/** 校验文件名并返回目录内绝对路径，拒绝路径穿越 */
function resolveModFile(rawFileName: unknown): { fullPath: string; fileName: string } {
  if (typeof rawFileName !== 'string' || rawFileName.length === 0 || rawFileName.length > 255) {
    fail('MOD_INVALID_NAME', '模组文件名不合法');
  }
  const fileName = rawFileName;
  if (
    fileName !== path.basename(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..')
  ) {
    fail('MOD_INVALID_NAME', '模组文件名不合法');
  }
  if (!isJarName(fileName) && !isDisabledJarName(fileName)) {
    fail('MOD_INVALID_FILE', '不是 .jar 模组文件');
  }
  const directory = getModsDirectory();
  const fullPath = path.join(directory, fileName);
  const relative = path.relative(path.resolve(directory), path.resolve(fullPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('MOD_PATH_ESCAPE', '模组路径超出目录范围');
  }
  return { fullPath, fileName };
}

function parseAuthors(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function parseDepends(value: unknown): Array<{ id: string; requirement?: string }> {
  if (!isPlainObject(value)) {
    return [];
  }
  const result: Array<{ id: string; requirement?: string }> = [];
  for (const [id, raw] of Object.entries(value)) {
    if (!id || id.length > 128) {
      continue;
    }
    let requirement: string | undefined;
    if (typeof raw === 'string') {
      requirement = raw;
    } else if (Array.isArray(raw)) {
      const parts = raw.filter((item): item is string => typeof item === 'string');
      requirement = parts.length > 0 ? parts.join(' || ') : undefined;
    }
    result.push({ id, requirement });
  }
  return result;
}

/** 解析 fabric.mod.json 的文本内容；缺少合法 id 时返回 null */
function parseMetadata(text: string): RawMetadata | null {
  try {
    // 部分压缩工具会给 JSON 写入 UTF-8 BOM，解析前先去掉
    const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, '').trim());
    if (!isPlainObject(raw)) {
      return null;
    }
    const id = raw.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      return null;
    }
    return {
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
      version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : undefined,
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : undefined,
      authors: parseAuthors(raw.authors),
      requires: parseDepends(raw.depends),
      provides: Array.isArray(raw.provides)
        ? raw.provides.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : []
    };
  } catch {
    return null;
  }
}

/**
 * 扫描 jar 内置的嵌套模组（META-INF/jars/*.jar）的 id 与 provides。
 * Xaero's Minimap、Iris 等会把前置或 Fabric API 模块打包在内部，用于消除误报。
 */
function readNestedModuleIds(fullPath: string): string[] {
  const names = listZipEntryNames(fullPath, NESTED_JAR_PREFIX, '.jar', MAX_NESTED_JARS);
  const ids: string[] = [];
  for (const name of names) {
    const nested = readZipEntry(fullPath, name, MAX_NESTED_JAR_BYTES);
    if (!nested) {
      continue;
    }
    const text = readZipEntryTextFromBuffer(nested, 'fabric.mod.json', MAX_METADATA_BYTES);
    if (!text) {
      continue;
    }
    const parsed = parseMetadata(text);
    if (!parsed) {
      continue;
    }
    ids.push(parsed.id, ...parsed.provides);
  }
  return ids;
}

function readRawMetadata(fullPath: string, stat: fs.Stats): RawMetadata | null {
  const key = `${fullPath}|${Math.floor(stat.mtimeMs)}|${stat.size}`;
  const cached = metadataCache.get(key);
  if (cached) {
    return cached.raw;
  }
  const text = readZipEntryText(fullPath, 'fabric.mod.json', MAX_METADATA_BYTES);
  const raw = text ? parseMetadata(text) : null;
  if (raw) {
    const nested = readNestedModuleIds(fullPath);
    if (nested.length > 0) {
      raw.provides = Array.from(new Set([...raw.provides, ...nested]));
    }
  }
  if (metadataCache.size >= METADATA_CACHE_LIMIT) {
    metadataCache.clear();
  }
  metadataCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, raw });
  return raw;
}

function scanModFiles(directory: string): ScannedMod[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: ScannedMod[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const enabled = isJarName(entry.name);
    if (!enabled && !isDisabledJarName(entry.name)) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      result.push({
        fileName: entry.name,
        fullPath,
        enabled,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        stat
      });
    } catch {
      // 单个文件读取失败时跳过
    }
  }
  return result;
}

function displayNameOf(mod: ModFile): string {
  return mod.metadata?.name ?? mod.fileName.replace(/\.disabled$/i, '');
}

/** 依赖是否已满足：内置模块、已启用模组 id/provides，以及 Fabric API 提供的全部 fabric-* 模块 */
function isDependencySatisfied(id: string, enabledIds: Set<string>): boolean {
  if (BUILTIN_DEPENDENCIES.has(id) || enabledIds.has(id)) {
    return true;
  }
  // Fabric API 由 40+ 个嵌套模块组成，安装 fabric-api 即视为提供所有 fabric-* 模块
  return id.startsWith('fabric-') && enabledIds.has('fabric-api');
}

function buildModFile(scanned: ScannedMod, enabledIds: Set<string>): ModFile {
  const raw = readRawMetadata(scanned.fullPath, scanned.stat);
  let metadata: ModMetadata | null = null;
  if (raw) {
    const depends: ModDependency[] = raw.requires.map((item) => ({
      id: item.id,
      requirement: item.requirement,
      satisfied: isDependencySatisfied(item.id, enabledIds)
    }));
    metadata = {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      description: raw.description,
      authors: raw.authors,
      loader: 'fabric',
      depends,
      missing: depends.filter((item) => !item.satisfied).map((item) => item.id)
    };
  }
  return {
    fileName: scanned.fileName,
    enabled: scanned.enabled,
    size: scanned.size,
    modifiedAt: scanned.modifiedAt,
    metadata
  };
}

/** 读取当前模组目录快照：启用状态、元数据与缺失依赖 */
export function getModsSnapshot(): ModsSnapshot {
  const config = getConfig();
  const context = getModsContext();
  const scanned = scanModFiles(context.directory);

  const enabledIds = new Set<string>();
  for (const item of scanned) {
    if (!item.enabled) {
      continue;
    }
    const raw = readRawMetadata(item.fullPath, item.stat);
    if (raw) {
      enabledIds.add(raw.id);
      for (const provided of raw.provides) {
        enabledIds.add(provided);
      }
    }
  }

  const mods = scanned.map((item) => buildModFile(item, enabledIds));
  mods.sort(
    (a, b) =>
      displayNameOf(a).localeCompare(displayNameOf(b), 'zh-CN') ||
      a.fileName.localeCompare(b.fileName)
  );

  return {
    directory: context.directory,
    isolated: config.modsIsolated,
    versionId: context.versionId,
    mods
  };
}

/** 启用/禁用模组：通过重命名 .jar 与 .jar.disabled */
export async function setModEnabled(fileName: string, enabled: boolean): Promise<ModsSnapshot> {
  const target = resolveModFile(fileName);
  const currentlyEnabled = isJarName(target.fileName);
  if (currentlyEnabled === enabled) {
    return getModsSnapshot();
  }

  const targetName = enabled
    ? target.fileName.slice(0, -'.disabled'.length)
    : `${target.fileName}.disabled`;
  if (!isJarName(targetName) && !isDisabledJarName(targetName)) {
    fail('MOD_INVALID_FILE', '模组文件名不合法');
  }
  const targetPath = path.join(path.dirname(target.fullPath), targetName);
  if (fs.existsSync(targetPath)) {
    fail('MOD_TARGET_EXISTS', '目标文件已存在，无法切换启用状态');
  }
  try {
    await fsp.rename(target.fullPath, targetPath);
  } catch (error) {
    fail(
      'MOD_RENAME_FAILED',
      `切换模组状态失败：${error instanceof Error ? error.message : '未知错误'}`
    );
  }
  logLine(`模组${enabled ? '启用' : '禁用'}：${target.fileName} → ${targetName}`);
  return getModsSnapshot();
}

/** 删除模组到系统回收站 */
export async function deleteMod(fileName: string): Promise<ModsSnapshot> {
  const target = resolveModFile(fileName);
  if (!fs.existsSync(target.fullPath)) {
    fail('MOD_NOT_FOUND', '模组文件不存在');
  }
  try {
    await shell.trashItem(target.fullPath);
  } catch (error) {
    fail(
      'MOD_DELETE_FAILED',
      `删除模组失败：${error instanceof Error ? error.message : '未知错误'}`
    );
  }
  removeInstallRecord(target.fileName);
  logLine(`模组已移入回收站：${target.fileName}`);
  return getModsSnapshot();
}

/** 创建并打开当前模组目录 */
export async function openModsDirectory(): Promise<void> {
  const directory = getModsDirectory();
  await fsp.mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) {
    fail('MODS_OPEN_FAILED', `无法打开模组目录：${error}`);
  }
}

/** 目标文件已存在时追加序号，避免静默覆盖用户已有模组 */
function uniqueDestination(directory: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(directory, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

/**
 * 把选中的 .jar 模组复制到当前模组目录。
 * 仅接受真实存在的 .jar 文件；同名文件自动追加序号，不覆盖。
 */
export async function importMods(paths: string[]): Promise<ModImportResult> {
  if (!Array.isArray(paths) || paths.length === 0) {
    fail('MODS_IMPORT_EMPTY', '没有选择任何模组文件');
  }
  if (paths.length > MAX_IMPORT_FILES) {
    fail('MODS_IMPORT_TOO_MANY', `一次最多导入 ${MAX_IMPORT_FILES} 个模组文件`);
  }

  const modsDir = getModsDirectory();
  await fsp.mkdir(modsDir, { recursive: true });

  const imported: string[] = [];
  const skipped: string[] = [];
  for (const rawPath of paths) {
    if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 4096) {
      skipped.push(String(rawPath));
      continue;
    }
    const source = path.resolve(rawPath);
    const fileName = path.basename(source);
    if (!isJarName(fileName)) {
      skipped.push(fileName);
      continue;
    }
    try {
      const stat = await fsp.stat(source);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MOD_BYTES) {
        skipped.push(fileName);
        continue;
      }
      const destination = uniqueDestination(modsDir, fileName);
      await fsp.copyFile(source, destination);
      imported.push(path.basename(destination));
    } catch {
      skipped.push(fileName);
    }
  }

  logLine(`导入模组：成功 ${imported.length} 个，跳过 ${skipped.length} 个`);
  return { imported, skipped };
}

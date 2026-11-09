import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { net } from 'electron';
import type { ModDependencyInstallResult } from '../../src/types/ipc';
import { getConfig } from './config';
import { downloadFile } from './downloader';
import { fail } from './errors';
import { logLine } from './logger';
import { getModsDirectory } from './mods';
import { resolveVersionChain } from './versionChain';

const MODRINTH_API = 'https://api.modrinth.com/v2';
/** Modrinth 要求带可识别的 User-Agent */
const USER_AGENT = 'woo-mc-launcher/1.1.0 (local portable launcher)';
const REQUEST_TIMEOUT_MS = 12_000;
/** 依赖递归深度：主模组 → 前置 → 前置的前置 */
const MAX_DEPTH = 3;
const MAX_INSTALLED = 20;
const MAX_REQUEST_IDS = 50;

interface ModrinthFile {
  url?: string;
  filename?: string;
  size?: number;
  primary?: boolean;
  hashes?: { sha1?: string; sha512?: string };
}

interface ModrinthDependency {
  version_id?: string | null;
  project_id?: string | null;
  dependency_type?: string;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  name?: string;
  version_number?: string;
  game_versions?: string[];
  loaders?: string[];
  files?: ModrinthFile[];
  dependencies?: ModrinthDependency[];
}

interface ModrinthProject {
  id: string;
  slug?: string;
  title?: string;
}

interface ModrinthSearchHit {
  project_id: string;
  slug?: string;
  title?: string;
}

interface ModrinthSearchResult {
  hits?: ModrinthSearchHit[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await net.fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.status === 404) {
        throw new AppError404();
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AppError404) {
        throw error;
      }
      lastError = error;
      if (attempt === 0) {
        await sleep(400);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

class AppError404 extends Error {
  constructor() {
    super('404');
  }
}

async function tryProject(idOrSlug: string): Promise<ModrinthProject | null> {
  try {
    return await fetchJson<ModrinthProject>(
      `${MODRINTH_API}/project/${encodeURIComponent(idOrSlug)}`
    );
  } catch (error) {
    if (error instanceof AppError404) {
      return null;
    }
    throw error;
  }
}

async function searchProject(modId: string, gameVersion: string): Promise<ModrinthSearchHit | null> {
  const facets = JSON.stringify([
    ['project_type:mod'],
    ['categories:fabric'],
    [`versions:${gameVersion}`]
  ]);
  const url =
    `${MODRINTH_API}/search?limit=5&index=relevance` +
    `&query=${encodeURIComponent(modId)}` +
    `&facets=${encodeURIComponent(facets)}`;
  const result = await fetchJson<ModrinthSearchResult>(url);
  const hits = Array.isArray(result.hits) ? result.hits : [];
  if (hits.length === 0) {
    return null;
  }
  const exact = hits.find(
    (hit) => hit.slug?.toLowerCase() === modId.toLowerCase() || hit.project_id === modId
  );
  return exact ?? hits[0];
}

/** 把 Fabric API 的模块 id（fabric-*）归到 fabric-api 项目 */
function projectSlugFor(modId: string): string {
  const normalized = modId.trim().toLowerCase();
  if (normalized === 'fabric-api' || normalized.startsWith('fabric-')) {
    return 'fabric-api';
  }
  return normalized;
}

/** 解析依赖 id 对应的 Modrinth 项目：先按 slug 直查，失败再搜索 */
async function resolveProject(modId: string, gameVersion: string): Promise<ModrinthProject | null> {
  const direct = await tryProject(projectSlugFor(modId));
  if (direct) {
    return direct;
  }
  const hit = await searchProject(modId, gameVersion);
  if (!hit) {
    return null;
  }
  return { id: hit.project_id, slug: hit.slug, title: hit.title };
}

/** 选择与当前 MC 版本 + Fabric 兼容的最新版本 */
async function fetchBestVersion(
  projectId: string,
  gameVersion: string
): Promise<ModrinthVersion | null> {
  const url =
    `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify(['fabric']))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await fetchJson<ModrinthVersion[]>(url);
  if (!Array.isArray(versions) || versions.length === 0) {
    return null;
  }
  for (const version of versions) {
    const files = Array.isArray(version.files) ? version.files : [];
    if (files.some((file) => typeof file.url === 'string' && file.url.length > 0)) {
      return version;
    }
  }
  return null;
}

async function fetchVersionById(versionId: string): Promise<ModrinthVersion | null> {
  try {
    return await fetchJson<ModrinthVersion>(
      `${MODRINTH_API}/version/${encodeURIComponent(versionId)}`
    );
  } catch (error) {
    if (error instanceof AppError404) {
      return null;
    }
    throw error;
  }
}

/** 当前所选版本的根原版版本，用于 Modrinth 兼容性筛选 */
function resolveTargetGameVersion(): string {
  const config = getConfig();
  if (!config.selectedVersionId) {
    fail('MOD_DEP_NO_VERSION', '请先选择一个已安装的游戏版本');
  }
  try {
    return resolveVersionChain(config.selectedVersionId).rootId;
  } catch {
    fail('MOD_DEP_NO_VERSION', '无法确定当前游戏版本，请重新选择版本');
  }
}

function isOutsideMods(directory: string, target: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative.startsWith('..') || path.isAbsolute(relative);
}

/** 目标文件已存在且大小一致时复用，否则追加序号避免覆盖 */
function resolveDestination(directory: string, fileName: string, size?: number): string {
  const candidate = path.join(directory, fileName);
  if (isOutsideMods(directory, candidate)) {
    fail('MOD_DEP_INVALID_FILE', '依赖文件名不合法');
  }
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile() && (size === undefined || stat.size === size)) {
      return candidate;
    }
  } catch {
    return candidate;
  }
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let index = 1; index < 100; index += 1) {
    const next = path.join(directory, `${base}-${index}${ext}`);
    if (!fs.existsSync(next)) {
      return next;
    }
  }
  fail('MOD_DEP_INVALID_FILE', '无法生成可用的依赖文件名');
}

interface InstallContext {
  directory: string;
  gameVersion: string;
  visited: Set<string>;
  result: ModDependencyInstallResult;
}

async function installProject(
  project: ModrinthProject,
  label: string,
  depth: number,
  context: InstallContext
): Promise<void> {
  if (context.visited.has(project.id)) {
    return;
  }
  if (context.result.installed.length >= MAX_INSTALLED) {
    return;
  }
  context.visited.add(project.id);

  const version = await fetchBestVersion(project.id, context.gameVersion);
  if (!version) {
    context.result.failed.push({
      id: label,
      message: `未找到兼容 ${context.gameVersion} 的 Fabric 版本`
    });
    return;
  }
  const files = Array.isArray(version.files) ? version.files : [];
  const file = files.find((item) => item.primary) ?? files[0];
  if (
    !file ||
    typeof file.url !== 'string' ||
    file.url.length === 0 ||
    typeof file.filename !== 'string' ||
    file.filename.length === 0
  ) {
    context.result.failed.push({ id: label, message: '版本缺少可下载文件' });
    return;
  }

  const destination = resolveDestination(context.directory, path.basename(file.filename), file.size);
  await downloadFile(file.url, destination, {
    expectedSize: file.size,
    sha1: file.hashes?.sha1
  });
  const fileName = path.basename(destination);
  context.result.installed.push({
    id: label,
    name: version.name ?? project.title ?? label,
    version: version.version_number ?? '',
    fileName
  });
  logLine(`依赖已安装：${label} ${version.version_number ?? ''} → ${fileName}`);

  if (depth >= MAX_DEPTH) {
    return;
  }
  const dependencies = Array.isArray(version.dependencies) ? version.dependencies : [];
  for (const dependency of dependencies) {
    if (dependency.dependency_type !== 'required') {
      continue;
    }
    let projectId = dependency.project_id ?? null;
    let depLabel = projectId ?? '';
    if (!projectId && dependency.version_id) {
      const depVersion = await fetchVersionById(dependency.version_id);
      if (depVersion) {
        projectId = depVersion.project_id;
        depLabel = projectId;
      }
    }
    if (!projectId) {
      continue;
    }
    try {
      await installProject({ id: projectId }, depLabel || projectId, depth + 1, context);
    } catch (error) {
      context.result.failed.push({
        id: depLabel || projectId,
        message: error instanceof Error ? error.message : '依赖下载失败'
      });
    }
  }
}

/**
 * 一键安装缺失依赖：Fabric API 模块会自动归到 fabric-api，
 * 其他 id 先按 slug 查 Modrinth，再搜索兼容当前 MC 版本的 Fabric 模组，并递归安装必需前置。
 */
export async function installMissingModDependencies(
  modIds: string[]
): Promise<ModDependencyInstallResult> {
  if (!Array.isArray(modIds) || modIds.length === 0) {
    fail('MOD_DEP_EMPTY', '没有需要安装的依赖');
  }
  const ids: string[] = [];
  for (const raw of modIds) {
    if (typeof raw !== 'string') {
      continue;
    }
    const id = raw.trim();
    if (id.length === 0 || id.length > 128) {
      continue;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    fail('MOD_DEP_EMPTY', '没有需要安装的依赖');
  }
  if (ids.length > MAX_REQUEST_IDS) {
    fail('MOD_DEP_TOO_MANY', `一次最多处理 ${MAX_REQUEST_IDS} 个依赖`);
  }

  const gameVersion = resolveTargetGameVersion();
  const directory = getModsDirectory();
  await fsp.mkdir(directory, { recursive: true });

  const context: InstallContext = {
    directory,
    gameVersion,
    visited: new Set<string>(),
    result: { installed: [], failed: [] }
  };

  for (const id of ids) {
    try {
      const project = await resolveProject(id, gameVersion);
      if (!project) {
        context.result.failed.push({ id, message: '未在 Modrinth 找到对应模组' });
        continue;
      }
      await installProject(project, id, 0, context);
    } catch (error) {
      context.result.failed.push({
        id,
        message: error instanceof Error ? error.message : '安装依赖失败'
      });
    }
  }

  logLine(
    `一键安装依赖：成功 ${context.result.installed.length} 个，失败 ${context.result.failed.length} 个`
  );
  return context.result;
}

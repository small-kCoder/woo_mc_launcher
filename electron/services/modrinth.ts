import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { net, shell } from 'electron';
import type {
  ModDependencyInstallResult,
  ModUpdateInfo,
  ModUpdatesResult,
  OnlineModHit,
  OnlineModSearchResult
} from '../../src/types/ipc';
import { getConfig } from './config';
import { downloadFile } from './downloader';
import { fail } from './errors';
import { logLine } from './logger';
import {
  baseModFileName,
  getInstallRecord,
  listInstallRecords,
  saveInstallRecord
} from './modStore';
import { getModsDirectory, getModsSnapshot } from './mods';
import { resolveVersionChain } from './versionChain';
import { readZipEntryText } from './zipText';

/** Modrinth 官方接口，失败后回退国内镜像 */
const API_BASES = ['https://api.modrinth.com/v2', 'https://mod.mcimirror.top/modrinth/v2'];
/** 镜像同时代理 cdn.modrinth.com 的文件 */
const CDN_MIRROR = 'https://mod.mcimirror.top';
/** Modrinth 要求带可识别的 User-Agent */
const USER_AGENT = 'woo-mc-launcher/1.2.0 (local portable launcher)';
const REQUEST_TIMEOUT_MS = 12_000;
/** 依赖递归深度：主模组 → 前置 → 前置的前置 */
const MAX_DEPTH = 3;
const MAX_INSTALLED = 20;
const MAX_REQUEST_IDS = 50;
const SEARCH_PAGE_SIZE = 20;
const MAX_UPDATE_CHECK = 40;

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
  description?: string;
  author?: string;
  downloads?: number;
  follows?: number;
  icon_url?: string | null;
  categories?: string[];
}

interface ModrinthSearchResult {
  hits?: ModrinthSearchHit[];
  total_hits?: number;
}

/** 加载器标签不参与展示，避免每个模组都带 fabric */
const LOADER_TAGS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'liteloader', 'rift']);

class NotFoundError extends Error {
  constructor() {
    super('404');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 依次尝试官方与镜像接口；两个来源都 404 时抛 NotFoundError */
async function requestJson<T>(pathAndQuery: string): Promise<T> {
  let lastError: unknown = null;
  let notFoundCount = 0;
  for (const base of API_BASES) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await net.fetch(`${base}${pathAndQuery}`, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (response.status === 404) {
          notFoundCount += 1;
          break;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(350);
        }
      }
    }
  }
  if (notFoundCount >= API_BASES.length) {
    throw new NotFoundError();
  }
  throw lastError instanceof Error ? lastError : new Error('Modrinth 请求失败');
}

function mirrorFileUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'cdn.modrinth.com') {
      return null;
    }
    return `${CDN_MIRROR}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** 下载模组文件；官方 CDN 失败时改用镜像地址重试 */
async function downloadModFile(file: ModrinthFile, dest: string): Promise<void> {
  const url = typeof file.url === 'string' ? file.url : '';
  if (!url) {
    throw new Error('缺少下载地址');
  }
  const options = { expectedSize: file.size, sha1: file.hashes?.sha1 };
  try {
    await downloadFile(url, dest, options);
  } catch (error) {
    const mirror = mirrorFileUrl(url);
    if (!mirror) {
      throw error;
    }
    logLine(`模组下载失败，改用镜像重试：${mirror}`);
    await downloadFile(mirror, dest, options);
  }
}

async function tryProject(idOrSlug: string): Promise<ModrinthProject | null> {
  try {
    return await requestJson<ModrinthProject>(`/project/${encodeURIComponent(idOrSlug)}`);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }
    throw error;
  }
}

async function searchProject(
  modId: string,
  gameVersion: string
): Promise<ModrinthSearchHit | null> {
  const facets = JSON.stringify([
    ['project_type:mod'],
    ['categories:fabric'],
    [`versions:${gameVersion}`]
  ]);
  const url =
    `/search?limit=5&index=relevance` +
    `&query=${encodeURIComponent(modId)}` +
    `&facets=${encodeURIComponent(facets)}`;
  const result = await requestJson<ModrinthSearchResult>(url);
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
    `/project/${encodeURIComponent(projectId)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify(['fabric']))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await requestJson<ModrinthVersion[]>(url);
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
    return await requestJson<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
  } catch (error) {
    if (error instanceof NotFoundError) {
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

/** 读取模组 jar 内的 fabric.mod.json id，用于去重 */
function readModId(jarPath: string): string | null {
  const text = readZipEntryText(jarPath, 'fabric.mod.json');
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, '').trim());
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 安装后清理同 id 的其他 jar，避免游戏加载重复模组 */
async function removeDuplicateMods(
  directory: string,
  keepFileName: string,
  jarPath: string
): Promise<void> {
  const modId = readModId(jarPath);
  if (!modId) {
    return;
  }
  let mods;
  try {
    mods = getModsSnapshot().mods;
  } catch {
    return;
  }
  for (const mod of mods) {
    if (mod.fileName === keepFileName) {
      continue;
    }
    if (!mod.metadata || mod.metadata.id.toLowerCase() !== modId.toLowerCase()) {
      continue;
    }
    const target = path.join(directory, mod.fileName);
    try {
      await shell.trashItem(target);
      logLine(`清理重复模组：${mod.fileName}（同 id：${modId}）`);
    } catch (error) {
      logLine(
        `清理重复模组失败：${mod.fileName}（${error instanceof Error ? error.message : String(error)}）`
      );
    }
  }
}

function pickPrimaryFile(version: ModrinthVersion): ModrinthFile | null {
  const files = Array.isArray(version.files) ? version.files : [];
  const file = files.find((item) => item.primary) ?? files[0];
  if (
    !file ||
    typeof file.url !== 'string' ||
    file.url.length === 0 ||
    typeof file.filename !== 'string' ||
    file.filename.length === 0
  ) {
    return null;
  }
  return file;
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
  const file = pickPrimaryFile(version);
  if (!file) {
    context.result.failed.push({ id: label, message: '版本缺少可下载文件' });
    return;
  }

  // 同名同大小视为已安装；否则下载，并在下载后按 fabric.mod.json 的 id 去重
  const destination = resolveDestination(context.directory, path.basename(file.filename!), file.size);
  await downloadModFile(file, destination);
  const fileName = path.basename(destination);
  await removeDuplicateMods(context.directory, fileName, destination);
  const title = version.name ?? project.title ?? label;
  context.result.installed.push({
    id: label,
    name: title,
    version: version.version_number ?? '',
    fileName
  });
  saveInstallRecord({
    projectId: project.id,
    slug: project.slug ?? null,
    title,
    versionId: version.id,
    versionNumber: version.version_number ?? '',
    fileName,
    installedAt: new Date().toISOString(),
    source: 'modrinth'
  });
  logLine(`模组已安装：${label} ${version.version_number ?? ''} → ${fileName}`);

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

/* ------------------------------ 在线搜索与安装 ------------------------------ */

/** 本地已安装版本：优先安装记录，其次按模组 id 与项目 slug 匹配 */
function buildInstalledIndex(): {
  byProject: Map<string, string>;
  byModId: Map<string, string | null>;
} {
  const byProject = new Map<string, string>();
  for (const record of listInstallRecords()) {
    byProject.set(record.projectId, record.versionNumber);
  }
  const byModId = new Map<string, string | null>();
  try {
    for (const mod of getModsSnapshot().mods) {
      if (mod.metadata) {
        byModId.set(mod.metadata.id.toLowerCase(), mod.metadata.version ?? null);
      }
    }
  } catch {
    // 读取失败时只依赖安装记录
  }
  return { byProject, byModId };
}

/** 在线搜索模组：自动限定当前 MC 版本与 Fabric 加载器 */
export async function searchOnlineMods(
  query: string,
  offset = 0
): Promise<OnlineModSearchResult> {
  const gameVersion = resolveTargetGameVersion();
  const keyword = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const safeOffset = Number.isInteger(offset) && offset > 0 ? Math.min(offset, 500) : 0;
  const facets = JSON.stringify([
    ['project_type:mod'],
    ['categories:fabric'],
    [`versions:${gameVersion}`]
  ]);
  const url =
    `/search?limit=${SEARCH_PAGE_SIZE}&offset=${safeOffset}&index=relevance` +
    `&query=${encodeURIComponent(keyword)}` +
    `&facets=${encodeURIComponent(facets)}`;
  const result = await requestJson<ModrinthSearchResult>(url);
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const index = buildInstalledIndex();

  const mapped: OnlineModHit[] = hits.map((hit) => {
    const slug = typeof hit.slug === 'string' ? hit.slug : null;
    const installedVersion =
      index.byProject.get(hit.project_id) ??
      (slug ? index.byModId.get(slug.toLowerCase()) ?? null : null);
    return {
      projectId: hit.project_id,
      slug,
      title: typeof hit.title === 'string' && hit.title.length > 0 ? hit.title : slug ?? hit.project_id,
      description: typeof hit.description === 'string' ? hit.description : '',
      author: typeof hit.author === 'string' ? hit.author : '',
      downloads: typeof hit.downloads === 'number' ? hit.downloads : 0,
      follows: typeof hit.follows === 'number' ? hit.follows : 0,
      iconUrl: typeof hit.icon_url === 'string' && hit.icon_url.length > 0 ? hit.icon_url : null,
      categories: Array.isArray(hit.categories)
        ? hit.categories.filter((item) => !LOADER_TAGS.has(item.toLowerCase())).slice(0, 4)
        : [],
      installedVersion: installedVersion ?? null
    };
  });

  return {
    hits: mapped,
    total: typeof result.total_hits === 'number' ? result.total_hits : mapped.length,
    offset: safeOffset,
    gameVersion
  };
}

/** 安装指定项目的最新兼容版本，并递归安装必需前置 */
export async function installOnlineMod(projectId: string): Promise<ModDependencyInstallResult> {
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 64) {
    fail('MOD_DEP_EMPTY', '模组标识不正确');
  }
  const gameVersion = resolveTargetGameVersion();
  const directory = getModsDirectory();
  await fsp.mkdir(directory, { recursive: true });

  const project = await tryProject(projectId);
  if (!project) {
    fail('MOD_NOT_FOUND', '未在 Modrinth 找到该模组');
  }
  const context: InstallContext = {
    directory,
    gameVersion,
    visited: new Set<string>(),
    result: { installed: [], failed: [] }
  };
  await installProject(project, project.slug ?? project.title ?? projectId, 0, context);
  logLine(`在线安装：${project.title ?? projectId} 成功 ${context.result.installed.length} 个`);
  return context.result;
}

/* ------------------------------ 更新检测 ------------------------------ */

/** 检测通过启动器安装的模组是否有兼容当前版本的新版本 */
export async function checkModUpdates(): Promise<ModUpdatesResult> {
  const gameVersion = resolveTargetGameVersion();
  const directory = getModsDirectory();
  const records = listInstallRecords().slice(0, MAX_UPDATE_CHECK);
  const updates: ModUpdateInfo[] = [];

  for (const record of records) {
    const baseName = baseModFileName(record.fileName);
    const enabledPath = path.join(directory, baseName);
    const disabledPath = `${enabledPath}.disabled`;
    if (!fs.existsSync(enabledPath) && !fs.existsSync(disabledPath)) {
      continue;
    }
    try {
      const latest = await fetchBestVersion(record.projectId, gameVersion);
      if (!latest || !latest.version_number || latest.id === record.versionId) {
        continue;
      }
      updates.push({
        fileName: record.fileName,
        baseFileName: baseName,
        title: record.title,
        projectId: record.projectId,
        installedVersion: record.versionNumber,
        latestVersion: latest.version_number
      });
    } catch (error) {
      logLine(
        `检查更新失败：${record.title}（${error instanceof Error ? error.message : String(error)}）`
      );
    }
  }

  updates.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return { updates, gameVersion };
}

/** 把指定模组更新到最新兼容版本，保留启用/禁用状态 */
export async function updateOnlineMod(fileName: string): Promise<ModDependencyInstallResult> {
  const record = getInstallRecord(fileName);
  if (!record) {
    fail('MOD_UPDATE_NO_RECORD', '该模组不是通过启动器安装的，无法自动更新');
  }
  const gameVersion = resolveTargetGameVersion();
  const directory = getModsDirectory();
  const latest = await fetchBestVersion(record.projectId, gameVersion);
  if (!latest) {
    fail('MOD_UPDATE_NO_VERSION', `未找到兼容 ${gameVersion} 的新版本`);
  }
  const file = pickPrimaryFile(latest);
  if (!file) {
    fail('MOD_UPDATE_NO_VERSION', '新版本缺少可下载文件');
  }

  const baseName = path.basename(file.filename!);
  const currentBase = baseModFileName(record.fileName);
  const currentEnabled = path.join(directory, currentBase);
  const currentDisabled = `${currentEnabled}.disabled`;
  const wasDisabled = fs.existsSync(currentDisabled) && !fs.existsSync(currentEnabled);
  const oldPath = wasDisabled ? currentDisabled : currentEnabled;
  const targetName = wasDisabled ? `${baseName}.disabled` : baseName;
  const targetPath = path.join(directory, targetName);

  // 文件名变化时先清理旧文件，避免重复模组
  if (path.resolve(oldPath) !== path.resolve(targetPath) && fs.existsSync(oldPath)) {
    try {
      await shell.trashItem(oldPath);
    } catch (error) {
      logLine(
        `旧版本移入回收站失败：${oldPath}（${error instanceof Error ? error.message : String(error)}）`
      );
    }
  }

  await downloadModFile(file, targetPath);
  saveInstallRecord({
    projectId: record.projectId,
    slug: record.slug,
    title: record.title,
    versionId: latest.id,
    versionNumber: latest.version_number ?? '',
    fileName: targetName,
    installedAt: new Date().toISOString(),
    source: 'modrinth'
  });
  logLine(`模组已更新：${record.title} ${record.versionNumber} → ${latest.version_number ?? ''}`);

  return {
    installed: [
      {
        id: record.projectId,
        name: record.title,
        version: latest.version_number ?? '',
        fileName: targetName
      }
    ],
    failed: []
  };
}

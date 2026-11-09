import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { BrowserWindow, net } from 'electron';
import type { DownloadSource, InstallProgress, ManifestVersion } from '../../src/types/ipc';
import { AppError, fail } from './errors';
import { getConfig } from './config';
import { logLine } from './logger';
import {
  createSpeedMeter,
  downloadFile,
  isDownloadCancelled,
  runBatch,
  type BatchResult,
  type DownloadTask
} from './downloader';
import { getCurrentArch, ruleAllows } from './libraryRules';
import {
  assertInsideGameDir,
  assertVersionId,
  getGameDirectory,
  getVersionDir,
  getVersionJsonPath,
  readVersionJson,
  type VersionDownload,
  type VersionJson,
  type VersionLibrary
} from './versions';
import { isVersionInstalled, listVersions } from './versionChain';
import { fabricVersionId, fetchFabricProfile } from './fabric';
import { mavenDownloadUrl, mavenRelativePath, parseMavenName } from './maven';

/** 官方清单地址，主地址失败时回退到旧域名 */
const MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
];
const MANIFEST_TIMEOUT_MS = 15_000;
const MANIFEST_CACHE_MS = 10 * 60 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 100;
const DOWNLOAD_CONCURRENCY = 8;
/** 资源对象分批大小，避免一次性构造上万任务 */
const ASSET_BATCH_SIZE = 500;
/** 兼容范围下限 */
const MIN_SUPPORTED_VERSION = '1.7.10';
const MIN_SUPPORTED_RELEASE_TIME = Date.parse('2014-05-01T00:00:00Z');

const TASK_TEXT = {
  parse: '解析版本',
  client: '下载客户端',
  libraries: '下载依赖库',
  natives: '释放本地库',
  assetsIndex: '下载资源索引',
  assets: '下载资源',
  done: '完成'
} as const;

export type ManifestKind = 'release' | 'snapshot' | 'all';

interface RawManifestEntry {
  id: string;
  type: string;
  url: string;
  releaseTime: string;
  sha1?: string;
}

interface RawManifest {
  latest: { release: string; snapshot: string };
  versions: RawManifestEntry[];
}

interface NativeArchive {
  jarPath: string;
  exclude: string[];
}

interface AssetsIndex {
  objects?: Record<string, { hash?: string; size?: number }>;
  virtual?: boolean;
}

// [原代码]: let manifestCache: { fetchedAt: number; data: RawManifest } | null = null;
/** 清单缓存按下载源隔离，避免官方与通道缓存串用 */
const manifestCache = new Map<string, { fetchedAt: number; data: RawManifest }>();
/** 同一时刻只允许一个安装任务 */
let activeInstall: { id: string; controller: AbortController } | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按目标路径去重后的总字节（资源索引中同一 hash 可能对应多个路径） */
function uniqueSize(tasks: DownloadTask[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const task of tasks) {
    const key = task.dest.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    total += task.size ?? 0;
  }
  return total;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError('INSTALL_CANCELLED', '安装已取消');
  }
}

/* ------------------------------ 进度 ------------------------------ */

/** 进度聚合：按字节计算百分比，节流 ≤10 次/秒 */
class ProgressTracker {
  private totalBytes = 0;
  private doneBytes = 0;
  private lastEmitAt = 0;
  private taskText: string = TASK_TEXT.parse;
  private finished = false;
  /** 实时网络速度（字节/秒），由下载器采样后写入 */
  private bytesPerSecond = 0;

  constructor(
    private readonly versionId: string,
    private readonly onProgress?: (progress: InstallProgress) => void
  ) {}

  addTotal(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) {
      this.totalBytes += bytes;
    }
  }

  /** 总量修正（可为负），用于资源索引与实际对象总和对齐 */
  adjustTotal(delta: number): void {
    if (Number.isFinite(delta)) {
      this.totalBytes = Math.max(1, this.totalBytes + delta);
    }
  }

  addDone(bytes: number): void {
    this.doneBytes = Math.max(0, this.doneBytes + bytes);
    this.emit();
  }

  /** 更新实时下载速度，不单独触发事件，随下一次 addDone 一起发出 */
  setSpeed(bytesPerSecond: number): void {
    this.bytesPerSecond = Number.isFinite(bytesPerSecond) ? Math.max(0, Math.round(bytesPerSecond)) : 0;
  }

  setTask(text: string): void {
    this.taskText = text;
    // 阶段切换时清空速度，避免“释放本地库/解析版本”等阶段继续显示上一个下载速度
    this.bytesPerSecond = 0;
    this.emit(true);
  }

  percent(): number {
    if (this.totalBytes <= 0) {
      return 0;
    }
    return Math.min(99, Math.floor((this.doneBytes / this.totalBytes) * 100));
  }

  emit(force = false): void {
    if (this.finished || !this.onProgress) {
      return;
    }
    const now = Date.now();
    const percent = this.percent();
    // [原代码]: if (!force && (now - this.lastEmitAt < PROGRESS_MIN_INTERVAL_MS || percent === this.lastPercent)) return;
    // 不再因百分比未变化而跳过，保证下载速度数值持续刷新
    if (!force && now - this.lastEmitAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    this.lastEmitAt = now;
    this.onProgress({
      versionId: this.versionId,
      percent,
      taskText: this.taskText,
      done: false,
      bytesPerSecond: this.bytesPerSecond
    });
  }

  complete(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.onProgress?.({ versionId: this.versionId, percent: 100, taskText: TASK_TEXT.done, done: true, bytesPerSecond: 0 });
  }

  interrupt(error?: { code: string; message: string }, cancelled = false): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const progress: InstallProgress = {
      versionId: this.versionId,
      percent: this.percent(),
      taskText: this.taskText,
      done: true,
      bytesPerSecond: 0
    };
    if (cancelled) {
      progress.cancelled = true;
    }
    if (error) {
      progress.error = error;
    }
    this.onProgress?.(progress);
  }
}

/* ------------------------------ 事件 ------------------------------ */

export function emitInstallProgress(progress: InstallProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('install:progress', progress);
    }
  }
}

/** 推送最新扫描结果，供渲染进程刷新版本列表 */
export function emitVersionsChanged(): void {
  const versions = listVersions();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('versions:changed', versions);
    }
  }
}

/* ------------------------------ 清单 ------------------------------ */

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MANIFEST_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      fail('MANIFEST_HTTP_ERROR', `获取版本清单失败（HTTP ${response.status}）`);
    }
    return await response.json();
  } catch (error) {
    if (timedOut) {
      fail('MANIFEST_TIMEOUT', '获取版本清单超时，请检查网络连接');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 校验并规范化清单结构，过滤非法条目 */
function normalizeManifest(raw: unknown): RawManifest {
  if (!isPlainObject(raw) || !Array.isArray(raw.versions)) {
    fail('MANIFEST_INVALID', '版本清单格式不正确');
  }
  const versions: RawManifestEntry[] = [];
  for (const item of raw.versions) {
    if (!isPlainObject(item)) {
      continue;
    }
    if (
      typeof item.id !== 'string' ||
      typeof item.type !== 'string' ||
      typeof item.url !== 'string' ||
      !item.url.startsWith('https://')
    ) {
      continue;
    }
    versions.push({
      id: item.id,
      type: item.type,
      url: item.url,
      releaseTime: typeof item.releaseTime === 'string' ? item.releaseTime : '',
      sha1: typeof item.sha1 === 'string' ? item.sha1 : undefined
    });
  }
  const latest = isPlainObject(raw.latest) ? raw.latest : {};
  return {
    latest: {
      release: typeof latest.release === 'string' ? latest.release : '',
      snapshot: typeof latest.snapshot === 'string' ? latest.snapshot : ''
    },
    versions
  };
}

/** 下载源中文名 */
function sourceLabel(source: DownloadSource): string {
  return source === 'channel1' ? '通道1' : source === 'channel2' ? '通道2' : '官方源';
}

/** 通道源的基础地址；官方源返回 null。通道未配置时给出可读错误 */
function resolveSourceBase(source: DownloadSource): string | null {
  if (source === 'official') {
    return null;
  }
  const config = getConfig();
  const url = source === 'channel1' ? config.channel1Url : config.channel2Url;
  if (!url) {
    fail('DOWNLOAD_SOURCE_NOT_CONFIGURED', `${sourceLabel(source)}地址未配置，请先在服务端连接设置中填写`);
  }
  return url;
}

/** 拉取原始清单（按下载源缓存 10 分钟；官方主地址失败时回退备用地址） */
async function getRawManifest(source: DownloadSource = 'official'): Promise<RawManifest> {
  const base = resolveSourceBase(source);
  const cacheKey = base ? `${source}:${base}` : 'official';
  const cached = manifestCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MANIFEST_CACHE_MS) {
    return cached.data;
  }
  const urls = base ? [`${base}/version_manifest_v2.json`] : MANIFEST_URLS;
  let lastMessage = '';
  for (const url of urls) {
    try {
      const data = normalizeManifest(await fetchJson(url));
      manifestCache.set(cacheKey, { fetchedAt: Date.now(), data });
      logLine(`已获取${sourceLabel(source)}版本清单，共 ${data.versions.length} 个版本`);
      return data;
    } catch (error) {
      lastMessage = error instanceof Error && error.message ? error.message : '未知错误';
      const host = new URL(url).host;
      logLine(`版本清单地址不可用：${host}（${lastMessage}）`);
    }
  }
  fail(
    'MANIFEST_FETCH_FAILED',
    lastMessage ? `无法获取${sourceLabel(source)}版本清单：${lastMessage}` : `无法获取${sourceLabel(source)}版本清单，请检查网络连接`
  );
}

/** 按类型筛选清单，并标记本地已安装版本 */
export async function fetchManifest(kind: ManifestKind, source: DownloadSource = 'official'): Promise<ManifestVersion[]> {
  if (kind !== 'release' && kind !== 'snapshot' && kind !== 'all') {
    fail('MANIFEST_INVALID_KIND', '版本类型参数不正确');
  }
  const data = await getRawManifest(source);
  const installedIds = new Set(
    listVersions()
      .filter((version) => version.installed)
      .map((version) => version.id)
  );
  return data.versions
    .filter((entry) => kind === 'all' || entry.type === kind)
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      releaseTime: entry.releaseTime,
      installed: installedIds.has(entry.id)
    }));
}

/* ------------------------------ 版本兼容 ------------------------------ */

/** 比较数字型版本号，非纯数字（快照/旧版别名）返回 null */
function compareVersionId(target: string, base: string): number | null {
  if (!/^\d+(?:\.\d+)*$/.test(target) || !/^\d+(?:\.\d+)*$/.test(base)) {
    return null;
  }
  const a = target.split('.').map(Number);
  const b = base.split('.').map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

/** 兼容范围校验：仅允许 1.7.10 及以后的原版版本 */
function assertSupported(json: VersionJson, id: string): void {
  const unsupported = (): never => fail('INSTALL_UNSUPPORTED_VERSION', '当前仅支持 1.7.10 及以后的原版版本');
  if (typeof json.inheritsFrom === 'string' && json.inheritsFrom.length > 0) {
    unsupported();
  }
  if (typeof json.mainClass !== 'string' || json.mainClass.length === 0) {
    unsupported();
  }
  const index = json.assetIndex;
  if (!index || typeof index.url !== 'string' || typeof index.id !== 'string' || index.id.length === 0) {
    unsupported();
  }
  const hasArguments =
    typeof json.minecraftArguments === 'string' ||
    (isPlainObject(json.arguments) && Array.isArray((json.arguments as Record<string, unknown>).game));
  if (!hasArguments) {
    unsupported();
  }
  const comparison = compareVersionId(id, MIN_SUPPORTED_VERSION);
  if (comparison === null) {
    const releaseTime = typeof json.releaseTime === 'string' ? Date.parse(json.releaseTime) : Number.NaN;
    if (Number.isFinite(releaseTime) && releaseTime < MIN_SUPPORTED_RELEASE_TIME) {
      unsupported();
    }
    logLine(`版本 ${id} 的版本号无法比较，已按兼容范围放行`);
    return;
  }
  if (comparison < 0) {
    unsupported();
  }
}

/* ------------------------------ 依赖解析 ------------------------------ */

// [原代码]: currentArch / ruleMatches / ruleAllows 原位于本文件，现抽到 libraryRules.ts 与启动计划共用
// [原逻辑]: function currentArch() { return process.arch === 'x64' ? 'x86_64' : 'x86'; }
// [原逻辑]: function ruleMatches(...) 与 ruleAllows(...) 的规则判定逻辑已迁移到 libraryRules.ts

/** 解析库文件相对路径并限制在游戏目录内 */
function resolveLibraryPath(gameDir: string, relative: string | undefined): string | null {
  if (!relative || relative.length === 0) {
    return null;
  }
  const normalized = relative.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '..' || segment === '.')) {
    return null;
  }
  return assertInsideGameDir(path.join(gameDir, 'libraries', ...segments), gameDir);
}

/** 选择 Windows 本地库分类器：优先模板展开，回退常见命名 */
function selectNative(
  library: VersionLibrary,
  template: string,
  osArch: string
): (VersionDownload & { url: string }) | null {
  const classifiers = library.downloads?.classifiers;
  if (!classifiers) {
    return null;
  }
  const candidates = [template.replace(/\$\{arch\}/g, osArch)];
  if (template.includes('${arch}')) {
    candidates.push(osArch === 'x86_64' ? 'natives-windows-64' : 'natives-windows-32');
  }
  candidates.push('natives-windows');
  const seen = new Set<string>();
  for (const key of candidates) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const item = classifiers[key];
    if (item && typeof item.url === 'string' && item.url.length > 0) {
      return item as VersionDownload & { url: string };
    }
  }
  return null;
}

/* ------------------------------ ZIP 解压 ------------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 65_535);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new AppError('INSTALL_NATIVES_FAILED', '本地库文件格式不正确');
  }
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 判断解压条目是否应排除（目录、META-INF、extract.exclude） */
function isExcludedEntry(name: string, excludes: string[]): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..')) {
    return true;
  }
  const rules = [...excludes, 'META-INF/'];
  for (const rule of rules) {
    if (typeof rule !== 'string' || rule.length === 0) {
      continue;
    }
    const pattern = rule.replace(/\\/g, '/');
    if (pattern.endsWith('/')) {
      if (normalized.startsWith(pattern)) {
        return true;
      }
      continue;
    }
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
      if (new RegExp(`^${escaped}$`, 'i').test(normalized)) {
        return true;
      }
      continue;
    }
    if (normalized === pattern || normalized.startsWith(`${pattern}/`)) {
      return true;
    }
  }
  return false;
}

/** 解压本地库到 natives 目录，遵守 extract.exclude 并排除 META-INF */
async function extractNatives(jarFile: string, outDir: string, excludes: string[]): Promise<void> {
  const buffer = await fsp.readFile(jarFile);
  const entries = listZipEntries(buffer);
  const root = path.resolve(outDir);
  const rootPrefix = root.toLowerCase().endsWith(path.sep) ? root.toLowerCase() : `${root.toLowerCase()}${path.sep}`;

  for (const entry of entries) {
    if (entry.name.endsWith('/') || isExcludedEntry(entry.name, excludes)) {
      continue;
    }
    const relative = entry.name.replace(/\\/g, '/');
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.toLowerCase().startsWith(rootPrefix)) {
      logLine(`跳过越界的本地库条目：${entry.name}`);
      continue;
    }
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      continue;
    }
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) {
      continue;
    }
    const raw = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (entry.method === 0) {
      content = raw;
    } else if (entry.method === 8) {
      content = zlib.inflateRawSync(raw);
    } else {
      logLine(`跳过不支持的压缩方式：${entry.name}`);
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
}

/* ------------------------------ 下载编排 ------------------------------ */

function ensureBatchSuccess(result: BatchResult): void {
  if (result.cancelled) {
    throw new AppError('INSTALL_CANCELLED', '安装已取消');
  }
  if (result.failed.length > 0) {
    const first = result.failed[0];
    fail(
      'INSTALL_DOWNLOAD_FAILED',
      `下载失败：${first.message}（共 ${result.failed.length} 个文件未能完成）`
    );
  }
}

/** 批量下载并把字节进度折算到全局进度（总量由调用方提前登记） */
async function runTasks(tasks: DownloadTask[], tracker: ProgressTracker, signal?: AbortSignal): Promise<BatchResult> {
  let reported = 0;
  const result = await runBatch(tasks, {
    concurrency: DOWNLOAD_CONCURRENCY,
    signal,
    onProgress: (doneBytes, _totalBytes, bytesPerSecond) => {
      tracker.setSpeed(bytesPerSecond);
      tracker.addDone(doneBytes - reported);
      reported = doneBytes;
    }
  });
  ensureBatchSuccess(result);
  return result;
}

function safeFileName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return null;
  }
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..') ? value : null;
}

function fileNameFromUrl(url: string): string | null {
  try {
    const name = path.posix.basename(new URL(url).pathname);
    return safeFileName(name);
  } catch {
    return null;
  }
}

/** 按大小跳过已存在的虚拟资源副本 */
async function copyVirtualAsset(source: string, dest: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  try {
    const existing = await fsp.stat(dest);
    const sourceStat = await fsp.stat(source);
    if (existing.isFile() && existing.size === sourceStat.size) {
      return;
    }
  } catch {
    // 目标不存在或读取失败时继续复制
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(source, dest);
}

/** 解析并下载一个版本的全部依赖 */
async function runInstall(
  versionId: string,
  tracker: ProgressTracker,
  signal?: AbortSignal,
  source: DownloadSource = 'official'
): Promise<void> {
  const id = assertVersionId(versionId);
  const gameDir = getGameDirectory();
  const versionDir = assertInsideGameDir(getVersionDir(id), gameDir);
  const sourceBase = resolveSourceBase(source);
  if (sourceBase) {
    logLine(`安装 ${id}：版本清单与 client.jar 走${sourceLabel(source)}（${sourceBase}）`);
  }
  await fsp.mkdir(versionDir, { recursive: true });

  /* 1. 解析版本 JSON */
  tracker.setTask(TASK_TEXT.parse);
  let json: VersionJson | null = null;
  try {
    json = readVersionJson(id);
  } catch {
    json = null;
  }
  if (!json) {
    const entry = (await getRawManifest(source)).versions.find((item) => item.id === id);
    if (!entry) {
      fail('VERSION_NOT_FOUND', '版本不存在，请刷新版本列表后重试');
    }
    throwIfCancelled(signal);
    // [原代码]: const versionJsonUrl = entry.url;
    // 通道源从本地服务取同一份版本 JSON，依赖库与资源仍使用 JSON 内的官方地址
    const versionJsonUrl = sourceBase
      ? `${sourceBase}/${encodeURIComponent(id)}/${encodeURIComponent(id)}.json`
      : entry.url;
    logLine(`安装 ${id}：下载版本 JSON（${sourceLabel(source)}）`);
    await downloadFile(versionJsonUrl, getVersionJsonPath(id), {
      sha1: entry.sha1,
      signal,
      onTotal: (bytes) => tracker.addTotal(bytes),
      onBytes: (delta) => tracker.addDone(delta)
    });
    json = readVersionJson(id);
  }
  assertSupported(json, id);
  throwIfCancelled(signal);

  /* 2. 解析下载清单：提前收集客户端、依赖库、日志配置与资源索引，用于计算总字节 */
  const client = json.downloads?.client;
  if (!client || typeof client.url !== 'string' || client.url.length === 0) {
    fail('INSTALL_INVALID_VERSION', '版本缺少客户端下载信息，无法安装');
  }
  const osArch = getCurrentArch();
  const libraries: VersionLibrary[] = Array.isArray(json.libraries)
    ? json.libraries.filter((item): item is VersionLibrary => isPlainObject(item))
    : [];
  const libraryTasks: DownloadTask[] = [];
  const nativeArchives: NativeArchive[] = [];
  const nativeTasks: DownloadTask[] = [];
  const nativesDir = assertInsideGameDir(path.join(versionDir, 'natives'), gameDir);

  for (const library of libraries) {
    if (!ruleAllows(library.rules, osArch)) {
      continue;
    }
    const artifact = library.downloads?.artifact;
    if (artifact && typeof artifact.url === 'string' && artifact.url.length > 0) {
      const dest = resolveLibraryPath(gameDir, artifact.path);
      if (!dest) {
        logLine(`忽略缺少路径的依赖库：${library.name ?? '未知'}`);
      } else {
        libraryTasks.push({ url: artifact.url, dest, size: artifact.size, sha1: artifact.sha1 });
      }
    }
    const template = library.natives?.windows;
    if (typeof template === 'string' && template.length > 0) {
      const native = selectNative(library, template, osArch);
      if (!native) {
        logLine(`未找到 Windows 本地库：${library.name ?? '未知'}`);
        continue;
      }
      const dest =
        resolveLibraryPath(gameDir, native.path) ??
        assertInsideGameDir(
          path.join(nativesDir, '.jars', `${safeFileName(path.basename(native.url.split('?')[0])) ?? 'native'}.jar`),
          gameDir
        );
      nativeTasks.push({ url: native.url, dest, size: native.size, sha1: native.sha1 });
      nativeArchives.push({ jarPath: dest, exclude: library.extract?.exclude ?? [] });
    }
  }

  const logFile = json.logging?.client?.file;
  const logFileName =
    logFile && typeof logFile.url === 'string' && logFile.url.length > 0
      ? safeFileName(logFile.id) ?? fileNameFromUrl(logFile.url)
      : null;
  if (logFile && !logFileName) {
    logLine(`忽略非法日志配置文件名：${String(logFile.id ?? '')}`);
  }

  const assetIndex = json.assetIndex as NonNullable<VersionJson['assetIndex']>;
  if (!safeFileName(assetIndex.id)) {
    fail('INSTALL_INVALID_VERSION', '资源索引标识不合法，无法安装');
  }
  const indexId = assetIndex.id as string;
  const indexPath = assertInsideGameDir(
    path.join(gameDir, 'assets', 'indexes', `${indexId}.json`),
    gameDir
  );
  const assetsTotalEstimate =
    typeof assetIndex.totalSize === 'number' && assetIndex.totalSize > 0 ? assetIndex.totalSize : 0;

  // 预登记总字节：进度不会因后续阶段发现新文件而回退
  tracker.addTotal(uniqueSize(libraryTasks));
  tracker.addTotal(uniqueSize(nativeTasks));
  tracker.addTotal(client.size ?? 0);
  if (logFile && logFileName) {
    tracker.addTotal(logFile.size ?? 0);
  }
  tracker.addTotal(assetIndex.size ?? 0);
  tracker.addTotal(assetsTotalEstimate);

  /* 3. 客户端 jar */
  tracker.setTask(TASK_TEXT.client);
  const jarPath = assertInsideGameDir(path.join(versionDir, `${id}.jar`), gameDir);
  // 通道源从本地服务取 client.jar；官方源使用版本 JSON 内的 Mojang 地址
  const clientUrl = sourceBase
    ? `${sourceBase}/${encodeURIComponent(id)}/${encodeURIComponent(id)}.jar`
    : client.url;
  // 客户端 jar 走单文件下载，单独采样速度后再写入 tracker
  const clientSpeed = createSpeedMeter();
  const clientWritten = await downloadFile(clientUrl, jarPath, {
    expectedSize: client.size,
    sha1: client.sha1,
    signal,
    onTotal: (bytes) => {
      if (client.size === undefined) {
        tracker.addTotal(bytes);
      }
    },
    onBytes: (delta) => {
      clientSpeed.add(delta);
      tracker.setSpeed(clientSpeed.value());
      tracker.addDone(delta);
    }
  });
  tracker.addDone(clientWritten === 0 ? client.size ?? 0 : 0);
  logLine(`客户端 ${id}.jar ${clientWritten === 0 ? '已存在，跳过' : `下载完成（${clientWritten} 字节）`}`);
  throwIfCancelled(signal);

  /* 4. 依赖库与本地库 */
  tracker.setTask(TASK_TEXT.libraries);
  const libResult = await runTasks(libraryTasks, tracker, signal);
  logLine(`依赖库：${libResult.downloaded} 个下载、${libResult.skipped} 个跳过（${libResult.bytes} 字节）`);
  const nativeResult = await runTasks(nativeTasks, tracker, signal);
  logLine(`本地库：${nativeResult.downloaded} 个下载、${nativeResult.skipped} 个跳过（${nativeResult.bytes} 字节）`);
  throwIfCancelled(signal);

  /* 5. 释放本地库 */
  tracker.setTask(TASK_TEXT.natives);
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const archive of nativeArchives) {
    throwIfCancelled(signal);
    try {
      await extractNatives(archive.jarPath, nativesDir, archive.exclude);
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError('INSTALL_CANCELLED', '安装已取消');
      }
      const message = error instanceof Error ? error.message : '未知错误';
      fail('INSTALL_NATIVES_FAILED', `解压本地库失败：${message}`);
    }
  }
  throwIfCancelled(signal);

  /* 6. 日志配置 */
  if (logFile && logFileName) {
    const dest = assertInsideGameDir(path.join(gameDir, 'assets', 'log_configs', logFileName), gameDir);
    const written = await downloadFile(logFile.url as string, dest, {
      expectedSize: logFile.size,
      sha1: logFile.sha1,
      signal,
      onTotal: (bytes) => {
        if (logFile.size === undefined) {
          tracker.addTotal(bytes);
        }
      },
      onBytes: (delta) => tracker.addDone(delta)
    });
    tracker.addDone(written === 0 ? logFile.size ?? 0 : 0);
    logLine(`日志配置 ${logFileName} ${written === 0 ? '已存在，跳过' : `下载完成（${written} 字节）`}`);
  }
  throwIfCancelled(signal);

  /* 7. 资源索引 */
  tracker.setTask(TASK_TEXT.assetsIndex);
  const indexWritten = await downloadFile(assetIndex.url as string, indexPath, {
    expectedSize: assetIndex.size,
    sha1: assetIndex.sha1,
    signal,
    onTotal: (bytes) => {
      if (assetIndex.size === undefined) {
        tracker.addTotal(bytes);
      }
    },
    onBytes: (delta) => tracker.addDone(delta)
  });
  tracker.addDone(indexWritten === 0 ? assetIndex.size ?? 0 : 0);
  logLine(`资源索引 ${indexId}.json ${indexWritten === 0 ? '已存在，跳过' : `下载完成（${indexWritten} 字节）`}`);
  throwIfCancelled(signal);

  let assetsIndex: AssetsIndex;
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      throw new Error('格式不正确');
    }
    assetsIndex = parsed as AssetsIndex;
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    fail('ASSET_INDEX_INVALID', `资源索引文件损坏，请重试（${message}）`);
  }

  /* 8. 资源对象 */
  tracker.setTask(TASK_TEXT.assets);
  const objects = isPlainObject(assetsIndex.objects) ? assetsIndex.objects : {};
  const validObjects: Array<{ name: string; hash: string; size: number }> = [];
  let actualAssetBytes = 0;
  const countedHashes = new Set<string>();
  for (const [name, value] of Object.entries(objects)) {
    if (!isPlainObject(value)) {
      continue;
    }
    const hash = typeof value.hash === 'string' ? value.hash.toLowerCase() : '';
    if (!/^[0-9a-f]{40}$/.test(hash) || typeof value.size !== 'number' || value.size <= 0) {
      logLine(`跳过非法的资源条目：${name}`);
      continue;
    }
    validObjects.push({ name, hash, size: value.size });
    // 同一 hash 可能对应多个虚拟路径，按文件去重计算总字节
    if (!countedHashes.has(hash)) {
      countedHashes.add(hash);
      actualAssetBytes += value.size;
    }
  }
  // 以索引实际大小校正总字节（索引 totalSize 缺失时补上实际值）
  tracker.adjustTotal(actualAssetBytes - assetsTotalEstimate);

  const objectsDir = assertInsideGameDir(path.join(gameDir, 'assets', 'objects'), gameDir);
  const virtualRoot = assetsIndex.virtual === true
    ? assertInsideGameDir(path.join(gameDir, 'assets', 'virtual', indexId), gameDir)
    : null;
  let assetBytes = 0;

  for (let start = 0; start < validObjects.length; start += ASSET_BATCH_SIZE) {
    throwIfCancelled(signal);
    const chunk = validObjects.slice(start, start + ASSET_BATCH_SIZE);
    const tasks: DownloadTask[] = chunk.map((item) => ({
      url: `https://resources.download.minecraft.net/${item.hash.slice(0, 2)}/${item.hash}`,
      dest: assertInsideGameDir(path.join(objectsDir, item.hash.slice(0, 2), item.hash), gameDir),
      size: item.size,
      sha1: item.hash
    }));
    let reported = 0;
    const result = await runBatch(tasks, {
      concurrency: DOWNLOAD_CONCURRENCY,
      signal,
      // [原代码]: onProgress: (doneBytes) => { tracker.addDone(doneBytes - reported); reported = doneBytes; }
      onProgress: (doneBytes, _totalBytes, bytesPerSecond) => {
        tracker.setSpeed(bytesPerSecond);
        tracker.addDone(doneBytes - reported);
        reported = doneBytes;
      }
    });
    ensureBatchSuccess(result);
    assetBytes += result.bytes;

    if (virtualRoot) {
      for (const item of chunk) {
        const source = path.join(objectsDir, item.hash.slice(0, 2), item.hash);
        const segments = item.name.replace(/\\/g, '/').split('/');
        const target = assertInsideGameDir(path.join(virtualRoot, ...segments), gameDir);
        await copyVirtualAsset(source, target, signal);
      }
    }
  }
  logLine(`资源对象：共 ${validObjects.length} 个，本次下载 ${assetBytes} 字节`);
  throwIfCancelled(signal);

  /* 9. 完成标记 */
  tracker.setTask(TASK_TEXT.done);
  await fsp.writeFile(
    assertInsideGameDir(path.join(versionDir, '.installed'), gameDir),
    `${new Date().toISOString()}\n`,
    'utf8'
  );
}

/* ------------------------------ Fabric 安装 ------------------------------ */

/** Fabric profile 依赖转换为下载任务：优先 downloads.artifact，否则按 Maven 坐标推导 */
function buildFabricLibraryTasks(json: VersionJson, gameDir: string, osArch: string): DownloadTask[] {
  const libraries = Array.isArray(json.libraries)
    ? json.libraries.filter((item): item is VersionLibrary => isPlainObject(item))
    : [];
  const tasks: DownloadTask[] = [];
  for (const library of libraries) {
    if (!ruleAllows(library.rules, osArch)) {
      continue;
    }
    const artifact = library.downloads?.artifact;
    if (artifact && typeof artifact.url === 'string' && artifact.url.length > 0) {
      const dest = resolveLibraryPath(gameDir, artifact.path);
      if (dest) {
        tasks.push({ url: artifact.url, dest, size: artifact.size, sha1: artifact.sha1 });
      }
      continue;
    }
    if (
      typeof library.name !== 'string' ||
      typeof library.url !== 'string' ||
      library.url.length === 0
    ) {
      logLine(`忽略无法解析的 Fabric 依赖：${library.name ?? '未知'}`);
      continue;
    }
    const coordinate = parseMavenName(library.name);
    if (!coordinate) {
      logLine(`忽略非法 Maven 坐标：${library.name}`);
      continue;
    }
    const relative = mavenRelativePath(coordinate);
    const dest = assertInsideGameDir(
      path.join(gameDir, 'libraries', ...relative.split('/')),
      gameDir
    );
    tasks.push({
      url: mavenDownloadUrl(library.url, coordinate),
      dest,
      size: library.size,
      sha1: library.sha1
    });
  }
  return tasks;
}

async function runFabricInstall(
  versionId: string,
  gameVersion: string,
  loaderVersion: string,
  tracker: ProgressTracker,
  signal: AbortSignal | undefined,
  source: DownloadSource
): Promise<void> {
  const gameDir = getGameDirectory();
  if (!isVersionInstalled(gameVersion)) {
    logLine(`Fabric 安装：基础版本 ${gameVersion} 未安装，先补全原版`);
    tracker.setTask('补全原版');
    await runInstall(gameVersion, tracker, signal, source);
  }
  throwIfCancelled(signal);

  tracker.setTask('获取 Fabric 信息');
  const profile = await fetchFabricProfile(gameVersion, loaderVersion);
  throwIfCancelled(signal);

  const json: VersionJson = {
    ...profile,
    id: versionId,
    inheritsFrom: gameVersion,
    releaseTime:
      typeof profile.releaseTime === 'string' ? profile.releaseTime : new Date().toISOString(),
    type: 'release',
    woo: { loader: 'fabric', loaderVersion, gameVersion }
  };

  const versionDir = assertInsideGameDir(getVersionDir(versionId), gameDir);
  await fsp.mkdir(versionDir, { recursive: true });

  const tasks = buildFabricLibraryTasks(json, gameDir, getCurrentArch());
  tracker.addTotal(uniqueSize(tasks));
  tracker.setTask('下载 Fabric 依赖');
  const result = await runTasks(tasks, tracker, signal);
  logLine(`Fabric 依赖：${result.downloaded} 个下载、${result.skipped} 个跳过`);
  throwIfCancelled(signal);

  const jsonPath = getVersionJsonPath(versionId);
  const tempPath = `${jsonPath}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, jsonPath);
  await fsp.writeFile(path.join(versionDir, '.installed'), `${new Date().toISOString()}\n`, 'utf8');
  tracker.setTask(TASK_TEXT.done);
}

async function executeFabric(
  versionId: string,
  gameVersion: string,
  loaderVersion: string,
  onProgress: ((progress: InstallProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  source: DownloadSource
): Promise<void> {
  const tracker = new ProgressTracker(versionId, onProgress);
  const startedAt = Date.now();
  logLine(`安装 Fabric：${versionId}（${sourceLabel(source)}）`);
  try {
    await runFabricInstall(versionId, gameVersion, loaderVersion, tracker, signal, source);
    tracker.complete();
    logLine(
      `Fabric 安装完成：${versionId}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`
    );
  } catch (error) {
    const cancelled = signal?.aborted === true || isDownloadCancelled(error);
    if (cancelled) {
      logLine(`Fabric 安装已取消：${versionId}`);
      tracker.interrupt(undefined, true);
      throw new AppError('INSTALL_CANCELLED', '安装已取消');
    }
    const message = error instanceof Error && error.message ? error.message : '安装失败';
    const code = error instanceof AppError ? error.code : 'INSTALL_FAILED';
    logLine(`Fabric 安装失败：${versionId}（${message}）`);
    tracker.interrupt({ code, message });
    throw error instanceof AppError ? error : new AppError(code, message);
  }
}

/** 后台启动 Fabric 安装：原版缺失时自动补齐，进度与取消沿用现有安装通道 */
export function startFabricInstall(
  gameVersion: string,
  loaderVersion: string,
  source: DownloadSource = 'official'
): void {
  const versionId = fabricVersionId(gameVersion, loaderVersion);
  if (activeInstall) {
    fail('INSTALL_IN_PROGRESS', '正在安装中，请等待当前安装完成');
  }
  const controller = new AbortController();
  activeInstall = { id: versionId, controller };
  const onProgress = (progress: InstallProgress): void => emitInstallProgress(progress);

  void executeFabric(versionId, gameVersion, loaderVersion, onProgress, controller.signal, source)
    .catch(() => {
      // 失败/取消已通过 install:progress 推送
    })
    .finally(() => {
      if (activeInstall?.controller === controller) {
        activeInstall = null;
      }
      emitVersionsChanged();
      logLine(`Fabric 安装流程结束：${versionId}`);
    });
}

/* ------------------------------ 对外接口 ------------------------------ */

/** 统一的执行与错误/取消事件包装 */
async function execute(
  versionId: string,
  onProgress: ((progress: InstallProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  label: string,
  source: DownloadSource = 'official'
): Promise<void> {
  const id = assertVersionId(versionId);
  const tracker = new ProgressTracker(id, onProgress);
  const startedAt = Date.now();
  logLine(`${label}：${id}（${sourceLabel(source)}）`);
  try {
    await runInstall(id, tracker, signal, source);
    tracker.setTask(TASK_TEXT.done);
    tracker.complete();
    logLine(`${label}完成：${id}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  } catch (error) {
    const cancelled = signal?.aborted === true || isDownloadCancelled(error);
    if (cancelled) {
      logLine(`${label}已取消：${id}`);
      tracker.interrupt(undefined, true);
      throw new AppError('INSTALL_CANCELLED', '安装已取消');
    }
    const message = error instanceof Error && error.message ? error.message : '安装失败';
    const code = error instanceof AppError ? error.code : 'INSTALL_FAILED';
    logLine(`${label}失败：${id}（${message}）`);
    tracker.interrupt({ code, message });
    throw error instanceof AppError ? error : new AppError(code, message);
  }
}

/** 安装（或重复补齐）指定版本，进度通过回调返回 */
export async function installVersion(
  versionId: string,
  onProgress?: (progress: InstallProgress) => void,
  signal?: AbortSignal,
  source: DownloadSource = 'official'
): Promise<void> {
  await execute(versionId, onProgress, signal, '安装版本', source);
}

/** 启动前补全缺失文件：复用安装逻辑，不清空已有文件 */
export async function ensureVersionDependencies(
  versionId: string,
  onProgress?: (progress: InstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  await execute(versionId, onProgress, signal, '检查版本依赖');
}

/** 是否有安装任务正在执行 */
export function isInstallRunning(): boolean {
  return activeInstall !== null;
}

/**
 * 后台启动安装：立即返回，进度与结果通过 install:progress 事件推送。
 * 重复调用时抛出“正在安装中”。
 */
export function startInstall(versionId: string, source: DownloadSource = 'official'): void {
  const id = assertVersionId(versionId);
  if (activeInstall) {
    fail('INSTALL_IN_PROGRESS', '正在安装中，请等待当前安装完成');
  }
  const controller = new AbortController();
  activeInstall = { id, controller };
  const onProgress = (progress: InstallProgress): void => emitInstallProgress(progress);

  void installVersion(id, onProgress, controller.signal, source)
    .catch(() => {
      // 失败/取消已通过 install:progress 推送
    })
    .finally(() => {
      if (activeInstall?.controller === controller) {
        activeInstall = null;
      }
      emitVersionsChanged();
      logLine(`安装流程结束：${id}`);
    });
}

/** 取消当前安装：中止请求并清理 .part，由下载层负责 */
export function cancelInstall(): void {
  if (!activeInstall) {
    return;
  }
  logLine(`请求取消安装：${activeInstall.id}`);
  activeInstall.controller.abort();
}

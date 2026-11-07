#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.MC_VERSIONS_DIR || path.join(SERVER_DIR, '..', 'mc版本'));
const MANIFEST_PATH = path.join(ROOT, 'version_manifest_v2.json');

/** 分块上传：合并后的文件目录（可用 UPLOADS_DIR 覆盖） */
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(SERVER_DIR, '..', 'uploads'));
/** 分块临时目录：UPLOADS_DIR/.chunks/<uploadId>/ */
const CHUNK_DIR = path.join(UPLOADS_DIR, '.chunks');
/** 单块上限 95MB：Cloudflare 免费版单请求体上限 100MB，留出余量 */
const CHUNK_MAX_BYTES = 95 * 1024 * 1024;
/** 单个文件总上限（默认 8GB） */
const UPLOAD_MAX_BYTES = Number.parseInt(process.env.UPLOAD_MAX_BYTES || '', 10) || 8 * 1024 * 1024 * 1024;
/** 分块数量上限，防止异常元数据占满磁盘 */
const MAX_CHUNKS = 20000;
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 可选上传口令；设置后所有上传请求必须携带 X-Upload-Token */
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

/** 房间索引：TTL 与容量 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const ROOM_MAX = 100;
const ROOM_BODY_LIMIT = 8 * 1024;
const ROOM_CODE_LENGTH = 6;
/** 去除易混淆字符：0/O、1/I */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const ROOM_SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_VERSION_RE = /^[A-Za-z0-9._ -]{1,128}$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function parsePort(raw) {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`SERVER_PORT 无效：${raw}（应为 1-65535）`);
    process.exit(1);
  }
  return port;
}

const HOST = process.env.SERVER_HOST || '0.0.0.0';
const PORT = parsePort(process.env.SERVER_PORT || '8080');

/** 构建清单状态：版本集合与已下载数量 */
function buildManifestState() {
  const stat = fs.statSync(MANIFEST_PATH);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (!Array.isArray(manifest.versions) || manifest.versions.length === 0) {
    throw new Error('versions 数组为空');
  }
  const versionIds = new Set(manifest.versions.map((item) => item.id));
  const availableVersions = manifest.versions.filter((item) =>
    fs.existsSync(path.join(ROOT, item.id, `${item.id}.jar`))
  ).length;
  return { manifest, versionIds, availableVersions, mtimeMs: stat.mtimeMs, size: stat.size };
}

/** 启动时加载官方清单；缺失则直接退出，避免带病提供服务 */
function loadManifestState() {
  try {
    return buildManifestState();
  } catch (error) {
    console.error(`无法读取版本清单：${MANIFEST_PATH}`);
    console.error(error instanceof Error ? error.message : String(error));
    console.error('请确认已下载版本文件，或通过 MC_VERSIONS_DIR 指定目录。');
    process.exit(1);
  }
}

let manifestState = loadManifestState();

// [原代码]: const manifest = loadManifest();
// [原代码]: const versionIds = new Set(manifest.versions.map((item) => item.id));
// [原代码]: const availableVersions = manifest.versions.filter((item) => fs.existsSync(...)).length;

/** 清单文件被每日同步脚本更新后热加载，无需重启服务 */
function getManifestState() {
  try {
    const stat = fs.statSync(MANIFEST_PATH);
    if (stat.mtimeMs !== manifestState.mtimeMs || stat.size !== manifestState.size) {
      manifestState = buildManifestState();
      console.log(
        `版本清单已更新：${manifestState.availableVersions} / ${manifestState.manifest.versions.length}`
      );
    }
  } catch (error) {
    console.error(`重新加载版本清单失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return manifestState;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // [原代码]: 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
  // [原代码]: 'Access-Control-Allow-Headers': 'Range,If-None-Match,Content-Type',
  'Access-Control-Allow-Headers':
    'Range,If-None-Match,Content-Type,X-Chunk-Init,X-Chunk-Upload-Id,X-Chunk-Index,X-Chunk-Complete,X-Chunk-Abort,X-Upload-Token',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,ETag'
};

function sendJson(req, res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendError(req, res, status, message) {
  sendJson(req, res, status, { error: message });
}

/** 只接受单段 Range；不合法时返回 'invalid' */
function parseRange(header, size) {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) {
    return 'invalid';
  }
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return 'invalid';
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === '' ? size - 1 : Number.parseInt(match[2], 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(req, res, filePath, contentType, cacheControl) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
  } catch {
    sendError(req, res, 404, 'not_found');
    return;
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...CORS_HEADERS, ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, stat.size);
  if (range === 'invalid') {
    res.writeHead(416, {
      ...CORS_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Range': `bytes */${stat.size}`,
      'Cache-Control': 'no-store'
    });
    res.end('Range Not Satisfiable');
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': contentType,
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': cacheControl
  };
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  res.writeHead(range ? 206 : 200, headers);

  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) {
      sendError(req, res, 500, 'read_failed');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/** 版本文件路径：/<id>/<id>.json 或 /<id>/<id>.jar，也兼容 /versions/<id>/<file> */
function resolveVersionFile(pathname) {
  const match = /^\/(?:versions\/)?([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!getManifestState().versionIds.has(id)) {
    return null;
  }
  const fileName = match[2];
  const kind = fileName === `${id}.json` ? 'json' : fileName === `${id}.jar` ? 'jar' : null;
  if (!kind) {
    return null;
  }
  const filePath = path.join(ROOT, id, fileName);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    return null;
  }
  return {
    id,
    kind,
    filePath
  };
}

/** 上传接口的结构化错误：携带 HTTP 状态，便于统一返回 */
class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function chunkName(index) {
  return String(index).padStart(6, '0');
}

/** 清洗文件名：只保留基名，去掉路径分隔符与非法字符 */
function sanitizeFileName(raw) {
  const value = typeof raw === 'string' ? raw : '';
  const base = path.basename(value.replace(/\0/g, '').trim());
  const cleaned = base.replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return null;
  }
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** 读取小型 JSON 请求体（元数据），超过限制直接拒绝 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new UploadError(413, 'body_too_large');
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new UploadError(400, 'invalid_json');
  }
}

async function readUploadMeta(uploadId) {
  try {
    const raw = await fsp.readFile(path.join(CHUNK_DIR, uploadId, 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function countReceivedChunks(sessionDir) {
  try {
    const names = await fsp.readdir(sessionDir);
    return names.filter((name) => /^\d{6}$/.test(name)).length;
  } catch {
    return 0;
  }
}

/** 把请求体流式写入分块临时文件，超过单块上限立即中止 */
function receiveChunk(req, filePath) {
  return new Promise((resolve, reject) => {
    const tempPath = `${filePath}.part`;
    const out = fs.createWriteStream(tempPath);
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      out.destroy();
      fsp.rm(tempPath, { force: true }).catch(() => {});
      reject(error);
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > CHUNK_MAX_BYTES) {
        req.destroy();
        fail(new UploadError(413, 'chunk_too_large'));
      }
    });
    req.on('aborted', () => fail(new UploadError(400, 'upload_aborted')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) {
        return;
      }
      if (bytes === 0) {
        settled = true;
        fsp.rm(tempPath, { force: true }).catch(() => {});
        reject(new UploadError(400, 'empty_chunk'));
        return;
      }
      settled = true;
      fsp
        .rename(tempPath, filePath)
        .then(() => resolve(bytes))
        .catch(reject);
    });
    req.pipe(out);
  });
}

/** 同目录已存在同名文件时自动追加 -1、-2 后缀 */
async function uniqueFileName(filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = filename;
  let suffix = 1;
  while (fs.existsSync(path.join(UPLOADS_DIR, candidate))) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
    if (suffix > 9999) {
      throw new UploadError(409, 'too_many_name_conflicts');
    }
  }
  return candidate;
}

async function handleUploadInit(req, res) {
  const body = await readJsonBody(req);
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
  if (!UPLOAD_ID_RE.test(uploadId)) {
    throw new UploadError(400, 'invalid_upload_id');
  }
  const filename = sanitizeFileName(body.filename);
  if (!filename) {
    throw new UploadError(400, 'invalid_filename');
  }
  const totalChunks = Number(body.totalChunks);
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
    throw new UploadError(400, 'invalid_total_chunks');
  }
  const totalSize = body.totalSize === undefined ? null : Number(body.totalSize);
  if (totalSize !== null && (!Number.isInteger(totalSize) || totalSize < 1 || totalSize > UPLOAD_MAX_BYTES)) {
    throw new UploadError(400, 'invalid_total_size');
  }
  const fileHash =
    typeof body.fileHash === 'string' && /^[0-9a-fA-F]{64}$/.test(body.fileHash) ? body.fileHash.toLowerCase() : null;

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  const existing = await readUploadMeta(uploadId);
  if (existing) {
    if (
      existing.filename !== filename ||
      existing.totalChunks !== totalChunks ||
      (totalSize !== null && existing.totalSize !== totalSize)
    ) {
      throw new UploadError(409, 'upload_conflict');
    }
    const received = await countReceivedChunks(sessionDir);
    sendJson(req, res, 200, {
      ok: true,
      resumed: true,
      uploadId,
      filename,
      totalChunks,
      received,
      maxChunkBytes: CHUNK_MAX_BYTES
    });
    return;
  }

  await fsp.mkdir(sessionDir, { recursive: true });
  const meta = {
    uploadId,
    filename,
    totalChunks,
    totalSize,
    fileHash,
    createdAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(sessionDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  sendJson(req, res, 200, {
    ok: true,
    resumed: false,
    uploadId,
    filename,
    totalChunks,
    received: 0,
    maxChunkBytes: CHUNK_MAX_BYTES
  });
}

async function handleUploadChunk(req, res) {
  const uploadId = String(req.headers['x-chunk-upload-id'] || '');
  const index = Number.parseInt(String(req.headers['x-chunk-index'] ?? ''), 10);
  if (!UPLOAD_ID_RE.test(uploadId)) {
    throw new UploadError(400, 'invalid_upload_id');
  }
  const meta = await readUploadMeta(uploadId);
  if (!meta) {
    throw new UploadError(404, 'upload_not_found');
  }
  if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
    throw new UploadError(400, 'invalid_chunk_index');
  }
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
  if (Number.isFinite(declared) && declared > CHUNK_MAX_BYTES) {
    throw new UploadError(413, 'chunk_too_large');
  }
  const sessionDir = path.join(CHUNK_DIR, uploadId);
  const bytes = await receiveChunk(req, path.join(sessionDir, chunkName(index)));
  const received = await countReceivedChunks(sessionDir);
  sendJson(req, res, 200, { ok: true, index, bytes, received, totalChunks: meta.totalChunks });
}

async function handleUploadComplete(req, res) {
  const body = await readJsonBody(req);
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
  if (!UPLOAD_ID_RE.test(uploadId)) {
    throw new UploadError(400, 'invalid_upload_id');
  }
  const meta = await readUploadMeta(uploadId);
  if (!meta) {
    throw new UploadError(404, 'upload_not_found');
  }
  const sessionDir = path.join(CHUNK_DIR, uploadId);
  const missing = [];
  let totalBytes = 0;
  for (let i = 0; i < meta.totalChunks; i += 1) {
    const chunkPath = path.join(sessionDir, chunkName(i));
    try {
      const stat = await fsp.stat(chunkPath);
      if (!stat.isFile()) {
        throw new Error('not a file');
      }
      totalBytes += stat.size;
    } catch {
      missing.push(i);
    }
  }
  if (missing.length > 0) {
    sendJson(req, res, 409, { error: 'chunks_incomplete', missing, totalChunks: meta.totalChunks });
    return;
  }
  if (meta.totalSize && totalBytes !== meta.totalSize) {
    throw new UploadError(400, 'size_mismatch');
  }
  if (totalBytes > UPLOAD_MAX_BYTES) {
    throw new UploadError(413, 'file_too_large');
  }

  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  const tempPath = path.join(UPLOADS_DIR, `.merge-${uploadId}.part`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tempPath);
  let mergedBytes = 0;
  try {
    for (let i = 0; i < meta.totalChunks; i += 1) {
      const buffer = await fsp.readFile(path.join(sessionDir, chunkName(i)));
      mergedBytes += buffer.length;
      if (mergedBytes > UPLOAD_MAX_BYTES) {
        throw new UploadError(413, 'file_too_large');
      }
      hash.update(buffer);
      if (!out.write(buffer)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (error) {
    out.destroy();
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  const sha256 = hash.digest('hex');
  if (meta.fileHash && sha256 !== meta.fileHash) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw new UploadError(422, 'hash_mismatch');
  }
  const filename = await uniqueFileName(meta.filename);
  await fsp.rename(tempPath, path.join(UPLOADS_DIR, filename));
  await fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  sendJson(req, res, 200, {
    ok: true,
    filename,
    size: mergedBytes,
    sha256,
    url: `/uploads/${encodeURIComponent(filename)}`
  });
}

async function handleUploadAbort(req, res) {
  const body = await readJsonBody(req);
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
  if (!UPLOAD_ID_RE.test(uploadId)) {
    throw new UploadError(400, 'invalid_upload_id');
  }
  await fsp.rm(path.join(CHUNK_DIR, uploadId), { recursive: true, force: true }).catch(() => {});
  sendJson(req, res, 200, { ok: true, aborted: uploadId });
}

/** 分块上传总入口：按请求头分发 Init / Chunk / Complete / Abort */
async function handleChunkUpload(req, res) {
  if (UPLOAD_TOKEN && req.headers['x-upload-token'] !== UPLOAD_TOKEN) {
    sendError(req, res, 401, 'upload_token_required');
    return;
  }
  try {
    if (req.headers['x-chunk-init']) {
      await handleUploadInit(req, res);
      return;
    }
    if (req.headers['x-chunk-complete']) {
      await handleUploadComplete(req, res);
      return;
    }
    if (req.headers['x-chunk-abort']) {
      await handleUploadAbort(req, res);
      return;
    }
    if (req.headers['x-chunk-upload-id'] && req.headers['x-chunk-index'] !== undefined) {
      await handleUploadChunk(req, res);
      return;
    }
    sendError(req, res, 400, 'missing_upload_action');
  } catch (error) {
    if (error instanceof UploadError) {
      sendError(req, res, error.status, error.message);
      return;
    }
    console.error(`上传处理失败：${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      sendError(req, res, 500, 'upload_failed');
    } else {
      res.destroy();
    }
  }
}

/** 房间索引的结构化错误 */
class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** code -> room；sessionId -> code */
const rooms = new Map();
const roomBySession = new Map();

function pruneRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expiresAt <= now) {
      rooms.delete(code);
      roomBySession.delete(room.sessionId);
    }
  }
}

function allocateRoomCode() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = '';
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
      code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new RoomError(503, 'room_code_exhausted');
}

function roomAuthOk(_req) {
  // 房间登记对公网客户端开放；更新/删除仅凭不可猜测的 sessionId 校验
  return true;
}

function isValidIPv4(value) {
  if (typeof value !== 'string' || !IPV4_RE.test(value)) {
    return false;
  }
  return value.split('.').every((part) => {
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function validateRoomPayload(body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!ROOM_SESSION_RE.test(sessionId)) {
    throw new RoomError(400, 'invalid_session_id');
  }
  const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
  if (!ROOM_VERSION_RE.test(versionId) || versionId.includes('..')) {
    throw new RoomError(400, 'invalid_version_id');
  }
  const networkName = typeof body.networkName === 'string' ? body.networkName.trim() : '';
  const networkSecret = typeof body.networkSecret === 'string' ? body.networkSecret.trim() : '';
  if (networkName.length === 0 || networkName.length > 128) {
    throw new RoomError(400, 'invalid_network_name');
  }
  if (networkSecret.length === 0 || networkSecret.length > 128) {
    throw new RoomError(400, 'invalid_network_secret');
  }
  if (!isValidIPv4(body.hostVirtualIp)) {
    throw new RoomError(400, 'invalid_host_virtual_ip');
  }
  if (!isValidIPv4(body.hostLanIp)) {
    throw new RoomError(400, 'invalid_host_lan_ip');
  }
  const gamePort = Number(body.gamePort);
  if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65535) {
    throw new RoomError(400, 'invalid_game_port');
  }
  const hostNameRaw = typeof body.hostName === 'string' ? body.hostName.trim() : '';
  const hostName = hostNameRaw.length > 0 ? hostNameRaw.slice(0, 64) : '房主';
  return {
    sessionId,
    versionId,
    networkName,
    networkSecret,
    hostVirtualIp: body.hostVirtualIp,
    hostLanIp: body.hostLanIp,
    gamePort,
    hostName
  };
}

function publicRoom(room) {
  return {
    versionId: room.versionId,
    networkName: room.networkName,
    networkSecret: room.networkSecret,
    hostVirtualIp: room.hostVirtualIp,
    hostLanIp: room.hostLanIp,
    gamePort: room.gamePort,
    hostName: room.hostName,
    expiresAt: room.expiresAt
  };
}

/** 房间索引路由：POST /rooms、GET/DELETE /rooms/<code>、POST /rooms/<code>/heartbeat */
async function handleRooms(req, res, pathname) {
  try {
    const parts = pathname.split('/').filter((part) => part.length > 0);
    if (parts[0] !== 'rooms') {
      sendError(req, res, 404, 'not_found');
      return;
    }

    if (parts.length === 1) {
      if (req.method !== 'POST') {
        sendError(req, res, 405, 'method_not_allowed');
        return;
      }
      if (!roomAuthOk(req)) {
        sendError(req, res, 401, 'room_token_required');
        return;
      }
      const payload = validateRoomPayload(await readJsonBody(req, ROOM_BODY_LIMIT));
      pruneRooms();
      const now = Date.now();
      let code = roomBySession.get(payload.sessionId);
      let room = code ? rooms.get(code) : null;
      if (!room) {
        if (rooms.size >= ROOM_MAX) {
          throw new RoomError(429, 'room_limit_reached');
        }
        code = allocateRoomCode();
        room = { ...payload, createdAt: now, expiresAt: now + ROOM_TTL_MS };
        rooms.set(code, room);
        roomBySession.set(payload.sessionId, code);
      } else {
        Object.assign(room, payload, { expiresAt: now + ROOM_TTL_MS });
      }
      sendJson(req, res, 200, { ok: true, code, expiresAt: room.expiresAt });
      return;
    }

    const code = (parts[1] || '').toUpperCase();
    if (!ROOM_CODE_RE.test(code)) {
      sendError(req, res, 404, 'room_not_found');
      return;
    }
    pruneRooms();
    const room = rooms.get(code);
    if (!room) {
      sendError(req, res, 404, 'room_not_found');
      return;
    }

    if (parts.length === 2) {
      if (req.method === 'GET') {
        sendJson(req, res, 200, { ok: true, ...publicRoom(room) });
        return;
      }
      if (req.method === 'DELETE') {
        if (!roomAuthOk(req)) {
          sendError(req, res, 401, 'room_token_required');
          return;
        }
        const body = await readJsonBody(req, ROOM_BODY_LIMIT);
        if (typeof body.sessionId !== 'string' || body.sessionId !== room.sessionId) {
          sendError(req, res, 403, 'room_session_mismatch');
          return;
        }
        rooms.delete(code);
        roomBySession.delete(room.sessionId);
        sendJson(req, res, 200, { ok: true, closed: code });
        return;
      }
      sendError(req, res, 405, 'method_not_allowed');
      return;
    }

    if (parts.length === 3 && parts[2] === 'heartbeat') {
      if (req.method !== 'POST') {
        sendError(req, res, 405, 'method_not_allowed');
        return;
      }
      if (!roomAuthOk(req)) {
        sendError(req, res, 401, 'room_token_required');
        return;
      }
      const body = await readJsonBody(req, ROOM_BODY_LIMIT);
      if (typeof body.sessionId !== 'string' || body.sessionId !== room.sessionId) {
        sendError(req, res, 403, 'room_session_mismatch');
        return;
      }
      room.expiresAt = Date.now() + ROOM_TTL_MS;
      sendJson(req, res, 200, { ok: true, expiresAt: room.expiresAt });
      return;
    }

    sendError(req, res, 404, 'not_found');
  } catch (error) {
    if (error instanceof RoomError || error instanceof UploadError) {
      sendError(req, res, error.status, error.message);
      return;
    }
    console.error(`房间接口失败：${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      sendError(req, res, 500, 'room_failed');
    } else {
      res.destroy();
    }
  }
}

function formatHostForUrl(host) {
  if (host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }
  return host.includes(':') ? `[${host}]` : host;
}

function logRequest(req, res, pathname, startedAt) {
  return () => {
    const remote = req.socket.remoteAddress || '-';
    console.log(
      `${new Date().toISOString()} ${remote} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`
    );
  };
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  let pathname = '/';
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(req, res, 400, 'bad_request');
    return;
  }
  res.on('finish', logRequest(req, res, pathname, startedAt));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // 分块上传接口：Cloudflare 免费版限制单请求体 100MB，拆成 ≤95MB 的分块
  if (pathname === '/__chunk_upload') {
    if (req.method !== 'POST') {
      sendError(req, res, 405, 'method_not_allowed');
      return;
    }
    void handleChunkUpload(req, res);
    return;
  }

  // 房间索引：仅登记元数据，不中继游戏流量
  if (pathname === '/rooms' || pathname.startsWith('/rooms/')) {
    void handleRooms(req, res, pathname);
    return;
  }

  // [原代码]: if (req.method !== 'GET' && req.method !== 'HEAD') { sendError(req, res, 405, 'method_not_allowed'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(req, res, 405, 'method_not_allowed');
    return;
  }

  if (pathname === '/health') {
    const state = getManifestState();
    pruneRooms();
    sendJson(req, res, 200, {
      ok: true,
      status: 'ok',
      versions: state.availableVersions,
      manifestVersions: state.manifest.versions.length,
      rooms: rooms.size,
      latestRelease: state.manifest.latest?.release ?? null,
      latestSnapshot: state.manifest.latest?.snapshot ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      now: new Date().toISOString()
    });
    return;
  }

  if (pathname === '/') {
    sendJson(req, res, 200, {
      name: 'woo-mc-version-server',
      endpoints: {
        health: '/health',
        manifest: '/version_manifest_v2.json',
        versionJson: '/<id>/<id>.json',
        versionJar: '/<id>/<id>.jar',
        chunkUpload: '/__chunk_upload',
        uploadedFile: '/uploads/<filename>',
        createRoom: '/rooms',
        getRoom: '/rooms/<code>'
      },
      versions: getManifestState().availableVersions
    });
    return;
  }

  if (pathname === '/version_manifest_v2.json') {
    void serveFile(req, res, MANIFEST_PATH, 'application/json; charset=utf-8', 'no-cache');
    return;
  }

  const versionFile = resolveVersionFile(pathname);
  if (versionFile) {
    const contentType =
      versionFile.kind === 'jar' ? 'application/java-archive' : 'application/json; charset=utf-8';
    void serveFile(req, res, versionFile.filePath, contentType, 'public, max-age=86400');
    return;
  }

  // 已合并的上传文件下载：/uploads/<filename>
  if (pathname.startsWith('/uploads/')) {
    const name = pathname.slice('/uploads/'.length);
    if (!name || name.includes('/') || name.includes('\\')) {
      sendError(req, res, 404, 'not_found');
      return;
    }
    const filePath = path.join(UPLOADS_DIR, name);
    if (!filePath.startsWith(`${UPLOADS_DIR}${path.sep}`)) {
      sendError(req, res, 404, 'not_found');
      return;
    }
    void serveFile(req, res, filePath, 'application/octet-stream', 'public, max-age=3600');
    return;
  }

  sendError(req, res, 404, 'not_found');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请使用 SERVER_PORT 指定其他端口。`);
  } else {
    console.error(`服务端启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const localHost = formatHostForUrl(HOST);
  console.log('Minecraft 版本服务已启动');
  console.log(`版本目录：${ROOT}`);
  console.log(`已下载版本：${manifestState.availableVersions} / ${manifestState.manifest.versions.length}`);
  console.log(`健康检查：http://${localHost}:${PORT}/health`);
  console.log(`版本清单：http://${localHost}:${PORT}/version_manifest_v2.json`);
  console.log(`上传目录：${UPLOADS_DIR}`);
  console.log(`房间索引：已启用（客户端公开登记，房间 TTL 2 小时）`);
  if (UPLOAD_TOKEN) {
    console.log('分块上传：已启用（需要 X-Upload-Token）');
  } else {
    console.log('分块上传：已启用（未设置 UPLOAD_TOKEN，公网可直接上传，请自行控制访问）');
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    const lanAddresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && !item.internal && item.family === 'IPv4')
      .map((item) => item.address);
    for (const address of lanAddresses) {
      console.log(`局域网访问：http://${address}:${PORT}/health`);
    }
  }
  console.log('按 Ctrl+C 停止服务。');
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务…`);
  server.close(() => {
    console.log('服务已停止。');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

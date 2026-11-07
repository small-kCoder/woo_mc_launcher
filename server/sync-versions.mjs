#!/usr/bin/env node
/**
 * 每日版本同步：访问 Mojang 官方清单，下载缺失/新增版本的 JSON 与 client.jar，
 * 全部成功后再原子更新本地 version_manifest_v2.json，供版本服务保持一致。
 *
 * 可用环境变量：
 * - MC_VERSIONS_DIR：版本目录（默认 ../mc版本）
 * - SYNC_LOG_DIR：日志目录（默认 ../logs）
 * - SYNC_CONCURRENCY：并发下载的版本数（默认 4，范围 1-8）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.MC_VERSIONS_DIR || path.join(SERVER_DIR, '..', 'mc版本'));
const LOG_DIR = path.resolve(process.env.SYNC_LOG_DIR || path.join(SERVER_DIR, '..', 'logs'));
const MANIFEST_PATH = path.join(ROOT, 'version_manifest_v2.json');

const MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
];
const TIMEOUT_MS = 60_000;
const RETRIES = 3;
const RETRY_DELAY_MS = 1_500;
const CONCURRENCY = Math.min(8, Math.max(1, Number.parseInt(process.env.SYNC_CONCURRENCY || '4', 10) || 4));
// 官方存在带空格的版本 ID（如 “3D Shareware v1.34”），此处仅禁止路径分隔符与 Windows 非法字符
const VERSION_ID_RE = /^[A-Za-z0-9._ -]+$/;

function stamp() {
  return new Date().toISOString();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function logFileName() {
  const now = new Date();
  return `version-sync-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.log`;
}

function log(message) {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, logFileName()), `${line}\n`, 'utf8');
  } catch {
    // 日志写入失败不影响同步
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionFilePaths(id) {
  const dir = path.join(ROOT, id);
  return {
    dir,
    json: path.join(dir, `${id}.json`),
    jar: path.join(dir, `${id}.jar`)
  };
}

async function fetchWithRetry(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'woo-mc-launcher/version-sync' }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`${label}失败（第 ${attempt}/${RETRIES} 次）：${message}`);
      if (attempt < RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError ?? new Error(`${label}失败`);
}

/** 下载到 .part 并校验大小/SHA1，通过后原子改名 */
async function downloadOnce(url, dest, expected) {
  const temp = `${dest}.part`;
  const response = await fetchWithRetry(url, `下载 ${path.basename(dest)} `);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha1');
  const out = fs.createWriteStream(temp);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (error) {
    out.destroy();
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }

  const sha1 = hash.digest('hex');
  if (expected.size && bytes !== expected.size) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new Error(`大小不一致（期望 ${expected.size}，实际 ${bytes}）`);
  }
  if (expected.sha1 && sha1 !== expected.sha1.toLowerCase()) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new Error(`SHA1 不一致（期望 ${expected.sha1}，实际 ${sha1}）`);
  }
  await fsp.rename(temp, dest);
  return bytes;
}

async function downloadWithRetry(url, dest, expected, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      return await downloadOnce(url, dest, expected);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`${label}失败（第 ${attempt}/${RETRIES} 次）：${message}`);
      if (attempt < RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError ?? new Error(`${label}失败`);
}

function isValidVersionId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 128 &&
    id.trim() === id &&
    !id.includes('..') &&
    VERSION_ID_RE.test(id)
  );
}

/** 同步单个版本：先 JSON 后 client.jar */
async function syncVersion(entry) {
  const id = entry.id;
  const paths = versionFilePaths(id);
  const needJson = !fs.existsSync(paths.json);
  const needJar = !fs.existsSync(paths.jar);
  if (!needJson && !needJar) {
    return { id, status: 'skip', bytes: 0 };
  }

  await fsp.mkdir(paths.dir, { recursive: true });
  if (needJson) {
    await downloadWithRetry(entry.url, paths.json, { sha1: entry.sha1 }, `版本 JSON ${id} `);
  }

  let json = null;
  try {
    json = JSON.parse(await fsp.readFile(paths.json, 'utf8'));
  } catch {
    throw new Error('版本 JSON 无法解析');
  }
  const client = json && json.downloads ? json.downloads.client : null;

  let jarBytes = 0;
  if (needJar) {
    if (!client || typeof client.url !== 'string' || client.url.length === 0) {
      log(`版本 ${id} 缺少 client 下载信息，跳过 jar`);
      return { id, status: 'partial', bytes: 0 };
    }
    jarBytes = await downloadWithRetry(
      client.url,
      paths.jar,
      { size: typeof client.size === 'number' ? client.size : undefined, sha1: client.sha1 },
      `client.jar ${id} `
    );
  }

  const jsonBytes = needJson ? fs.statSync(paths.json).size : 0;
  return { id, status: 'updated', bytes: jarBytes + jsonBytes };
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  const results = new Array(items.length);
  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 原子写入新清单 */
async function writeManifest(rawText) {
  const temp = `${MANIFEST_PATH}.part`;
  await fsp.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fsp.writeFile(temp, rawText, 'utf8');
  await fsp.rename(temp, MANIFEST_PATH);
}

async function fetchOfficialManifest() {
  let lastMessage = '';
  for (const url of MANIFEST_URLS) {
    try {
      const response = await fetchWithRetry(url, '获取官方清单 ');
      const rawText = await response.text();
      const parsed = JSON.parse(rawText);
      if (!parsed || !Array.isArray(parsed.versions) || parsed.versions.length === 0) {
        throw new Error('versions 数组为空');
      }
      return { rawText, manifest: parsed, source: url };
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      log(`清单地址不可用：${url}（${lastMessage}）`);
    }
  }
  throw new Error(`无法获取官方版本清单：${lastMessage || '未知错误'}`);
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  log('开始同步官方版本清单');
  log(`版本目录：${ROOT}`);

  const { rawText, manifest, source } = await fetchOfficialManifest();
  log(`官方清单：${manifest.versions.length} 个版本（来源 ${source}）`);

  const entries = manifest.versions.filter((item) => {
    if (!item || !isValidVersionId(item.id) || typeof item.url !== 'string') {
      log(`跳过非法清单条目：${String(item && item.id)}`);
      return false;
    }
    return true;
  });

  const missing = [];
  let complete = 0;
  for (const entry of entries) {
    const paths = versionFilePaths(entry.id);
    const hasJson = fs.existsSync(paths.json);
    const hasJar = fs.existsSync(paths.jar);
    if (hasJson && hasJar) {
      complete += 1;
    } else {
      missing.push(entry);
    }
  }
  log(`本地完整：${complete} / ${entries.length}，待更新：${missing.length}`);

  const failures = [];
  let updated = 0;
  let bytes = 0;
  if (missing.length > 0) {
    const results = await runPool(
      missing,
      async (entry) => {
        try {
          const result = await syncVersion(entry);
          if (result.status === 'updated') {
            updated += 1;
            bytes += result.bytes;
            log(`已更新 ${result.id}（${(result.bytes / 1024 / 1024).toFixed(2)} MB）`);
          } else if (result.status === 'partial') {
            log(`版本 ${result.id} 缺少 jar，已跳过`);
          }
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`同步 ${entry.id} 失败：${message}`);
          return { id: entry.id, message };
        }
      },
      CONCURRENCY
    );
    for (const failure of results) {
      if (failure) {
        failures.push(failure);
      }
    }
  }

  if (failures.length > 0) {
    log(`同步未完成：${failures.length} 个版本失败，保留旧清单供下次重试`);
    for (const failure of failures) {
      log(`  失败：${failure.id}（${failure.message}）`);
    }
    process.exitCode = 1;
    return;
  }

  let manifestChanged = false;
  try {
    const currentRaw = await fsp.readFile(MANIFEST_PATH, 'utf8');
    manifestChanged = currentRaw !== rawText;
  } catch {
    manifestChanged = true;
  }
  if (manifestChanged) {
    await writeManifest(rawText);
    log('本地清单已更新');
  } else {
    log('本地清单已是最新，无需写入');
  }

  log(`同步完成：新增/补全 ${updated} 个版本，共 ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`同步失败：${message}`);
  process.exitCode = 1;
});

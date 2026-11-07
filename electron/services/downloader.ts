import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { net } from 'electron';
import { AppError } from './errors';
import { logLine } from './logger';

/** 连接超时（从发起到拿到响应头） */
const CONNECT_TIMEOUT_MS = 15_000;
/** 传输空闲超时：超过该时长没有收到任何数据则中止并重试 */
const IDLE_TIMEOUT_MS = 20_000;
/** 单文件重试次数与退避间隔 */
const RETRY_DELAYS_MS = [300, 900, 2_000];
/** 进度节流：最多 10 次/秒 */
const PROGRESS_MIN_INTERVAL_MS = 100;
/** 速度采样窗口与平滑系数（越大越跟手，越小越平滑） */
const SPEED_SAMPLE_WINDOW_MS = 600;
const SPEED_SMOOTHING = 0.4;
const PART_SUFFIX = '.part';
const DEFAULT_CONCURRENCY = 8;

export interface DownloadOptions {
  /** 预期文件大小，命中则跳过，下载后校验 */
  expectedSize?: number;
  /** 预期 SHA1，命中则跳过，下载后校验 */
  sha1?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 已写出的字节增量（重试时会用负值回退） */
  onBytes?: (delta: number) => void;
  /** 从响应头获知文件大小时回调，用于进度总量 */
  onTotal?: (bytes: number) => void;
  /** 强制重新下载 */
  force?: boolean;
}

export interface DownloadTask {
  url: string;
  dest: string;
  size?: number;
  sha1?: string;
  force?: boolean;
}

export interface BatchOptions {
  concurrency?: number;
  /** 累计完成字节（含跳过的文件）、总字节与实时网络速度（字节/秒） */
  // [原代码]: onProgress?: (doneBytes: number, totalBytes: number) => void;
  onProgress?: (doneBytes: number, totalBytes: number, bytesPerSecond: number) => void;
  signal?: AbortSignal;
}

export interface BatchFailure {
  dest: string;
  message: string;
}

export interface BatchResult {
  downloaded: number;
  skipped: number;
  failed: BatchFailure[];
  cancelled: boolean;
  bytes: number;
}

/** 实时下载速度采样器：600ms 窗口 + 指数平滑 */
export interface SpeedMeter {
  /** 记录本次实际收到的网络字节（负值/回退忽略） */
  add: (delta: number) => void;
  /** 当前速度（字节/秒） */
  value: () => number;
}

export function createSpeedMeter(): SpeedMeter {
  let speedBytes = 0;
  let windowStart = Date.now();
  let smoothed = 0;
  return {
    add(delta: number): void {
      if (delta > 0) {
        speedBytes += delta;
      }
    },
    value(): number {
      const elapsed = Date.now() - windowStart;
      if (elapsed < SPEED_SAMPLE_WINDOW_MS) {
        return Math.round(smoothed);
      }
      const instant = speedBytes / (elapsed / 1000);
      smoothed = smoothed > 0 ? smoothed * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING : instant;
      speedBytes = 0;
      windowStart = Date.now();
      return Math.round(smoothed);
    }
  };
}

/** 是否是取消引起的错误 */
export function isDownloadCancelled(error: unknown): boolean {
  return error instanceof AppError && error.code === 'DOWNLOAD_CANCELLED';
}

function cancelledError(): AppError {
  return new AppError('DOWNLOAD_CANCELLED', '下载已取消');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function unlinkIfExists(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch {
    // 不存在或无法删除时忽略
  }
}

/** 计算已存在文件的 SHA1，读取失败返回 null */
async function sha1File(file: string): Promise<string | null> {
  try {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** 本地文件是否与预期大小/SHA1 一致（未提供校验信息时仅检查存在） */
async function fileMatches(dest: string, expectedSize?: number, sha1?: string): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(dest);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    return false;
  }
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    return false;
  }
  if (sha1) {
    const actual = await sha1File(dest);
    return actual !== null && actual.toLowerCase() === sha1.toLowerCase();
  }
  return true;
}

/** 解析响应体，边写盘边计算 SHA1 */
async function writeResponseBody(
  response: Response,
  partFile: string,
  report: (delta: number) => void,
  signal: AbortSignal,
  onActivity: () => void
): Promise<{ bytes: number; sha1: string }> {
  if (!response.body) {
    throw new AppError('DOWNLOAD_EMPTY_BODY', '下载失败（响应内容为空）');
  }
  const handle = await fsp.open(partFile, 'w');
  const hash = crypto.createHash('sha1');
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      if (signal.aborted) {
        throw cancelledError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      onActivity();
      const buffer = Buffer.from(value);
      hash.update(buffer);
      bytes += buffer.length;
      await handle.write(buffer);
      report(buffer.length);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { bytes, sha1: hash.digest('hex') };
}

/** 单次下载尝试：写入 .part，校验通过后 rename 为正式文件 */
async function downloadOnce(url: string, dest: string, options: DownloadOptions): Promise<number> {
  const partFile = `${dest}${PART_SUFFIX}`;
  const controller = new AbortController();
  const external = options.signal;
  let connectTimedOut = false;
  let idleTimedOut = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  const onExternalAbort = (): void => controller.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });
  const connectTimer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, CONNECT_TIMEOUT_MS);

  const report = (delta: number): void => {
    options.onBytes?.(delta);
  };

  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const response = await net.fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(connectTimer);
    if (!response.ok) {
      throw new AppError('DOWNLOAD_HTTP_ERROR', `下载失败（HTTP ${response.status}）`);
    }
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      options.onTotal?.(contentLength);
    }
    // 收到响应头后开始计时：长时间无数据则中止并重试
    resetIdleTimer();
    const { bytes, sha1 } = await writeResponseBody(
      response,
      partFile,
      report,
      controller.signal,
      resetIdleTimer
    );

    if (options.expectedSize !== undefined && bytes !== options.expectedSize) {
      throw new AppError(
        'DOWNLOAD_SIZE_MISMATCH',
        `文件大小校验失败（预期 ${options.expectedSize}，实际 ${bytes}）`
      );
    }
    if (options.sha1 && sha1.toLowerCase() !== options.sha1.toLowerCase()) {
      throw new AppError('DOWNLOAD_HASH_MISMATCH', '文件完整性校验失败，请重试');
    }
    await fsp.rename(partFile, dest);
    return bytes;
  } catch (error) {
    await unlinkIfExists(partFile);
    if (external?.aborted) {
      throw cancelledError();
    }
    if (connectTimedOut || idleTimedOut) {
      throw new AppError('DOWNLOAD_TIMEOUT', '下载超时，请检查网络连接');
    }
    if (error instanceof AppError) {
      throw error;
    }
    const detail = error instanceof Error && error.message ? error.message : '未知错误';
    throw new AppError('DOWNLOAD_FAILED', `下载失败：${detail}`);
  } finally {
    clearTimeout(connectTimer);
    clearIdleTimer();
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 下载单个文件到 dest：已存在且校验通过时跳过。
 * 使用临时 .part 文件，成功后原子替换；失败重试 3 次。
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions = {}
): Promise<number> {
  if (!options.force && (await fileMatches(dest, options.expectedSize, options.sha1))) {
    return 0;
  }
  if (options.signal?.aborted) {
    throw cancelledError();
  }

  let lastError: unknown = new AppError('DOWNLOAD_FAILED', '下载失败');
  let totalReported = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let reported = 0;
    const onBytes = options.onBytes;
    const onTotal = options.onTotal;
    const attemptOptions: DownloadOptions = {
      ...options,
      onTotal: onTotal
        ? (bytes: number) => {
            // 重试时不重复累计总量
            if (!totalReported) {
              totalReported = true;
              onTotal(bytes);
            }
          }
        : undefined,
      onBytes: onBytes
        ? (delta: number) => {
            reported += delta;
            onBytes(delta);
          }
        : undefined
    };
    try {
      return await downloadOnce(url, dest, attemptOptions);
    } catch (error) {
      lastError = error;
      if (reported > 0 && onBytes) {
        onBytes(-reported);
      }
      if (isDownloadCancelled(error) || options.signal?.aborted) {
        throw cancelledError();
      }
      if (attempt === RETRY_DELAYS_MS.length) {
        break;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      logLine(`下载失败，${delay}ms 后重试（${path.basename(dest)}）：${error instanceof Error ? error.message : '未知错误'}`);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

/** 按目标路径去重，避免同一文件被多个并发任务同时写入 .part */
function dedupeByDest(tasks: DownloadTask[]): DownloadTask[] {
  const seen = new Set<string>();
  const result: DownloadTask[] = [];
  for (const task of tasks) {
    const key = task.dest.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(task);
  }
  return result;
}

/**
 * 批量下载：固定并发 + 字节进度聚合 + 失败汇总。
 * 任务队列按指针推进，取消时中止进行中的请求并清理 .part。
 */
export async function runBatch(inputTasks: DownloadTask[], options: BatchOptions = {}): Promise<BatchResult> {
  const tasks = dedupeByDest(inputTasks);
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, options.concurrency ?? DEFAULT_CONCURRENCY));
  const totalBytes = tasks.reduce((sum, task) => sum + (task.size ?? 0), 0);
  const result: BatchResult = { downloaded: 0, skipped: 0, failed: [], cancelled: false, bytes: 0 };

  let doneBytes = 0;
  let lastEmitAt = 0;
  // 速度只统计网络实际收到的字节，跳过文件不会造成瞬时“无限速度”
  const speedMeter = createSpeedMeter();
  const emitProgress = (force = false): void => {
    if (!options.onProgress) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    lastEmitAt = now;
    options.onProgress(doneBytes, totalBytes, speedMeter.value());
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) {
        result.cancelled = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) {
        return;
      }
      const task = tasks[index];
      let taskReported = 0;
      try {
        const written = await downloadFile(task.url, task.dest, {
          expectedSize: task.size,
          sha1: task.sha1,
          force: task.force,
          signal: options.signal,
          onBytes: (delta) => {
            taskReported += delta;
            doneBytes += delta;
            speedMeter.add(delta);
            emitProgress();
          }
        });
        if (written === 0) {
          result.skipped += 1;
          // 跳过的文件按已知大小补齐进度
          doneBytes += task.size ?? 0;
          taskReported = task.size ?? 0;
        } else {
          result.downloaded += 1;
          result.bytes += written;
          if (task.size !== undefined) {
            doneBytes += task.size - taskReported;
          }
        }
        emitProgress();
      } catch (error) {
        if (result.cancelled) {
          return;
        }
        if (isDownloadCancelled(error) || options.signal?.aborted) {
          result.cancelled = true;
          return;
        }
        const message = error instanceof Error && error.message ? error.message : '下载失败';
        result.failed.push({ dest: task.dest, message });
        logLine(`下载失败：${path.basename(task.dest)}（${message}）`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(tasks.length, 1)) }, () => worker()));
  if (result.cancelled) {
    // 清理可能残留的临时文件，已完成文件保留以便下次复用
    for (const task of tasks) {
      await unlinkIfExists(`${task.dest}${PART_SUFFIX}`);
    }
  }
  emitProgress(true);
  return result;
}

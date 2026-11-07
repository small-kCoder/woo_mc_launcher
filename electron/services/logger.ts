import fs from 'node:fs';
import path from 'node:path';
import { getLogsDir } from './paths';

/** 内存中保留的最近日志条数，供失败弹窗展示 */
const RECENT_LIMIT = 200;
const DEFAULT_RECENT_LINES = 20;

let logFile: string | null = null;
let stream: fs.WriteStream | null = null;
let recentLines: string[] = [];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 生成 logs/launch-<yyyyMMdd-HHmmss>.log 的文件名 */
function buildLogFileName(date: Date): string {
  const y = date.getFullYear();
  const md = `${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `launch-${y}${md}-${hms}.log`;
}

/** 打码访问令牌，避免日志泄漏 */
function redact(line: string): string {
  return line.replace(/--accessToken\s+\S+/g, '--accessToken ***');
}

function pushRecent(line: string): void {
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) {
    recentLines = recentLines.slice(-RECENT_LIMIT);
  }
}

/** 按启动创建日志文件（同一进程只创建一次） */
function ensureStream(): fs.WriteStream {
  if (stream) {
    return stream;
  }
  const dir = getLogsDir();
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, buildLogFileName(new Date()));
  stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  return stream;
}

/** 写入一行日志 */
export function logLine(message: string): void {
  const line = redact(message).replace(/\r?\n/g, ' ');
  pushRecent(line);
  ensureStream().write(`${line}\n`);
}

/** 写入原始输出块（自动按行拆分并记录） */
export function logChunk(chunk: string): void {
  const text = redact(chunk);
  ensureStream().write(text);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  for (const line of lines) {
    pushRecent(line);
  }
}

/** 获取最近若干行日志 */
export function getRecentLines(count: number = DEFAULT_RECENT_LINES): string[] {
  const size = Number.isFinite(count) && count > 0 ? count : DEFAULT_RECENT_LINES;
  return recentLines.slice(-size);
}

/** 当前日志文件路径，未初始化时返回 null */
export function getLogFile(): string | null {
  return logFile;
}

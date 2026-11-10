import fs from 'node:fs';
import path from 'node:path';
import { logLine } from './logger';
import { getDataDir } from './paths';

/** 通过启动器安装/更新过的模组记录：用于可靠的更新检测 */
export interface ModInstallRecord {
  projectId: string;
  slug: string | null;
  title: string;
  versionId: string;
  versionNumber: string;
  /** 当前实际文件名（可能带 .disabled 后缀） */
  fileName: string;
  installedAt: string;
  source: 'modrinth';
}

const RECORD_FILE = 'mods-installed.json';
const MAX_RECORDS = 500;

let cache: Record<string, ModInstallRecord> | null = null;

function recordFilePath(): string {
  return path.join(getDataDir(), RECORD_FILE);
}

function normalizeRecord(raw: unknown): ModInstallRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  if (
    typeof item.projectId !== 'string' ||
    item.projectId.length === 0 ||
    typeof item.fileName !== 'string' ||
    item.fileName.length === 0 ||
    typeof item.versionId !== 'string' ||
    typeof item.versionNumber !== 'string'
  ) {
    return null;
  }
  return {
    projectId: item.projectId,
    slug: typeof item.slug === 'string' && item.slug.length > 0 ? item.slug : null,
    title: typeof item.title === 'string' && item.title.length > 0 ? item.title : item.fileName,
    versionId: item.versionId,
    versionNumber: item.versionNumber,
    fileName: item.fileName,
    installedAt:
      typeof item.installedAt === 'string' && item.installedAt.length > 0
        ? item.installedAt
        : new Date().toISOString(),
    source: 'modrinth'
  };
}

function load(): Record<string, ModInstallRecord> {
  if (cache) {
    return cache;
  }
  const records: Record<string, ModInstallRecord> = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(recordFilePath(), 'utf8'));
    const list =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as { records?: unknown }).records
        : null;
    if (list && typeof list === 'object' && !Array.isArray(list)) {
      for (const [key, value] of Object.entries(list as Record<string, unknown>)) {
        const record = normalizeRecord(value);
        if (record) {
          records[key] = record;
        }
      }
    }
  } catch {
    // 文件不存在或损坏时从空记录开始
  }
  cache = records;
  return records;
}

function persist(records: Record<string, ModInstallRecord>): void {
  const file = recordFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** 文件名去掉 .disabled 后缀，便于启用/禁用后仍能查到记录 */
export function baseModFileName(fileName: string): string {
  return fileName.toLowerCase().endsWith('.disabled')
    ? fileName.slice(0, -'.disabled'.length)
    : fileName;
}

export function getInstallRecord(fileName: string): ModInstallRecord | null {
  const records = load();
  return records[fileName] ?? records[baseModFileName(fileName)] ?? null;
}

export function listInstallRecords(): ModInstallRecord[] {
  return Object.values(load());
}

export function saveInstallRecord(record: ModInstallRecord): void {
  const records = load();
  // 同一项目只保留最新一条，避免旧文件名残留
  for (const [key, item] of Object.entries(records)) {
    if (item.projectId === record.projectId) {
      delete records[key];
    }
  }
  const entries = Object.entries(records);
  if (entries.length >= MAX_RECORDS) {
    entries
      .sort((a, b) => a[1].installedAt.localeCompare(b[1].installedAt))
      .slice(0, entries.length - MAX_RECORDS + 1)
      .forEach(([key]) => delete records[key]);
  }
  records[record.fileName] = record;
  persist(records);
  logLine(`记录模组安装：${record.title} ${record.versionNumber}（${record.fileName}）`);
}

export function removeInstallRecord(fileName: string): void {
  const records = load();
  const key = records[fileName]
    ? fileName
    : records[baseModFileName(fileName)]
      ? baseModFileName(fileName)
      : null;
  if (!key) {
    return;
  }
  delete records[key];
  persist(records);
}

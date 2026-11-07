import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors';
import { logLine } from './logger';
import { getGameDirectory } from './versions';
import type { ModFile, ModImportResult } from '../../src/types/ipc';

/** 单次导入的文件数量与单文件大小上限 */
const MAX_IMPORT_FILES = 50;
const MAX_MOD_BYTES = 512 * 1024 * 1024;

/** 模组目录：<gameDir>/mods */
export function getModsDirectory(): string {
  return path.join(getGameDirectory(), 'mods');
}

function isJarName(name: string): boolean {
  return name.toLowerCase().endsWith('.jar');
}

/** 列出已导入的模组（.jar），按修改时间倒序 */
export function listMods(): ModFile[] {
  const modsDir = getModsDirectory();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: ModFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isJarName(entry.name)) {
      continue;
    }
    try {
      const stat = fs.statSync(path.join(modsDir, entry.name));
      result.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      // 单个文件读取失败时跳过，不影响列表
    }
  }
  result.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return result;
}

/** 目标文件已存在时追加序号，避免静默覆盖用户已有模组 */
function uniqueDestination(modsDir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(modsDir, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(modsDir, `${base}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

/**
 * 把选中的 .jar 模组复制到游戏的 mods 目录。
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

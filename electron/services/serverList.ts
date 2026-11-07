import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import * as nbt from 'prismarine-nbt';
import { getGameDirectory } from './versions';
import { logLine } from './logger';

/** servers.dat 中条目的 NBT 结构（name/ip 为必填字符串标签） */
type NbtTag = { type: string; value: unknown };
type NbtEntry = Record<string, NbtTag>;
type ServerListTag = { type: 'list'; value: { type: string; value: NbtEntry[] } };

function serverFile(): string {
  return path.join(getGameDirectory(), 'servers.dat');
}

function stringTag(value: string): NbtTag {
  return { type: 'string', value };
}

function isCompoundEntry(value: unknown): value is NbtEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从根 compound 中取出 servers 列表；结构不合法时重建 */
function ensureServers(root: nbt.NBT): ServerListTag {
  if (!root.value || typeof root.value !== 'object') {
    root.value = {};
  }
  const values = root.value as unknown as Record<string, unknown>;
  const current = values.servers as ServerListTag | undefined;
  if (
    current &&
    current.type === 'list' &&
    current.value &&
    typeof current.value === 'object' &&
    Array.isArray(current.value.value)
  ) {
    return current;
  }
  const created: ServerListTag = { type: 'list', value: { type: 'compound', value: [] } };
  values.servers = created;
  return created;
}

/** 读取 servers.dat；不存在或损坏时返回 null，并备份损坏文件 */
async function readServersRoot(file: string): Promise<nbt.NBT | null> {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = await nbt.parse(await fsp.readFile(file));
    if (!parsed.parsed || parsed.parsed.type !== 'compound') {
      throw new Error('根标签不是 compound');
    }
    return parsed.parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`servers.dat 解析失败，已重建：${message}`);
    try {
      await fsp.copyFile(file, `${file}.broken-${Date.now()}`);
    } catch {
      // 备份失败不影响重建
    }
    return null;
  }
}

/**
 * 将联机房间写入 servers.dat：同名条目覆盖，其余条目保留。
 * 写入前首次备份为 servers.dat.bak，使用 .tmp + rename 原子替换。
 */
export async function upsertRoomServer(name: string, address: string): Promise<void> {
  const file = serverFile();
  const root = (await readServersRoot(file)) ?? ({
    type: 'compound',
    name: '',
    value: {}
  } as nbt.NBT);
  const list = ensureServers(root);
  const entries = list.value.value;
  const existing = entries.find((entry) => isCompoundEntry(entry) && entry.name && entry.name.type === 'string' && entry.name.value === name);

  if (existing) {
    existing.ip = stringTag(address);
  } else {
    entries.push({ name: stringTag(name), ip: stringTag(address) });
  }

  const compressed = zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // 首次写入前保留原文件，便于用户恢复
  const backup = `${file}.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) {
    try {
      await fsp.copyFile(file, backup);
    } catch {
      // 备份失败不影响写入
    }
  }
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, compressed);
  await fsp.rename(temp, file);
  logLine(`已写入服务器列表：${name} → ${address}`);
}

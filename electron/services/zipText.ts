import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** 默认单条目读取上限：2MB 足够容纳 fabric.mod.json */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** 定位中央目录结束记录（EOCD），找不到返回 -1 */
function findEocd(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/**
 * 读取 EOCD 中的中央目录信息。
 * 这里只解析尾部数据，不要用传入 buffer 的长度做边界判断：
 * 文件模式下 buffer 只是尾部片段，需由调用方按文件大小校验。
 */
function readEocdInfo(
  tail: Buffer
): { totalEntries: number; centralOffset: number; centralSize: number } | null {
  const eocd = findEocd(tail);
  if (eocd < 0) {
    return null;
  }
  const totalEntries = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return null;
  }
  return { totalEntries, centralOffset, centralSize };
}

/** 遍历中央目录并返回条目（内部按需读取，避免整包载入） */
function readEntries(central: Buffer): CentralEntry[] | null {
  const entries: CentralEntry[] = [];
  let cursor = 0;
  while (cursor + 46 <= central.length) {
    if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return null;
    }
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > central.length) {
      return null;
    }
    entries.push({
      name: central.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      method: central.readUInt16LE(cursor + 10),
      compressedSize: central.readUInt32LE(cursor + 20),
      uncompressedSize: central.readUInt32LE(cursor + 24),
      localOffset: central.readUInt32LE(cursor + 42)
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateEntry(
  data: Buffer,
  entry: CentralEntry,
  isCompressed: boolean,
  maxBytes: number
): Buffer | null {
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    return null;
  }
  if (!isCompressed) {
    return data;
  }
  if (entry.method === 0) {
    return data.subarray(0, Math.min(data.length, entry.uncompressedSize || data.length));
  }
  if (entry.method === 8) {
    return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
  }
  return null;
}

function normalizeName(name: string): string {
  return name.replace(/\\/g, '/');
}

/** 从文件读取单个 ZIP 条目（保持低内存占用） */
export function readZipEntry(
  filePath: string,
  entryName: string,
  maxBytes = DEFAULT_MAX_BYTES
): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) {
      return null;
    }
    const tailSize = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    const meta = readEocdInfo(tail);
    if (!meta) {
      return null;
    }
    // 中央目录可能落在尾块之前，按文件内的实际偏移重新读取
    const centralStart = meta.centralOffset;
    const centralSize = meta.centralSize;
    if (centralStart + centralSize > size) {
      return null;
    }
    const central = Buffer.alloc(centralSize);
    fs.readSync(fd, central, 0, centralSize, centralStart);
    const entries = readEntries(central);
    if (!entries) {
      return null;
    }
    const target = normalizeName(entryName);
    for (const entry of entries) {
      if (normalizeName(entry.name) !== target) {
        continue;
      }
      if (entry.localOffset + 30 > size) {
        return null;
      }
      const local = Buffer.alloc(30);
      fs.readSync(fd, local, 0, 30, entry.localOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        return null;
      }
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + entry.compressedSize > size) {
        return null;
      }
      if (entry.compressedSize > maxBytes || entry.uncompressedSize > maxBytes) {
        return null;
      }
      const compressed = Buffer.alloc(entry.compressedSize);
      fs.readSync(fd, compressed, 0, entry.compressedSize, dataOffset);
      return inflateEntry(compressed, entry, true, maxBytes);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略关闭失败
      }
    }
  }
}

/** 只读取 ZIP 中指定文本条目 */
export function readZipEntryText(
  filePath: string,
  entryName: string,
  maxBytes = DEFAULT_MAX_BYTES
): string | null {
  const buffer = readZipEntry(filePath, entryName, maxBytes);
  return buffer ? buffer.toString('utf8') : null;
}

/** 列出符合前缀/后缀的条目名（如 META-INF/jars/ 下的嵌套模组） */
export function listZipEntryNames(
  filePath: string,
  prefix: string,
  suffix: string,
  limit = 64
): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) {
      return [];
    }
    const tailSize = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    const meta = readEocdInfo(tail);
    if (!meta || meta.centralOffset + meta.centralSize > size) {
      return [];
    }
    const central = Buffer.alloc(meta.centralSize);
    fs.readSync(fd, central, 0, meta.centralSize, meta.centralOffset);
    const entries = readEntries(central);
    if (!entries) {
      return [];
    }
    const result: string[] = [];
    const lowerPrefix = prefix.toLowerCase();
    const lowerSuffix = suffix.toLowerCase();
    for (const entry of entries) {
      const name = normalizeName(entry.name);
      const lower = name.toLowerCase();
      if (!lower.startsWith(lowerPrefix) || !lower.endsWith(lowerSuffix)) {
        continue;
      }
      result.push(name);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略
      }
    }
  }
}

/** 从内存中的 ZIP 数据读取条目（用于嵌套 jar） */
export function readZipEntryFromBuffer(
  buffer: Buffer,
  entryName: string,
  maxBytes = DEFAULT_MAX_BYTES
): Buffer | null {
  try {
    const tailSize = Math.min(buffer.length, 22 + 65535);
    const tail = buffer.subarray(buffer.length - tailSize);
    const meta = readEocdInfo(tail);
    if (!meta) {
      return null;
    }
    const centralEnd = meta.centralOffset + meta.centralSize;
    if (centralEnd > buffer.length) {
      return null;
    }
    const central = buffer.subarray(meta.centralOffset, centralEnd);
    const entries = readEntries(central);
    if (!entries) {
      return null;
    }
    const target = normalizeName(entryName);
    for (const entry of entries) {
      if (normalizeName(entry.name) !== target) {
        continue;
      }
      if (entry.localOffset + 30 > buffer.length) {
        return null;
      }
      if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
        return null;
      }
      const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
      const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + entry.compressedSize > buffer.length) {
        return null;
      }
      const data = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
      return inflateEntry(data, entry, true, maxBytes);
    }
    return null;
  } catch {
    return null;
  }
}

/** 从内存中的 ZIP 数据读取文本条目 */
export function readZipEntryTextFromBuffer(
  buffer: Buffer,
  entryName: string,
  maxBytes = DEFAULT_MAX_BYTES
): string | null {
  const entry = readZipEntryFromBuffer(buffer, entryName, maxBytes);
  return entry ? entry.toString('utf8') : null;
}

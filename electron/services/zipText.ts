import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * 只读取 ZIP 中指定文本条目，避免把整个模组 jar 载入内存。
 * 不支持 ZIP64；损坏或找不到条目时返回 null。
 */
export function readZipEntryText(
  filePath: string,
  entryName: string,
  maxBytes = 2 * 1024 * 1024
): string | null {
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

    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) {
      return null;
    }

    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      return null;
    }
    if (centralOffset + centralSize > size) {
      return null;
    }

    const central = Buffer.alloc(centralSize);
    fs.readSync(fd, central, 0, centralSize, centralOffset);

    let cursor = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        return null;
      }
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const nameStart = cursor + 46;
      if (nameStart + nameLength > central.length) {
        return null;
      }
      const rawName = central.subarray(nameStart, nameStart + nameLength).toString('utf8');
      cursor = nameStart + nameLength + extraLength + commentLength;
      if (rawName.replace(/\\/g, '/') !== entryName) {
        continue;
      }
      if (uncompressedSize > maxBytes || compressedSize > maxBytes) {
        return null;
      }
      if (localOffset + 30 > size) {
        return null;
      }

      const local = Buffer.alloc(30);
      fs.readSync(fd, local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        return null;
      }
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > size) {
        return null;
      }

      const compressed = Buffer.alloc(compressedSize);
      fs.readSync(fd, compressed, 0, compressedSize, dataOffset);
      if (method === 0) {
        return compressed.toString('utf8');
      }
      if (method === 8) {
        const inflated = zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
        return inflated.toString('utf8');
      }
      return null;
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

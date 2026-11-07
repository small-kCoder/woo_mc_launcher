import crypto from 'node:crypto';
import { fail } from '../errors';

/** Minecraft 离线用户名规则：3-16 位字母、数字或下划线 */
const OFFLINE_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/** 校验离线用户名，非法时抛出中文错误 */
export function validateOfflineName(name: unknown): void {
  if (typeof name !== 'string' || !OFFLINE_NAME_PATTERN.test(name)) {
    fail('AUTH_INVALID_OFFLINE_NAME', '用户名需为 3-16 位字母、数字或下划线');
  }
}

/**
 * 计算离线 UUID，等价于 Java 的
 * UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))。
 * 对 MD5 结果设置版本位 3 与 RFC 4122 变体位后格式化为标准小写 UUID。
 */
export function offlineUuid(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    fail('AUTH_INVALID_OFFLINE_NAME', '用户名不能为空');
  }
  const digest = crypto.createHash('md5').update(Buffer.from(`OfflinePlayer:${name}`, 'utf8')).digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

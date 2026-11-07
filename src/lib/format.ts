/** 版本类型后缀：release 正式版 / snapshot 快照 / 旧版本 */
export function versionTypeSuffix(type: string): string {
  if (type === 'snapshot') {
    return '快照';
  }
  if (type === 'old_beta' || type === 'old_alpha') {
    return '旧版';
  }
  return '正式版';
}

/** 把 ISO 时间格式化为 YYYY-MM-DD，非法输入返回空串 */
export function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 运行时长：不足 1 小时为 mm:ss，超过 1 小时为 hh:mm:ss */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = `${minutes}`.padStart(2, '0');
  const ss = `${seconds}`.padStart(2, '0');
  const hh = `${hours}`.padStart(2, '0');
  return hours > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 短 UUID：取前 8 位用于正版账户展示 */
export function shortUuid(uuid: string): string {
  return uuid.slice(0, 8);
}

/** 下载速度格式化：B/s、KB/s、MB/s，非法或非正值返回空串 */
export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '';
  }
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** 文件大小格式化：B、KB、MB、GB */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

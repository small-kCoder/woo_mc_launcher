/** 只展示可读的中文错误；IPC 原始英文异常统一替换为中文兜底文案 */
export function toUserMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (message && /[\u4e00-\u9fa5]/.test(message)) {
    return message;
  }
  return fallback;
}

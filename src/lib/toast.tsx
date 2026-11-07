/** Toast 类型 */
export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastInput {
  type: ToastType;
  message: string;
}

/** 最多同时展示 3 条，单条 3 秒后自动消失 */
const MAX_TOASTS = 3;
const TOAST_DURATION_MS = 3000;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

function emit(): void {
  const snapshot = [...items];
  for (const listener of listeners) {
    listener(snapshot);
  }
}

/** 移除指定 Toast */
export function removeToast(id: number): void {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) {
    return;
  }
  items = next;
  emit();
}

/** 展示一条 Toast，超出上限时丢弃最早的一条 */
export function showToast(input: ToastInput): void {
  const item: ToastItem = { id: nextId++, type: input.type, message: input.message };
  items = [...items, item].slice(-MAX_TOASTS);
  emit();
  window.setTimeout(() => removeToast(item.id), TOAST_DURATION_MS);
}

/** 订阅 Toast 队列，返回取消订阅函数 */
export function subscribeToasts(listener: (next: ToastItem[]) => void): () => void {
  listeners.add(listener);
  listener([...items]);
  return () => {
    listeners.delete(listener);
  };
}

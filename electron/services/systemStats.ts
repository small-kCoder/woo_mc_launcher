import os from 'node:os';
import { BrowserWindow } from 'electron';
import type { SystemStats } from '../../src/types/ipc';

/** 采样与推送间隔 */
const POLL_INTERVAL_MS = 1000;

interface CpuTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

let previous: CpuTimes = readCpuTimes();
let timer: NodeJS.Timeout | null = null;

/**
 * 读取当前 CPU / 内存占用。
 * CPU 通过两次 os.cpus() 的时间差计算，首次调用（间隔过短）会返回 0。
 */
export function getSystemStats(): SystemStats {
  const current = readCpuTimes();
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  previous = current;

  const cpuPercent = totalDelta > 0 ? clampPercent(100 * (1 - idleDelta / totalDelta)) : 0;
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const memoryPercent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;

  return { cpuPercent, memoryPercent, usedBytes, totalBytes, freeBytes };
}

function broadcast(stats: SystemStats): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('system:stats', stats);
    }
  }
}

/** 启动每秒一次的资源采样推送（有窗口时才推送） */
export function startSystemStatsPolling(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    if (BrowserWindow.getAllWindows().length === 0) {
      return;
    }
    broadcast(getSystemStats());
  }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopSystemStatsPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 便携目录解析：全项目唯一的路径来源。
 * 打包后以 exe 所在目录为根，开发时以项目目录为根。
 */
export function getRoot(): string {
  // 以 CLI 方式启动（process.defaultApp 为 true）时一律视为开发态，
  // 因为本机 Electron 33 在开发态下 app.isPackaged 仍返回 true
  const isDevLaunch = (process as unknown as { defaultApp?: boolean }).defaultApp === true;
  if (isDevLaunch) {
    return app.getAppPath();
  }
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
}

export function getGameDir(): string {
  return path.join(getRoot(), '.minecraft');
}

export function getRuntimeJavaDir(): string {
  return path.join(getRoot(), 'runtime', 'java');
}

export function getDataDir(): string {
  return path.join(getRoot(), 'data');
}

export function getLogsDir(): string {
  return path.join(getRoot(), 'logs');
}

export function getConfigFile(): string {
  return path.join(getDataDir(), 'config.json');
}

export function getAccountsFile(): string {
  return path.join(getDataDir(), 'accounts.json');
}

export function getSkinsDir(): string {
  return path.join(getDataDir(), 'skins');
}

/**
 * 首次启动时创建可写目录；runtime/java 缺失不阻塞。
 */
export function ensureRuntimeDirs(): void {
  const dirs = [getGameDir(), getDataDir(), getLogsDir()];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

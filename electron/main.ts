import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerAllIpc } from './ipc/register';
import { getConfig } from './services/config';
import { ensureRuntimeDirs, getRoot } from './services/paths';
import { logLine } from './services/logger';
import { stopMultiplayerOnExit } from './services/multiplayer';
import { startSystemStatsPolling } from './services/systemStats';

/** 通过附加参数把应用版本传给 sandbox 环境下的 preload */
const APP_VERSION_ARG = '--launcher-app-version=';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 640,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`${APP_VERSION_ARG}${app.getVersion()}`]
    }
  });

  mainWindow = win;

  // 首帧渲染完成后再显示，避免白闪
  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // 主进程产物位于 dist-electron/electron/，渲染产物位于 dist/
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // 第二个实例启动时聚焦已有窗口
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    ensureRuntimeDirs();
    const config = getConfig();
    logLine(`启动器启动，版本 ${app.getVersion()}，根目录 ${getRoot()}`);
    logLine(`配置已加载，游戏目录 ${config.gameDir}，内存 ${config.memoryMb}MB`);
    registerAllIpc();
    createWindow();
    startSystemStatsPolling();
  });
}

app.on('before-quit', () => {
  stopMultiplayerOnExit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

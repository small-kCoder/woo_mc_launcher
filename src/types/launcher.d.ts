import type { LauncherApi } from './ipc';

export type { LauncherApi, LauncherEventChannel, LauncherWindowControls } from './ipc';

declare global {
  interface Window {
    launcher: LauncherApi;
  }
}

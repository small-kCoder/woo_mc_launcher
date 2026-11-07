import { spawn } from 'node:child_process';

/** 轮询间隔与最长等待时间 */
const POLL_INTERVAL_MS = 400;
const DEFAULT_TIMEOUT_MS = 300_000;
/** 窗口出现后尝试切到前台的次数与间隔 */
const ACTIVATE_RETRIES = 3;
const ACTIVATE_RETRY_DELAY_MS = 300;

export interface GameWindowWatchOptions {
  pid: number;
  timeoutMs?: number;
  /** 发现窗口时回调；activated 表示是否成功切换到前台 */
  onFound: (activated: boolean) => void;
  /** 检测脚本异常（不影响游戏本身） */
  onError?: (message: string) => void;
}

export interface GameWindowWatch {
  cancel: () => void;
}

/**
 * 用一次性的 PowerShell 小进程轮询指定 pid 的可见主窗口（MainWindowHandle），
 * 发现后尝试 AppActivate 切到前台并输出结果。相比每次轮询都起进程，开销更低。
 */
export function watchGameWindow(options: GameWindowWatchOptions): GameWindowWatch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = ${options.pid}
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
$shell = New-Object -ComObject WScript.Shell
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS}
  $proc = Get-Process -Id $target -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  if ($proc.MainWindowHandle -ne 0) {
    $activated = $false
    for ($i = 0; $i -lt ${ACTIVATE_RETRIES}; $i++) {
      if ($shell.AppActivate($target)) { $activated = $true; break }
      Start-Sleep -Milliseconds ${ACTIVATE_RETRY_DELAY_MS}
    }
    Write-Output ('FOUND ' + [int]$activated)
    break
  }
}
`;
  // 用 -EncodedCommand 避免脚本中的引号/换行被 shell 改写
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );

  let cancelled = false;
  let reported = false;
  const killTimer = setTimeout(() => {
    cancel();
  }, timeoutMs + 2_000);
  killTimer.unref?.();

  function cancel(): void {
    if (cancelled) {
      return;
    }
    cancelled = true;
    clearTimeout(killTimer);
    if (!child.killed) {
      child.kill();
    }
  }

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (reported || cancelled) {
      return;
    }
    const text = chunk.toString();
    const match = /FOUND\s+([01])/.exec(text);
    if (!match) {
      return;
    }
    reported = true;
    cancel();
    options.onFound(match[1] === '1');
  });

  child.on('error', (error) => {
    options.onError?.(error.message);
  });

  return { cancel };
}

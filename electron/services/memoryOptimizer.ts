import { spawn } from 'node:child_process';
import type { MemoryOptimizeResult } from '../../src/types/ipc';
import { AppError } from './errors';
import { logLine } from './logger';

/** 优化脚本超时（避免系统繁忙时卡死启动流程） */
const OPTIMIZE_TIMEOUT_MS = 30_000;

/**
 * 参考 PCL 的“内存优化”思路：整理各进程工作集，把物理内存尽量归还系统，
 * 并通过优化前后的可用物理内存差值估算释放量。
 * 说明：不做提权，只能整理当前用户有权访问的进程；失败进程会被跳过。
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WooMemOptimizer {
  [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct MEMORYSTATUSEX {
    public uint dwLength; public uint dwMemoryLoad;
    public ulong ullTotalPhys; public ulong ullAvailPhys;
    public ulong ullTotalPageFile; public ulong ullAvailPageFile;
    public ulong ullTotalVirtual; public ulong ullAvailVirtual;
    public ulong ullAvailExtendedVirtual;
  }
  [DllImport("kernel32.dll")] public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}
"@
function WooAvailableMemory {
  $status = New-Object WooMemOptimizer+MEMORYSTATUSEX
  $status.dwLength = [uint32]64
  [WooMemOptimizer]::GlobalMemoryStatusEx([ref]$status) | Out-Null
  return [int64]$status.ullAvailPhys
}
$before = WooAvailableMemory
$started = Get-Date
$trimmed = 0
foreach ($item in Get-Process) {
  if ($item.Id -eq $PID) { continue }
  try {
    $handle = [WooMemOptimizer]::OpenProcess(0x0500, $false, [uint32]$item.Id)
    if ($handle -ne [IntPtr]::Zero) {
      if ([WooMemOptimizer]::EmptyWorkingSet($handle)) { $trimmed++ }
      [WooMemOptimizer]::CloseHandle($handle) | Out-Null
    }
  } catch { }
}
Start-Sleep -Milliseconds 500
$after = WooAvailableMemory
$freed = $after - $before
if ($freed -lt 0) { $freed = 0 }
$elapsed = [int](((Get-Date) - $started).TotalMilliseconds)
Write-Output ('OPTIMIZED ' + $freed + ' ' + $elapsed + ' ' + $trimmed)
`;

function parseResult(output: string, fallbackElapsed: number): MemoryOptimizeResult {
  const match = /OPTIMIZED\s+(\d+)\s+(\d+)\s+(\d+)/.exec(output);
  if (!match) {
    return { freedBytes: 0, elapsedMs: fallbackElapsed, trimmedProcesses: 0 };
  }
  return {
    freedBytes: Number.parseInt(match[1], 10),
    elapsedMs: Number.parseInt(match[2], 10),
    trimmedProcesses: Number.parseInt(match[3], 10)
  };
}

/** 执行一次内存优化；失败时抛结构化错误，由调用方决定是否阻断启动 */
export function optimizeMemory(): Promise<MemoryOptimizeResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let settled = false;
    let stdout = '';
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      const result = parseResult(stdout, Date.now() - startedAt);
      logLine(
        `内存优化完成：释放 ${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB，` +
          `整理 ${result.trimmedProcesses} 个进程，用时 ${result.elapsedMs}ms`
      );
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill();
      }
      finish(new AppError('MEMORY_OPTIMIZE_TIMEOUT', '内存优化超时'));
    }, OPTIMIZE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.once('error', (error) => finish(new AppError('MEMORY_OPTIMIZE_FAILED', `内存优化失败：${error.message}`)));
    child.once('close', () => finish());
  });
}

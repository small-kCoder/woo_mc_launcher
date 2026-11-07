import { EventEmitter } from 'node:events';
import type { LaunchPhase } from '../../src/types/ipc';

/** 主进程内部事件：游戏日志行与启动阶段，供联机服务订阅 */
const emitter = new EventEmitter();
emitter.setMaxListeners(20);

export function emitGameLine(line: string): void {
  emitter.emit('line', line);
}

export function onGameLine(listener: (line: string) => void): () => void {
  emitter.on('line', listener);
  return () => emitter.off('line', listener);
}

export function emitLaunchPhase(phase: LaunchPhase): void {
  emitter.emit('phase', phase);
}

export function onLaunchPhase(listener: (phase: LaunchPhase) => void): () => void {
  emitter.on('phase', listener);
  return () => emitter.off('phase', listener);
}

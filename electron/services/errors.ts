/**
 * 应用内统一的错误类型：带错误码，便于 IPC 层记录与渲染进程区分原因。
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 抛出带错误码的中文错误 */
export function fail(code: string, message: string): never {
  throw new AppError(code, message);
}

/**
 * 结构化日志管理器
 * 支持按模块过滤日志级别，避免控制台被开发日志淹没
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel: LogLevel = process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return level >= currentLevel;
}

// Debug 级别的日志（开发环境保留，生产环境静默）
export function debug(module: string, message: string, ...args: unknown[]): void {
  if (!shouldLog(LogLevel.DEBUG)) return;
  console.debug(`[DEBUG][${module}] ${message}`, ...args);
}

// Info 级别的日志
export function info(module: string, message: string, ...args: unknown[]): void {
  if (!shouldLog(LogLevel.INFO)) return;
  console.log(`[${module}] ${message}`, ...args);
}

// Warn 级别的日志
export function warn(module: string, message: string, ...args: unknown[]): void {
  if (!shouldLog(LogLevel.WARN)) return;
  console.warn(`[${module}] ${message}`, ...args);
}

// Error 级别的日志
export function error(module: string, message: string, ...args: unknown[]): void {
  if (!shouldLog(LogLevel.ERROR)) return;
  console.error(`[${module}] ${message}`, ...args);
}

// 便捷方法：按模块创建隔离的 logger
export function createLogger(module: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => debug(module, msg, ...args),
    info: (msg: string, ...args: unknown[]) => info(module, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => warn(module, msg, ...args),
    error: (msg: string, ...args: unknown[]) => error(module, msg, ...args),
  };
}

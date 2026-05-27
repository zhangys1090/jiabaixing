/**
 * jiabaixing 日志系统
 * 提供统一的日志记录功能，支持不同级别的日志输出和持久化存储
 * 支持 Trace ID 全链路追踪
 */

import { EventEmitter } from 'events';
import path from 'path';
import winston from 'winston';

if (process.platform === 'win32') {
  process.stdout.setDefaultEncoding?.('utf8');
  process.stderr.setDefaultEncoding?.('utf8');
}

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

const logEmitter = new EventEmitter();

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  service?: string;
  traceId?: string;
  module?: string;
  requestId?: string;
  userId?: string;
  environment?: string;
  hostname?: string;
  pid?: number;
  stack?: string;
}

const currentTraceId: { id: string | null } = { id: null };

function generateTraceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 11);
  return `trace_${timestamp}_${random}`;
}

function getTraceId(): string | null {
  return currentTraceId.id;
}

function setTraceId(traceId: string | null): void {
  currentTraceId.id = traceId;
}

function clearTraceId(): void {
  currentTraceId.id = null;
}

const logger = winston.createLogger({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'production' ? 'warn' : 'info'),
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    winston.format.errors({
      stack: true,
    }),
    winston.format.splat(),
    winston.format.json(),
    winston.format.printf((info: unknown) => {
      const record = info as Record<string, unknown>;
      record.environment = process.env.NODE_ENV || 'development';
      record.hostname = process.env.HOSTNAME || 'localhost';
      record.pid = process.pid;
      return JSON.stringify(record);
    })
  ),
  defaultMeta: {
    service: 'jiabaixing',
  },
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/fatal.log'),
      level: 'fatal',
      maxsize: 2 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/audit.log'),
      level: 'info',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 15,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
  ],
});

logger.add(
  new winston.transports.Console({
    level:
      process.env.CONSOLE_LOG_LEVEL ||
      (process.env.NODE_ENV === 'production' ? 'warn' : 'info'),
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'HH:mm:ss',
      }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, module }) => {
        const moduleTag = module ? `[${module}]` : '';
        return `${timestamp} ${level} ${moduleTag} ${message}`.trim();
      })
    ),
  })
);

export class Logger {
  public static on(event: string, listener: (entry: LogEntry) => void): void {
    logEmitter.on(event, listener);
  }

  public static off(event: string, listener: (entry: LogEntry) => void): void {
    logEmitter.off(event, listener);
  }

  private static emitLog(entry: LogEntry): void {
    logEmitter.emit('log', entry);
  }

  public static getTraceId(): string | null {
    return getTraceId();
  }

  public static debug(message: string, module?: string, meta?: unknown): void {
    logger.debug(message, {
      traceId: getTraceId(),
      module,
      ...(meta as Record<string, unknown>),
    });

    Logger.emitLog({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      module,
    });
  }

  public static info(message: string, module?: string, meta?: unknown): void {
    logger.info(message, {
      traceId: getTraceId(),
      module,
      ...(meta as Record<string, unknown>),
    });

    Logger.emitLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      module,
    });
  }

  public static warn(message: string, module?: string, meta?: unknown): void {
    logger.warn(message, {
      traceId: getTraceId(),
      module,
      ...(meta as Record<string, unknown>),
    });

    Logger.emitLog({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      module,
    });
  }

  public static error(
    message: string,
    error?: Error,
    module?: string,
    meta?: unknown
  ): void {
    logger.error(message, {
      traceId: getTraceId(),
      module,
      error: error?.message,
      stack: error?.stack,
      ...(meta as Record<string, unknown>),
    });

    Logger.emitLog({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: error ? `${message} - ${error.message}` : message,
      module,
      stack: error?.stack,
    });
  }

  public static fatal(
    message: string,
    error?: Error,
    module?: string,
    meta?: unknown
  ): void {
    logger.error(message, {
      traceId: getTraceId(),
      module,
      error: error?.message,
      stack: error?.stack,
      ...(meta as Record<string, unknown>),
    });

    Logger.emitLog({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message: error
        ? `[FATAL] ${message} - ${error.message}`
        : `[FATAL] ${message}`,
      module,
      stack: error?.stack,
    });
  }

  public static generateTraceId(): string {
    return generateTraceId();
  }

  public static setTraceId(traceId: string): void {
    setTraceId(traceId);
  }

  public static clearTraceId(): void {
    clearTraceId();
  }

  public static withTrace(traceId: string, fn: () => void): void {
    setTraceId(traceId);
    try {
      fn();
    } finally {
      clearTraceId();
    }
  }
}

export default Logger;

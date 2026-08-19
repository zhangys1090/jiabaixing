"use strict";
/**
 * jiabaixing 日志系统
 * 提供统一的日志记录功能，支持不同级别的日志输出和持久化存储
 * 支持 Trace ID 全链路追踪
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = exports.LogLevel = void 0;
const events_1 = require("events");
const path_1 = __importDefault(require("path"));
const winston_1 = __importDefault(require("winston"));
const async_hooks_1 = require("async_hooks");
if (process.platform === 'win32') {
    process.stdout.setDefaultEncoding?.('utf8');
    process.stderr.setDefaultEncoding?.('utf8');
}
var LogLevel;
(function (LogLevel) {
    LogLevel["DEBUG"] = "debug";
    LogLevel["INFO"] = "info";
    LogLevel["WARN"] = "warn";
    LogLevel["ERROR"] = "error";
    LogLevel["FATAL"] = "fatal";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
const logEmitter = new events_1.EventEmitter();
const traceIdStore = new async_hooks_1.AsyncLocalStorage();
const _globalFallbackTraceId = { id: null };
function generateTraceId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 11);
    return `trace_${timestamp}_${random}`;
}
function getTraceId() {
    const storeValue = traceIdStore.getStore();
    if (storeValue !== undefined) {
        return storeValue;
    }
    return _globalFallbackTraceId.id;
}
function setTraceId(traceId) {
    _globalFallbackTraceId.id = traceId;
}
function clearTraceId() {
    _globalFallbackTraceId.id = null;
}
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL ||
        (process.env.NODE_ENV === 'production' ? 'warn' : 'info'),
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
    }), winston_1.default.format.errors({
        stack: true,
    }), winston_1.default.format.splat(), winston_1.default.format.json(), winston_1.default.format.printf((info) => {
        const record = info;
        record.environment = process.env.NODE_ENV || 'development';
        record.hostname = process.env.HOSTNAME || 'localhost';
        record.pid = process.pid;
        return JSON.stringify(record);
    })),
    defaultMeta: {
        service: 'jiabaixing',
    },
    transports: [
        new winston_1.default.transports.File({
            filename: path_1.default.join(__dirname, '../../logs/error.log'),
            level: 'error',
            maxsize: 5 * 1024 * 1024,
            maxFiles: 5,
            tailable: true,
        }),
        new winston_1.default.transports.File({
            filename: path_1.default.join(__dirname, '../../logs/combined.log'),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 10,
            tailable: true,
        }),
        new winston_1.default.transports.File({
            filename: path_1.default.join(__dirname, '../../logs/fatal.log'),
            level: 'fatal',
            maxsize: 2 * 1024 * 1024,
            maxFiles: 3,
            tailable: true,
        }),
        new winston_1.default.transports.File({
            filename: path_1.default.join(__dirname, '../../logs/audit.log'),
            level: 'info',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 15,
            tailable: true,
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
        }),
    ],
});
logger.add(new winston_1.default.transports.Console({
    level: process.env.CONSOLE_LOG_LEVEL ||
        (process.env.NODE_ENV === 'production' ? 'warn' : 'info'),
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({
        format: 'HH:mm:ss',
    }), winston_1.default.format.colorize(), winston_1.default.format.printf(({ timestamp, level, message, module }) => {
        const moduleTag = module ? `[${module}]` : '';
        return `${timestamp} ${level} ${moduleTag} ${message}`.trim();
    })),
}));
class Logger {
    static on(event, listener) {
        logEmitter.on(event, listener);
    }
    static off(event, listener) {
        logEmitter.off(event, listener);
    }
    static emitLog(entry) {
        logEmitter.emit('log', entry);
    }
    static getTraceId() {
        return getTraceId();
    }
    static debug(message, module, meta) {
        logger.debug(message, {
            traceId: getTraceId(),
            module,
            ...meta,
        });
        Logger.emitLog({
            timestamp: new Date().toISOString(),
            level: 'debug',
            message,
            module,
        });
    }
    static info(message, module, meta) {
        logger.info(message, {
            traceId: getTraceId(),
            module,
            ...meta,
        });
        Logger.emitLog({
            timestamp: new Date().toISOString(),
            level: 'info',
            message,
            module,
        });
    }
    static warn(message, module, meta) {
        logger.warn(message, {
            traceId: getTraceId(),
            module,
            ...meta,
        });
        Logger.emitLog({
            timestamp: new Date().toISOString(),
            level: 'warn',
            message,
            module,
        });
    }
    static error(message, error, module, meta) {
        logger.error(message, {
            traceId: getTraceId(),
            module,
            error: error?.message,
            stack: error?.stack,
            ...meta,
        });
        Logger.emitLog({
            timestamp: new Date().toISOString(),
            level: 'error',
            message: error ? `${message} - ${error.message}` : message,
            module,
            stack: error?.stack,
        });
    }
    static fatal(message, error, module, meta) {
        logger.error(message, {
            traceId: getTraceId(),
            module,
            error: error?.message,
            stack: error?.stack,
            ...meta,
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
    static generateTraceId() {
        return generateTraceId();
    }
    static setTraceId(traceId) {
        setTraceId(traceId);
    }
    static clearTraceId() {
        clearTraceId();
    }
    static withTrace(traceId, fn) {
        traceIdStore.run(traceId, () => {
            fn();
        });
    }
    static withTraceAsync(traceId, fn) {
        return traceIdStore.run(traceId, fn);
    }
}
exports.Logger = Logger;
exports.default = Logger;

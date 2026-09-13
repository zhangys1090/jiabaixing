"use strict";
/**
 * 结构化日志管理器
 * 支持按模块过滤日志级别，避免控制台被开发日志淹没
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogLevel = void 0;
exports.setLogLevel = setLogLevel;
exports.debug = debug;
exports.info = info;
exports.warn = warn;
exports.error = error;
exports.createLogger = createLogger;
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
let currentLevel = process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO;
function setLogLevel(level) {
    currentLevel = level;
}
function shouldLog(level) {
    return level >= currentLevel;
}
// Debug 级别的日志（开发环境保留，生产环境静默）
function debug(module, message, ...args) {
    if (!shouldLog(LogLevel.DEBUG))
        return;
    console.debug(`[DEBUG][${module}] ${message}`, ...args);
}
// Info 级别的日志
function info(module, message, ...args) {
    if (!shouldLog(LogLevel.INFO))
        return;
    console.log(`[${module}] ${message}`, ...args);
}
// Warn 级别的日志
function warn(module, message, ...args) {
    if (!shouldLog(LogLevel.WARN))
        return;
    console.warn(`[${module}] ${message}`, ...args);
}
// Error 级别的日志
function error(module, message, ...args) {
    if (!shouldLog(LogLevel.ERROR))
        return;
    console.error(`[${module}] ${message}`, ...args);
}
// 便捷方法：按模块创建隔离的 logger
function createLogger(module) {
    return {
        debug: (msg, ...args) => debug(module, msg, ...args),
        info: (msg, ...args) => info(module, msg, ...args),
        warn: (msg, ...args) => warn(module, msg, ...args),
        error: (msg, ...args) => error(module, msg, ...args),
    };
}

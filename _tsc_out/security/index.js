"use strict";
/**
 * 安全模块统一导出
 *
 * 整合了 AuditLogger、AuditService、DataSovereigntyPipeline 的导出
 * 提供统一的审计日志和安全事件管理接口
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeText = exports.checkSensitiveInfo = exports.checkDangerousCommand = exports.ShellHooks = exports.registerBuiltinShellHooks = exports.SslGuard = exports.UrlSafetyChecker = exports.DataSovereigntyPipeline = exports.AuditLogger = exports.AuditService = void 0;
// ── 核心服务 ──
var AuditService_1 = require("./AuditService");
Object.defineProperty(exports, "AuditService", { enumerable: true, get: function () { return AuditService_1.AuditService; } });
// ── 审计日志器 ──
var AuditLogger_1 = require("./AuditLogger");
Object.defineProperty(exports, "AuditLogger", { enumerable: true, get: function () { return AuditLogger_1.AuditLogger; } });
// ── 数据主权审计管道 ──
var DataSovereigntyPipeline_1 = require("./DataSovereigntyPipeline");
Object.defineProperty(exports, "DataSovereigntyPipeline", { enumerable: true, get: function () { return DataSovereigntyPipeline_1.DataSovereigntyPipeline; } });
// ── URL 安全检查 ──
var UrlSafetyChecker_1 = require("./UrlSafetyChecker");
Object.defineProperty(exports, "UrlSafetyChecker", { enumerable: true, get: function () { return UrlSafetyChecker_1.UrlSafetyChecker; } });
// ── SSL 证书守卫 ──
var SslGuard_1 = require("./SslGuard");
Object.defineProperty(exports, "SslGuard", { enumerable: true, get: function () { return SslGuard_1.SslGuard; } });
// ── Shell 命令钩子 ──
var ShellHooks_1 = require("./ShellHooks");
Object.defineProperty(exports, "registerBuiltinShellHooks", { enumerable: true, get: function () { return ShellHooks_1.registerBuiltinShellHooks; } });
Object.defineProperty(exports, "ShellHooks", { enumerable: true, get: function () { return ShellHooks_1.ShellHooks; } });
// ── 敏感信息检测（从 harness 模块重新导出） ──
var SensitiveDetector_1 = require("../harness/security/SensitiveDetector");
Object.defineProperty(exports, "checkDangerousCommand", { enumerable: true, get: function () { return SensitiveDetector_1.checkDangerousCommand; } });
Object.defineProperty(exports, "checkSensitiveInfo", { enumerable: true, get: function () { return SensitiveDetector_1.checkSensitiveInfo; } });
Object.defineProperty(exports, "sanitizeText", { enumerable: true, get: function () { return SensitiveDetector_1.sanitizeText; } });

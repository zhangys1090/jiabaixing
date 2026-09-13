"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = exports.SecurityAuditor = exports.startSpan = exports.startOTelSpan = exports.shutdownOTel = exports.recordOTelRequest = exports.PerformanceMonitor = exports.perf = exports.measureSync = exports.measure = exports.getTracer = exports.getMeter = exports.endSpan = void 0;
var PerformanceMonitor_1 = require("./PerformanceMonitor");
Object.defineProperty(exports, "endSpan", { enumerable: true, get: function () { return PerformanceMonitor_1.endSpan; } });
Object.defineProperty(exports, "getMeter", { enumerable: true, get: function () { return PerformanceMonitor_1.getMeter; } });
Object.defineProperty(exports, "getTracer", { enumerable: true, get: function () { return PerformanceMonitor_1.getTracer; } });
Object.defineProperty(exports, "measure", { enumerable: true, get: function () { return PerformanceMonitor_1.measure; } });
Object.defineProperty(exports, "measureSync", { enumerable: true, get: function () { return PerformanceMonitor_1.measureSync; } });
Object.defineProperty(exports, "perf", { enumerable: true, get: function () { return PerformanceMonitor_1.perf; } });
Object.defineProperty(exports, "PerformanceMonitor", { enumerable: true, get: function () { return PerformanceMonitor_1.PerformanceMonitor; } });
Object.defineProperty(exports, "recordOTelRequest", { enumerable: true, get: function () { return PerformanceMonitor_1.recordOTelRequest; } });
Object.defineProperty(exports, "shutdownOTel", { enumerable: true, get: function () { return PerformanceMonitor_1.shutdownOTel; } });
Object.defineProperty(exports, "startOTelSpan", { enumerable: true, get: function () { return PerformanceMonitor_1.startOTelSpan; } });
Object.defineProperty(exports, "startSpan", { enumerable: true, get: function () { return PerformanceMonitor_1.startSpan; } });
// ── SecurityAuditor 兼容层导出 ──
var SecurityAuditor_1 = require("./SecurityAuditor");
Object.defineProperty(exports, "SecurityAuditor", { enumerable: true, get: function () { return SecurityAuditor_1.SecurityAuditor; } });
// ── 统一审计服务导出 ──
var AuditService_1 = require("../security/AuditService");
Object.defineProperty(exports, "AuditService", { enumerable: true, get: function () { return AuditService_1.AuditService; } });

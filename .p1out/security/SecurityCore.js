"use strict";
/**
 * SecurityCore — 安全核心模块
 *
 * 合并自: SecurityPolicyEngine + SecurityGuard + NetworkGuard
 * 职责: 输入校验、策略引擎、网络守卫、沙箱检查、权限控制
 * 集成: UrlSafetyChecker + SslGuard + ShellHooks
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityCore = exports.registerBuiltinShellHooks = exports.ShellHooks = exports.SslGuard = exports.UrlSafetyChecker = exports.NetworkGuard = exports.SecurityGuard = exports.SlidingWindowRateLimiter = exports.SecurityPolicyEngine = exports.CircuitBreaker = void 0;
// ── 向后兼容: 重新导出原有模块 ──
var SecurityPolicyEngine_1 = require("./SecurityPolicyEngine");
Object.defineProperty(exports, "CircuitBreaker", { enumerable: true, get: function () { return SecurityPolicyEngine_1.CircuitBreaker; } });
Object.defineProperty(exports, "SecurityPolicyEngine", { enumerable: true, get: function () { return SecurityPolicyEngine_1.SecurityPolicyEngine; } });
Object.defineProperty(exports, "SlidingWindowRateLimiter", { enumerable: true, get: function () { return SecurityPolicyEngine_1.SlidingWindowRateLimiter; } });
var SecurityGuard_1 = require("./SecurityGuard");
Object.defineProperty(exports, "SecurityGuard", { enumerable: true, get: function () { return SecurityGuard_1.SecurityGuard; } });
var NetworkGuard_1 = require("./NetworkGuard");
Object.defineProperty(exports, "NetworkGuard", { enumerable: true, get: function () { return NetworkGuard_1.NetworkGuard; } });
var UrlSafetyChecker_1 = require("./UrlSafetyChecker");
Object.defineProperty(exports, "UrlSafetyChecker", { enumerable: true, get: function () { return UrlSafetyChecker_1.UrlSafetyChecker; } });
var SslGuard_1 = require("./SslGuard");
Object.defineProperty(exports, "SslGuard", { enumerable: true, get: function () { return SslGuard_1.SslGuard; } });
var ShellHooks_1 = require("./ShellHooks");
const Logger_1 = require("../utils/Logger");
Object.defineProperty(exports, "ShellHooks", { enumerable: true, get: function () { return ShellHooks_1.ShellHooks; } });
Object.defineProperty(exports, "registerBuiltinShellHooks", { enumerable: true, get: function () { return ShellHooks_1.registerBuiltinShellHooks; } });
const SensitiveDetector_1 = require("../harness/security/SensitiveDetector");
const NetworkGuard_2 = require("./NetworkGuard");
const SecurityGuard_2 = require("./SecurityGuard");
const SecurityPolicyEngine_2 = require("./SecurityPolicyEngine");
const ShellHooks_2 = require("./ShellHooks");
const SslGuard_2 = require("./SslGuard");
const UrlSafetyChecker_2 = require("./UrlSafetyChecker");
const DEFAULT_CORE_CONFIG = {
    enableNetworkGuard: true,
    enableRateLimit: true,
    rateLimitPerMinute: 60,
    riskThreshold: 'high',
    enableUrlSafety: true,
    enableSslGuard: true,
    enableShellHooks: true,
    enableSensitiveDetection: true,
};
class SecurityCore {
    constructor(config) {
        this.config = { ...DEFAULT_CORE_CONFIG, ...config };
        this.policyEngine = SecurityPolicyEngine_2.SecurityPolicyEngine.getInstance();
        this.guard = SecurityGuard_2.SecurityGuard.getInstance();
        this.urlSafety = UrlSafetyChecker_2.UrlSafetyChecker.getInstance();
        this.sslGuard = SslGuard_2.SslGuard.getInstance();
        this.shellHooks = ShellHooks_2.ShellHooks.getInstance();
        if (this.config.enableNetworkGuard) {
            NetworkGuard_2.NetworkGuard.install();
        }
        if (this.config.enableShellHooks) {
            (0, ShellHooks_2.registerBuiltinShellHooks)();
        }
    }
    static getInstance(config) {
        if (!SecurityCore.instance) {
            SecurityCore.instance = new SecurityCore(config);
        }
        return SecurityCore.instance;
    }
    getPolicyEngine() {
        return this.policyEngine;
    }
    getGuard() {
        return this.guard;
    }
    validateInput(input, maxLength = 10000) {
        return this.guard.validateInput(input, maxLength);
    }
    validateCommand(command) {
        return this.guard.validateCommand(command);
    }
    sandboxCheck(code, language = 'javascript') {
        return this.guard.sandboxCheck(code, language);
    }
    checkRateLimit(userId, limit, windowMs) {
        if (!this.config.enableRateLimit)
            return true;
        return this.policyEngine.checkRateLimit(userId, limit, windowMs);
    }
    detectPromptInjection(input) {
        return this.policyEngine.detectPromptInjection(input);
    }
    filterHarmfulContent(input) {
        return this.policyEngine.filterHarmfulContent(input);
    }
    checkSecurityRedlines(input) {
        return this.policyEngine.checkSecurityRedlines(input);
    }
    assessRisk(operation, resource, action, parameters) {
        return this.policyEngine.assessRisk(operation, resource, action, parameters);
    }
    isUrlAllowed(url) {
        return NetworkGuard_2.NetworkGuard.isUrlAllowed(url);
    }
    getUrlSafety() {
        return this.urlSafety;
    }
    checkUrlSafety(url) {
        if (!this.config.enableUrlSafety) {
            return {
                safe: true,
                riskLevel: 'safe',
                category: '已禁用',
                reason: 'URL安全检查已禁用',
                url,
            };
        }
        return this.urlSafety.check(url);
    }
    getSslGuard() {
        return this.sslGuard;
    }
    getShellHooks() {
        return this.shellHooks;
    }
    async runShellPreHooks(context) {
        if (!this.config.enableShellHooks) {
            return { proceed: true };
        }
        return this.shellHooks.runPreHooks(context);
    }
    async runShellPostHooks(context, exitCode, stdout, stderr) {
        if (!this.config.enableShellHooks)
            return;
        return this.shellHooks.runPostHooks(context, exitCode, stdout, stderr);
    }
    checkSensitiveInfo(text, scene = 'output') {
        if (!this.config.enableSensitiveDetection) {
            return {
                safe: true,
                riskLevel: 'none',
                violations: [],
            };
        }
        return (0, SensitiveDetector_1.checkSensitiveInfo)(text, scene);
    }
    checkDangerousCommand(command) {
        if (!this.config.enableSensitiveDetection) {
            return { dangerous: false };
        }
        return (0, SensitiveDetector_1.checkDangerousCommand)(command);
    }
    sanitizeText(text) {
        return (0, SensitiveDetector_1.sanitizeText)(text);
    }
    getCircuitBreaker(name, config) {
        return this.policyEngine.getCircuitBreaker(name, config);
    }
    healthCheck() {
        const details = {};
        let healthy = true;
        try {
            this.guard.getAuditLogs({ limit: 1 });
            details.guardAvailable = true;
        }
        catch (err) {
            Logger_1.Logger.debug(`安全健康检查-guard不可用: ${err?.message}`, 'SecurityCore');
            details.guardAvailable = false;
            healthy = false;
        }
        try {
            this.policyEngine.checkRateLimit('health-check', 1, 60000);
            details.policyEngineAvailable = true;
        }
        catch (err) {
            Logger_1.Logger.debug(`安全健康检查-policyEngine不可用: ${err?.message}`, 'SecurityCore');
            details.policyEngineAvailable = false;
            healthy = false;
        }
        details.networkGuardEnabled = this.config.enableNetworkGuard;
        details.rateLimitEnabled = this.config.enableRateLimit;
        details.urlSafetyEnabled = this.config.enableUrlSafety;
        details.sslGuardEnabled = this.config.enableSslGuard;
        details.shellHooksEnabled = this.config.enableShellHooks;
        details.sensitiveDetectionEnabled = this.config.enableSensitiveDetection;
        if (this.config.enableShellHooks) {
            details.registeredShellHooks =
                this.shellHooks.getRegisteredHooks().length;
        }
        return { healthy, details };
    }
}
exports.SecurityCore = SecurityCore;
SecurityCore.instance = null;

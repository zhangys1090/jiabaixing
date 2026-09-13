"use strict";
/**
 * Harness Sandbox Executor - 沙箱执行器
 *
 * 提供安全的代码执行环境，防止恶意操作
 * 支持：资源限制、网络隔离、文件系统访问控制
 *
 * V5.6 增强：
 * - Worker 线程真隔离（替代 new Function 伪沙箱）
 * - 资源限制（memory/CPU/timeout）通过 worker_threads resourceLimits
 * - 双模式：isolated (Worker) / inline (Function, 仅 low 安全级别)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxExecutor = exports.DEFAULT_SANDBOX_CONFIG = void 0;
const path = __importStar(require("path"));
const worker_threads_1 = require("worker_threads");
const Logger_1 = require("../../utils/Logger");
// 默认配置
exports.DEFAULT_SANDBOX_CONFIG = {
    securityLevel: 'low',
    mode: 'isolated',
    timeoutMs: 30000,
    maxMemoryMb: 256,
    maxCpuPercent: 50,
    allowedAPIs: [
        'console.log',
        'console.warn',
        'console.error',
        'JSON.parse',
        'JSON.stringify',
        'Date.now',
        'Math.*',
    ],
    allowedFilePaths: [],
    networkPolicy: 'deny',
    enableLogging: true,
};
/**
 * 沙箱执行器
 */
class SandboxExecutor {
    config;
    logs = [];
    securityViolations = [];
    constructor(config) {
        this.config = { ...exports.DEFAULT_SANDBOX_CONFIG, ...config };
        Logger_1.Logger.info(`🔒 SandboxExecutor 初始化 (安全级别: ${this.config.securityLevel})`, 'SandboxExecutor');
    }
    /**
     * 在沙箱中执行代码
     */
    async executeCode(code) {
        const startTime = Date.now();
        this.logs = [];
        this.securityViolations = [];
        Logger_1.Logger.debug(`📝 沙箱执行开始: ${code.slice(0, 100)}...`, 'SandboxExecutor');
        try {
            // 预检查代码安全性
            const preCheck = this.preCheckCode(code);
            if (!preCheck.allowed) {
                return {
                    success: false,
                    error: `安全检查失败: ${preCheck.reason}`,
                    durationMs: Date.now() - startTime,
                    securityViolations: [preCheck.reason],
                };
            }
            // 在受限环境中执行
            const result = await this.executeInSandbox(code);
            const durationMs = Date.now() - startTime;
            Logger_1.Logger.debug(`✅ 沙箱执行完成 (${durationMs}ms)`, 'SandboxExecutor');
            return {
                success: true,
                output: result,
                durationMs,
                logs: this.logs.length > 0 ? [...this.logs] : undefined,
                securityViolations: this.securityViolations.length > 0
                    ? [...this.securityViolations]
                    : undefined,
            };
        }
        catch (error) {
            const durationMs = Date.now() - startTime;
            Logger_1.Logger.error(`❌ 沙箱执行失败: ${error.message}`, error, 'SandboxExecutor');
            return {
                success: false,
                error: error.message,
                durationMs,
                logs: this.logs.length > 0 ? [...this.logs] : undefined,
                securityViolations: this.securityViolations.length > 0
                    ? [...this.securityViolations]
                    : undefined,
            };
        }
    }
    /**
     * 预检查代码安全性
     */
    static CRITICAL_PATTERNS = [
        { pattern: /require\s*\(/, name: 'require调用' },
        { pattern: /import\s*\(/, name: '动态导入' },
        { pattern: /eval\s*\(/, name: 'eval调用' },
        { pattern: /new\s+Function\b/, name: 'new Function构造函数' },
        { pattern: /child_process/, name: '子进程调用' },
        { pattern: /\.constructor\s*\.\s*constructor/, name: '原型链逃逸' },
        { pattern: /arguments\s*\.\s*callee/, name: 'arguments.callee逃逸' },
        { pattern: /\bWorker\b/, name: 'Worker创建' },
    ];
    static HIGH_RISK_PATTERNS = [
        { pattern: /process\./, name: 'process访问' },
        { pattern: /globalThis/, name: 'globalThis访问' },
        { pattern: /global\./, name: 'global对象访问' },
        { pattern: /__dirname/, name: '__dirname访问' },
        { pattern: /__filename/, name: '__filename访问' },
        { pattern: /fs\./, name: '文件系统操作' },
        { pattern: /net\./, name: '网络操作' },
        { pattern: /http\./, name: 'HTTP操作' },
        { pattern: /this\s*\.\s*constructor/, name: 'this.constructor逃逸' },
        { pattern: /Reflect\./, name: 'Reflect访问' },
        { pattern: /\bProxy\b/, name: 'Proxy使用' },
        { pattern: /\bWeakRef\b/, name: 'WeakRef使用' },
        { pattern: /\bSharedArrayBuffer\b/, name: 'SharedArrayBuffer使用' },
        { pattern: /\bAtomics\b/, name: 'Atomics使用' },
        { pattern: /\bparentPort\b/, name: 'parentPort访问' },
        { pattern: /\bfetch\s*\(/, name: 'fetch调用' },
        { pattern: /\bXMLHttpRequest\b/, name: 'XMLHttpRequest使用' },
        { pattern: /\bWebSocket\b/, name: 'WebSocket使用' },
    ];
    preCheckCode(code) {
        for (const { pattern, name } of SandboxExecutor.CRITICAL_PATTERNS) {
            if (pattern.test(code)) {
                this.securityViolations.push(`检测到危险操作: ${name}`);
                return {
                    allowed: false,
                    reason: `检测到危险操作: ${name}`,
                    riskLevel: 'critical',
                };
            }
        }
        if (this.config.securityLevel !== 'low') {
            for (const { pattern, name } of SandboxExecutor.HIGH_RISK_PATTERNS) {
                if (pattern.test(code)) {
                    this.securityViolations.push(`检测到高风险操作: ${name}`);
                    return {
                        allowed: false,
                        reason: `检测到高风险操作: ${name} (安全级别: ${this.config.securityLevel})`,
                        riskLevel: 'high',
                    };
                }
            }
        }
        return { allowed: true, riskLevel: 'low' };
    }
    async executeInSandbox(code) {
        const effectiveMode = this.config.mode === 'inline' && this.config.securityLevel !== 'low'
            ? 'isolated'
            : this.config.mode;
        if (effectiveMode === 'isolated') {
            return this.executeInWorker(code);
        }
        return this.executeInline(code);
    }
    async executeInWorker(code) {
        const workerPath = path.join(__dirname, 'sandboxWorker.js');
        return new Promise((resolve, reject) => {
            let settled = false;
            const worker = new worker_threads_1.Worker(workerPath, {
                eval: false,
                ...(this.config.maxMemoryMb
                    ? {
                        resourceLimits: {
                            maxOldGenerationSizeMb: this.config.maxMemoryMb,
                            maxYoungGenerationSizeMb: Math.floor(this.config.maxMemoryMb / 4),
                            stackSizeMb: 4,
                        },
                    }
                    : {}),
            });
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    void worker.terminate();
                    reject(new Error(`Worker 执行超时 (${this.config.timeoutMs}ms)`));
                }
            }, this.config.timeoutMs);
            worker.on('message', (msg) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutId);
                if (msg.logs && msg.logs.length > 0) {
                    this.logs.push(...msg.logs);
                }
                if (msg.success) {
                    resolve(msg.output);
                }
                else {
                    reject(new Error(msg.error || 'Worker 执行失败'));
                }
            });
            worker.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutId);
                reject(err);
            });
            worker.on('exit', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    reject(new Error(`Worker 异常退出 (code=${code})`));
                }
            });
            worker.postMessage({ code });
        });
    }
    async executeInline(code) {
        // P1-5 修复: inline 模式（new Function）不提供真正隔离，
        // 仅允许安全级别 low 且代码长度 < 1KB 的简单表达式。
        // 超出限制时自动升级到 Worker 隔离模式。
        if (code.length > 1024) {
            Logger_1.Logger.warn('⚠️ inline 模式代码超过 1KB，自动升级到 isolated 模式', 'SandboxExecutor');
            return this.executeInWorker(code);
        }
        Logger_1.Logger.warn('⚠️ inline 模式不提供真正沙箱隔离，仅限低风险表达式', 'SandboxExecutor');
        this.securityViolations.push('inline_mode_no_isolation');
        const safeContext = this.createSafeContext();
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`执行超时 (${this.config.timeoutMs}ms)`));
            }, this.config.timeoutMs);
            try {
                const asyncFunction = new Function(...Object.keys(safeContext), `'use strict';
           const _origProto = Object.getPrototypeOf(this);
           try {
             Object.setPrototypeOf(this, null);
           } catch(_e) {}
           try {
             return (async () => {
               const _guardProps = ['constructor', '__proto__', 'prototype'];
               for (const _gp of _guardProps) {
                 try { Object.defineProperty(this, _gp, { get: () => undefined, set: () => {}, configurable: false }); } catch(_de) {}
               }
               ${code}
             })();
           } finally {
             try { Object.setPrototypeOf(this, _origProto); } catch(_se) {}
           }`);
                const contextValues = Object.values(safeContext);
                const nullProtoCtx = Object.create(null);
                for (let i = 0; i < contextValues.length; i++) {
                    nullProtoCtx[Object.keys(safeContext)[i]] = contextValues[i];
                }
                asyncFunction
                    .call(nullProtoCtx)
                    .then((result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                })
                    .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
            }
            catch (error) {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
    }
    /**
     * 创建安全的执行上下文
     */
    createSafeContext() {
        const safeConsole = {
            log: (...args) => {
                this.logs.push(args.map((a) => String(a)).join(' '));
            },
            warn: (...args) => {
                this.logs.push('[WARN] ' + args.map((a) => String(a)).join(' '));
            },
            error: (...args) => {
                this.logs.push('[ERROR] ' + args.map((a) => String(a)).join(' '));
            },
        };
        const safeJSON = {
            parse: JSON.parse,
            stringify: JSON.stringify,
        };
        const safeDate = Date;
        const safeMath = Math;
        const safeError = class SafeError extends Error {
            constructor(message) {
                super(message);
                this.name = 'Error';
            }
        };
        const safeTypeError = class SafeTypeError extends TypeError {
            constructor(message) {
                super(message);
                this.name = 'TypeError';
            }
        };
        const safeRangeError = class SafeRangeError extends RangeError {
            constructor(message) {
                super(message);
                this.name = 'RangeError';
            }
        };
        return {
            console: safeConsole,
            JSON: safeJSON,
            Date: safeDate,
            Math: safeMath,
            parseInt,
            parseFloat,
            isNaN,
            isFinite,
            encodeURIComponent,
            decodeURIComponent,
            encodeURI,
            decodeURI,
            Array,
            Object,
            String,
            Number,
            Boolean,
            Map,
            Set,
            RegExp,
            Error: safeError,
            TypeError: safeTypeError,
            RangeError: safeRangeError,
            Promise,
            Symbol,
            require: () => {
                throw new Error('require 不可用');
            },
            process: undefined,
            global: undefined,
            globalThis: undefined,
            __dirname: undefined,
            __filename: undefined,
            Buffer: undefined,
            module: undefined,
            exports: undefined,
            Reflect: undefined,
            Proxy: undefined,
            WeakRef: undefined,
            SharedArrayBuffer: undefined,
            Atomics: undefined,
            Worker: undefined,
            parentPort: undefined,
            arguments: undefined,
        };
    }
    /**
     * 检查工具执行权限
     */
    checkToolPermission(toolName, _params) {
        const highRiskTools = [
            'delete_file',
            'execute_command',
            'modify_system',
            'shell_exec',
            'system_command',
        ];
        const mediumRiskTools = ['write_file', 'edit_file'];
        if (highRiskTools.includes(toolName) &&
            this.config.securityLevel !== 'low') {
            return {
                allowed: false,
                reason: `工具 ${toolName} 在当前安全级别下不可用`,
                riskLevel: 'critical',
            };
        }
        if (mediumRiskTools.includes(toolName) &&
            this.config.securityLevel === 'high') {
            return {
                allowed: false,
                reason: `工具 ${toolName} 需要降低安全级别`,
                riskLevel: 'high',
            };
        }
        return { allowed: true, riskLevel: 'low' };
    }
    /**
     * 更新沙箱配置
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        Logger_1.Logger.info(`🔒 沙箱配置更新: ${JSON.stringify(newConfig)}`, 'SandboxExecutor');
    }
    /**
     * 获取当前配置
     */
    getConfig() {
        return { ...this.config };
    }
}
exports.SandboxExecutor = SandboxExecutor;
exports.default = SandboxExecutor;

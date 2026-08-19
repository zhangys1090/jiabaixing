"use strict";
/**
 * Harness Sandbox Executor - 沙箱执行器
 *
 * 提供安全的代码执行环境，防止恶意操作
 * 支持：资源限制、网络隔离、文件系统访问控制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxExecutor = exports.DEFAULT_SANDBOX_CONFIG = void 0;
const Logger_1 = require("../../utils/Logger");
// 默认配置
exports.DEFAULT_SANDBOX_CONFIG = {
    securityLevel: 'low',
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
    constructor(config) {
        this.logs = [];
        this.securityViolations = [];
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
    preCheckCode(code) {
        if (code.length > 50000) {
            this.securityViolations.push('代码长度超过50000字符限制');
            return { allowed: false, reason: '代码过长，可能为注入攻击', riskLevel: 'critical' };
        }
        const dangerousPatterns = [
            { pattern: /require\s*\(/, name: 'require调用' },
            { pattern: /import\s*\(/, name: '动态导入' },
            { pattern: /eval\s*\(/, name: 'eval调用' },
            { pattern: /Function\s*\(/, name: 'Function构造函数' },
            { pattern: /process\./, name: 'process访问' },
            { pattern: /global\./, name: 'global对象访问' },
            { pattern: /globalThis/, name: 'globalThis访问' },
            { pattern: /__dirname/, name: '__dirname访问' },
            { pattern: /__filename/, name: '__filename访问' },
            { pattern: /Buffer\./, name: 'Buffer访问' },
            { pattern: /child_process/, name: '子进程调用' },
            { pattern: /fs\./, name: '文件系统操作' },
            { pattern: /net\./, name: '网络操作' },
            { pattern: /http\./, name: 'HTTP操作' },
            { pattern: /while\s*\(\s*true\s*\)/, name: '无限循环' },
            { pattern: /for\s*\(\s*;\s*;\s*\)/, name: '无限for循环' },
            { pattern: /setTimeout\s*\(\s*[^,]+\s*,\s*0\s*\)/, name: '零延迟定时器攻击' },
            { pattern: /setInterval/, name: '定时器(可能无限)' },
            { pattern: /new\s+Worker/, name: 'Web Worker创建' },
            { pattern: /Atomics\./, name: 'Atomics操作' },
            { pattern: /SharedArrayBuffer/, name: '共享内存访问' },
        ];
        for (const { pattern, name } of dangerousPatterns) {
            if (pattern.test(code)) {
                this.securityViolations.push(`检测到危险操作: ${name}`);
                return {
                    allowed: false,
                    reason: `检测到危险操作: ${name}`,
                    riskLevel: 'critical',
                };
            }
        }
        const recursionDepth = (code.match(/\bfunction\b/g) || []).length + (code.match(/=>/g) || []).length;
        if (recursionDepth > 20) {
            this.securityViolations.push(`函数嵌套过深: ${recursionDepth}`);
            return { allowed: false, reason: `函数嵌套过深(${recursionDepth})，可能为栈溢出攻击`, riskLevel: 'high' };
        }
        return { allowed: true, riskLevel: 'low' };
    }
    /**
     * 在沙箱环境中执行代码
     */
    async executeInSandbox(code) {
        // 创建安全的执行上下文
        const safeContext = this.createSafeContext();
        // 使用 Promise 包装，支持超时
        return new Promise((resolve, reject) => {
            // 超时控制
            const timeoutId = setTimeout(() => {
                reject(new Error(`执行超时 (${this.config.timeoutMs}ms)`));
            }, this.config.timeoutMs);
            try {
                // 使用严格模式和受限上下文执行
                const asyncFunction = new Function(...Object.keys(safeContext), `
          'use strict';
          return (async () => {
            ${code}
          })();
        `);
                // 执行代码
                asyncFunction(...Object.values(safeContext))
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
        // 安全的 console
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
        return {
            console: safeConsole,
            JSON,
            Date,
            Math,
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
            Error,
            TypeError,
            RangeError,
            Promise,
            Symbol,
            BigInt,
            require: () => {
                throw new Error('require 不可用');
            },
            process: undefined,
            global: undefined,
            globalThis: undefined,
            __dirname: undefined,
            __filename: undefined,
            Buffer: undefined,
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

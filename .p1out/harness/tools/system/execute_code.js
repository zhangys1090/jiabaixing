"use strict";
/**
 * Harness Tool: execute_code - 代码执行（沙箱隔离）
 *
 * 支持 JavaScript（沙箱）/ Python / Shell 三种语言
 * JavaScript 通过 SandboxExecutor 在受限上下文执行；Python/Shell 通过子进程带超时执行
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXECUTE_CODE_DEF = void 0;
exports.createExecuteCodeExecutor = createExecuteCodeExecutor;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.EXECUTE_CODE_DEF = {
    name: 'execute_code',
    description: '代码执行工具。在沙箱中执行 JavaScript，或通过子进程执行 Python/Shell。适用场景：计算、数据处理、原型验证、脚本执行。不适用：需要持久化副作用的关键操作。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        language: {
            type: 'string',
            description: '执行语言：javascript | python | shell（默认 javascript）',
            default: 'javascript',
        },
        code: {
            type: 'string',
            description: '要执行的代码',
        },
        timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 10000',
            default: 10000,
        },
    },
    requiredParams: ['code'],
    requiredPermissions: [types_1.Permission.CODE_EXECUTE],
    riskLevel: 'medium',
    idempotent: false,
    timeout: 15000,
};
const FORBIDDEN_PATTERNS = [
    'rm -rf /',
    'rm -rf /*',
    'shutdown',
    'format',
    'del /s /q C:',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'fork bomb',
];
function ok(output, duration, metadata) {
    return { success: true, output, duration, validated: false, metadata };
}
function fail(error, duration, output = '') {
    return { success: false, output, error, duration, validated: false };
}
function containsForbidden(code) {
    const lower = code.toLowerCase();
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (lower.includes(pattern.toLowerCase())) {
            return pattern;
        }
    }
    return null;
}
async function executeJavaScript(code, deps, timeout, startTime) {
    if (deps.sandboxExecutor) {
        try {
            const result = await deps.sandboxExecutor.executeCode(code);
            const output = typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output ?? '', null, 2);
            if (result.success) {
                return ok(output || '(无输出)', Date.now() - startTime, {
                    language: 'javascript',
                    sandboxed: true,
                });
            }
            return fail(result.error || '执行失败', Date.now() - startTime, output);
        }
        catch (err) {
            return fail(`沙箱执行失败: ${err.message}`, Date.now() - startTime);
        }
    }
    // 回退：受限 eval，捕获 console 输出
    const logs = [];
    const sandboxConsole = {
        log: (...args) => logs.push(args.map(String).join(' ')),
        error: (...args) => logs.push(args.map(String).join(' ')),
        warn: (...args) => logs.push(args.map(String).join(' ')),
    };
    try {
        const asyncFn = new Function('console', `"use strict";\n${code}`);
        const result = asyncFn(sandboxConsole);
        const output = [
            ...logs,
            result !== undefined ? `=> ${JSON.stringify(result, null, 2)}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        return ok(output || '(无输出)', Date.now() - startTime, {
            language: 'javascript',
            sandboxed: false,
        });
    }
    catch (err) {
        return fail(`JavaScript 执行错误: ${err.message}`, Date.now() - startTime, logs.join('\n'));
    }
}
function executeSubprocess(code, language, timeout, startTime) {
    try {
        let command;
        let cleanupFile = null;
        if (language === 'python') {
            const tmpFile = path_1.default.join(os_1.default.tmpdir(), `jbx_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);
            fs_1.default.writeFileSync(tmpFile, code, 'utf-8');
            cleanupFile = tmpFile;
            const py = process.platform === 'win32' ? 'python' : 'python3';
            command = `${py} "${tmpFile}"`;
        }
        else {
            command = code;
        }
        const result = (0, child_process_1.execSync)(command, {
            encoding: 'utf-8',
            timeout,
            cwd: process.cwd(),
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
        if (cleanupFile) {
            try {
                fs_1.default.unlinkSync(cleanupFile);
            }
            catch {
                /* ignore */
            }
        }
        Logger_1.Logger.info(`⚡ execute_code 成功 (${language})`, 'ExecuteCode');
        return ok((result || '(无输出)').substring(0, 10000), Date.now() - startTime, { language, exitCode: 0 });
    }
    catch (error) {
        const err = error;
        const output = err.stdout || err.stderr || err.message || '执行失败';
        return fail(`${language} 执行失败 (exit ${err.status ?? 1}): ${err.message.substring(0, 200)}`, Date.now() - startTime, output.substring(0, 5000));
    }
}
function createExecuteCodeExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const code = String(params.code || '');
        const language = String(params.language || 'javascript').toLowerCase();
        const timeout = Number(params.timeout) || 10000;
        if (!code) {
            return fail('请提供要执行的代码', Date.now() - startTime);
        }
        const forbidden = containsForbidden(code);
        if (forbidden) {
            Logger_1.Logger.warn(`🛡️ execute_code 拦截危险代码: "${forbidden}"`, 'ExecuteCode');
            return fail(`代码被安全策略拦截: 包含禁止的操作 "${forbidden}"`, Date.now() - startTime);
        }
        if (deps.terminalBackend) {
            const lang = language === 'javascript' || language === 'js'
                ? 'javascript'
                : language === 'python' || language === 'python3'
                    ? 'python'
                    : 'shell';
            const result = await deps.terminalBackend.executeCode(code, lang, {
                timeout,
            });
            const output = result.stdout || result.stderr || '(无输出)';
            if (result.success) {
                return ok(output.substring(0, 10000), Date.now() - startTime, {
                    language: lang,
                    backend: result.backend,
                    exitCode: result.exitCode,
                });
            }
            return fail(`${lang} 执行失败 (exit ${result.exitCode}): ${result.stderr.substring(0, 200)}`, Date.now() - startTime, output.substring(0, 5000));
        }
        if (language === 'javascript' || language === 'js') {
            return executeJavaScript(code, deps, timeout, startTime);
        }
        if (language === 'python' || language === 'python3') {
            return executeSubprocess(code, 'python', timeout, startTime);
        }
        if (language === 'shell' || language === 'bash' || language === 'sh') {
            return executeSubprocess(code, 'shell', timeout, startTime);
        }
        return fail(`不支持的语言: ${language}。支持: javascript | python | shell`, Date.now() - startTime);
    };
}

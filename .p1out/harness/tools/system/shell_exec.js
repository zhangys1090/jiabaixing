"use strict";
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
exports.SHELL_EXEC_DEF = void 0;
exports.createShellExecExecutor = createShellExecExecutor;
const child_process_1 = require("child_process");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.SHELL_EXEC_DEF = {
    name: 'shell_exec',
    description: 'Shell命令执行工具。在系统终端中执行命令并返回输出。适用场景：运行脚本、管理系统、安装依赖。不适用：需要交互式输入的命令。设置 interpret=true 可让 AI 解读命令输出。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        command: {
            type: 'string',
            description: '要执行的命令',
        },
        timeout: {
            type: 'number',
            description: '超时时间（毫秒）',
            default: 30000,
        },
        cwd: {
            type: 'string',
            description: '工作目录（可选）',
        },
        interpret: {
            type: 'boolean',
            description: '是否让 AI 解读命令输出结果',
            default: false,
        },
    },
    requiredParams: ['command'],
    requiredPermissions: [types_1.Permission.SYSTEM_ADMIN],
    riskLevel: 'high',
    idempotent: false,
    timeout: 35000,
};
const FORBIDDEN_COMMANDS = [
    'format',
    'del /s /q C:',
    'rm -rf /',
    'rm -rf /*',
    'rmdir /s /q',
    'rd /s /q',
    'shutdown',
    'restart',
    'reg delete',
    'reg add HKLM',
    'net user',
    'net localgroup',
    'cipher /w',
    'diskpart',
    'bcdedit',
    'taskkill /f /im svchost',
    'taskkill /f /im csrss',
    'taskkill /f /im lsass',
    'del /f /s /q',
    'erase /f /s /q',
    'cacls * /g everyone:f',
    'icacls * /grant everyone:f',
    'mklink /h',
    'fsutil',
    'vssadmin delete',
    'wbadmin delete',
    'powershell -enc',
    'powershell -encodedcommand',
    'pwsh -enc',
    'pwsh -encodedcommand',
    'certutil',
    'certutil -urlcache',
    'certutil -f',
    'bitsadmin',
    'bitsadmin /transfer',
    'bitsadmin /create',
    'cmd /c del',
    'cmd /c format',
    '> /dev/sda',
    'dd if=',
    'chmod -r 777 /',
    'chown -r',
    'kill -9 1',
    ':(){:|:&};:',
];
function ok(output, duration, metadata) {
    return { success: true, output, duration, validated: false, metadata };
}
function fail(error, duration, output = '') {
    return { success: false, output, error, duration, validated: false };
}
async function interpretOutput(llm, command, output) {
    try {
        const prompt = `以下是命令执行的输出结果，请用简洁的中文解读关键信息。

命令: ${command}
输出:
\`\`\`
${output.substring(0, 3000)}
\`\`\`

要求:
1. 用 1-3 句话总结关键信息
2. 如果是错误，指出原因和建议
3. 如果是列表/表格，提取最重要的几项
4. 不要重复原始输出`;
        return await llm.chat(prompt, [], '你是一个命令行输出解读专家。简洁回答。');
    }
    catch (err) {
        Logger_1.Logger.debug(`命令输出解读失败: ${err?.message}`, 'ShellExec');
        return '';
    }
}
const _commandAuditLog = [];
const MAX_AUDIT_ENTRIES = 500;

function recordCommandAudit(command, success, duration, exitCode, cwd) {
    _commandAuditLog.push({
        timestamp: Date.now(),
        command: command.substring(0, 200),
        success,
        duration,
        exitCode,
        cwd: cwd || process.cwd(),
    });
    if (_commandAuditLog.length > MAX_AUDIT_ENTRIES) {
        _commandAuditLog.shift();
    }
}

function createShellExecExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const command = params.command;
        const timeout = params.timeout || 30000;
        let cwd = params.cwd;
        const interpret = params.interpret === true;
        // 中文命令检测：纯中文开头的命令在系统终端无法执行
        if (command && /^[\u4e00-\u9fff]/.test(command.trim())) {
            // 允许包含中文但以合法命令开头的混合命令（如 echo "中文"）
            const commandPart = command.trim().split(/\s+/)[0];
            const knownCommands = /^(npm|node|python|python3|git|docker|echo|ls|cat|cd|mkdir|rm|cp|mv|curl|wget|ping|ipconfig|netstat|dir|type|findstr|java|go|rustc|cargo|make|gcc|g\+\+|clang|dotnet|ruby|php|perl|bash|sh|zsh|powershell|cmd|winget|choco|scoop|pip|conda|yarn|pnpm|npx|tsc|eslint|prettier|jest|mocha)/i;
            if (!knownCommands.test(commandPart)) {
                Logger_1.Logger.warn(`🛡️ shell_exec 拦截中文命令: "${command.substring(0, 50)}"`, 'ShellExec');
                return fail(`命令以中文开头，不是有效的系统命令: "${command.substring(0, 50)}"。如需执行系统命令，请使用英文命令名，如 "dir" 或 "ping baidu.com"。如需AI帮助，请直接描述你的需求。`, Date.now() - startTime);
            }
        }
        // Windows 路径兼容：将 /tmp/ 转换为 Windows 临时目录
        if (cwd && /^\/tmp\//.test(cwd)) {
            const os = await Promise.resolve().then(() => __importStar(require('os')));
            cwd = cwd.replace(/^\/tmp\//, os.tmpdir().replace(/\\/g, '/') + '/');
            Logger_1.Logger.info(`🔧 路径标准化: /tmp/ → ${cwd}`, 'ShellExec');
        }
        // Fork bomb 模式检测（bash fork bomb 的各种变体）
        if (command.match(/\(\)\s*\{[\s\S]*\|\s*&[\s\S]*\}\s*;/) ||
            command.includes(':(){')) {
            Logger_1.Logger.warn(`🛡️ shell_exec 拦截 fork bomb: "${command.substring(0, 50)}"`, 'ShellExec');
            return fail('命令被安全策略拦截: 检测到 fork bomb 模式', Date.now() - startTime);
        }
        // 管道重定向到设备文件检测
        if (command.match(/>\s*\/dev\/(sda|hda|sd[a-z]|nvme)/)) {
            Logger_1.Logger.warn(`🛡️ shell_exec 拦截设备写入: "${command.substring(0, 50)}"`, 'ShellExec');
            return fail('命令被安全策略拦截: 检测到向块设备写入的重定向', Date.now() - startTime);
        }
        try {
            const lowerCommand = command.toLowerCase().trim();
            for (const forbidden of FORBIDDEN_COMMANDS) {
                if (lowerCommand.includes(forbidden.toLowerCase())) {
                    Logger_1.Logger.warn(`🛡️ shell_exec 拦截危险命令: "${command}"`, 'ShellExec');
                    return fail(`命令被安全策略拦截: 包含禁止的操作 "${forbidden}"`, Date.now() - startTime);
                }
            }
            if (deps.terminalBackend) {
                const result = await deps.terminalBackend.execute(command, {
                    timeout,
                    cwd,
                });
                const output = result.stdout || result.stderr || '(无输出)';
                if (result.success) {
                    recordCommandAudit(command, true, Date.now() - startTime, result.exitCode, cwd);
                    let finalOutput = output.substring(0, 10000);
                    if (interpret && deps.llm) {
                        const interp = await interpretOutput(deps.llm, command, output);
                        if (interp)
                            finalOutput += `\n\n📖 解读:\n${interp}`;
                    }
                    return ok(finalOutput, Date.now() - startTime, {
                        exitCode: result.exitCode,
                        command,
                        backend: result.backend,
                    });
                }
                recordCommandAudit(command, false, Date.now() - startTime, result.exitCode, cwd);
                return fail(`命令退出码: ${result.exitCode}`, Date.now() - startTime, output.substring(0, 5000));
            }
            if (deps.shellRunner) {
                const result = await deps.shellRunner(command, { timeout, cwd });
                const output = result.stdout || result.stderr || '(无输出)';
                if (result.exitCode === 0) {
                    recordCommandAudit(command, true, Date.now() - startTime, 0, cwd);
                    let finalOutput = output.substring(0, 10000);
                    if (interpret && deps.llm) {
                        const interp = await interpretOutput(deps.llm, command, output);
                        if (interp)
                            finalOutput += `\n\n📖 解读:\n${interp}`;
                    }
                    return ok(finalOutput, Date.now() - startTime, {
                        exitCode: 0,
                        command,
                    });
                }
                recordCommandAudit(command, false, Date.now() - startTime, result.exitCode, cwd);
                return fail(`命令退出码: ${result.exitCode}`, Date.now() - startTime, output.substring(0, 5000));
            }
            const result = (0, child_process_1.execSync)(command, {
                encoding: 'utf-8',
                timeout,
                cwd: cwd || process.cwd(),
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            Logger_1.Logger.info(`⚡ shell_exec 成功: "${command.substring(0, 50)}"`, 'ShellExec');
            recordCommandAudit(command, true, Date.now() - startTime, 0, cwd);
            let finalOutput = (result || '(无输出)').substring(0, 10000);
            if (interpret && deps.llm) {
                const interp = await interpretOutput(deps.llm, command, result);
                if (interp)
                    finalOutput += `\n\n📖 解读:\n${interp}`;
            }
            return ok(finalOutput, Date.now() - startTime, { exitCode: 0, command });
        }
        catch (error) {
            const err = error;
            const output = err.stdout || err.stderr || err.message || '执行失败';
            recordCommandAudit(command, false, Date.now() - startTime, err.status || 1, cwd);
            Logger_1.Logger.warn(`⚠️ shell_exec 失败: "${command.substring(0, 50)}"`, 'ShellExec');
            return fail(`命令执行失败 (exit code: ${err.status || 1}): ${err.message.substring(0, 200)}`, Date.now() - startTime, output.substring(0, 5000));
        }
    };
}

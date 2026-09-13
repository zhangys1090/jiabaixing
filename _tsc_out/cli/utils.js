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
exports.RUNTIME_POSTURES = exports.parseRuntimePostureFlags = exports.applyRuntimePostureFlags = void 0;
exports.detectShellCommand = detectShellCommand;
exports.getIM = getIM;
exports.checkBackendHealth = checkBackendHealth;
exports.parseGlobalOptions = parseGlobalOptions;
exports.stripAnsi = stripAnsi;
exports.getEnvFilePath = getEnvFilePath;
exports.readEnvFileSafe = readEnvFileSafe;
exports.getGitStatus = getGitStatus;
exports.getForegroundWindowInfo = getForegroundWindowInfo;
exports.detectEnvironmentType = detectEnvironmentType;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const GatewayBridge_1 = require("../integration/GatewayBridge");
const IntegrationManager_1 = require("../integration/IntegrationManager");
const Logger_1 = require("../utils/Logger");
const constants_1 = require("./constants");
const ipc_1 = require("./ipc");
/**
 * 检测输入是否为 Shell 命令
 * @param input - 用户输入
 * @returns 识别到的 Shell 命令名，或 null
 */
function detectShellCommand(input) {
    const firstWord = input.trim().split(/\s+/)[0]?.toLowerCase();
    if (!firstWord)
        return null;
    if (constants_1.SHELL_COMMANDS.includes(firstWord))
        return firstWord;
    if (/^[a-zA-Z]:\\/.test(firstWord))
        return 'path';
    if (firstWord.endsWith('.exe') ||
        firstWord.endsWith('.cmd') ||
        firstWord.endsWith('.bat'))
        return firstWord;
    return null;
}
/**
 * 获取集成管理器实例（GatewayBridge 优先）
 * @returns IntegrationManager 或 GatewayBridge 实例
 */
function getIM() {
    const bridge = GatewayBridge_1.GatewayBridge.getInstance();
    if (bridge.isWorkerAlive())
        return bridge;
    return IntegrationManager_1.IntegrationManager.getInstance();
}
/**
 * 检查后端服务健康状态
 * 优先通过 IPC 获取，降级到 HTTP
 * @returns 健康状态信息
 */
async function checkBackendHealth() {
    // 优先尝试 IPC 获取状态
    try {
        const ipcResult = await (0, ipc_1.ipcSend)('status');
        const data = ipcResult;
        if (data && data.initialized) {
            return {
                online: true,
                status: 'healthy',
                uptime: data.uptime,
                model: process.env.LLM_MODEL || 'deepseek-v4-flash',
                llm: data.llm,
            };
        }
    }
    catch {
        Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
    }
    try {
        const res = await fetch(`${constants_1.backendUrl}/api/health`, {
            signal: AbortSignal.timeout(3000),
        });
        const data = (await res.json());
        const status = data.status;
        const online = status === 'healthy' || status === 'degraded';
        return {
            online,
            status,
            uptime: data.uptime,
            model: data.model,
            llm: data.llm,
            services: data.services,
        };
    }
    catch {
        return { online: false };
    }
}
/**
 * 从参数列表中解析 --json / --quiet 等全局选项
 * @param args - 原始参数列表
 * @returns 分离后的 { positional, options }
 */
function parseGlobalOptions(args) {
    const positional = [];
    const options = {
        json: false,
        quiet: false,
    };
    for (const arg of args) {
        if (arg === '--json') {
            options.json = true;
        }
        else if (arg === '--quiet' || arg === '-q') {
            options.quiet = true;
        }
        else {
            positional.push(arg);
        }
    }
    return { positional, options };
}
/**
 * 去除文本中的 ANSI 颜色码，用于管道模式纯文本输出
 * @param text - 含 ANSI 码的文本
 * @returns 纯文本
 */
function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}
/** 获取项目目录下的 .env 文件路径 */
function getEnvFilePath() {
    return path.join(process.cwd(), '.env');
}
/** 读取 .env 文件内容，隐藏敏感字段 */
function readEnvFileSafe(envFile) {
    if (!fs.existsSync(envFile))
        return [];
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            return line;
        if (trimmed.includes('KEY=') ||
            trimmed.includes('SECRET=') ||
            trimmed.includes('VERIFY_KEY=')) {
            const [key] = trimmed.split('=');
            return `${key}=****`;
        }
        return trimmed;
    });
}
/** 获取 Git 状态信息 */
function getGitStatus(dirs) {
    const results = [];
    for (const dir of dirs) {
        try {
            const gitDir = path.join(dir, '.git');
            if (!fs.existsSync(gitDir))
                continue;
            const { execSync } = require('child_process');
            const branch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: dir,
                timeout: 3000,
                encoding: 'utf-8',
            })
                .toString()
                .trim();
            const status = execSync('git status --porcelain', {
                cwd: dir,
                timeout: 3000,
                encoding: 'utf-8',
            })
                .toString()
                .trim();
            const uncommitted = status
                ? status.split('\n').filter((l) => l).length
                : 0;
            const lastMsg = execSync('git log -1 --format=%s', {
                cwd: dir,
                timeout: 3000,
                encoding: 'utf-8',
            })
                .toString()
                .trim();
            const name = path.basename(dir);
            results.push(JSON.stringify({ name, branch, uncommitted, lastMsg, dir }));
        }
        catch {
            /* 跳过非git目录 */
        }
    }
    return results;
}
/**
 * 获取前台窗口信息（仅 Windows）
 * @returns 进程名和窗口标题，或 null
 */
function getForegroundWindowInfo() {
    try {
        const { execSync } = require('child_process');
        const psCmd = `powershell -Command "Add-Type @\\\"using System;using System.Runtime.InteropServices;using System.Text;public class W { [DllImport(\\\"user32.dll\\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\\"user32.dll\\\")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder lpString,int nMaxCount);[DllImport(\\\"user32.dll\\\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint lpdwProcessId);} \\\";$h=[W]::GetForegroundWindow();$s=New-Object Text.StringBuilder 256;[W]::GetWindowText($h,$s,256)|Out-Null;$p=0;[W]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;$t=$s.ToString();$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output \\\"$n|$t\\\""`;
        const result = execSync(psCmd, { timeout: 5000, encoding: 'utf-8' })
            .toString()
            .trim();
        const parts = result.split('|');
        if (parts.length >= 2 && parts[0]) {
            return {
                proc: parts[0],
                title: parts.slice(1).join('|'),
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * 根据窗口标题和进程名判断环境类型
 * @param title - 窗口标题
 * @param proc - 进程名
 * @returns 环境类型描述
 */
function detectEnvironmentType(title, proc) {
    const t = title.toLowerCase();
    const p = proc.toLowerCase();
    if (t.includes('code') ||
        t.includes('vscode') ||
        p.includes('code') ||
        t.includes('terminal') ||
        p.includes('terminal') ||
        p.includes('cmd') ||
        p.includes('powershell') ||
        p.includes('bash') ||
        t.includes('cursor')) {
        return `${constants_1.COLORS.green}💻 编程${constants_1.COLORS.reset}`;
    }
    if (p.includes('chrome') ||
        p.includes('edge') ||
        p.includes('firefox') ||
        p.includes('explorer')) {
        return `${constants_1.COLORS.yellow}🌐 浏览${constants_1.COLORS.reset}`;
    }
    return `${constants_1.COLORS.dim}其他${constants_1.COLORS.reset}`;
}
var runtimePosture_1 = require("./runtimePosture");
Object.defineProperty(exports, "applyRuntimePostureFlags", { enumerable: true, get: function () { return runtimePosture_1.applyRuntimePostureFlags; } });
Object.defineProperty(exports, "parseRuntimePostureFlags", { enumerable: true, get: function () { return runtimePosture_1.parseRuntimePostureFlags; } });
Object.defineProperty(exports, "RUNTIME_POSTURES", { enumerable: true, get: function () { return runtimePosture_1.RUNTIME_POSTURES; } });

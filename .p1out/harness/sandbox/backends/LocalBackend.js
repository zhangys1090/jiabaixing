"use strict";
/**
 * 本地执行后端
 *
 * 直接在宿主机执行命令，无隔离。
 * 重构自 shell_exec.ts / execute_code.ts 中的 execSync 逻辑。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalBackend = void 0;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../../utils/Logger");
class LocalBackend {
    constructor(config) {
        this.type = 'local';
        this.initialized = false;
        this.config = {
            timeout: 30000,
            persistentShell: false,
            ...config,
        };
    }
    async initialize() {
        if (this.initialized)
            return;
        this.initialized = true;
        Logger_1.Logger.info(`🖥️ LocalBackend 已就绪 (cwd: ${this.config.cwd || process.cwd()})`, 'LocalBackend');
    }
    async execute(command, options) {
        const startTime = Date.now();
        const timeout = options?.timeout ?? this.config.timeout ?? 30000;
        const cwd = this.resolveCwd(options?.cwd);
        const maxBuffer = options?.maxBuffer ?? 1024 * 1024;
        try {
            const result = await this.execAsync(command, {
                timeout,
                cwd,
                maxBuffer,
                env: options?.env,
            });
            return {
                success: result.exitCode === 0,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - startTime,
                backend: 'local',
                metadata: { command, cwd },
            };
        }
        catch (err) {
            const e = err;
            return {
                success: false,
                stdout: e.stdout ?? '',
                stderr: e.stderr ?? e.message,
                exitCode: e.code ?? 1,
                durationMs: Date.now() - startTime,
                backend: 'local',
                metadata: { command, cwd, error: e.message },
            };
        }
    }
    async executeCode(code, language, options) {
        if (language === 'shell') {
            return this.execute(code, options);
        }
        if (language === 'python') {
            return this.executePython(code, options);
        }
        // javascript: 本地无沙箱，降级为 node -e
        return this.execute(`node -e "${code.replace(/"/g, '\\"')}"`, options);
    }
    async isAvailable() {
        return true;
    }
    getInfo() {
        return {
            type: 'local',
            name: 'LocalBackend',
            available: true,
            description: '直接在宿主机执行，无隔离',
            persistentShell: this.config.persistentShell ?? false,
            isolation: 'none',
        };
    }
    async cleanup() {
        this.initialized = false;
    }
    // ==================== 内部方法 ====================
    resolveCwd(cwd) {
        if (!cwd)
            return this.config.cwd || process.cwd();
        // Windows 路径兼容：/tmp/ → 系统临时目录
        if (/^\/tmp\//.test(cwd)) {
            return cwd.replace(/^\/tmp\//, os_1.default.tmpdir().replace(/\\/g, '/') + '/');
        }
        return cwd;
    }
    execAsync(command, opts) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(command, {
                encoding: 'utf-8',
                timeout: opts.timeout,
                cwd: opts.cwd,
                maxBuffer: opts.maxBuffer,
                windowsHide: true,
                env: opts.env ? { ...process.env, ...opts.env } : process.env,
            }, (err, stdout, stderr) => {
                if (err) {
                    resolve({
                        stdout: stdout || '',
                        stderr: stderr || err.message,
                        exitCode: Number(err.code) || 1,
                    });
                }
                else {
                    resolve({
                        stdout: stdout || '',
                        stderr: stderr || '',
                        exitCode: 0,
                    });
                }
            });
        });
    }
    async executePython(code, options) {
        const startTime = Date.now();
        const timeout = options?.timeout ?? this.config.timeout ?? 30000;
        const cwd = this.resolveCwd(options?.cwd);
        const py = process.platform === 'win32' ? 'python' : 'python3';
        const tmpFile = path_1.default.join(os_1.default.tmpdir(), `jbx_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);
        try {
            fs_1.default.writeFileSync(tmpFile, code, 'utf-8');
            const result = (0, child_process_1.execSync)(`"${py}" "${tmpFile}"`, {
                encoding: 'utf-8',
                timeout,
                cwd,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            return {
                success: true,
                stdout: result || '(无输出)',
                stderr: '',
                exitCode: 0,
                durationMs: Date.now() - startTime,
                backend: 'local',
                metadata: { language: 'python', file: tmpFile },
            };
        }
        catch (err) {
            const e = err;
            return {
                success: false,
                stdout: e.stdout || '',
                stderr: e.stderr || e.message,
                exitCode: e.status ?? 1,
                durationMs: Date.now() - startTime,
                backend: 'local',
                metadata: { language: 'python', file: tmpFile, error: e.message },
            };
        }
        finally {
            try {
                fs_1.default.unlinkSync(tmpFile);
            }
            catch {
                // 忽略清理失败
            }
        }
    }
}
exports.LocalBackend = LocalBackend;

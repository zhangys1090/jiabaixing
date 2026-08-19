"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DaytonaBackend = void 0;
const child_process_1 = require("child_process");
const Logger_1 = require("../../../utils/Logger");
class DaytonaBackend {
    constructor(config) {
        this.type = 'daytona';
        this.initialized = false;
        this.sessionId = null;
        this.config = {
            timeout: 30000,
            ...config,
        };
    }
    async initialize() {
        if (this.initialized)
            return;
        const available = await this.isAvailable();
        if (!available) {
            throw new Error('Daytona CLI 不可用，请确认 daytona 已安装且已登录 (daytona auth)');
        }
        if (this.config.workspaceName) {
            this.sessionId = await this.createOrGetSession();
            Logger_1.Logger.info(`🚀 Daytona 后端已就绪: workspace=${this.config.workspaceName}, session=${this.sessionId}`, 'DaytonaBackend');
        }
        else {
            Logger_1.Logger.info('🚀 Daytona 后端已就绪 (无持久工作区)', 'DaytonaBackend');
        }
        this.initialized = true;
    }
    async execute(command, options) {
        const startTime = Date.now();
        const timeout = options?.timeout ?? this.config.timeout ?? 30000;
        try {
            let fullCommand;
            if (this.sessionId) {
                fullCommand = `daytona exec "${this.sessionId}" -- bash -l -c '${command.replace(/'/g, "'\\''")}'`;
            }
            else {
                fullCommand = `daytona code exec -- bash -l -c '${command.replace(/'/g, "'\\''")}'`;
            }
            const result = await this.execAsync(fullCommand, timeout);
            return {
                success: result.exitCode === 0,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - startTime,
                backend: 'daytona',
                metadata: { command, session: this.sessionId },
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
                backend: 'daytona',
                metadata: { command, error: e.message },
            };
        }
    }
    async executeCode(code, language, options) {
        if (language === 'shell') {
            return this.execute(code, options);
        }
        const ext = language === 'python' ? 'py' : 'js';
        const runner = language === 'python' ? 'python3' : 'node';
        const tmpFile = `/tmp/jbx_daytona_${Date.now()}.${ext}`;
        const writeAndRun = `cat > ${tmpFile} << 'JBX_EOF'\n${code}\nJBX_EOF\n${runner} ${tmpFile}\nrm -f ${tmpFile}`;
        return this.execute(writeAndRun, options);
    }
    async isAvailable() {
        try {
            const result = await this.execAsync('daytona version', 10000);
            return result.exitCode === 0 && result.stdout.includes('Daytona');
        }
        catch {
            return false;
        }
    }
    getInfo() {
        return {
            type: 'daytona',
            name: 'DaytonaBackend',
            available: this.initialized,
            description: `Daytona Serverless 开发环境${this.config.workspaceName ? ` (工作区: ${this.config.workspaceName})` : ''}`,
            persistentShell: true,
            isolation: 'container',
        };
    }
    async cleanup() {
        if (this.sessionId) {
            Logger_1.Logger.info(`🚀 Daytona 会话已释放: ${this.sessionId}`, 'DaytonaBackend');
        }
        this.sessionId = null;
        this.initialized = false;
    }
    async createOrGetSession() {
        try {
            const listResult = await this.execAsync(`daytona list --output json`, 15000);
            if (listResult.exitCode === 0 && listResult.stdout.trim()) {
                try {
                    const sessions = JSON.parse(listResult.stdout);
                    if (Array.isArray(sessions)) {
                        const existing = sessions.find((s) => s.name === this.config.workspaceName);
                        if (existing?.id) {
                            return String(existing.id);
                        }
                    }
                }
                catch {
                    // JSON 解析失败，继续创建新会话
                }
            }
        }
        catch {
            // 列表查询失败，尝试创建
        }
        const createCmd = this.config.template
            ? `daytona create --name "${this.config.workspaceName}" --template "${this.config.template}"`
            : `daytona create --name "${this.config.workspaceName}"`;
        const createResult = await this.execAsync(createCmd, 60000);
        if (createResult.exitCode !== 0) {
            throw new Error(`Daytona 工作区创建失败: ${createResult.stderr}`);
        }
        const match = createResult.stdout.match(/[a-f0-9-]{36}/);
        if (!match) {
            throw new Error('无法从输出中提取会话 ID');
        }
        return match[0];
    }
    execAsync(command, timeout) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(command, {
                encoding: 'utf-8',
                timeout,
                maxBuffer: 2 * 1024 * 1024,
                windowsHide: true,
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
}
exports.DaytonaBackend = DaytonaBackend;

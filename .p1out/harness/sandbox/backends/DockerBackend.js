"use strict";
/**
 * Docker 执行后端
 *
 * 使用持久 Docker 容器执行命令，提供完全隔离。
 * 容器生命周期: 首次执行时启动 → 跨命令复用 → cleanup() 时停止删除
 *
 * 安全加固（参考 Hermes）:
 *   --cap-drop ALL + 仅添加 DAC_OVERRIDE/CHOWN/FOWNER
 *   --security-opt no-new-privileges
 *   --pids-limit 256
 *   tmpfs 大小限制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerBackend = void 0;
const child_process_1 = require("child_process");
const Logger_1 = require("../../../utils/Logger");
class DockerBackend {
    constructor(config) {
        this.type = 'docker';
        this.containerId = null;
        this.initialized = false;
        this.config = {
            timeout: 30000,
            persistentShell: false,
            containerName: 'jiabaixing-sandbox',
            cpu: 1,
            memory: 2048,
            mountCwd: false,
            volumes: [],
            forwardEnv: [],
            ...config,
        };
    }
    async initialize() {
        if (this.initialized)
            return;
        const available = await this.isAvailable();
        if (!available) {
            throw new Error('Docker 不可用，请确认 docker 已安装且 daemon 正在运行');
        }
        // 尝试复用已有容器
        this.containerId = await this.findExistingContainer();
        if (this.containerId) {
            Logger_1.Logger.info(`🐳 复用已有容器: ${this.containerId}`, 'DockerBackend');
        }
        else {
            this.containerId = await this.createContainer();
            Logger_1.Logger.info(`🐳 新建容器: ${this.containerId}`, 'DockerBackend');
        }
        this.initialized = true;
    }
    async execute(command, options) {
        const startTime = Date.now();
        const timeout = options?.timeout ?? this.config.timeout ?? 30000;
        if (!this.containerId) {
            await this.initialize();
        }
        const escapedCmd = this.escapeForDockerExec(command);
        const dockerExecCmd = [
            'docker',
            'exec',
            '-i',
            '--workdir',
            options?.cwd || '/workspace',
            ...this.buildEnvFlags(options?.env),
            this.containerId,
            'bash',
            '-l',
            '-c',
            escapedCmd,
        ].join(' ');
        try {
            const result = await this.execAsync(dockerExecCmd, timeout);
            return {
                success: result.exitCode === 0,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - startTime,
                backend: 'docker',
                metadata: { containerId: this.containerId, command },
            };
        }
        catch (err) {
            const e = err;
            return {
                success: false,
                stdout: e.stdout ?? '',
                stderr: e.stderr ?? e.message,
                exitCode: 1,
                durationMs: Date.now() - startTime,
                backend: 'docker',
                metadata: { containerId: this.containerId, command, error: e.message },
            };
        }
    }
    async executeCode(code, language, options) {
        if (language === 'shell') {
            return this.execute(code, options);
        }
        // 将代码写入容器临时文件再执行
        const ext = language === 'python' ? 'py' : 'js';
        const runner = language === 'python' ? 'python3' : 'node';
        const tmpFile = `/tmp/jbx_code_${Date.now()}.${ext}`;
        // 用 heredoc 写入文件
        const writeAndRun = `cat > ${tmpFile} << 'JBX_EOF'\n${code}\nJBX_EOF\n${runner} ${tmpFile}`;
        const result = await this.execute(writeAndRun, options);
        // 清理临时文件（不阻塞结果）
        this.execute(`rm -f ${tmpFile}`).catch((err) => {
            Logger_1.Logger.debug(`Docker临时文件清理失败: ${err?.message}`, 'DockerBackend');
        });
        return result;
    }
    async isAvailable() {
        try {
            const result = await this.execAsync('docker info', 5000);
            return result.exitCode === 0;
        }
        catch {
            return false;
        }
    }
    getInfo() {
        return {
            type: 'docker',
            name: 'DockerBackend',
            available: this.containerId !== null,
            description: `Docker 容器隔离执行 (镜像: ${this.config.image})`,
            persistentShell: this.config.persistentShell ?? false,
            isolation: 'container',
        };
    }
    async cleanup() {
        if (!this.containerId)
            return;
        try {
            await this.execAsync(`docker stop ${this.containerId}`, 10000);
            await this.execAsync(`docker rm ${this.containerId}`, 10000);
            Logger_1.Logger.info(`🐳 容器已清理: ${this.containerId}`, 'DockerBackend');
        }
        catch (err) {
            Logger_1.Logger.warn(`容器清理失败: ${err.message}`, 'DockerBackend');
        }
        this.containerId = null;
        this.initialized = false;
    }
    // ==================== 内部方法 ====================
    async createContainer() {
        const args = [
            'docker',
            'run',
            '-d',
            '--name',
            this.config.containerName,
            // 安全加固
            '--cap-drop',
            'ALL',
            '--cap-add',
            'DAC_OVERRIDE',
            '--cap-add',
            'CHOWN',
            '--cap-add',
            'FOWNER',
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '256',
            // 资源限制
            `--cpus=${this.config.cpu}`,
            `--memory=${this.config.memory}m`,
            // tmpfs 限制
            '--tmpfs',
            '/tmp:rw,size=512m',
            '--tmpfs',
            '/var/tmp:rw,size=256m',
            // 工作目录
            '-w',
            '/workspace',
        ];
        // 挂载宿主目录
        if (this.config.mountCwd) {
            const hostCwd = this.config.cwd || process.cwd();
            args.push('-v', `${hostCwd.replace(/\\/g, '/')}:/workspace`);
        }
        // 额外卷
        for (const vol of this.config.volumes || []) {
            args.push('-v', vol);
        }
        // 环境变量转发
        for (const envName of this.config.forwardEnv || []) {
            const val = process.env[envName];
            if (val)
                args.push('-e', `${envName}=${val}`);
        }
        // 长时间运行
        args.push(this.config.image, 'sleep', '2h');
        const result = await this.execAsync(args.join(' '), 30000);
        if (result.exitCode !== 0) {
            throw new Error(`创建容器失败: ${result.stderr || result.stdout}`);
        }
        return result.stdout.trim();
    }
    async findExistingContainer() {
        try {
            const result = await this.execAsync(`docker ps -q -f name=${this.config.containerName}`, 5000);
            const id = result.stdout.trim();
            return id || null;
        }
        catch {
            return null;
        }
    }
    buildEnvFlags(env) {
        if (!env)
            return [];
        const flags = [];
        for (const [k, v] of Object.entries(env)) {
            flags.push('-e', `${k}=${v}`);
        }
        return flags;
    }
    escapeForDockerExec(command) {
        // 用单引号包裹，内部单引号转义
        return `'${command.replace(/'/g, "'\\''")}'`;
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
                        exitCode: 1,
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
exports.DockerBackend = DockerBackend;

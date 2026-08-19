"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModalBackend = void 0;
const child_process_1 = require("child_process");
const Logger_1 = require("../../../utils/Logger");
class ModalBackend {
    constructor(config) {
        this.type = 'modal';
        this.initialized = false;
        this.appDeployed = false;
        this.config = {
            timeout: 30000,
            modalTimeout: 300,
            ...config,
        };
    }
    async initialize() {
        if (this.initialized)
            return;
        const available = await this.isAvailable();
        if (!available) {
            throw new Error('Modal CLI 不可用，请确认 modal 已安装且已认证 (modal token set)');
        }
        Logger_1.Logger.info(`⚡ Modal 后端已就绪${this.config.appName ? ` (App: ${this.config.appName})` : ''}`, 'ModalBackend');
        this.initialized = true;
    }
    async execute(command, options) {
        const startTime = Date.now();
        const timeout = options?.timeout ?? this.config.timeout ?? 30000;
        if (!this.initialized) {
            await this.initialize();
        }
        try {
            const script = this.buildRunScript(command, options);
            const result = await this.execAsync(`modal run -d ${script}`, Math.max(timeout, 60000));
            return {
                success: result.exitCode === 0,
                stdout: this.parseModalOutput(result.stdout),
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - startTime,
                backend: 'modal',
                metadata: { command, app: this.config.appName },
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
                backend: 'modal',
                metadata: { command, error: e.message },
            };
        }
    }
    async executeCode(code, language, options) {
        if (language === 'shell') {
            return this.execute(code, options);
        }
        if (language === 'python') {
            return this.executePythonModal(code, options);
        }
        return this.execute(`node -e "${code.replace(/"/g, '\\"')}"`, options);
    }
    async isAvailable() {
        try {
            const result = await this.execAsync('modal profile current', 10000);
            return result.exitCode === 0;
        }
        catch {
            return false;
        }
    }
    getInfo() {
        return {
            type: 'modal',
            name: 'ModalBackend',
            available: this.initialized,
            description: `Modal Serverless GPU 环境${this.config.gpu ? ` (GPU: ${this.config.gpu})` : ''}`,
            persistentShell: false,
            isolation: 'container',
        };
    }
    async cleanup() {
        this.appDeployed = false;
        this.initialized = false;
        Logger_1.Logger.info('⚡ Modal 后端已清理', 'ModalBackend');
    }
    buildRunScript(command, options) {
        const gpuLine = this.config.gpu ? `    gpu="${this.config.gpu}"` : '';
        const cpuLine = this.config.cpu ? `    cpu=${this.config.cpu}` : '';
        const memLine = this.config.memory
            ? `    memory=${Math.floor(this.config.memory / 1024)}*1024`
            : '';
        const timeoutLine = this.config.modalTimeout
            ? `    timeout=${this.config.modalTimeout}`
            : '';
        const cwd = options?.cwd || this.config.cwd || '/root';
        return `modal run - <<'MODAL_EOF'
import modal

app = modal.App("jiabaixing-exec")

@app.function(
${gpuLine}${gpuLine ? ',' : ''}
${cpuLine}${cpuLine ? ',' : ''}
${memLine}${memLine ? ',' : ''}
${timeoutLine}${timeoutLine ? ',' : ''}
    image=modal.Image.debian_slim().pip_install("requests"),
)
def exec_command():
    import subprocess
    result = subprocess.run(
        ["bash", "-l", "-c", ${JSON.stringify(`cd ${cwd} && ${command}`)}],
        capture_output=True,
        text=True,
        timeout=${this.config.modalTimeout || 300},
    )
    print(result.stdout)
    if result.stderr:
        import sys
        print(result.stderr, file=sys.stderr)
    return result.returncode

if __name__ == "__app__":
    exec_command()
MODAL_EOF`;
    }
    async executePythonModal(code, options) {
        const startTime = Date.now();
        const timeout = options?.timeout ?? this.config.timeout ?? 30000;
        const gpuLine = this.config.gpu ? `    gpu="${this.config.gpu}",` : '';
        const timeoutLine = this.config.modalTimeout
            ? `    timeout=${this.config.modalTimeout},`
            : '';
        const modalScript = `modal run - <<'MODAL_EOF'
import modal

app = modal.App("jiabaixing-pyexec")

@app.function(
${gpuLine}
${timeoutLine}
    image=modal.Image.debian_slim().pip_install("numpy", "pandas"),
)
def exec_code():
${code
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n')}

if __name__ == "__app__":
    exec_code()
MODAL_EOF`;
        try {
            const result = await this.execAsync(modalScript, Math.max(timeout, 60000));
            return {
                success: result.exitCode === 0,
                stdout: this.parseModalOutput(result.stdout),
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - startTime,
                backend: 'modal',
                metadata: { language: 'python', app: this.config.appName },
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
                backend: 'modal',
                metadata: { language: 'python', error: e.message },
            };
        }
    }
    parseModalOutput(raw) {
        const lines = raw.split('\n');
        const outputLines = [];
        let capture = false;
        for (const line of lines) {
            if (line.includes('Creating') ||
                line.includes('Building') ||
                line.includes('Pushing')) {
                continue;
            }
            if (line.includes('─────') || line.includes('│')) {
                capture = true;
                const content = line.replace(/[─│┌┐└┘├┤┬┴┼]/g, '').trim();
                if (content)
                    outputLines.push(content);
                continue;
            }
            if (capture || (!line.startsWith('✓') && !line.startsWith('▸'))) {
                outputLines.push(line);
            }
        }
        return outputLines.join('\n').trim() || raw;
    }
    execAsync(command, timeout) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(command, {
                encoding: 'utf-8',
                timeout,
                maxBuffer: 4 * 1024 * 1024,
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
exports.ModalBackend = ModalBackend;

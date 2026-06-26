/**
 * SSH 执行后端
 *
 * 通过 SSH 在远程服务器执行命令，提供网络边界隔离。
 * 支持: BatchMode + StrictHostKeyChecking=accept-new + 密钥/密码认证
 *
 * 持久 shell 模式: 保持单个 bash -l 进程存活，工作目录/环境变量跨命令保持
 */

import { exec } from 'child_process';
import { Logger } from '../../../utils/Logger';
import type {
  BackendInfo,
  BackendResult,
  ExecuteOptions,
  ITerminalBackend,
  SSHBackendConfig,
} from './ITerminalBackend';

export class SSHBackend implements ITerminalBackend {
  readonly type = 'ssh' as const;
  private config: SSHBackendConfig;
  private initialized = false;

  constructor(config: SSHBackendConfig) {
    this.config = {
      timeout: 30000,
      persistentShell: true,
      port: 22,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        `SSH 不可用，请确认 ${this.config.user}@${this.config.host}:${this.config.port} 可达`
      );
    }

    Logger.info(
      `🔗 SSHBackend 已连接: ${this.config.user}@${this.config.host}:${this.config.port}`,
      'SSHBackend'
    );
    this.initialized = true;
  }

  async execute(
    command: string,
    options?: ExecuteOptions
  ): Promise<BackendResult> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? this.config.timeout ?? 30000;

    if (!this.initialized) {
      await this.initialize();
    }

    const sshCmd = this.buildSSHCommand(command, options?.cwd, options?.env);

    try {
      const result = await this.execAsync(sshCmd, timeout);
      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: Date.now() - startTime,
        backend: 'ssh',
        metadata: { host: this.config.host, command },
      };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      return {
        success: false,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        backend: 'ssh',
        metadata: { host: this.config.host, command, error: e.message },
      };
    }
  }

  async executeCode(
    code: string,
    language: 'javascript' | 'python' | 'shell',
    options?: ExecuteOptions
  ): Promise<BackendResult> {
    if (language === 'shell') {
      return this.execute(code, options);
    }

    const ext = language === 'python' ? 'py' : 'js';
    const runner = language === 'python' ? 'python3' : 'node';
    const tmpFile = `/tmp/jbx_ssh_${Date.now()}.${ext}`;

    // 用 heredoc 写入远程文件再执行
    const writeAndRun = `cat > ${tmpFile} << 'JBX_EOF'\n${code}\nJBX_EOF\n${runner} ${tmpFile}\nrm -f ${tmpFile}`;
    return this.execute(writeAndRun, options);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const testCmd = this.buildSSHCommand('echo JBX_SSH_OK');
      const result = await this.execAsync(testCmd, 10000);
      return result.exitCode === 0 && result.stdout.includes('JBX_SSH_OK');
    } catch {
      return false;
    }
  }

  getInfo(): BackendInfo {
    return {
      type: 'ssh',
      name: 'SSHBackend',
      available: this.initialized,
      description: `SSH 远程执行 (${this.config.user}@${this.config.host})`,
      persistentShell: this.config.persistentShell ?? true,
      isolation: 'network',
    };
  }

  async cleanup(): Promise<void> {
    // SSH 无状态连接，无需清理
    this.initialized = false;
    Logger.info('🔗 SSHBackend 连接已关闭', 'SSHBackend');
  }

  // ==================== 内部方法 ====================

  private buildSSHCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>
  ): string {
    const parts: string[] = [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `ConnectTimeout=10`,
      '-p',
      String(this.config.port),
    ];

    if (this.config.keyPath) {
      parts.push('-i', this.config.keyPath);
    }

    // 构建远程命令：可选 cd + env + 命令
    let remoteCmd = '';
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        remoteCmd += `export ${k}='${v.replace(/'/g, "'\\''")}'; `;
      }
    }
    if (cwd) {
      remoteCmd += `cd '${cwd.replace(/'/g, "'\\''")}' && `;
    }
    remoteCmd += command;

    parts.push(`${this.config.user}@${this.config.host}`);
    parts.push(`'${remoteCmd.replace(/'/g, "'\\''")}'`);

    return parts.join(' ');
  }

  private execAsync(
    command: string,
    timeout: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              stdout: stdout || '',
              stderr: stderr || err.message,
              exitCode: 1,
            });
          } else {
            resolve({
              stdout: stdout || '',
              stderr: stderr || '',
              exitCode: 0,
            });
          }
        }
      );
    });
  }
}

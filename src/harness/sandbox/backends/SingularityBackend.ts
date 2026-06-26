import { exec } from 'child_process';
import { Logger } from '../../../utils/Logger';
import type {
  BackendInfo,
  BackendResult,
  ExecuteOptions,
  ITerminalBackend,
} from './ITerminalBackend';

export interface SingularityBackendConfig {
  type: 'singularity';
  /** SIF 镜像路径 */
  image: string;
  /** 是否使用 --fakeroot */
  fakeroot?: boolean;
  /** 绑定挂载（bind paths） */
  binds?: string[];
  /** 默认超时（毫秒） */
  timeout?: number;
  /** 默认工作目录 */
  cwd?: string;
  /** 额外 NVIDIA 支持 */
  nvidia?: boolean;
}

export class SingularityBackend implements ITerminalBackend {
  readonly type = 'singularity' as const;
  private config: SingularityBackendConfig;
  private initialized = false;

  constructor(config: SingularityBackendConfig) {
    this.config = {
      timeout: 30000,
      fakeroot: false,
      binds: [],
      nvidia: false,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        'Singularity 不可用，请确认 singularity 已安装 (通常在 HPC 集群上)'
      );
    }

    const imageExists = await this.checkImage();
    if (!imageExists) {
      throw new Error(`Singularity 镜像不存在: ${this.config.image}`);
    }

    Logger.info(
      `🔬 Singularity 后端已就绪 (镜像: ${this.config.image})`,
      'SingularityBackend'
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

    const singularityCmd = this.buildSingularityCommand(command, options);

    try {
      const result = await this.execAsync(singularityCmd, timeout);
      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: Date.now() - startTime,
        backend: 'singularity',
        metadata: { command, image: this.config.image },
      };
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      return {
        success: false,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message,
        exitCode: e.code ?? 1,
        durationMs: Date.now() - startTime,
        backend: 'singularity',
        metadata: { command, image: this.config.image, error: e.message },
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
    const tmpFile = `/tmp/jbx_singularity_${Date.now()}.${ext}`;
    const writeAndRun = `cat > ${tmpFile} << 'JBX_EOF'\n${code}\nJBX_EOF\n${runner} ${tmpFile}\nrm -f ${tmpFile}`;

    return this.execute(writeAndRun, options);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.execAsync('singularity --version', 10000);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  getInfo(): BackendInfo {
    return {
      type: 'singularity',
      name: 'SingularityBackend',
      available: this.initialized,
      description: `Singularity 容器执行 (镜像: ${this.config.image})`,
      persistentShell: false,
      isolation: 'container',
    };
  }

  async cleanup(): Promise<void> {
    this.initialized = false;
    Logger.info('🔬 Singularity 后端已清理', 'SingularityBackend');
  }

  private buildSingularityCommand(
    command: string,
    options?: ExecuteOptions
  ): string {
    const parts: string[] = ['singularity', 'exec'];

    if (this.config.fakeroot) {
      parts.push('--fakeroot');
    }

    if (this.config.nvidia) {
      parts.push('--nv');
    }

    const cwd = options?.cwd || this.config.cwd || '/workspace';
    parts.push('--pwd', cwd);

    const allBinds = [...(this.config.binds || [])];
    if (allBinds.length > 0) {
      for (const bind of allBinds) {
        parts.push('--bind', bind);
      }
    }

    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        parts.push('--env', `${k}=${v}`);
      }
    }

    parts.push(this.config.image);
    parts.push('bash', '-l', '-c', `'${command.replace(/'/g, "'\\''")}'`);

    return parts.join(' ');
  }

  private async checkImage(): Promise<boolean> {
    try {
      const result = await this.execAsync(
        `singularity sif list ${this.config.image} 2>/dev/null || singularity image.check ${this.config.image}`,
        15000
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
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

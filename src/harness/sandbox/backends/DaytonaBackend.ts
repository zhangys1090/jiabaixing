import { exec } from 'child_process';
import { Logger } from '../../../utils/Logger';
import type {
  BackendInfo,
  BackendResult,
  ExecuteOptions,
  ITerminalBackend,
} from './ITerminalBackend';

export interface DaytonaBackendConfig {
  type: 'daytona';
  /** Daytona API 端点 */
  apiUrl?: string;
  /** 工作区名称 */
  workspaceName?: string;
  /** 目标模板（可选） */
  template?: string;
  /** 默认超时（毫秒） */
  timeout?: number;
  /** 默认工作目录 */
  cwd?: string;
}

export class DaytonaBackend implements ITerminalBackend {
  readonly type = 'daytona' as const;
  private config: DaytonaBackendConfig;
  private initialized = false;
  private sessionId: string | null = null;

  constructor(config: DaytonaBackendConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        'Daytona CLI 不可用，请确认 daytona 已安装且已登录 (daytona auth)'
      );
    }

    if (this.config.workspaceName) {
      this.sessionId = await this.createOrGetSession();
      Logger.info(
        `🚀 Daytona 后端已就绪: workspace=${this.config.workspaceName}, session=${this.sessionId}`,
        'DaytonaBackend'
      );
    } else {
      Logger.info('🚀 Daytona 后端已就绪 (无持久工作区)', 'DaytonaBackend');
    }

    this.initialized = true;
  }

  async execute(
    command: string,
    options?: ExecuteOptions
  ): Promise<BackendResult> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? this.config.timeout ?? 30000;

    try {
      let fullCommand: string;

      if (this.sessionId) {
        fullCommand = `daytona exec "${this.sessionId}" -- bash -l -c '${command.replace(/'/g, "'\\''")}'`;
      } else {
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
        backend: 'daytona',
        metadata: { command, error: e.message },
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
    const tmpFile = `/tmp/jbx_daytona_${Date.now()}.${ext}`;
    const writeAndRun = `cat > ${tmpFile} << 'JBX_EOF'\n${code}\nJBX_EOF\n${runner} ${tmpFile}\nrm -f ${tmpFile}`;

    return this.execute(writeAndRun, options);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.execAsync('daytona version', 10000);
      return result.exitCode === 0 && result.stdout.includes('Daytona');
    } catch {
      return false;
    }
  }

  getInfo(): BackendInfo {
    return {
      type: 'daytona',
      name: 'DaytonaBackend',
      available: this.initialized,
      description: `Daytona Serverless 开发环境${this.config.workspaceName ? ` (工作区: ${this.config.workspaceName})` : ''}`,
      persistentShell: true,
      isolation: 'container',
    };
  }

  async cleanup(): Promise<void> {
    if (this.sessionId) {
      Logger.info(`🚀 Daytona 会话已释放: ${this.sessionId}`, 'DaytonaBackend');
    }
    this.sessionId = null;
    this.initialized = false;
  }

  private async createOrGetSession(): Promise<string> {
    try {
      const listResult = await this.execAsync(
        `daytona list --output json`,
        15000
      );
      if (listResult.exitCode === 0 && listResult.stdout.trim()) {
        try {
          const sessions = JSON.parse(listResult.stdout);
          if (Array.isArray(sessions)) {
            const existing = sessions.find(
              (s: Record<string, unknown>) =>
                s.name === this.config.workspaceName
            );
            if (existing?.id) {
              return String(existing.id);
            }
          }
        } catch {
          // JSON 解析失败，继续创建新会话
        }
      }
    } catch {
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
              exitCode: Number(err.code) || 1,
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

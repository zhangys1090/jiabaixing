/**
 * 本地执行后端
 *
 * 直接在宿主机执行命令，无隔离。
 * 重构自 shell_exec.ts / execute_code.ts 中的 execSync 逻辑。
 */

import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type {
  BackendInfo,
  BackendResult,
  ExecuteOptions,
  ITerminalBackend,
  LocalBackendConfig,
} from './ITerminalBackend';

export class LocalBackend implements ITerminalBackend {
  readonly type = 'local' as const;
  private config: LocalBackendConfig;
  private initialized = false;

  constructor(config: LocalBackendConfig) {
    this.config = {
      timeout: 30000,
      persistentShell: false,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    Logger.info(
      `🖥️ LocalBackend 已就绪 (cwd: ${this.config.cwd || process.cwd()})`,
      'LocalBackend'
    );
  }

  async execute(
    command: string,
    options?: ExecuteOptions
  ): Promise<BackendResult> {
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
        backend: 'local',
        metadata: { command, cwd, error: e.message },
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

    if (language === 'python') {
      return this.executePython(code, options);
    }

    // javascript: 本地无沙箱，降级为 node -e
    return this.execute(`node -e "${code.replace(/"/g, '\\"')}"`, options);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getInfo(): BackendInfo {
    return {
      type: 'local',
      name: 'LocalBackend',
      available: true,
      description: '直接在宿主机执行，无隔离',
      persistentShell: this.config.persistentShell ?? false,
      isolation: 'none',
    };
  }

  async cleanup(): Promise<void> {
    this.initialized = false;
  }

  // ==================== 内部方法 ====================

  private resolveCwd(cwd?: string): string {
    if (!cwd) return this.config.cwd || process.cwd();
    // Windows 路径兼容：/tmp/ → 系统临时目录
    if (/^\/tmp\//.test(cwd)) {
      return cwd.replace(/^\/tmp\//, os.tmpdir().replace(/\\/g, '/') + '/');
    }
    return cwd;
  }

  private execAsync(
    command: string,
    opts: {
      timeout: number;
      cwd: string;
      maxBuffer: number;
      env?: Record<string, string>;
    }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          encoding: 'utf-8',
          timeout: opts.timeout,
          cwd: opts.cwd,
          maxBuffer: opts.maxBuffer,
          windowsHide: true,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
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

  private async executePython(
    code: string,
    options?: ExecuteOptions
  ): Promise<BackendResult> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? this.config.timeout ?? 30000;
    const cwd = this.resolveCwd(options?.cwd);
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const tmpFile = path.join(
      os.tmpdir(),
      `jbx_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`
    );

    try {
      fs.writeFileSync(tmpFile, code, 'utf-8');
      const result = execSync(`"${py}" "${tmpFile}"`, {
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
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      return {
        success: false,
        stdout: e.stdout || '',
        stderr: e.stderr || e.message,
        exitCode: e.status ?? 1,
        durationMs: Date.now() - startTime,
        backend: 'local',
        metadata: { language: 'python', file: tmpFile, error: e.message },
      };
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // 忽略清理失败
      }
    }
  }
}

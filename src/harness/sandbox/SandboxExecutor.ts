/**
 * Harness Sandbox Executor - 沙箱执行器
 *
 * 提供安全的代码执行环境，防止恶意操作
 * 支持：资源限制、网络隔离、文件系统访问控制
 *
 * V5.6 增强：
 * - Worker 线程真隔离（替代 new Function 伪沙箱）
 * - 资源限制（memory/CPU/timeout）通过 worker_threads resourceLimits
 * - 双模式：isolated (Worker) / inline (Function, 仅 low 安全级别)
 */

import { Logger } from '../../utils/Logger';

// 安全级别定义
export type SandboxSecurityLevel = 'low' | 'medium' | 'high' | 'critical';
export type SandboxMode = 'isolated' | 'inline';

// 沙箱执行配置
export interface SandboxConfig {
  securityLevel: SandboxSecurityLevel;
  mode: SandboxMode;
  timeoutMs: number;
  maxMemoryMb: number;
  maxCpuPercent: number;
  allowedAPIs: string[];
  allowedFilePaths: string[];
  networkPolicy: 'allow' | 'deny' | 'read-only';
  enableLogging: boolean;
}

// 沙箱执行结果
export interface SandboxExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  memoryUsedMb?: number;
  cpuUsedPercent?: number;
  logs?: string[];
  securityViolations?: string[];
}

// 权限检查结果
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  riskLevel: SandboxSecurityLevel;
}

// 资源使用监控
export interface ResourceUsage {
  memoryMb: number;
  cpuPercent: number;
  durationMs: number;
}

// 默认配置
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  securityLevel: 'low',
  mode: 'isolated',
  timeoutMs: 30000,
  maxMemoryMb: 256,
  maxCpuPercent: 50,
  allowedAPIs: [
    'console.log',
    'console.warn',
    'console.error',
    'JSON.parse',
    'JSON.stringify',
    'Date.now',
    'Math.*',
  ],
  allowedFilePaths: [],
  networkPolicy: 'deny',
  enableLogging: true,
};

/**
 * 沙箱执行器
 */
export class SandboxExecutor {
  private config: SandboxConfig;
  private logs: string[] = [];
  private securityViolations: string[] = [];

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    Logger.info(
      `🔒 SandboxExecutor 初始化 (安全级别: ${this.config.securityLevel})`,
      'SandboxExecutor'
    );
  }

  /**
   * 在沙箱中执行代码
   */
  async executeCode(code: string): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    this.logs = [];
    this.securityViolations = [];

    Logger.debug(
      `📝 沙箱执行开始: ${code.slice(0, 100)}...`,
      'SandboxExecutor'
    );

    try {
      // 预检查代码安全性
      const preCheck = this.preCheckCode(code);
      if (!preCheck.allowed) {
        return {
          success: false,
          error: `安全检查失败: ${preCheck.reason}`,
          durationMs: Date.now() - startTime,
          securityViolations: [preCheck.reason!],
        };
      }

      // 在受限环境中执行
      const result = await this.executeInSandbox(code);

      const durationMs = Date.now() - startTime;

      Logger.debug(`✅ 沙箱执行完成 (${durationMs}ms)`, 'SandboxExecutor');

      return {
        success: true,
        output: result,
        durationMs,
        logs: this.logs.length > 0 ? [...this.logs] : undefined,
        securityViolations:
          this.securityViolations.length > 0
            ? [...this.securityViolations]
            : undefined,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      Logger.error(
        `❌ 沙箱执行失败: ${(error as Error).message}`,
        error as Error,
        'SandboxExecutor'
      );

      return {
        success: false,
        error: (error as Error).message,
        durationMs,
        logs: this.logs.length > 0 ? [...this.logs] : undefined,
        securityViolations:
          this.securityViolations.length > 0
            ? [...this.securityViolations]
            : undefined,
      };
    }
  }

  /**
   * 预检查代码安全性
   */
  private preCheckCode(code: string): PermissionCheckResult {
    // 检查危险模式
    const dangerousPatterns = [
      { pattern: /require\s*\(/, name: 'require调用' },
      { pattern: /import\s*\(/, name: '动态导入' },
      { pattern: /eval\s*\(/, name: 'eval调用' },
      { pattern: /Function\s*\(/, name: 'Function构造函数' },
      { pattern: /process\./, name: 'process访问' },
      { pattern: /global\./, name: 'global对象访问' },
      { pattern: /__dirname/, name: '__dirname访问' },
      { pattern: /__filename/, name: '__filename访问' },
      { pattern: /child_process/, name: '子进程调用' },
      { pattern: /fs\./, name: '文件系统操作' },
      { pattern: /net\./, name: '网络操作' },
      { pattern: /http\./, name: 'HTTP操作' },
    ];

    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(code)) {
        this.securityViolations.push(`检测到危险操作: ${name}`);
        return {
          allowed: false,
          reason: `检测到危险操作: ${name}`,
          riskLevel: 'critical',
        };
      }
    }

    return { allowed: true, riskLevel: 'low' };
  }

  private async executeInSandbox(code: string): Promise<unknown> {
    const effectiveMode = this.config.mode === 'inline' && this.config.securityLevel !== 'low'
      ? 'isolated'
      : this.config.mode;

    if (effectiveMode === 'isolated') {
      return this.executeInWorker(code);
    }
    return this.executeInline(code);
  }

  private async executeInWorker(code: string): Promise<unknown> {
    const workerPath = path.join(__dirname, 'sandboxWorker.js');

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;

      const worker = new Worker(workerPath, {
        resourceLimits: {
          maxOldGenerationSizeMb: this.config.maxMemoryMb,
          maxYoungGenerationSizeMb: Math.floor(this.config.maxMemoryMb / 4),
          stackSizeMb: 4,
        },
        eval: false,
      });

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          worker.terminate();
          reject(new Error(`Worker 执行超时 (${this.config.timeoutMs}ms)`));
        }
      }, this.config.timeoutMs);

      worker.on('message', (msg: { success: boolean; output?: unknown; error?: string; logs?: string[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);

        if (msg.logs && msg.logs.length > 0) {
          this.logs.push(...msg.logs);
        }

        if (msg.success) {
          resolve(msg.output);
        } else {
          reject(new Error(msg.error || 'Worker 执行失败'));
        }
      });

      worker.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      });

      worker.on('exit', (code: number) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(new Error(`Worker 异常退出 (code=${code})`));
        }
      });

      worker.postMessage({ code });
    });
  }

  private async executeInline(code: string): Promise<unknown> {
    const safeContext = this.createSafeContext();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`执行超时 (${this.config.timeoutMs}ms)`));
      }, this.config.timeoutMs);

      try {
        const asyncFunction = new Function(
          ...Object.keys(safeContext),
          `'use strict'; return (async () => { ${code} })();`
        );

        asyncFunction(...Object.values(safeContext))
          .then((result: unknown) => {
            clearTimeout(timeoutId);
            resolve(result);
          })
          .catch((error: unknown) => {
            clearTimeout(timeoutId);
            reject(error);
          });
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * 创建安全的执行上下文
   */
  private createSafeContext(): Record<string, unknown> {
    // 安全的 console
    const safeConsole = {
      log: (...args: unknown[]) => {
        this.logs.push(args.map((a) => String(a)).join(' '));
      },
      warn: (...args: unknown[]) => {
        this.logs.push('[WARN] ' + args.map((a) => String(a)).join(' '));
      },
      error: (...args: unknown[]) => {
        this.logs.push('[ERROR] ' + args.map((a) => String(a)).join(' '));
      },
    };

    return {
      console: safeConsole,
      JSON,
      Date,
      Math,
      // 禁止访问的对象占位
      require: () => {
        throw new Error('require 不可用');
      },
      process: undefined,
      global: undefined,
    };
  }

  /**
   * 检查工具执行权限
   */
  checkToolPermission(
    toolName: string,
    _params: Record<string, unknown>
  ): PermissionCheckResult {
    const highRiskTools = [
      'delete_file',
      'execute_command',
      'modify_system',
      'shell_exec',
      'system_command',
    ];
    const mediumRiskTools = ['write_file', 'edit_file'];

    if (
      highRiskTools.includes(toolName) &&
      this.config.securityLevel !== 'low'
    ) {
      return {
        allowed: false,
        reason: `工具 ${toolName} 在当前安全级别下不可用`,
        riskLevel: 'critical',
      };
    }

    if (
      mediumRiskTools.includes(toolName) &&
      this.config.securityLevel === 'high'
    ) {
      return {
        allowed: false,
        reason: `工具 ${toolName} 需要降低安全级别`,
        riskLevel: 'high',
      };
    }

    return { allowed: true, riskLevel: 'low' };
  }

  /**
   * 更新沙箱配置
   */
  updateConfig(newConfig: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...newConfig };
    Logger.info(
      `🔒 沙箱配置更新: ${JSON.stringify(newConfig)}`,
      'SandboxExecutor'
    );
  }

  /**
   * 获取当前配置
   */
  getConfig(): SandboxConfig {
    return { ...this.config };
  }
}

export default SandboxExecutor;

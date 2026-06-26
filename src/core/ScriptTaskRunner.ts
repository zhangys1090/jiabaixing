/**
 * ScriptTaskRunner — 纯脚本定时任务执行器
 *
 * 执行 shell/python 脚本，捕获输出。
 * 遵循"空输出静默"原则：stdout 为空则静默执行，有输出才投递。
 * 非零退出码投递错误告警。
 */

import { exec } from 'child_process';
import { Logger } from '../utils/Logger';
import { IntegrationManager } from '../integration/IntegrationManager';
import path from 'path';
import fs from 'fs';

/** 脚本执行结果 */
export interface ScriptTaskResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** 脚本执行配置 */
export interface ScriptRunnerConfig {
  /** 脚本搜索路径 */
  scriptsDir: string;
  /** 命令超时（毫秒） */
  timeoutMs: number;
  /** 工作目录 */
  cwd?: string;
}

const DEFAULT_CONFIG: ScriptRunnerConfig = {
  scriptsDir: path.resolve(process.cwd(), 'data', 'scripts'),
  timeoutMs: 30000,
};

export class ScriptTaskRunner {
  private config: ScriptRunnerConfig;

  constructor(config?: Partial<ScriptRunnerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 确保脚本目录存在
    if (!fs.existsSync(this.config.scriptsDir)) {
      fs.mkdirSync(this.config.scriptsDir, { recursive: true });
    }
  }

  /**
   * 执行脚本文件
   *
   * 安全规则：
   *   - 脚本必须位于 scriptsDir 内
   *   - 拒绝路径穿越（../）
   *   - 按扩展名选择解释器：.sh/.bash → /bin/bash，其他 → python
   */
  async runScript(scriptName: string): Promise<ScriptTaskResult> {
    const scriptPath = this.resolveScriptPath(scriptName);
    if (!scriptPath) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: `脚本路径非法或不存在: ${scriptName}`,
        timedOut: false,
        durationMs: 0,
      };
    }

    const isWin = process.platform === 'win32';
    const ext = path.extname(scriptPath).toLowerCase();
    const isShell = ext === '.sh' || ext === '.bash';

    let command: string;
    if (isShell) {
      // Windows 用 Git Bash 或 WSL；Unix 用 /bin/bash
      command = isWin
        ? `bash "${scriptPath}"` // Git Bash 在 PATH 中
        : `/bin/bash "${scriptPath}"`;
    } else if (ext === '.ps1') {
      command = isWin
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
        : `pwsh "${scriptPath}"`;
    } else {
      // Python 或其他
      command = `python "${scriptPath}"`;
    }

    Logger.debug(
      `📜 执行脚本: ${scriptName} (${isShell ? 'bash' : 'python'})`,
      'ScriptTaskRunner'
    );

    const start = Date.now();
    try {
      const { stdout, stderr, exitCode, timedOut } = await this.exec(
        command,
        this.config.timeoutMs
      );

      const durationMs = Date.now() - start;

      if (timedOut) {
        Logger.warn(
          `⏰ 脚本超时 (${this.config.timeoutMs}ms): ${scriptName}`,
          'ScriptTaskRunner'
        );
      }

      Logger.debug(
        `📜 脚本完成: ${scriptName} (exit=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B, ${durationMs}ms)`,
        'ScriptTaskRunner'
      );

      return {
        success: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      Logger.error(
        `❌ 脚本执行异常: ${scriptName}`,
        err as Error,
        'ScriptTaskRunner'
      );
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: (err as Error).message,
        timedOut: false,
        durationMs,
      };
    }
  }

  // ==================== 投递逻辑 ====================

  /**
   * 根据脚本结果决定是否需要投递消息。
   *
   * 规则（与 Hermes 一致）：
   *   - 退出码 0, stdout 非空 → 投递 stdout
   *   - 退出码 0, stdout 为空 → 静默（不投递）
   *   - 非零退出码 → 投递错误告警
   *   - 超时 → 投递错误告警
   */
  shouldDeliver(result: ScriptTaskResult): {
    deliver: boolean;
    message: string;
  } {
    // [SILENT] 协议：即使有输出也可显式静默
    const stdout = result.stdout;
    if (stdout.includes('[SILENT]')) {
      return { deliver: false, message: '' };
    }

    if (result.timedOut) {
      return {
        deliver: true,
        message: `⚠️ 脚本超时 (超过 ${this.config.timeoutMs / 1000}s)\n${result.stderr ? `stderr: ${result.stderr.substring(0, 200)}` : ''}`,
      };
    }

    if (result.exitCode !== 0 && result.exitCode !== null) {
      return {
        deliver: true,
        message: `❌ 脚本异常退出 (exit code: ${result.exitCode})${result.stderr ? `\n${result.stderr.substring(0, 500)}` : ''}${stdout ? `\nstdout: ${stdout.substring(0, 200)}` : ''}`,
      };
    }

    if (stdout.length > 0) {
      return { deliver: true, message: stdout };
    }

    // 退出码 0 且 stdout 为空 → 静默
    return { deliver: false, message: '' };
  }

  /**
   * 将脚本输出投递到目标平台
   */
  async deliverTo(
    platform: string,
    message: string,
    to?: string
  ): Promise<void> {
    try {
      const im = IntegrationManager.getInstance();
      await im.sendMessage({
        platform: platform as any,
        message,
        to: to || '',
      });
      Logger.info(
        `📤 脚本结果已投递到 ${platform}${to ? '/' + to : ''}`,
        'ScriptTaskRunner'
      );
    } catch (err) {
      Logger.error(
        `❌ 投递到 ${platform} 失败`,
        err as Error,
        'ScriptTaskRunner'
      );
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 解析并验证脚本路径。
   * 返回绝对路径，如果非法则返回 null。
   */
  private resolveScriptPath(scriptName: string): string | null {
    // 拒绝路径穿越
    if (scriptName.includes('..') || scriptName.startsWith('/')) {
      return null;
    }

    // 1. 直接是 scriptsDir 内的文件名
    const directPath = path.resolve(this.config.scriptsDir, scriptName);
    if (fs.existsSync(directPath)) {
      return this.validateInsideScriptsDir(directPath);
    }

    // 2. 遍历 scriptsDir 子目录
    try {
      const entries = fs.readdirSync(this.config.scriptsDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nestedPath = path.resolve(
            this.config.scriptsDir,
            entry.name,
            scriptName
          );
          if (fs.existsSync(nestedPath)) {
            return this.validateInsideScriptsDir(nestedPath);
          }
        }
      }
    } catch {
      /* 忽略 */
    }

    return null;
  }

  /** 验证路径在 scriptsDir 内 */
  private validateInsideScriptsDir(targetPath: string): string | null {
    const resolved = path.resolve(targetPath);
    if (
      !resolved.startsWith(path.resolve(this.config.scriptsDir) + path.sep) &&
      resolved !== path.resolve(this.config.scriptsDir)
    ) {
      Logger.warn(`🚫 脚本路径安全校验失败: ${targetPath}`, 'ScriptTaskRunner');
      return null;
    }
    return resolved;
  }

  /** 执行命令并捕获输出 */
  private exec(
    command: string,
    timeoutMs: number
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    return new Promise((resolve) => {
      exec(
        command,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // err.killed = true 表示超时被杀死
            const timedOut =
              err.killed === true ||
              (err as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            resolve({
              stdout: stdout || '',
              stderr: stderr || err.message,
              exitCode:
                (err as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                  ? null
                  : ((err as any).code ?? -1),
              timedOut,
            });
          } else {
            resolve({
              stdout: stdout || '',
              stderr: stderr || '',
              exitCode: 0,
              timedOut: false,
            });
          }
        }
      );
    });
  }
}

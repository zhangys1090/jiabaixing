import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Logger } from '../../../utils/Logger';

export interface FileSyncConfig {
  /** 远程主机 */
  host: string;
  /** 远程用户 */
  user: string;
  /** SSH 端口 */
  port?: number;
  /** SSH 私钥路径 */
  keyPath?: string;
  /** 本地基础路径 */
  localBasePath?: string;
  /** 远程基础路径 */
  remoteBasePath?: string;
  /** 排除模式 */
  excludePatterns?: string[];
  /** 同步方向 */
  direction: 'push' | 'pull' | 'bidirectional';
}

export interface FileSyncResult {
  success: boolean;
  filesSynced: number;
  bytesTransferred: number;
  durationMs: number;
  errors: string[];
}

export class FileSyncService {
  private config: FileSyncConfig;
  private syncHistory: Array<{
    timestamp: number;
    direction: string;
    result: FileSyncResult;
  }> = [];

  constructor(config: FileSyncConfig) {
    this.config = {
      port: 22,
      localBasePath: process.cwd(),
      remoteBasePath: '/workspace',
      excludePatterns: [
        'node_modules',
        '.git',
        '__pycache__',
        '*.pyc',
        '.env',
        'dist',
        'build',
        '.next',
      ],
      ...config,
    };
  }

  public async push(
    localPath?: string,
    remotePath?: string
  ): Promise<FileSyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let filesSynced = 0;
    let bytesTransferred = 0;

    const src = localPath || this.config.localBasePath!;
    const dst = this.buildRemotePath(remotePath || this.config.remoteBasePath!);

    try {
      const rsyncCmd = this.buildRsyncCommand(src, dst, 'push');
      const result = await this.execAsync(rsyncCmd, 120000);

      if (result.exitCode !== 0) {
        errors.push(`rsync push 失败: ${result.stderr}`);
      } else {
        const stats = this.parseRsyncStats(result.stdout);
        filesSynced = stats.files;
        bytesTransferred = stats.bytes;
      }
    } catch (err) {
      errors.push(`push 异常: ${(err as Error).message}`);
    }

    const syncResult: FileSyncResult = {
      success: errors.length === 0,
      filesSynced,
      bytesTransferred,
      durationMs: Date.now() - startTime,
      errors,
    };

    this.recordHistory('push', syncResult);
    return syncResult;
  }

  public async pull(
    remotePath?: string,
    localPath?: string
  ): Promise<FileSyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let filesSynced = 0;
    let bytesTransferred = 0;

    const src = this.buildRemotePath(remotePath || this.config.remoteBasePath!);
    const dst = localPath || this.config.localBasePath!;

    try {
      const rsyncCmd = this.buildRsyncCommand(src, dst, 'pull');
      const result = await this.execAsync(rsyncCmd, 120000);

      if (result.exitCode !== 0) {
        errors.push(`rsync pull 失败: ${result.stderr}`);
      } else {
        const stats = this.parseRsyncStats(result.stdout);
        filesSynced = stats.files;
        bytesTransferred = stats.bytes;
      }
    } catch (err) {
      errors.push(`pull 异常: ${(err as Error).message}`);
    }

    const syncResult: FileSyncResult = {
      success: errors.length === 0,
      filesSynced,
      bytesTransferred,
      durationMs: Date.now() - startTime,
      errors,
    };

    this.recordHistory('pull', syncResult);
    return syncResult;
  }

  public async syncBidirectional(): Promise<{
    pushResult: FileSyncResult;
    pullResult: FileSyncResult;
  }> {
    const pushResult = await this.push();
    const pullResult = await this.pull();
    return { pushResult, pullResult };
  }

  public async pushFile(
    localFilePath: string,
    remoteFilePath: string
  ): Promise<FileSyncResult> {
    const startTime = Date.now();

    if (!fs.existsSync(localFilePath)) {
      return {
        success: false,
        filesSynced: 0,
        bytesTransferred: 0,
        durationMs: 0,
        errors: [`本地文件不存在: ${localFilePath}`],
      };
    }

    const remoteTarget = this.buildRemotePath(remoteFilePath);
    const rsyncCmd = this.buildRsyncCommand(
      localFilePath,
      remoteTarget,
      'push'
    );

    try {
      const result = await this.execAsync(rsyncCmd, 60000);
      const stat = fs.statSync(localFilePath);

      return {
        success: result.exitCode === 0,
        filesSynced: result.exitCode === 0 ? 1 : 0,
        bytesTransferred: stat.size,
        durationMs: Date.now() - startTime,
        errors: result.exitCode !== 0 ? [result.stderr] : [],
      };
    } catch (err) {
      return {
        success: false,
        filesSynced: 0,
        bytesTransferred: 0,
        durationMs: Date.now() - startTime,
        errors: [(err as Error).message],
      };
    }
  }

  public async pullFile(
    remoteFilePath: string,
    localFilePath: string
  ): Promise<FileSyncResult> {
    const startTime = Date.now();
    const remoteSource = this.buildRemotePath(remoteFilePath);

    const rsyncCmd = this.buildRsyncCommand(
      remoteSource,
      localFilePath,
      'pull'
    );

    try {
      const result = await this.execAsync(rsyncCmd, 60000);

      const exists = fs.existsSync(localFilePath);
      const bytes = exists ? fs.statSync(localFilePath).size : 0;

      return {
        success: result.exitCode === 0,
        filesSynced: result.exitCode === 0 ? 1 : 0,
        bytesTransferred: bytes,
        durationMs: Date.now() - startTime,
        errors: result.exitCode !== 0 ? [result.stderr] : [],
      };
    } catch (err) {
      return {
        success: false,
        filesSynced: 0,
        bytesTransferred: 0,
        durationMs: Date.now() - startTime,
        errors: [(err as Error).message],
      };
    }
  }

  public getSyncHistory(limit: number = 20): typeof this.syncHistory {
    return this.syncHistory.slice(-limit);
  }

  private buildRemotePath(remotePath: string): string {
    const port = this.config.port || 22;
    const hostPart = `${this.config.user}@${this.config.host}`;

    if (port !== 22) {
      return `${hostPart}:${remotePath}`;
    }
    return `${hostPart}:${remotePath}`;
  }

  private buildRsyncCommand(
    src: string,
    dst: string,
    direction: 'push' | 'pull'
  ): string {
    const parts: string[] = ['rsync', '-avz', '--stats'];

    if (this.config.port && this.config.port !== 22) {
      parts.push('-e', `"ssh -p ${this.config.port}"`);
    }

    if (this.config.keyPath) {
      const keyPart =
        this.config.port && this.config.port !== 22
          ? `-i ${this.config.keyPath} -p ${this.config.port}`
          : `-i ${this.config.keyPath}`;
      parts.push('-e', `"ssh ${keyPart}"`);
    }

    for (const pattern of this.config.excludePatterns || []) {
      parts.push('--exclude', pattern);
    }

    if (direction === 'pull') {
      const localDir = path.dirname(dst);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
    }

    parts.push(src.endsWith('/') ? src : src + '/');
    parts.push(dst.endsWith('/') ? dst : dst + '/');

    return parts.join(' ');
  }

  private parseRsyncStats(output: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;

    const fileMatch = output.match(
      /Number of (?:regular )?files transferred:\s*(\d+)/
    );
    if (fileMatch) {
      files = parseInt(fileMatch[1], 10);
    }

    const bytesMatch = output.match(/Total transferred file size:\s*([\d,]+)/);
    if (bytesMatch) {
      bytes = parseInt(bytesMatch[1].replace(/,/g, ''), 10);
    }

    return { files, bytes };
  }

  private recordHistory(direction: string, result: FileSyncResult): void {
    this.syncHistory.push({
      timestamp: Date.now(),
      direction,
      result,
    });

    if (this.syncHistory.length > 100) {
      this.syncHistory = this.syncHistory.slice(-50);
    }

    if (result.success) {
      Logger.info(
        `📁 文件同步 ${direction}: ${result.filesSynced} 文件, ${result.bytesTransferred} 字节, ${result.durationMs}ms`,
        'FileSync'
      );
    } else {
      Logger.warn(
        `📁 文件同步 ${direction} 失败: ${result.errors.join('; ')}`,
        'FileSync'
      );
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
          maxBuffer: 4 * 1024 * 1024,
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

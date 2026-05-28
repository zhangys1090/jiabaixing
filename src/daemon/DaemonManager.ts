/**
 * Harness Layer 0: Daemon Manager — 后台常驻服务管理
 *
 * 无外部依赖的进程守护：
 *   daemon start   — 以后台进程启动后端服务
 *   daemon stop    — 停止后台服务
 *   daemon status  — 查看运行状态
 *   daemon restart — 重启后台服务
 *   daemon logs    — 查看最近日志
 *
 * 通过 PID 文件 (daemon.json) 追踪进程生命周期。
 * 支持 Windows / Linux / macOS。
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execSync } from 'child_process';

// ============ 类型 ============

interface DaemonState {
  pid: number;
  port: number;
  startTime: string;
  logFile: string;
  devMode: boolean;
}

interface DaemonStatus {
  running: boolean;
  state: DaemonState | null;
  uptime: number | null; // seconds
  memoryUsage: string | null;
}

// ============ 常量 ============

const PROJECT_ROOT = path.resolve(process.cwd());
const DAEMON_DIR = path.join(PROJECT_ROOT, '.jiabaixing');
const DAEMON_FILE = path.join(DAEMON_DIR, 'daemon.json');
const DEFAULT_LOG_FILE = path.join(DAEMON_DIR, 'daemon.log');
const DEFAULT_PORT = parseInt(
  process.env.API_PORT || process.env.PORT || '3111',
  10
);

// ============ DaemonManager ============

export class DaemonManager {
  private port: number;

  constructor(port?: number) {
    this.port = port || DEFAULT_PORT;
  }

  // ============ 公共 API ============

  async start(): Promise<{ success: boolean; message: string; pid?: number }> {
    const status = await this.status();
    if (status.running) {
      return {
        success: false,
        message: `后端服务已在运行中 (PID: ${status.state!.pid}, 已运行 ${this.formatUptime(status.uptime!)})`,
      };
    }

    const devMode = !this.isProductionBuild();
    const entryPoint = this.resolveEntryPoint(devMode);

    if (!fs.existsSync(entryPoint)) {
      return {
        success: false,
        message: `入口文件不存在: ${entryPoint}。${devMode ? '请确保 src/main.ts 存在。' : '请先执行 npm run build 构建项目。'}`,
      };
    }

    try {
      const pid = await this.spawnProcess(entryPoint, devMode);
      const state: DaemonState = {
        pid,
        port: this.port,
        startTime: new Date().toISOString(),
        logFile: DEFAULT_LOG_FILE,
        devMode,
      };

      this.ensureDaemonDir();
      fs.writeFileSync(DAEMON_FILE, JSON.stringify(state, null, 2), 'utf-8');

      // 等待 2 秒确认进程没有立即崩溃
      await this.sleep(2000);
      const confirmed = this.isProcessAlive(pid);

      if (!confirmed) {
        // 进程可能立即崩溃了，尝试读取日志
        const logTail = this.readLogTail(10);
        return {
          success: false,
          message: `进程启动后立即退出 (PID: ${pid})。\n最近日志:\n${logTail}`,
        };
      }

      return {
        success: true,
        message: `后端服务已启动 (PID: ${pid}, 端口: ${this.port}, 模式: ${devMode ? '开发' : '生产'})`,
        pid,
      };
    } catch (err) {
      return {
        success: false,
        message: `启动失败: ${(err as Error).message}`,
      };
    }
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    const state = this.readState();
    if (!state) {
      return {
        success: false,
        message: '未找到运行中的守护进程（daemon.json 不存在）',
      };
    }

    const alive = this.isProcessAlive(state.pid);
    if (!alive) {
      // PID 文件存在但进程已死 — 清理
      this.cleanup();
      return {
        success: true,
        message: `守护进程记录已清理 (PID ${state.pid} 已不存在)`,
      };
    }

    try {
      // 先尝试 SIGTERM（优雅退出）
      this.killProcess(state.pid, 'SIGTERM');

      // 等待最多 5 秒
      let waited = 0;
      while (this.isProcessAlive(state.pid) && waited < 5000) {
        await this.sleep(500);
        waited += 500;
      }

      // 如果还没死，用 SIGKILL
      if (this.isProcessAlive(state.pid)) {
        this.killProcess(state.pid, 'SIGKILL');
        await this.sleep(500);
      }

      const finalCheck = this.isProcessAlive(state.pid);
      this.cleanup();

      if (finalCheck) {
        return { success: false, message: `无法终止进程 PID: ${state.pid}` };
      }

      return {
        success: true,
        message: `后端服务已停止 (PID: ${state.pid}, 运行时长: ${this.formatUptime(this.calculateUptime(state))})`,
      };
    } catch (err) {
      return { success: false, message: `停止失败: ${(err as Error).message}` };
    }
  }

  async status(): Promise<DaemonStatus> {
    const state = this.readState();
    if (!state) {
      return { running: false, state: null, uptime: null, memoryUsage: null };
    }

    const alive = this.isProcessAlive(state.pid);
    if (!alive) {
      return { running: false, state: null, uptime: null, memoryUsage: null };
    }

    const uptime = this.calculateUptime(state);
    const memoryUsage = this.getMemoryUsage(state.pid);

    return { running: true, state, uptime, memoryUsage };
  }

  async restart(): Promise<{ success: boolean; message: string }> {
    const stopResult = await this.stop();
    // stop 成功或进程本来就不在运行都可以继续
    if (!stopResult.success && stopResult.message.includes('无法终止进程')) {
      return stopResult;
    }

    await this.sleep(1000);
    return this.start();
  }

  async logs(lines: number = 30): Promise<string> {
    const logFile = DEFAULT_LOG_FILE;
    if (!fs.existsSync(logFile)) {
      const state = this.readState();
      const file = state?.logFile;
      if (!file || !fs.existsSync(file)) {
        return '(暂无日志文件)';
      }
      return this.readLogTail(lines, file);
    }
    return this.readLogTail(lines, logFile);
  }

  logFilePath(): string {
    const state = this.readState();
    return state?.logFile || DEFAULT_LOG_FILE;
  }

  // ============ 内部方法 ============

  private readState(): DaemonState | null {
    try {
      if (!fs.existsSync(DAEMON_FILE)) return null;
      const raw = fs.readFileSync(DAEMON_FILE, 'utf-8');
      return JSON.parse(raw) as DaemonState;
    } catch {
      return null;
    }
  }

  private ensureDaemonDir(): void {
    if (!fs.existsSync(DAEMON_DIR)) {
      fs.mkdirSync(DAEMON_DIR, { recursive: true });
    }
  }

  private cleanup(): void {
    try {
      if (fs.existsSync(DAEMON_FILE)) {
        fs.unlinkSync(DAEMON_FILE);
      }
    } catch {
      // 忽略清理错误
    }
  }

  private isProductionBuild(): boolean {
    const distMain = path.join(PROJECT_ROOT, 'dist', 'src', 'main.js');
    return fs.existsSync(distMain);
  }

  private resolveEntryPoint(devMode: boolean): string {
    if (devMode) {
      return path.join(PROJECT_ROOT, 'src', 'main.ts');
    }
    return path.join(PROJECT_ROOT, 'dist', 'src', 'main.js');
  }

  private spawnProcess(entryPoint: string, devMode: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      this.ensureDaemonDir();

      const logFd = fs.openSync(DEFAULT_LOG_FILE, 'a');

      let child;
      if (devMode) {
        // ts-node 开发模式
        const tsNodePath = path.join(
          PROJECT_ROOT,
          'node_modules',
          '.bin',
          'ts-node'
        );
        child = spawn('node', [tsNodePath, '--transpileOnly', entryPoint], {
          cwd: PROJECT_ROOT,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: {
            ...process.env,
            API_PORT: String(this.port),
            CONSOLE_LOG_LEVEL: 'warn',
          },
          shell: true,
        });
      } else {
        // 编译后的 JS 生产模式
        child = spawn('node', [entryPoint], {
          cwd: PROJECT_ROOT,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: {
            ...process.env,
            API_PORT: String(this.port),
            NODE_ENV: 'production',
          },
          shell: true,
        });
      }

      fs.closeSync(logFd);

      child.on('error', (err) => {
        reject(new Error(`无法启动进程: ${err.message}`));
      });

      child.on('spawn', () => {
        if (child.pid) {
          child.unref();
          resolve(child.pid);
        } else {
          reject(new Error('进程 PID 为空'));
        }
      });

      // 超时保护
      setTimeout(() => {
        if (!child.pid) {
          reject(new Error('进程启动超时'));
        }
      }, 10000);
    });
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // 发送信号 0 不会杀死进程，仅检查是否存在
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killProcess(pid: number, signal: NodeJS.Signals): void {
    try {
      if (os.platform() === 'win32' && signal === 'SIGKILL') {
        // Windows 不支持 SIGKILL，用 taskkill
        execSync(`taskkill /PID ${pid} /F /T 2>nul`, { stdio: 'ignore' });
      } else if (os.platform() === 'win32' && signal === 'SIGTERM') {
        // Windows 用不带 /F 的 taskkill
        execSync(`taskkill /PID ${pid} /T 2>nul`, { stdio: 'ignore' });
      } else {
        process.kill(pid, signal);
      }
    } catch {
      // 进程可能已经退出
    }
  }

  private calculateUptime(state: DaemonState): number {
    const start = new Date(state.startTime).getTime();
    const now = Date.now();
    return Math.max(0, Math.floor((now - start) / 1000));
  }

  private getMemoryUsage(pid: number): string | null {
    try {
      if (os.platform() === 'win32') {
        const output = execSync(
          `tasklist /FI "PID eq ${pid}" /FO CSV /NH 2>nul`,
          { encoding: 'utf-8', timeout: 3000 }
        );
        const match = output.match(/"([^"]+)","([^"]+)","([^"]+)"/);
        if (match) {
          const memKB = parseInt(match[3].replace(/[^0-9]/g, ''), 10);
          return memKB >= 1024
            ? `${(memKB / 1024).toFixed(1)} MB`
            : `${memKB} KB`;
        }
      } else {
        const output = execSync(`ps -o rss= -p ${pid} 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        const memKB = parseInt(output, 10);
        if (memKB > 0) {
          return memKB >= 1024
            ? `${(memKB / 1024).toFixed(1)} MB`
            : `${memKB} KB`;
        }
      }
    } catch {
      // 无法获取内存信息
    }
    return null;
  }

  private readLogTail(lines: number, logFile?: string): string {
    const file = logFile || DEFAULT_LOG_FILE;
    try {
      if (!fs.existsSync(file)) return '(日志文件不存在)';
      const content = fs.readFileSync(file, 'utf-8');
      const allLines = content.split('\n').filter((l) => l.trim());
      const tail = allLines.slice(-lines);
      return tail.length > 0 ? tail.join('\n') : '(日志为空)';
    } catch {
      return '(无法读取日志)';
    }
  }

  formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default DaemonManager;

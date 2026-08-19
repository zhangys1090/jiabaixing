/**
 * BackendLauncher — Python 后端自动启动器（Hermes Bootstrap 方案）
 *
 * 启动策略（优先快速启动，失败再降级）：
 * 1. 检测 Python（嵌入式 → 系统已知路径 → PATH）
 * 2. 检测后端代码目录（python-backend/ → 项目 python/）
 * 3. 直接启动 uvicorn，健康检查轮询
 * 4. 如果启动失败，再触发 Bootstrap 安装流程（异步）
 *
 * 注意：start() 是异步的但不阻塞窗口创建，UI 应显示"后端启动中"
 */

const { spawn, execFile, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { app } = require('electron');

/** 默认配置 */
const DEFAULTS = {
  backendHost: '127.0.0.1',
  backendPort: 8765,
  healthEndpoint: '/health',
  startupTimeoutMs: 30000,
  healthCheckIntervalMs: 1000,
  maxHealthRetries: 30,
  bootstrapTimeoutMs: 300000,
};

class BackendLauncher {
  /**
   * @param {object} options
   * @param {number} [options.port] - 后端端口
   * @param {object} options.logger - 日志工具
   */
  constructor(options = {}) {
    this.port = options.port || DEFAULTS.backendPort;
    this.logger = options.logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.process = null;
    this._exiting = false;
    this._status = 'idle'; // idle | starting | running | failed | installing
    this._error = null;
    this._appDir = this._resolveAppDir();
    this._stampPath = path.join(this._appDir, 'electron', 'backend', 'install-stamp.json');
    this._logDir = path.join(app.getPath('userData'), 'logs');
    this._logPath = path.join(this._logDir, 'backend.log');
    this._preferredPort = this.port;
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      status: this._status,
      error: this._error,
      port: this.port,
      url: this.getUrl(),
    };
  }

  /**
   * 启动后端（不阻塞，状态通过 getStatus 查询）
   * @returns {Promise<boolean>} 是否成功启动
   */
  async start() {
    if (this._status === 'running') return true;
    if (this._status === 'starting') return false;

    this._status = 'starting';
    this._error = null;
    this._ensureLogDir();
    this._writeLog('=== BackendLauncher start ===');

    // Step 0: 处理端口占用（优先清理旧进程，否则换端口）
    const portInfo = await this._resolvePort();
    if (!portInfo) {
      this._status = 'failed';
      this._error = 'No available port for backend';
      this.logger.error('[BackendLauncher] No available port');
      this._writeLog('No available port');
      return false;
    }
    this.port = portInfo.port;
    if (portInfo.resolvedBy === 'fallback') {
      this.logger.warn('[BackendLauncher] Preferred port occupied, using fallback port:', this.port);
      this._writeLog(`Preferred port ${this._preferredPort} occupied, using fallback port ${this.port}`);
    } else {
      this._writeLog(`Port ${this.port} ready`);
    }

    // Step 1: 检测 Python
    const pythonPath = this._detectPython();
    this._writeLog(`Python path: ${pythonPath}`);

    if (!pythonPath) {
      this._status = 'failed';
      this._error = 'Python not found';
      this.logger.warn('[BackendLauncher] Python not found, starting bootstrap...');
      // 异步触发 Bootstrap，不阻塞
      this._startBootstrap();
      return false;
    }

    // Step 2: 检测后端目录
    const backendDir = this._resolveBackendDir();
    this._writeLog(`Backend dir: ${backendDir}`);

    if (!backendDir || !fs.existsSync(path.join(backendDir, 'agent'))) {
      this._status = 'failed';
      this._error = 'Backend code not found';
      this.logger.warn('[BackendLauncher] Backend dir not found:', backendDir);
      return false;
    }

    // Step 3: 启动后端
    try {
      this._spawn(pythonPath, backendDir);

      // Step 4: 健康检查
      const healthy = await this._waitForHealth();
      if (healthy) {
        this._status = 'running';
        this.logger.info('[BackendLauncher] Backend ready on port', this.port);
        this._writeLog('Backend ready');
        return true;
      }

      this._status = 'failed';
      this._error = 'Health check timeout';
      this.logger.warn('[BackendLauncher] Backend did not become healthy in time');
      this._writeLog('Health check timeout');
      return false;
    } catch (err) {
      this._status = 'failed';
      this._error = err.message;
      this.logger.error('[BackendLauncher] Failed to start:', err.message);
      this._writeLog(`Start error: ${err.message}`);
      return false;
    }
  }

  /**
   * 停止后端进程
   */
  stop() {
    if (this.process && !this.process.killed) {
      this._exiting = true;
      this.logger.info('[BackendLauncher] Stopping backend...');
      this._writeLog('Stopping backend...');
      try {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill();
          }
        }, 5000);
      } catch {
        // 进程可能已退出
      }
      this.process = null;
    }
    this._status = 'idle';
  }

  /**
   * 获取后端 URL
   */
  getUrl() {
    return `http://${DEFAULTS.backendHost}:${this.port}`;
  }

  // ================================================================
  // Bootstrap 安装流程（异步）
  // ================================================================

  async _startBootstrap() {
    if (this._status === 'installing') return;
    this._status = 'installing';
    this.logger.info('[BackendLauncher] Starting bootstrap installation...');
    this._writeLog('Starting bootstrap...');

    try {
      const scriptPath = path.join(this._appDir, 'electron', 'backend', 'install.ps1');
      if (!fs.existsSync(scriptPath)) {
        throw new Error('install.ps1 not found');
      }

      const { execFile } = require('child_process');
      execFile(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-AppDir', this._appDir],
        { timeout: DEFAULTS.bootstrapTimeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            this.logger.error('[BackendLauncher] Bootstrap failed:', error.message);
            this._writeLog(`Bootstrap failed: ${error.message}`);
            this._status = 'failed';
            this._error = `Bootstrap failed: ${error.message}`;
            return;
          }

          this.logger.info('[BackendLauncher] Bootstrap completed, restarting backend...');
          this._writeLog('Bootstrap completed');
          this._writeStamp({ installed: true });
          // 安装完成后重新启动
          this.start();
        }
      );
    } catch (err) {
      this._status = 'failed';
      this._error = `Bootstrap error: ${err.message}`;
      this.logger.error('[BackendLauncher] Bootstrap error:', err.message);
    }
  }

  _readStamp() {
    try {
      if (fs.existsSync(this._stampPath)) {
        return JSON.parse(fs.readFileSync(this._stampPath, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return null;
  }

  _writeStamp(updates) {
    try {
      const stamp = this._readStamp() || {};
      Object.assign(stamp, updates, { lastChecked: new Date().toISOString() });
      const dir = path.dirname(this._stampPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._stampPath, JSON.stringify(stamp, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('[BackendLauncher] Failed to update stamp:', err.message);
    }
  }

  // ================================================================
  // Python 检测
  // ================================================================

  _detectPython() {
    // 1. 嵌入的 Python 环境（Bootstrap 安装后）
    const embedded = this._resolveEmbeddedPython();
    if (embedded && this._isExecutablePython(embedded)) {
      this.logger.info('[BackendLauncher] Using embedded Python:', embedded);
      return embedded;
    }

    // 2. 系统已知路径（按实际可执行验证，避免 fs.existsSync 通过但 spawn ENOENT）
    const knownPaths = [
      'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
    ];
    for (const p of knownPaths) {
      if (this._isExecutablePython(p)) {
        this.logger.info('[BackendLauncher] Using system Python:', p);
        return p;
      }
    }

    // 3. 系统 PATH 中的 python / python3 / py
    const pathCommands = ['python', 'python3', 'py'];
    for (const cmd of pathCommands) {
      const resolved = this._resolvePathCommand(cmd);
      if (resolved && this._isExecutablePython(resolved)) {
        this.logger.info('[BackendLauncher] Using PATH Python:', resolved);
        return resolved;
      }
    }

    this.logger.warn('[BackendLauncher] No usable Python found');
    return null;
  }

  /**
   * 验证 Python 可执行文件是否真的能运行（避免 ENOENT 虚假存在）
   */
  _isExecutablePython(pythonPath) {
    if (!pythonPath || !fs.existsSync(pythonPath)) return false;
    try {
      const { execFileSync } = require('child_process');
      execFileSync(pythonPath, ['-V'], { timeout: 3000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析 PATH 中命令的绝对路径（Windows where）
   */
  _resolvePathCommand(cmd) {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`where ${cmd}`, { encoding: 'utf-8', windowsHide: true });
      const firstLine = result.split('\n')[0]?.trim();
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch {
      // ignore
    }
    return null;
  }

  _resolveEmbeddedPython() {
    const candidates = [
      path.join(this._appDir, 'python', 'python.exe'),
      path.join(process.resourcesPath || '', 'app', 'python', 'python.exe'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _resolveBackendDir() {
    // 优先检查 asar unpack 目录：Python 无法在 asar 虚拟文件系统中执行，
    // 因此 unpacked 路径必须排在 app.asar 内路径之前。
    const unpackedDir = path.resolve(this._appDir, '..', 'app.asar.unpacked', 'python-backend');
    if (fs.existsSync(path.join(unpackedDir, 'agent'))) return unpackedDir;

    // 打包模式（未 asar）: resources/app/python-backend/
    const pkgDir = path.join(this._appDir, 'python-backend');
    if (fs.existsSync(path.join(pkgDir, 'agent'))) return pkgDir;

    // 打包模式（asar 同级）: resources/python-backend/
    const resourcesDir = path.resolve(this._appDir, '..', 'python-backend');
    if (fs.existsSync(path.join(resourcesDir, 'agent'))) return resourcesDir;

    // 开发模式: 项目根目录下的 python/
    const devDir = path.resolve(this._appDir, '..', '..', '..', 'python');
    if (fs.existsSync(path.join(devDir, 'agent'))) return devDir;

    // 开发模式备选: 向上多级
    const devDir2 = path.resolve(__dirname, '..', '..', '..', '..', '..', 'python');
    if (fs.existsSync(path.join(devDir2, 'agent'))) return devDir2;

    return null;
  }

  _resolveAppDir() {
    // 打包模式: __dirname = resources/app/electron/backend
    const pkgDir = path.resolve(__dirname, '..', '..');
    if (fs.existsSync(path.join(pkgDir, 'electron', 'main.js'))) return pkgDir;

    // 开发模式: __dirname = src/frontend/electron/backend
    const devDir = path.resolve(__dirname, '..');
    if (fs.existsSync(path.join(devDir, 'main.js'))) return devDir;

    return path.resolve(__dirname, '..', '..');
  }

  // ================================================================
  // 环境变量加载
  // ================================================================

  /**
   * 从多个候选位置加载 .env 文件。
   * 打包后 .env 可放在 resources/app/ 或 python-backend/ 目录下，
   * 开发时则使用项目根目录的 .env。
   * @param {string} backendDir - 后端代码目录
   * @returns {Record<string, string>} 解析出的环境变量
   */
  _loadEnvFile(backendDir) {
    const candidates = [
      path.join(backendDir, '.env'),
      path.join(backendDir, '..', '.env'),
      // asar 打包后 .env 位于 app.asar 内部，fs 可直接读取
      path.join(this._appDir, '.env'),
      // 与 app.asar 同级的 resources/.env（未 asar 或手动放置）
      path.join(path.dirname(this._appDir), '.env'),
      path.join(this._appDir, '..', '..', '..', '.env'),
    ];

    for (const envPath of candidates) {
      if (fs.existsSync(envPath)) {
        this.logger.info('[BackendLauncher] Loading env from:', envPath);
        this._writeLog(`Loading env from: ${envPath}`);
        try {
          const content = fs.readFileSync(envPath, 'utf-8');
          const vars = {};
          content.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const idx = trimmed.indexOf('=');
            if (idx === -1) return;
            const key = trimmed.slice(0, idx).trim();
            let value = trimmed.slice(idx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            if (key) vars[key] = value;
          });
          return vars;
        } catch (err) {
          this.logger.warn('[BackendLauncher] Failed to load env:', err.message);
          this._writeLog(`Failed to load env: ${err.message}`);
        }
      }
    }

    this.logger.warn('[BackendLauncher] No .env file found');
    this._writeLog('No .env file found');
    return {};
  }

  // ================================================================
  // 端口管理
  // ================================================================

  /**
   * 确认目标端口可用。若被占用，优先杀掉占用进程；
   * 否则从 fallback 范围找一个可用端口。
   * @returns {Promise<{port: number, resolvedBy: 'direct'|'fallback'|'killed'}|null>}
   */
  async _resolvePort() {
    const host = DEFAULTS.backendHost;
    const preferred = this._preferredPort;

    // 1) 首选端口是否可直接 bind
    let free = await this._isPortFree(host, preferred);
    if (free) {
      return { port: preferred, resolvedBy: 'direct' };
    }

    // 2) 端口被占：尝试杀掉占用进程（仅本机 uvicorn/python 后端）
    this.logger.warn(`[BackendLauncher] Port ${preferred} occupied, attempting to free it...`);
    this._writeLog(`Port ${preferred} occupied, attempting to free it...`);
    const killed = await this._killPortOwner(preferred);
    if (killed) {
      await this._sleep(500);
      free = await this._isPortFree(host, preferred);
      if (free) {
        return { port: preferred, resolvedBy: 'killed' };
      }
    }

    // 3) 换端口：在 8766-8799 范围找一个可用端口
    for (let p = preferred + 1; p <= 8799; p++) {
      if (await this._isPortFree(host, p)) {
        return { port: p, resolvedBy: 'fallback' };
      }
    }

    return null;
  }

  _isPortFree(host, port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, host);
    });
  }

  /**
   * 通过 netstat 找到占用指定端口的 PID，并尝试终止它。
   * 仅终止属于 python/pythonw/uvicorn 的进程，避免误杀系统服务。
   */
  async _killPortOwner(port) {
    return new Promise((resolve) => {
      try {
        execFile('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf-8', windowsHide: true }, (err, stdout) => {
          if (err || !stdout) {
            resolve(false);
            return;
          }
          const lines = stdout.split(/\r?\n/);
          let targetPid = null;
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5) continue;
            const local = parts[1];
            const state = parts[3];
            const pid = parts[4];
            if (state === 'LISTENING' && local && local.endsWith(`:${port}`)) {
              targetPid = pid;
              break;
            }
          }
          if (!targetPid) {
            resolve(false);
            return;
          }

          // 安全检查：只杀 python 相关进程
          let processName = '';
          try {
            processName = execSync(`tasklist /fi "pid eq ${targetPid}" /fo csv /nh`, { encoding: 'utf-8', windowsHide: true });
          } catch {
            resolve(false);
            return;
          }
          const lower = processName.toLowerCase();
          if (!lower.includes('python') && !lower.includes('uvicorn')) {
            this.logger.warn(`[BackendLauncher] Port ${port} occupied by non-Python process (${processName.trim()}), not killing`);
            this._writeLog(`Port ${port} occupied by non-Python process, not killing`);
            resolve(false);
            return;
          }

          try {
            execFile('taskkill', ['/F', '/PID', targetPid], { windowsHide: true }, (killErr) => {
              if (killErr) {
                this.logger.warn(`[BackendLauncher] Failed to kill PID ${targetPid}:`, killErr.message);
                resolve(false);
              } else {
                this.logger.info(`[BackendLauncher] Killed old backend PID ${targetPid} on port ${port}`);
                this._writeLog(`Killed old backend PID ${targetPid} on port ${port}`);
                resolve(true);
              }
            });
          } catch {
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
  }

  // ================================================================
  // 进程管理
  // ================================================================

  _spawn(pythonPath, backendDir) {
    // 加载 .env 文件中的环境变量，使后端能读取 LLM_API_KEY 等配置
    const envFromFile = this._loadEnvFile(backendDir);

    const env = {
      ...process.env,
      ...envFromFile,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      AGENT_PORT: String(this.port),
    };

    const args = [
      '-m', 'uvicorn',
      'agent.main:app',
      '--host', DEFAULTS.backendHost,
      '--port', String(this.port),
      '--no-access-log',
    ];

    this.logger.info('[BackendLauncher] Spawning:', pythonPath, args.join(' '));
    this._writeLog(`Spawning: ${pythonPath} ${args.join(' ')}`);
    this._writeLog(`CWD: ${backendDir}`);

    this.process = spawn(pythonPath, args, {
      cwd: backendDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._spawnedWithFallback = false;

    this.process.stdout?.on('data', (data) => {
      try {
        const line = data.toString().trim();
        if (line) {
          this.logger.info('[Python]', line);
          this._writeLog(`[stdout] ${line}`);
        }
      } catch { /* ignore */ }
    });

    this.process.stderr?.on('data', (data) => {
      try {
        const line = data.toString().trim();
        if (line) {
          // uvicorn 启动信息也走 stderr，低级别记录
          this.logger.warn('[Python]', line);
          this._writeLog(`[stderr] ${line}`);
        }
      } catch { /* ignore */ }
    });

    this.process.on('error', (err) => {
      this.logger.error('[BackendLauncher] Process error:', err.message);
      this._writeLog(`Process error: ${err.message}`);

      // 针对 ENOENT 做一次 PATH python 回退重试
      if (err.code === 'ENOENT' && !this._spawnedWithFallback) {
        this._spawnedWithFallback = true;
        const fallback = this._resolvePathCommand('python') || this._resolvePathCommand('python3') || this._resolvePathCommand('py');
        if (fallback) {
          this.logger.warn('[BackendLauncher] Retrying with PATH Python:', fallback);
          this._writeLog(`Retrying with PATH Python: ${fallback}`);
          try {
            this.process.removeAllListeners();
            this._spawn(fallback, backendDir);
          } catch (retryErr) {
            this.logger.error('[BackendLauncher] Fallback spawn failed:', retryErr.message);
          }
        }
      }
    });

    this.process.on('exit', (code, signal) => {
      if (!this._exiting) {
        this.logger.warn('[BackendLauncher] Process exited with code:', code, 'signal:', signal);
        this._writeLog(`Process exited: code=${code} signal=${signal}`);
        if (this._status === 'running' || this._status === 'starting') {
          this._status = 'failed';
          this._error = `Process exited with code ${code}`;
        }
      }
      this.process = null;
    });
  }

  async _waitForHealth() {
    const url = `http://${DEFAULTS.backendHost}:${this.port}${DEFAULTS.healthEndpoint}`;
    for (let i = 0; i < DEFAULTS.maxHealthRetries; i++) {
      if (this._exiting) return false;
      try {
        const ok = await this._httpGet(url);
        if (ok) return true;
      } catch {
        // 后端尚未就绪
      }
      await this._sleep(DEFAULTS.healthCheckIntervalMs);
    }
    return false;
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.status === 'ok' || data.status === 'healthy');
          } catch {
            resolve(res.statusCode === 200);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  // ================================================================
  // 日志落盘
  // ================================================================

  _ensureLogDir() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  _writeLog(message) {
    try {
      this._ensureLogDir();
      const ts = new Date().toISOString();
      fs.appendFileSync(this._logPath, `[${ts}] ${message}\n`, 'utf-8');
    } catch {
      // 日志写入失败不影响主流程
    }
  }

  getLogPath() {
    return this._logPath;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = BackendLauncher;

/**
 * Updater - 自动更新管理（可选依赖 electron-updater）
 *
 * 职责：
 * - 检查 GitHub Releases 更新
 * - 下载更新包
 * - 安装更新
 * - 进度事件广播到渲染进程
 *
 * 可选依赖：
 * - 如果 electron-updater 不可用（如手动打包场景），降级为 stub
 * - 不影响应用主流程启动
 */

let autoUpdater = null;
let updaterAvailable = false;

try {
  const updaterModule = require('electron-updater');
  autoUpdater = updaterModule.autoUpdater;
  updaterAvailable = !!autoUpdater;
} catch {
  // electron-updater 未安装，降级为 stub 模式
}

/**
 * 创建一个 stub 自动更新器，用于 electron-updater 不可用时
 * 所有方法都是空操作，确保主流程不崩溃
 */
function createStubUpdater() {
  const { EventEmitter } = require('events');
  const stub = new EventEmitter();
  stub.autoDownload = false;
  stub.autoInstallOnAppQuit = false;
  stub.allowPrerelease = false;
  stub.allowDowngrade = false;
  stub.checkForUpdates = async () => ({ updateInfo: { version: '0.0.0' } });
  stub.downloadUpdate = async () => {};
  stub.quitAndInstall = () => {};
  stub.setFeedURL = () => {};
  return stub;
}

class Updater {
  /**
   * @param {object} options
   * @param {Electron.BrowserWindow} options.mainWindow
   * @param {object} options.logger
   * @param {boolean} options.autoCheck - 是否自动检查更新
   * @param {number} options.checkInterval - 自动检查间隔 (ms)，默认 4 小时
   */
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.logger = options.logger || console;
    this.autoCheck = options.autoCheck ?? true;
    this.checkInterval = options.checkInterval ?? 4 * 60 * 60 * 1000;
    this._checkTimer = null;
    this._downloading = false;
    this._available = updaterAvailable;

    if (!this._available) {
      this.logger.warn('[Updater] electron-updater not available, running in stub mode');
      autoUpdater = createStubUpdater();
    }

    this._configure();
  }

  /**
   * 初始化：启动自动检查
   */
  init() {
    if (!this._available) return;

    if (this.autoCheck) {
      setTimeout(() => this.checkForUpdates(), 30000);
      this._checkTimer = setInterval(() => this.checkForUpdates(), this.checkInterval);
      this.logger.info(`[Updater] Auto-check enabled (interval: ${this.checkInterval / 1000}s)`);
    }
  }

  /**
   * 检查更新
   */
  async checkForUpdates() {
    if (!this._available) return false;
    try {
      this.logger.info('[Updater] Checking for updates...');
      await autoUpdater.checkForUpdates();
      return true;
    } catch (err) {
      if (!err.message?.includes('net::ERR')) {
        this.logger.warn('[Updater] Check failed:', err.message);
      }
      return false;
    }
  }

  /**
   * 下载更新
   */
  async downloadUpdate() {
    if (!this._available || this._downloading) return false;
    try {
      this._downloading = true;
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      this.logger.error('[Updater] Download failed:', err.message);
      this._broadcast(channels.UPDATE.ERROR, { message: err.message });
      return false;
    } finally {
      this._downloading = false;
    }
  }

  /**
   * 安装更新并重启
   */
  installUpdate() {
    if (!this._available) return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  /**
   * 设置是否自动检查
   */
  setAutoCheck(enabled) {
    if (!this._available) return;
    this.autoCheck = enabled;
    if (enabled && !this._checkTimer) {
      this._checkTimer = setInterval(() => this.checkForUpdates(), this.checkInterval);
    } else if (!enabled && this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  /**
   * 事件监听（供 ipcHandlers 使用）
   */
  on(event, callback) {
    if (!this._available) return;
    autoUpdater.on(event, callback);
  }

  /**
   * 退出并安装
   */
  quitAndInstall() {
    if (!this._available) return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  /**
   * 更新主窗口引用
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * 销毁
   */
  destroy() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  /**
   * 是否可用
   */
  isAvailable() {
    return this._available;
  }

  // ================================================================
  // 私有方法
  // ================================================================

  _configure() {
    if (!this._available) return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = true;

    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'jiabaixing',
      repo: 'jiabaixing-desktop',
    });

    this._setupEvents();
  }

  _setupEvents() {
    const channels = require('../ipc/channels');

    autoUpdater.on('checking-for-update', () => {
      this.logger.info('[Updater] Checking...');
      this._broadcast(channels.UPDATE.CHECK);
    });

    autoUpdater.on('update-available', (info) => {
      this.logger.info(`[Updater] Update available: v${info.version}`);
      this._broadcast(channels.UPDATE.AVAILABLE, {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      this.logger.info('[Updater] Up to date');
      this._broadcast(channels.UPDATE.NOT_AVAILABLE, {
        version: info.version,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      this._broadcast(channels.UPDATE.PROGRESS, {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.logger.info(`[Updater] Downloaded: v${info.version}`);
      this._broadcast(channels.UPDATE.DOWNLOAD, {
        version: info.version,
        downloaded: true,
      });
    });

    autoUpdater.on('error', (err) => {
      this.logger.error('[Updater] Error:', err.message);
      this._broadcast(channels.UPDATE.ERROR, { message: err.message });
    });
  }

  _broadcast(channel, data) {
    this.mainWindow?.webContents?.send(channel, data);
  }
}

module.exports = Updater;

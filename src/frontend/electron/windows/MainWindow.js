/**
 * MainWindow - 窗口管理模块
 *
 * 职责：
 * - 主窗口创建与配置（安全选项）
 * - 窗口状态记忆（位置/尺寸）
 * - 关闭行为控制（最小化到托盘 vs 退出）
 * - 多显示器支持
 * - 窗口事件广播到渲染进程
 */

const { BrowserWindow, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const channels = require('../ipc/channels');

const DEFAULT_OPTIONS = {
  width: 1280,
  height: 800,
  minWidth: 900,
  minHeight: 600,
  title: '家百星 Desktop',
  show: false, // 先隐藏，ready-to-show 再显示
  webPreferences: {
    preload: path.join(__dirname, '..', 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: true,
    // 防止渲染进程访问 Node API
    enableRemoteModule: false,
  },
};

class MainWindow {
  /**
   * @param {object} options
   * @param {string} options.stateFilePath - 窗口状态持久化路径
   * @param {boolean} options.closeToTray - 关闭时最小化到托盘
   * @param {Function} options.logger - 日志函数
   */
  constructor(options = {}) {
    this.stateFilePath = options.stateFilePath;
    this.closeToTray = options.closeToTray ?? true;
    this.logger = options.logger || console;
    this.window = null;
    this._ready = false;
  }

  /**
   * 创建窗口
   */
  create() {
    const savedState = this._loadWindowState();
    const bounds = savedState ? this._getValidBounds(savedState) : this._getCenterBounds();

    this.window = new BrowserWindow({
      ...DEFAULT_OPTIONS,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });

    // 隐藏菜单栏（沉浸式界面，类似 Hermes）
    Menu.setApplicationMenu(null);
    this.window.setMenuBarVisibility(false);
    this.window.autoHideMenuBar = true;

    this._setupEvents();
    this._loadApp();

    this.logger.info('[MainWindow] Created');
    return this.window;
  }

  /**
   * 获取窗口实例
   */
  getWindow() {
    return this.window;
  }

  /**
   * 窗口是否已准备好
   */
  isReady() {
    return this._ready;
  }

  /**
   * 显示并聚焦
   */
  show() {
    if (this.window) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
    }
  }

  /**
   * 隐藏窗口
   */
  hide() {
    this.window?.hide();
  }

  /**
   * 关闭或隐藏窗口（取决于 closeToTray 配置）
   */
  closeOrHide() {
    if (this.closeToTray && this.window) {
      this.window.hide();
    } else {
      this.window?.close();
    }
  }

  /**
   * 销毁窗口
   */
  destroy() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
    this._ready = false;
  }

  // ================================================================
  // 私有方法
  // ================================================================

  _loadApp() {
    const devServerUrl = process.env.ELECTRON_START_URL || process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      this.window.loadURL(devServerUrl);
    } else {
      this.window.loadFile(path.join(__dirname, '..', '..', 'build', 'index.html'));
    }
  }

  _setupEvents() {
    if (!this.window) return;

    // ready-to-show：显示窗口
    this.window.once('ready-to-show', () => {
      this._ready = true;
      this.window.show();

      // 恢复最大化状态
      const state = this._loadWindowState();
      if (state?.isMaximized) {
        this.window.maximize();
      }
      if (state?.isFullScreen) {
        this.window.setFullScreen(true);
      }
    });

    // 窗口状态变化 → 保存 & 广播
    const broadcastState = () => {
      if (!this.window || this.window.isDestroyed()) return;

      const state = {
        isMaximized: this.window.isMaximized(),
        isMinimized: this.window.isMinimized(),
        isFullScreen: this.window.isFullScreen(),
        isFocused: this.window.isFocused(),
      };

      this._saveWindowState();
      this.window.webContents.send(channels.WINDOW.MAXIMIZE_CHANGE, state);
    };

    this.window.on('maximize', broadcastState);
    this.window.on('unmaximize', broadcastState);
    this.window.on('minimize', broadcastState);
    this.window.on('restore', broadcastState);
    this.window.on('enter-full-screen', broadcastState);
    this.window.on('leave-full-screen', broadcastState);
    this.window.on('focus', broadcastState);
    this.window.on('blur', broadcastState);

    // 关闭行为控制
    this.window.on('close', (e) => {
      if (this.closeToTray && !this._forceQuit) {
        e.preventDefault();
        this.window.hide();
        this.logger.info('[MainWindow] Hidden to tray (close intercepted)');
        return false;
      }
      this._saveWindowState();
      return undefined;
    });

    // 渲染进程崩溃恢复
    this.window.webContents.on('render-process-gone', (_event, details) => {
      this.logger.error('[MainWindow] Renderer crashed:', details.reason);
      // 3秒后自动重载
      setTimeout(() => {
        if (this.window && !this.window.isDestroyed()) {
          this._loadApp();
        }
      }, 3000);
    });

    // 未授权访问远程资源拦截
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      // 只允许打开白名单域名
      const allowed = ['https://github.com', 'https://jiabaixing.com'];
      if (allowed.some((d) => url.startsWith(d))) {
        return { action: 'allow' };
      }
      return { action: 'deny' };
    });
  }

  /**
   * 强制退出（绕过 closeToTray）
   */
  forceQuit() {
    this._forceQuit = true;
    this.window?.close();
  }

  // ================================================================
  // 窗口状态持久化
  // ================================================================

  _getStatePath() {
    if (this.stateFilePath) return this.stateFilePath;
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'window-state.json');
  }

  _loadWindowState() {
    try {
      const raw = fs.readFileSync(this._getStatePath(), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _saveWindowState() {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: this.window.isMaximized(),
      isFullScreen: this.window.isFullScreen(),
    };
    try {
      const statePath = this._getStatePath();
      const stateDir = path.dirname(statePath);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('[MainWindow] Failed to save window state:', err.message);
    }
  }

  /**
   * 确保窗口在可见显示器范围内
   */
  _getValidBounds(saved) {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const { x, y, width, height } = d.bounds;
      return saved.x < x + width && saved.x + saved.width > x && saved.y < y + height && saved.y + saved.height > y;
    });
    if (!visible) return this._getCenterBounds();
    return saved;
  }

  _getCenterBounds() {
    const display = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = display.workAreaSize;
    const w = Math.min(DEFAULT_OPTIONS.width, sw * 0.85);
    const h = Math.min(DEFAULT_OPTIONS.height, sh * 0.85);
    return {
      x: Math.round((sw - w) / 2),
      y: Math.round((sh - h) / 2),
      width: Math.round(w),
      height: Math.round(h),
    };
  }
}

module.exports = MainWindow;

/**
 * NotificationManager - 通知系统管理
 *
 * 职责：
 * - 统一通知入口（渲染进程通知 + 系统通知）
 * - 通知点击处理
 * - 通知历史管理
 * - 通知偏好设置
 */

const { Notification, nativeImage } = require('electron');
const path = require('path');
const channels = require('../ipc/channels');

class NotificationManager {
  /**
   * @param {object} options
   * @param {Electron.BrowserWindow} options.mainWindow
   * @param {Function} options.logger
   */
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.logger = options.logger || console;
    this._history = [];
    this._maxHistory = 100;
    this._preferences = {
      enabled: true,
      sound: true,
      showInApp: true,
    };
  }

  /**
   * 显示通知
   * @param {object} options
   * @param {string} options.title
   * @param {string} options.body
   * @param {string} [options.icon] - 图标路径
   * @param {Function} [options.onClick]
   * @param {Function} [options.onClose]
   * @returns {Notification|null}
   */
  show(options = {}) {
    if (!this._preferences.enabled) {
      this.logger.debug('[Notification] Disabled, skipping');
      return null;
    }

    const { title = '家百星', body, icon, onClick, onClose } = options;

    // 同时通知渲染进程（应用内通知）
    if (this._preferences.showInApp && this.mainWindow) {
      this.mainWindow.webContents.send(channels.NOTIFICATION.SHOW, {
        title,
        body,
        timestamp: Date.now(),
      });
    }

    // 如果不支持系统通知或禁用了，仅应用内通知
    if (!Notification.isSupported()) {
      this.logger.debug('[Notification] System notifications not supported');
      return null;
    }

    const notifIcon = this._getIcon(icon);

    const notification = new Notification({
      title,
      body,
      icon: notifIcon,
      silent: !this._preferences.sound,
      // macOS 支持富文本
      subtitle: process.platform === 'darwin' ? '家百星' : undefined,
    });

    notification.on('click', () => {
      this.logger.info(`[Notification] Clicked: ${title}`);
      this.mainWindow?.show?.();
      this.mainWindow?.focus?.();
      onClick?.();

      // 通知渲染进程
      this.mainWindow?.webContents?.send(channels.NOTIFICATION.CLICK, { title, body });
    });

    notification.on('close', () => {
      onClose?.();
      this.mainWindow?.webContents?.send(channels.NOTIFICATION.CLOSE, { title });
    });

    notification.show();

    // 记录历史
    this._addToHistory({ title, body, timestamp: Date.now() });

    return notification;
  }

  /**
   * 快捷方法：显示信息通知
   */
  info(title, body) {
    return this.show({ title, body });
  }

  /**
   * 快捷方法：显示成功通知
   */
  success(title, body) {
    return this.show({ title, body });
  }

  /**
   * 快捷方法：显示警告通知
   */
  warning(title, body) {
    return this.show({ title, body });
  }

  /**
   * 快捷方法：显示错误通知
   */
  error(title, body) {
    return this.show({ title, body });
  }

  /**
   * 更新偏好设置
   */
  setPreferences(prefs) {
    this._preferences = { ...this._preferences, ...prefs };
  }

  /**
   * 注册通知点击回调（供 ipcHandlers 使用）
   * @param {Function} callback
   */
  onClick(callback) {
    this._clickCallback = callback;
  }

  /**
   * 获取通知历史
   */
  getHistory() {
    return [...this._history];
  }

  /**
   * 清空通知历史
   */
  clearHistory() {
    this._history = [];
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
    this._history = [];
  }

  // ================================================================
  // 私有方法
  // ================================================================

  _getIcon(iconPath) {
    if (iconPath) {
      try {
        return nativeImage.createFromPath(iconPath);
      } catch {
        // fallthrough
      }
    }
    // 默认应用图标
    try {
      const defaultIcon = path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png');
      return nativeImage.createFromPath(defaultIcon);
    } catch {
      return nativeImage.createEmpty();
    }
  }

  _addToHistory(entry) {
    this._history.unshift(entry);
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(0, this._maxHistory);
    }
  }
}

module.exports = NotificationManager;

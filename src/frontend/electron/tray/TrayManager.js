/**
 * TrayManager - 系统托盘管理
 *
 * 职责：
 * - 系统托盘创建与图标管理
 * - 托盘菜单（显示/隐藏/退出）
 * - 托盘气泡通知
 * - 双击托盘显示主窗口
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const channels = require('../ipc/channels');

class TrayManager {
  /**
   * @param {object} options
   * @param {Electron.BrowserWindow} options.mainWindow
   * @param {Function} options.logger
   */
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.logger = options.logger || console;
    this.tray = null;
    this._tooltip = options.tooltip || '家百星';
  }

  /**
   * 创建系统托盘
   * @returns {Tray}
   */
  create() {
    if (this.tray) return this.tray;

    const iconPath = this._getIconPath();
    let trayIcon;

    try {
      trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
        throw new Error('Icon image is empty');
      }
      // macOS 托盘图标需要调整大小
      if (process.platform === 'darwin') {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
      }
    } catch (err) {
      this.logger.warn('[Tray] Icon not found, using default:', err.message);
      trayIcon = this._createDefaultIcon();
    }

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip(this._tooltip);

    this._setupMenu();
    this._setupEvents();

    this.logger.info('[Tray] Created');
    return this.tray;
  }

  /**
   * 更新托盘提示文字
   */
  setTooltip(text) {
    this._tooltip = text;
    this.tray?.setToolTip(text);
  }

  /**
   * 显示托盘气泡通知
   */
  displayBalloon(options) {
    this.tray?.displayBalloon({
      title: options.title || '家百星',
      content: options.content || '',
      iconType: options.iconType || 'info',
    });
  }

  /**
   * 更新托盘图标
   */
  setIcon(iconPath) {
    if (!this.tray) return;
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (process.platform === 'darwin') {
        this.tray.setImage(icon.resize({ width: 16, height: 16 }));
      } else {
        this.tray.setImage(icon);
      }
    } catch (err) {
      this.logger.warn('[Tray] Failed to set icon:', err.message);
    }
  }

  /**
   * 显示主窗口
   */
  showWindow() {
    this.mainWindow?.show?.();
  }

  /**
   * 隐藏主窗口
   */
  hideWindow() {
    this.mainWindow?.hide?.();
  }

  /**
   * 更新主窗口引用
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * 托盘是否可见
   */
  isVisible() {
    return this.tray !== null;
  }

  /**
   * 销毁托盘
   */
  destroy() {
    this.tray?.destroy();
    this.tray = null;
    this.logger.info('[Tray] Destroyed');
  }

  // ================================================================
  // 私有方法
  // ================================================================

  _getIconPath() {
    const iconName =
      process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.png' : 'icon.png';
    return path.join(__dirname, '..', '..', 'assets', iconName);
  }

  /**
   * 无图标文件时创建一个临时占位图标
   */
  _createDefaultIcon() {
    // 16x16 透明图标占位
    return nativeImage.createEmpty();
  }

  _setupMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示家百星',
        click: () => this.showWindow(),
      },
      { type: 'separator' },
      {
        label: '检查更新',
        click: () => {
          this.mainWindow?.webContents?.send(channels.UPDATE.CHECK);
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.mainWindow?.forceQuit?.();
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  _setupEvents() {
    if (!this.tray) return;

    // macOS：点击托盘图标显示/隐藏窗口
    this.tray.on('click', () => {
      if (process.platform === 'darwin') {
        if (this.mainWindow?.isVisible?.()) {
          this.hideWindow();
        } else {
          this.showWindow();
        }
      }
    });

    // Windows：双击托盘图标显示窗口
    this.tray.on('double-click', () => {
      this.showWindow();
    });
  }
}

module.exports = TrayManager;

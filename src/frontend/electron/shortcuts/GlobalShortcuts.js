/**
 * GlobalShortcuts - 全局快捷键管理
 *
 * 职责：
 * - 注册/注销全局快捷键
 * - 快捷键触发事件广播
 * - 快捷键冲突检测
 */

const { globalShortcut, BrowserWindow } = require('electron');
const channels = require('../ipc/channels');

/**
 * 默认快捷键配置
 * 可由用户配置文件覆盖
 */
const DEFAULT_SHORTCUTS = {
  'CommandOrControl+Shift+Space': {
    action: 'show-hide-window',
    description: '显示/隐藏主窗口',
  },
  'CommandOrControl+Shift+Q': {
    action: 'quick-chat',
    description: '快速对话',
  },
};

class GlobalShortcuts {
  /**
   * @param {object} options
   * @param {Electron.BrowserWindow} options.mainWindow
   * @param {object} options.shortcutConfig - 自定义快捷键配置
   * @param {Function} options.logger
   */
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.logger = options.logger || console;
    this._registered = new Map(); // accelerator -> handler
    this._config = { ...DEFAULT_SHORTCUTS, ...options.shortcutConfig };
  }

  /**
   * 注册所有默认快捷键
   */
  registerAll() {
    for (const [accelerator, def] of Object.entries(this._config)) {
      this.register(accelerator, def.action);
    }
    this.logger.info(`[Shortcuts] Registered ${this._registered.size} shortcuts`);
  }

  /**
   * 注册单个快捷键
   * @param {string} accelerator - Electron accelerator 格式
   * @param {string} action - 动作标识
   * @returns {boolean} 是否成功
   */
  register(accelerator, action) {
    try {
      if (this._registered.has(accelerator)) {
        this.logger.warn(`[Shortcuts] Already registered: ${accelerator}`);
        return false;
      }

      const handler = () => {
        this.logger.info(`[Shortcuts] Triggered: ${accelerator} → ${action}`);
        this._handleAction(action);
      };

      const success = globalShortcut.register(accelerator, handler);
      if (success) {
        this._registered.set(accelerator, handler);
      } else {
        this.logger.warn(`[Shortcuts] Failed to register: ${accelerator}`);
      }
      return success;
    } catch (err) {
      this.logger.error(`[Shortcuts] Register error: ${err.message}`);
      return false;
    }
  }

  /**
   * 注销单个快捷键
   */
  unregister(accelerator) {
    try {
      globalShortcut.unregister(accelerator);
      this._registered.delete(accelerator);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 注销所有快捷键
   */
  unregisterAll() {
    globalShortcut.unregisterAll();
    this._registered.clear();
    this.logger.info('[Shortcuts] All unregistered');
  }

  /**
   * 按回调ID注销快捷键（供 ipcHandlers 使用）
   */
  unregisterByCallbackId(callbackId) {
    for (const [accelerator, def] of Object.entries(this._config)) {
      if (def.action === callbackId) {
        this.unregister(accelerator);
        return true;
      }
    }
    return false;
  }

  /**
   * 更新主窗口引用
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * 获取所有已注册快捷键
   */
  getRegistered() {
    const result = {};
    for (const [accelerator] of this._registered) {
      const def = this._config[accelerator];
      result[accelerator] = {
        action: def?.action || 'unknown',
        description: def?.description || '',
      };
    }
    return result;
  }

  /**
   * 获取当前平台的快捷键修饰键
   */
  getModifierKey() {
    return process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  }

  /**
   * 销毁：注销所有快捷键
   */
  destroy() {
    this.unregisterAll();
  }

  // ================================================================
  // 私有方法
  // ================================================================

  _handleAction(action) {
    switch (action) {
      case 'show-hide-window':
        this._toggleWindow();
        break;
      case 'quick-chat':
        this._quickChat();
        break;
      default:
        this.logger.warn(`[Shortcuts] Unknown action: ${action}`);
    }

    // 广播到渲染进程
    this.mainWindow?.webContents?.send(channels.SHORTCUTS.TRIGGERED, { action });
  }

  _toggleWindow() {
    if (!this.mainWindow) return;
    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  _quickChat() {
    if (!this.mainWindow) return;
    this.mainWindow.show();
    this.mainWindow.focus();
    // 通知渲染进程打开快速对话面板
    this.mainWindow.webContents.send('shortcut:quick-chat');
  }
}

module.exports = GlobalShortcuts;

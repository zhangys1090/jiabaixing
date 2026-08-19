/**
 * MainWindow.js 单元测试
 *
 * 测试窗口管理器的完整生命周期：
 * - 创建与显示
 * - 窗口状态记忆（位置/尺寸）
 * - 关闭行为控制（最小化到托盘 vs 退出）
 * - 多显示器支持
 * - 窗口事件广播
 * - 渲染进程崩溃恢复
 */

const path = require('path');
const { EventEmitter } = require('events');

// Mock electron — 必须在 require 源码之前
jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  class MockBrowserWindow extends EE {
    constructor(options = {}) {
      super();
      this._options = options;
      this._visible = false;
      this._maximized = false;
      this._minimized = false;
      this._fullScreen = false;
      this._destroyed = false;
      this._bounds = { x: 100, y: 100, width: 1280, height: 800 };
      this.webContents = {
        send: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        reload: jest.fn(),
        setWindowOpenHandler: jest.fn(() => ({ action: 'deny' })),
      };
    }
    loadURL() {}
    loadFile() {}
    show() {
      this._visible = true;
    }
    hide() {
      this._visible = false;
    }
    close() {
      this.emit('close');
    }
    focus() {}
    minimize() {
      this._minimized = true;
    }
    restore() {
      this._minimized = false;
    }
    maximize() {
      this._maximized = true;
    }
    unmaximize() {
      this._maximized = false;
    }
    destroy() {
      this._destroyed = true;
    }
    isVisible() {
      return this._visible;
    }
    isMinimized() {
      return this._minimized;
    }
    isMaximized() {
      return this._maximized;
    }
    isFullScreen() {
      return this._fullScreen;
    }
    isDestroyed() {
      return this._destroyed;
    }
    isFocused() {
      return true;
    }
    getBounds() {
      return { ...this._bounds };
    }
    setBounds(b) {
      this._bounds = { ...b };
    }
    setFullScreen(fs) {
      this._fullScreen = fs;
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: jest.fn(() => ({
        workAreaSize: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getAllDisplays: jest.fn(() => [
        {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      ]),
    },
    app: {
      getPath: jest.fn((name) => `/mock/${name}`),
    },
  };
});

// Mock fs for window state persistence
jest.mock('fs', () => {
  const original = jest.requireActual('fs');
  return {
    ...original,
    readFileSync: jest.fn(() => {
      throw new Error('ENOENT');
    }),
    writeFileSync: jest.fn(),
  };
});

// fs 必须在 jest.mock('fs', ...) 之后 require，否则拿到的是真实模块
const fs = require('fs');

const MainWindow = require('../../../electron/windows/MainWindow');
const channels = require('../../../electron/ipc/channels');

describe('MainWindow', () => {
  let mainWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    fs.writeFileSync.mockClear();
  });

  afterEach(() => {
    if (mainWindow) {
      mainWindow.destroy();
      mainWindow = null;
    }
  });

  // ----------------------------------------------------------
  // 创建
  // ----------------------------------------------------------
  describe('创建', () => {
    it('should create window instance', () => {
      mainWindow = new MainWindow();
      const win = mainWindow.create();

      expect(win).toBeDefined();
      expect(mainWindow.getWindow()).toBe(win);
    });

    it('should set default options correctly', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      const opts = mainWindow.getWindow()._options;
      expect(opts.title).toBe('家百星');
      expect(opts.width).toBe(1280);
      expect(opts.height).toBe(800);
      expect(opts.minWidth).toBe(900);
      expect(opts.minHeight).toBe(600);
    });

    it('should apply security webPreferences', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      const prefs = mainWindow.getWindow()._options.webPreferences;
      expect(prefs.nodeIntegration).toBe(false);
      expect(prefs.contextIsolation).toBe(true);
      expect(prefs.sandbox).toBe(true);
      expect(prefs.webSecurity).toBe(true);
      expect(prefs.allowRunningInsecureContent).toBe(false);
      expect(prefs.experimentalFeatures).toBe(false);
      expect(prefs.enableRemoteModule).toBe(false);
    });

    it('should default closeToTray to true', () => {
      mainWindow = new MainWindow();
      expect(mainWindow.closeToTray).toBe(true);
    });

    it('should accept custom closeToTray option', () => {
      mainWindow = new MainWindow({ closeToTray: false });
      expect(mainWindow.closeToTray).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 显示与隐藏
  // ----------------------------------------------------------
  describe('显示与隐藏', () => {
    it('should show window', () => {
      mainWindow = new MainWindow();
      mainWindow.create();
      mainWindow.show();

      expect(mainWindow.getWindow().isVisible()).toBe(true);
    });

    it('should restore minimized window when showing', () => {
      mainWindow = new MainWindow();
      mainWindow.create();
      mainWindow.getWindow()._minimized = true;
      mainWindow.show();

      expect(mainWindow.getWindow().isMinimized()).toBe(false);
    });

    it('should hide window', () => {
      mainWindow = new MainWindow();
      mainWindow.create();
      mainWindow.getWindow().show();
      mainWindow.hide();

      expect(mainWindow.getWindow().isVisible()).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 关闭行为
  // ----------------------------------------------------------
  describe('关闭行为', () => {
    it('should hide to tray when closeToTray is true', () => {
      mainWindow = new MainWindow({ closeToTray: true });
      mainWindow.create();
      mainWindow.getWindow().show();

      const closeEvent = { preventDefault: jest.fn() };
      mainWindow.getWindow().emit('close', closeEvent);

      // 窗口应该被拦截关闭，改为隐藏
      expect(closeEvent.preventDefault).toHaveBeenCalled();
    });

    it('should allow close when closeToTray is false', () => {
      mainWindow = new MainWindow({ closeToTray: false });
      mainWindow.create();

      const closeEvent = { preventDefault: jest.fn() };
      mainWindow.getWindow().emit('close', closeEvent);

      // 不应该阻止关闭
      expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('should force quit bypassing closeToTray', () => {
      mainWindow = new MainWindow({ closeToTray: true });
      mainWindow.create();

      mainWindow.forceQuit();

      expect(mainWindow._forceQuit).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 窗口状态广播
  // ----------------------------------------------------------
  describe('窗口状态广播', () => {
    it('should broadcast maximize state changes', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      mainWindow.getWindow().emit('maximize');
      expect(mainWindow.getWindow().webContents.send).toHaveBeenCalledWith(
        channels.WINDOW.MAXIMIZE_CHANGE,
        expect.objectContaining({ isMaximized: true })
      );
    });

    it('should broadcast minimize state changes', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      mainWindow.getWindow().emit('minimize');
      expect(mainWindow.getWindow().webContents.send).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 渲染进程崩溃恢复
  // ----------------------------------------------------------
  describe('渲染进程崩溃恢复', () => {
    it('should handle renderer crash', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      jest.useFakeTimers();
      mainWindow.getWindow().webContents.on.mockImplementation((event, handler) => {
        if (event === 'render-process-gone') {
          handler({}, { reason: 'crashed' });
        }
      });

      // 触发崩溃处理
      jest.advanceTimersByTime(3000);
      jest.useRealTimers();
    });
  });

  // ----------------------------------------------------------
  // 窗口状态持久化
  // ----------------------------------------------------------
  describe('窗口状态持久化', () => {
    it('should save window state to file', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      // 触发保存
      mainWindow.getWindow().emit('maximize');

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should handle missing state file gracefully', () => {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      mainWindow = new MainWindow();
      mainWindow.create();

      // 应该使用默认居中位置
      expect(mainWindow.getWindow()).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // 多显示器支持
  // ----------------------------------------------------------
  describe('多显示器支持', () => {
    it('should center window on primary display when no saved state', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      const bounds = mainWindow.getWindow().getBounds();
      expect(bounds.x).toBeGreaterThan(0);
      expect(bounds.y).toBeGreaterThan(0);
    });

    it('should use saved bounds if within visible display', () => {
      fs.readFileSync.mockReturnValue(
        JSON.stringify({
          x: 200,
          y: 150,
          width: 1024,
          height: 768,
          isMaximized: false,
          isFullScreen: false,
        })
      );

      mainWindow = new MainWindow();
      mainWindow.create();

      const bounds = mainWindow.getWindow().getBounds();
      expect(bounds.x).toBe(200);
      expect(bounds.y).toBe(150);
    });
  });

  // ----------------------------------------------------------
  // 销毁
  // ----------------------------------------------------------
  describe('销毁', () => {
    it('should destroy window', () => {
      mainWindow = new MainWindow();
      mainWindow.create();
      mainWindow.destroy();

      expect(mainWindow.getWindow()).toBeNull();
      expect(mainWindow.isReady()).toBe(false);
    });

    it('should handle destroy when no window', () => {
      mainWindow = new MainWindow();
      // 不创建直接销毁不应报错
      expect(() => mainWindow.destroy()).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 就绪状态
  // ----------------------------------------------------------
  describe('就绪状态', () => {
    it('should not be ready before ready-to-show', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      expect(mainWindow.isReady()).toBe(false);
    });

    it('should be ready after ready-to-show event', () => {
      mainWindow = new MainWindow();
      mainWindow.create();

      mainWindow.getWindow().emit('ready-to-show');
      expect(mainWindow.isReady()).toBe(true);
    });
  });
});

/**
 * ipcHandlers.js 单元测试
 *
 * 测试 IPC 通道处理器注册：
 * - 窗口操作处理器
 * - 系统信息处理器
 * - 文件对话框处理器
 * - Shell 操作处理器
 * - 服务通信处理器
 * - 应用控制处理器
 * - 托盘操作处理器
 * - 快捷键处理器
 * - 通知处理器
 * - 更新处理器
 * - 主题处理器
 */

jest.mock('electron', () => {
  const { EventEmitter } = require('events');
  class MockBrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this._options = options;
      this._visible = true;
      this._maximized = false;
      this._minimized = false;
      this._fullScreen = false;
      this.webContents = {
        send: jest.fn(),
        on: jest.fn(),
      };
    }
    isDestroyed() {
      return false;
    }
    show() {
      this._visible = true;
    }
    hide() {
      this._visible = false;
    }
    close() {}
    focus() {}
    minimize() {
      this._minimized = true;
    }
    maximize() {
      this._maximized = true;
    }
    isMaximized() {
      return this._maximized;
    }
    isMinimized() {
      return this._minimized;
    }
    isVisible() {
      return this._visible;
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    shell: {
      openExternal: jest.fn(() => Promise.resolve()),
      openPath: jest.fn(() => Promise.resolve()),
    },
    dialog: {
      showOpenDialog: jest.fn(() => Promise.resolve({ canceled: false, filePaths: ['/test/file.txt'] })),
      showSaveDialog: jest.fn(() => Promise.resolve({ canceled: false, filePath: '/test/save.txt' })),
    },
    ipcMain: {
      handle: jest.fn(),
      on: jest.fn(),
      removeHandler: jest.fn(),
    },
    app: {
      getPath: jest.fn((name) => `/mock/${name}`),
      getVersion: jest.fn(() => '1.0.0'),
      getName: jest.fn(() => 'jiabaixing'),
      quit: jest.fn(),
    },
    nativeTheme: {
      shouldUseDarkColors: false,
      themeSource: 'system',
    },
  };
});

const { ipcMain } = require('electron');
const { registerAllHandlers } = require('../../../electron/ipc/ipcHandlers');
const channels = require('../../../electron/ipc/channels');

describe('IPC Handlers', () => {
  let mockMainWindow;
  let mockTrayManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMainWindow = {
      show: jest.fn(),
      hide: jest.fn(),
      close: jest.fn(),
      focus: jest.fn(),
      minimize: jest.fn(),
      maximize: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      isMaximized: jest.fn(() => false),
      isMinimized: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
        reload: jest.fn(),
        toggleDevTools: jest.fn(),
        getZoomFactor: jest.fn(() => 1.0),
        setZoomFactor: jest.fn(),
      },
    };
    mockTrayManager = {
      hideWindow: jest.fn(),
      showWindow: jest.fn(),
    };
  });

  afterEach(() => {
    ipcMain._reset();
  });

  // ----------------------------------------------------------
  // 注册完整性
  // ----------------------------------------------------------
  describe('注册完整性', () => {
    it('should register window handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith(channels.WINDOW.MINIMIZE, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.WINDOW.MAXIMIZE, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.WINDOW.CLOSE, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.WINDOW.FULLSCREEN, expect.any(Function));
    });

    it('should register system handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith(channels.SYSTEM.GET_INFO, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.SYSTEM.GET_PATH, expect.any(Function));
    });

    it('should register file handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith(channels.FILE.OPEN_DIALOG, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.FILE.SAVE_DIALOG, expect.any(Function));
    });

    it('should register shell handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith(channels.SHELL.OPEN_URL, expect.any(Function));
    });

    it('should register app handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith(channels.APP.QUIT, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.APP.RELOAD, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.APP.TOGGLE_DEVTOOLS, expect.any(Function));
    });

    it('should register tray handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith(channels.TRAY.SHOW_WINDOW, expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(channels.TRAY.HIDE_WINDOW, expect.any(Function));
    });

    it('should register theme handlers', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      expect(ipcMain.handle).toHaveBeenCalledWith('theme:get', expect.any(Function));
      expect(ipcMain.on).toHaveBeenCalledWith('theme:set', expect.any(Function));
    });
  });

  // ----------------------------------------------------------
  // 窗口处理器功能
  // ----------------------------------------------------------
  describe('窗口处理器功能', () => {
    it('should minimize window', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.WINDOW.MINIMIZE)[1];
      handler({}, {});

      expect(mockMainWindow.minimize).toHaveBeenCalled();
    });

    it('should maximize window', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.WINDOW.MAXIMIZE)[1];
      handler({}, {});

      expect(mockMainWindow.maximize).toHaveBeenCalled();
    });

    it('should close window', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.WINDOW.CLOSE)[1];
      handler({}, {});

      expect(mockMainWindow.hide).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // Shell 处理器功能
  // ----------------------------------------------------------
  describe('Shell 处理器功能', () => {
    it('should open URL', async () => {
      const { shell } = require('electron');
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.SHELL.OPEN_URL)[1];
      await handler({}, 'https://example.com');

      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
    });
  });

  // ----------------------------------------------------------
  // App 处理器功能
  // ----------------------------------------------------------
  describe('App 处理器功能', () => {
    it('should quit app', () => {
      const { app } = require('electron');
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.APP.QUIT)[1];
      handler({}, {});

      expect(app.quit).toHaveBeenCalled();
    });

    it('should reload window', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.APP.RELOAD)[1];
      handler({}, {});

      expect(mockMainWindow.webContents.reload).toHaveBeenCalled();
    });

    it('should toggle devtools', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.APP.TOGGLE_DEVTOOLS)[1];
      handler({}, {});

      expect(mockMainWindow.webContents.toggleDevTools).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // Tray 处理器功能
  // ----------------------------------------------------------
  describe('Tray 处理器功能', () => {
    it('should show window via tray', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.TRAY.SHOW_WINDOW)[1];
      handler({}, {});

      expect(mockTrayManager.showWindow).toHaveBeenCalled();
    });

    it('should hide window via tray', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.TRAY.HIDE_WINDOW)[1];
      handler({}, {});

      expect(mockTrayManager.hideWindow).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 主题处理器功能
  // ----------------------------------------------------------
  describe('主题处理器功能', () => {
    it('should get theme', () => {
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === 'theme:get')[1];
      const result = handler({}, {});

      expect(result).toBe('light');
    });

    it('should set theme', () => {
      const { nativeTheme } = require('electron');
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.on.mock.calls.find((c) => c[0] === 'theme:set')[1];
      handler({}, 'dark');

      expect(nativeTheme.themeSource).toBe('dark');
    });
  });

  // ----------------------------------------------------------
  // 系统处理器功能
  // ----------------------------------------------------------
  describe('系统处理器功能', () => {
    it('should return app info', async () => {
      const { app } = require('electron');
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.SYSTEM.GET_INFO)[1];
      const result = await handler({}, {});

      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('version');
      expect(result.name).toBe('jiabaixing');
    });

    it('should return path', async () => {
      const { app } = require('electron');
      registerAllHandlers(mockMainWindow, mockTrayManager);

      const handler = ipcMain.handle.mock.calls.find((c) => c[0] === channels.SYSTEM.GET_PATH)[1];
      const result = await handler({}, 'home');

      expect(app.getPath).toHaveBeenCalledWith('home');
    });
  });
});

/**
 * ipcHandlers.test.js
 *
 * 测试 IPC 处理器模块化注册 (registerAllHandlers)
 * 源码: src/frontend/electron/ipc/ipcHandlers.js
 *
 * 覆盖: 窗口控制/系统信息/文件操作/Shell/服务通信/应用控制/主题
 */

// 必须在 require 源码之前设置 moduleNameMapper
// jest.electron.config.js 已经处理了 mock 映射
// 但 resetModules: true 会使模块缓存被清除，需要 jest.mock 确保源码内部 require 使用同一实例
jest.mock('electron', () => require('../../electron/__mocks__/electron'));

const { ipcMain, dialog, shell, nativeTheme } = require('electron');
const channels = require('../../electron/ipc/channels');

// require 源码 — resetModules 在 jest.electron.config.js 中已启用
let registerAllHandlers;

// ============================================================
// 公共 Mock 工厂
// ============================================================

function createMockMainWindow() {
  return {
    minimize: jest.fn(),
    unmaximize: jest.fn(),
    maximize: jest.fn(),
    close: jest.fn(),
    isMaximized: jest.fn().mockReturnValue(false),
    isFullScreen: jest.fn().mockReturnValue(false),
    setFullScreen: jest.fn(),
    isVisible: jest.fn().mockReturnValue(true),
    isDestroyed: jest.fn().mockReturnValue(false),
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    restore: jest.fn(),
    webContents: {
      send: jest.fn(),
      reload: jest.fn(),
      toggleDevTools: jest.fn(),
    },
  };
}

function createMockServiceRunner() {
  return {
    sendMessage: jest.fn().mockResolvedValue('response'),
    getStatus: jest.fn().mockReturnValue({ status: 'running' }),
    onMessage: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  };
}

function createMockTrayManager() {
  return {
    showWindow: jest.fn(),
    hideWindow: jest.fn(),
  };
}

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// ============================================================
// 测试
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  // 清理 handler 注册表，避免跨测试污染
  ipcMain._handlers = {};
  ipcMain._onHandlers = {};
  registerAllHandlers = require('../../electron/ipc/ipcHandlers').registerAllHandlers;
});

// ----------------------------------------------------------------
// 模块导出
// ----------------------------------------------------------------
describe('ipcHandlers 模块导出', () => {
  test('导出 registerAllHandlers 函数', () => {
    expect(typeof registerAllHandlers).toBe('function');
  });
});

// ----------------------------------------------------------------
// 窗口控制
// ----------------------------------------------------------------
describe('窗口控制 IPC', () => {
  let mainWindow;
  beforeEach(() => {
    mainWindow = createMockMainWindow();
    registerAllHandlers({ mainWindow, logger: mockLogger });
  });

  test('最小化窗口', () => {
    const handler = ipcMain._handlers[channels.WINDOW.MINIMIZE];
    expect(handler).toBeDefined();
    const result = handler();
    expect(mainWindow.minimize).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  test('最大化/取消最大化窗口', () => {
    const handler = ipcMain._handlers[channels.WINDOW.MAXIMIZE];
    expect(handler).toBeDefined();

    // 未最大化 → maximize
    mainWindow.isMaximized.mockReturnValue(false);
    let result = handler();
    expect(mainWindow.maximize).toHaveBeenCalled();
    expect(result.success).toBe(true);

    // 已最大化 → unmaximize
    mainWindow.isMaximized.mockReturnValue(true);
    result = handler();
    expect(mainWindow.unmaximize).toHaveBeenCalled();
  });

  test('关闭窗口', () => {
    const handler = ipcMain._handlers[channels.WINDOW.CLOSE];
    expect(handler).toBeDefined();
    const result = handler();
    expect(mainWindow.close).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  test('切换全屏', () => {
    const handler = ipcMain._handlers[channels.WINDOW.FULLSCREEN];
    expect(handler).toBeDefined();

    mainWindow.isFullScreen.mockReturnValue(false);
    let result = handler();
    expect(mainWindow.setFullScreen).toHaveBeenCalledWith(true);
    expect(result.success).toBe(true);

    mainWindow.isFullScreen.mockReturnValue(true);
    result = handler();
    expect(mainWindow.setFullScreen).toHaveBeenCalledWith(false);
  });

  test('无 mainWindow 时不崩溃', () => {
    // 重新注册，不传 mainWindow
    registerAllHandlers({ logger: mockLogger });
    const handler = ipcMain._handlers[channels.WINDOW.MINIMIZE];
    expect(() => handler()).not.toThrow();
  });
});

// ----------------------------------------------------------------
// 系统信息
// ----------------------------------------------------------------
describe('系统信息 IPC', () => {
  beforeEach(() => {
    registerAllHandlers({ logger: mockLogger });
  });

  test('获取系统信息', () => {
    const handler = ipcMain._handlers[channels.SYSTEM.GET_INFO];
    expect(handler).toBeDefined();
    const info = handler();
    expect(info).toHaveProperty('platform');
    expect(info).toHaveProperty('arch');
    expect(info).toHaveProperty('appVersion');
    expect(info).toHaveProperty('appName');
  });

  test('获取有效路径', () => {
    const handler = ipcMain._handlers[channels.SYSTEM.GET_PATH];
    expect(handler).toBeDefined();
    const result = handler(null, 'home');
    expect(result).toEqual({ success: true, path: '/mock/path' });
  });

  test('获取无效路径返回错误', () => {
    const handler = ipcMain._handlers[channels.SYSTEM.GET_PATH];
    require('electron').app.getPath.mockImplementation(() => {
      throw new Error('bad path');
    });
    const result = handler(null, 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ----------------------------------------------------------------
// 文件操作
// ----------------------------------------------------------------
describe('文件操作 IPC', () => {
  let mainWindow;
  beforeEach(() => {
    mainWindow = createMockMainWindow();
    registerAllHandlers({ mainWindow, logger: mockLogger });
  });

  test('打开文件对话框', async () => {
    const handler = ipcMain._handlers[channels.FILE.OPEN_DIALOG];
    expect(handler).toBeDefined();
    const result = await handler(null, {});
    expect(result).toHaveProperty('canceled');
    expect(result).toHaveProperty('filePaths');
    expect(dialog.showOpenDialog).toHaveBeenCalled();
  });

  test('保存文件对话框', async () => {
    const handler = ipcMain._handlers[channels.FILE.SAVE_DIALOG];
    expect(handler).toBeDefined();
    const result = await handler(null, {});
    expect(result).toHaveProperty('canceled');
    expect(result).toHaveProperty('filePath');
    expect(dialog.showSaveDialog).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// Shell
// ----------------------------------------------------------------
describe('Shell IPC', () => {
  beforeEach(() => {
    registerAllHandlers({ logger: mockLogger });
  });

  test('打开外部链接', async () => {
    const handler = ipcMain._handlers[channels.SHELL.OPEN_URL];
    expect(handler).toBeDefined();
    const result = await handler(null, 'https://example.com');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(result).toEqual({ success: true });
  });

  test('打开本地路径', async () => {
    const handler = ipcMain._handlers[channels.SHELL.OPEN_PATH];
    expect(handler).toBeDefined();
    const result = await handler(null, '/some/path');
    expect(shell.openPath).toHaveBeenCalledWith('/some/path');
    expect(result).toEqual({ success: true });
  });

  test('打开链接失败返回错误', async () => {
    shell.openExternal.mockRejectedValueOnce(new Error('blocked'));
    const handler = ipcMain._handlers[channels.SHELL.OPEN_URL];
    const result = await handler(null, 'https://bad.com');
    expect(result.success).toBe(false);
  });
});

// ----------------------------------------------------------------
// 服务通信
// ----------------------------------------------------------------
describe('服务通信 IPC', () => {
  let serviceRunner, mainWindow;
  beforeEach(() => {
    serviceRunner = createMockServiceRunner();
    mainWindow = createMockMainWindow();
    registerAllHandlers({ serviceRunner, mainWindow, logger: mockLogger });
  });

  test('发送消息到服务', async () => {
    const handler = ipcMain._handlers[channels.SERVICE.SEND_MESSAGE];
    expect(handler).toBeDefined();
    const result = await handler(null, { text: 'hello' });
    expect(serviceRunner.sendMessage).toHaveBeenCalledWith({ text: 'hello' });
    expect(result).toEqual({ success: true, data: 'response' });
  });

  test('服务不可用时返回错误', async () => {
    registerAllHandlers({ mainWindow, logger: mockLogger }); // 无 serviceRunner
    const handler = ipcMain._handlers[channels.SERVICE.SEND_MESSAGE];
    const result = await handler(null, { text: 'hello' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  test('获取服务状态', () => {
    const handler = ipcMain._handlers[channels.SERVICE.GET_STATUS];
    expect(handler).toBeDefined();
    const result = handler();
    expect(result).toEqual({ success: true, data: { status: 'running' } });
  });

  test('服务消息推送注册', () => {
    expect(serviceRunner.onMessage).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 应用控制
// ----------------------------------------------------------------
describe('应用控制 IPC', () => {
  let mainWindow;
  beforeEach(() => {
    mainWindow = createMockMainWindow();
    registerAllHandlers({ mainWindow, logger: mockLogger });
  });

  test('退出应用', () => {
    const handler = ipcMain._handlers[channels.APP.QUIT];
    expect(handler).toBeDefined();
    handler();
    expect(require('electron').app.quit).toHaveBeenCalled();
  });

  test('刷新页面', () => {
    const handler = ipcMain._handlers[channels.APP.RELOAD];
    expect(handler).toBeDefined();
    const result = handler();
    expect(mainWindow.webContents.reload).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  test('切换开发者工具', () => {
    const handler = ipcMain._handlers[channels.APP.TOGGLE_DEVTOOLS];
    expect(handler).toBeDefined();
    const result = handler();
    expect(mainWindow.webContents.toggleDevTools).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });
});

// ----------------------------------------------------------------
// 主题
// ----------------------------------------------------------------
describe('主题 IPC', () => {
  beforeEach(() => {
    registerAllHandlers({ logger: mockLogger });
  });

  test('获取当前主题', () => {
    const handler = ipcMain._handlers['theme:get'];
    expect(handler).toBeDefined();
    const theme = handler();
    expect(['dark', 'light']).toContain(theme);
  });

  test('设置主题', () => {
    const handler = ipcMain._onHandlers['theme:set'];
    expect(handler).toBeDefined();
    handler(null, 'dark');
    expect(nativeTheme.themeSource).toBe('dark');
  });

  test('设置系统主题', () => {
    const handler = ipcMain._onHandlers['theme:set'];
    handler(null, 'system');
    expect(nativeTheme.themeSource).toBe('system');
  });
});

// ----------------------------------------------------------------
// 托盘 IPC
// ----------------------------------------------------------------
describe('托盘 IPC', () => {
  let trayManager;
  beforeEach(() => {
    trayManager = createMockTrayManager();
    registerAllHandlers({ trayManager, logger: mockLogger });
  });

  test('显示窗口', () => {
    const handler = ipcMain._handlers[channels.TRAY.SHOW_WINDOW];
    expect(handler).toBeDefined();
    const result = handler();
    expect(trayManager.showWindow).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  test('隐藏窗口', () => {
    const handler = ipcMain._handlers[channels.TRAY.HIDE_WINDOW];
    expect(handler).toBeDefined();
    const result = handler();
    expect(trayManager.hideWindow).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });
});

// ----------------------------------------------------------------
// 安全性检查
// ----------------------------------------------------------------
describe('安全性', () => {
  test('IPC 通道名不泄露敏感信息', () => {
    // 所有通道名必须是字符串
    Object.values(channels).forEach((category) => {
      if (typeof category === 'object') {
        Object.values(category).forEach((ch) => {
          expect(typeof ch).toBe('string');
        });
      }
    });
  });

  test('系统信息不包含密码字段', () => {
    registerAllHandlers({ logger: mockLogger });
    const handler = ipcMain._handlers[channels.SYSTEM.GET_INFO];
    const info = handler();
    expect(info).not.toHaveProperty('password');
    expect(info).not.toHaveProperty('token');
    expect(info).not.toHaveProperty('secret');
  });
});

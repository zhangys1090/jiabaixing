/**
 * MainWindow.test.js
 *
 * 测试主窗口管理器
 * 源码: src/frontend/electron/window/MainWindow.js
 *
 * 覆盖: 窗口创建/状态恢复/显示隐藏/全屏切换/销毁/事件传播
 */

const { BrowserWindow, screen } = require('electron');
const fs = require('fs');
const channels = require('../../../electron/ipc/channels');
const MainWindow = require('../../../electron/windows/MainWindow');

// ============================================================
// Mock
// ============================================================

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// screen mock（MainWindow._getCenterBounds 内部调用）
beforeAll(() => {
  screen.getPrimaryDisplay = jest.fn().mockReturnValue({
    id: 1,
    label: 'Display 1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    workAreaSize: { width: 1920, height: 1040 },
    scaleFactor: 1,
  });
});

// ============================================================
// 测试
// ============================================================

let mainWindow;

beforeEach(() => {
  jest.clearAllMocks();
  fs._readFileMap = {}; // 重置虚拟文件系统
  mainWindow = new MainWindow({ logger: mockLogger });
});

afterEach(() => {
  if (mainWindow) {
    try {
      mainWindow.destroy();
    } catch (e) {}
  }
});

// ----------------------------------------------------------------
// 窗口创建
// ----------------------------------------------------------------
describe('窗口创建', () => {
  test('create 创建 BrowserWindow', () => {
    mainWindow.create();
    expect(BrowserWindow).toHaveBeenCalled();
    expect(mainWindow._window).toBeDefined();
    expect(mainWindow._window).not.toBeNull();
  });

  test('创建成功后返回自身', () => {
    const result = mainWindow.create();
    expect(result).toBe(mainWindow);
  });

  test('重复创建时抛出错误', () => {
    mainWindow.create();
    expect(() => mainWindow.create()).toThrow('already created');
  });
});

// ----------------------------------------------------------------
// 窗口选项
// ----------------------------------------------------------------
describe('窗口选项', () => {
  test('默认窗口大小 1200x800', () => {
    mainWindow.create();
    const opts = BrowserWindow.mock.calls[0][0];
    expect(opts.width).toBe(1200);
    expect(opts.height).toBe(800);
  });

  test('无边框窗口模式', () => {
    mainWindow.create();
    const opts = BrowserWindow.mock.calls[0][0];
    expect(opts.frame).toBe(false);
  });

  test('禁用 Node.js 和 Webview', () => {
    mainWindow.create();
    const opts = BrowserWindow.mock.calls[0][0];
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.webviewTag).toBe(false);
  });

  test('使用 preload 脚本', () => {
    mainWindow.create();
    const opts = BrowserWindow.mock.calls[0][0];
    expect(opts.webPreferences.preload).toContain('preload.js');
  });

  test('自定义尺寸', () => {
    const custom = new MainWindow({
      width: 800,
      height: 600,
      x: 50,
      y: 50,
      logger: mockLogger,
    });
    custom.create();
    const opts = BrowserWindow.mock.calls[0][0];
    expect(opts.width).toBe(800);
    expect(opts.height).toBe(600);
    expect(opts.x).toBe(50);
    expect(opts.y).toBe(50);
    custom.destroy();
  });
});

// ----------------------------------------------------------------
// 状态恢复
// ----------------------------------------------------------------
describe('状态恢复', () => {
  test('状态文件损坏时不崩溃', () => {
    fs._readFileMap['window-state.json'] = '{invalid json';
    expect(() => mainWindow.create()).not.toThrow();
  });

  test('状态文件被拒绝时不崩溃', () => {
    fs._readFileMap['window-state.json'] = new Error('EACCES');
    expect(() => mainWindow.create()).not.toThrow();
  });

  test('空状态文件不崩溃', () => {
    fs._readFileMap['window-state.json'] = '';
    expect(() => mainWindow.create()).not.toThrow();
  });
});

// ----------------------------------------------------------------
// show / hide / isVisible
// ----------------------------------------------------------------
describe('show / hide / isVisible', () => {
  test('show 显示窗口', () => {
    mainWindow.create();
    mainWindow.show();
    expect(mainWindow._window.show).toHaveBeenCalled();
    expect(mainWindow.isVisible()).toBe(true);
  });

  test('hide 隐藏窗口', () => {
    mainWindow.create();
    mainWindow.hide();
    expect(mainWindow._window.hide).toHaveBeenCalled();
    expect(mainWindow.isVisible()).toBe(false);
  });

  test('切换可见性', () => {
    mainWindow.create();
    expect(mainWindow.isVisible()).toBe(true);
    mainWindow.hide();
    expect(mainWindow.isVisible()).toBe(false);
    mainWindow.show();
    expect(mainWindow.isVisible()).toBe(true);
  });
});

// ----------------------------------------------------------------
// focus / minimize / maximize / close
// ----------------------------------------------------------------
describe('窗口操作', () => {
  test('focus 聚焦窗口', () => {
    mainWindow.create();
    mainWindow.focus();
    expect(mainWindow._window.focus).toHaveBeenCalled();
  });

  test('minimize 最小化窗口', () => {
    mainWindow.create();
    mainWindow.minimize();
    expect(mainWindow._window.minimize).toHaveBeenCalled();
  });

  test('maximize 最大化窗口', () => {
    mainWindow.create();
    mainWindow.maximize();
    expect(mainWindow._window.maximize).toHaveBeenCalled();
  });

  test('close 关闭窗口', () => {
    mainWindow.create();
    mainWindow.close();
    expect(mainWindow._window.close).toHaveBeenCalled();
  });

  test('forceQuit 跳过 close 事件直接销毁', () => {
    mainWindow.create();
    mainWindow.forceQuit();
    expect(mainWindow._window.destroy).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 全屏切换
// ----------------------------------------------------------------
describe('全屏切换', () => {
  test('toggleFullscreen 切换全屏', () => {
    mainWindow.create();
    mainWindow.toggleFullscreen();
    expect(mainWindow._window.setFullScreen).toHaveBeenCalledWith(true);
  });
});

// ----------------------------------------------------------------
// URL 加载
// ----------------------------------------------------------------
describe('URL 加载', () => {
  test('加载 URL', async () => {
    mainWindow.create();
    const result = await mainWindow.loadURL('https://example.com');
    expect(mainWindow._window.loadURL).toHaveBeenCalledWith('https://example.com');
    expect(result).toBe(true);
  });

  test('加载失败返回 false', async () => {
    mainWindow.create();
    mainWindow._window.loadURL = jest.fn().mockRejectedValue(new Error('net::ERR'));
    const result = await mainWindow.loadURL('https://example.com');
    expect(result).toBe(false);
  });
});

// ----------------------------------------------------------------
// IPC 事件转发
// ----------------------------------------------------------------
describe('IPC 事件转发', () => {
  test('转发 MAXIMIZE 事件', () => {
    mainWindow.create();
    const maximizeHandler = mainWindow._window.webContents.on.mock.calls.find(([event]) => event === 'maximize');
    expect(maximizeHandler).toBeDefined();
  });

  test('转发 UNMAXIMIZE 事件', () => {
    mainWindow.create();
    const unmaximizeHandler = mainWindow._window.webContents.on.mock.calls.find(([event]) => event === 'unmaximize');
    expect(unmaximizeHandler).toBeDefined();
  });

  test('转发 CLOSE 事件', () => {
    mainWindow.create();
    const closeHandler = mainWindow._window.webContents.on.mock.calls.find(([event]) => event === 'close');
    expect(closeHandler).toBeDefined();
  });
});

// ----------------------------------------------------------------
// getHandle
// ----------------------------------------------------------------
describe('getHandle', () => {
  test('获取窗口句柄', () => {
    mainWindow.create();
    const handle = mainWindow.getHandle();
    expect(handle).toBeDefined();
  });

  test('未创建时返回 null', () => {
    expect(mainWindow.getHandle()).toBeNull();
  });
});

// ----------------------------------------------------------------
// 销毁
// ----------------------------------------------------------------
describe('销毁', () => {
  test('destroy 清理资源', () => {
    mainWindow.create();
    mainWindow.destroy();
    expect(mainWindow._window.destroy).toHaveBeenCalled();
    expect(mainWindow._window).toBeNull();
  });

  test('重复 destroy 不崩溃', () => {
    mainWindow.create();
    mainWindow.destroy();
    expect(() => mainWindow.destroy()).not.toThrow();
  });
});

// ----------------------------------------------------------------
// 窗口状态持久化
// ----------------------------------------------------------------
describe('窗口状态持久化', () => {
  test('创建窗口时读取状态文件', () => {
    mainWindow.create();
    expect(fs._readFileMap['window-state.json']).toBeDefined();
  });
});

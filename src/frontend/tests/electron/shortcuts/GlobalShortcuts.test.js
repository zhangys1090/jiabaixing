/**
 * GlobalShortcuts.test.js
 *
 * 测试全局快捷键管理器
 * 源码: src/frontend/electron/shortcuts/GlobalShortcuts.js
 *
 * 覆盖: 注册/注销/动作广播/重复注册防御/销毁
 */

const { globalShortcut } = require('electron');
const channels = require('../../../electron/ipc/channels');
const GlobalShortcuts = require('../../../electron/shortcuts/GlobalShortcuts');

// ============================================================
// Mock
// ============================================================

function createMockMainWindow() {
  return {
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    close: jest.fn(),
    isVisible: jest.fn().mockReturnValue(true),
    isDestroyed: jest.fn().mockReturnValue(false),
    webContents: { send: jest.fn() },
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

let shortcuts;

beforeEach(() => {
  jest.clearAllMocks();
  globalShortcut.register.mockReturnValue(true);
  globalShortcut.isRegistered.mockReturnValue(false);
  shortcuts = new GlobalShortcuts({
    mainWindow: createMockMainWindow(),
    logger: mockLogger,
  });
});

// ----------------------------------------------------------------
// 注册/注销
// ----------------------------------------------------------------
describe('注册/注销快捷键', () => {
  test('注册单个快捷键', () => {
    const result = shortcuts.register('CommandOrControl+Shift+Space', 'show-hide-window');
    expect(result).toBe(true);
    expect(globalShortcut.register).toHaveBeenCalledWith('CommandOrControl+Shift+Space', expect.any(Function));
  });

  test('注册成功时返回 true', () => {
    globalShortcut.register.mockReturnValue(true);
    expect(shortcuts.register('Ctrl+Alt+T', 'test-action')).toBe(true);
  });

  test('注册失败时返回 false', () => {
    globalShortcut.register.mockReturnValue(false);
    expect(shortcuts.register('Invalid+Combo', 'test')).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('重复注册同一快捷键返回 false', () => {
    shortcuts.register('Ctrl+Shift+A', 'action1');
    globalShortcut.isRegistered.mockReturnValue(true);
    // 再次注册：源码检查 _registered.has(accelerator)
    const result = shortcuts.register('Ctrl+Shift+A', 'action2');
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('registerAll 注册所有默认快捷键', () => {
    shortcuts.registerAll();
    // 默认快捷键有 2 个
    expect(globalShortcut.register).toHaveBeenCalledTimes(2);
  });

  test('unregister 单个快捷键', () => {
    shortcuts.register('Ctrl+Shift+A', 'action1');
    const result = shortcuts.unregister('Ctrl+Shift+A');
    expect(result).toBe(true);
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+A');
  });

  test('unregisterAll 注销全部', () => {
    shortcuts.register('Ctrl+A', 'a');
    shortcuts.register('Ctrl+B', 'b');
    shortcuts.unregisterAll();
    expect(globalShortcut.unregisterAll).toHaveBeenCalled();
  });

  test('销毁时自动注销全部快捷键', () => {
    shortcuts.register('Ctrl+A', 'a');
    shortcuts.destroy();
    expect(globalShortcut.unregisterAll).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 动作广播
// ----------------------------------------------------------------
describe('动作广播', () => {
  test('触发 show-hide-window 时切换窗口显示', () => {
    const mainWindow = createMockMainWindow();
    mainWindow.isVisible.mockReturnValue(true);
    const gs = new GlobalShortcuts({ mainWindow, logger: mockLogger });

    gs.register('Ctrl+Shift+Space', 'show-hide-window');
    // 模拟快捷键触发
    const triggerFn = globalShortcut.register.mock.calls[0][1];
    triggerFn();

    expect(mainWindow.hide).toHaveBeenCalled();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(channels.SHORTCUTS.TRIGGERED, {
      action: 'show-hide-window',
    });
  });

  test('触发 show-hide-window 时显示隐藏窗口', () => {
    const mainWindow = createMockMainWindow();
    mainWindow.isVisible.mockReturnValue(false);
    const gs = new GlobalShortcuts({ mainWindow, logger: mockLogger });

    gs.register('Ctrl+Shift+Space', 'show-hide-window');
    const triggerFn = globalShortcut.register.mock.calls[0][1];
    triggerFn();

    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
  });

  test('触发 quick-chat 时显示并聚焦主窗口', () => {
    const mainWindow = createMockMainWindow();
    const gs = new GlobalShortcuts({ mainWindow, logger: mockLogger });

    gs.register('Ctrl+Shift+Q', 'quick-chat');
    const triggerFn = globalShortcut.register.mock.calls[0][1];
    triggerFn();

    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      expect.stringContaining('shortcut:quick-chat'),
      expect.anything()
    );
  });

  test('未知动作时打印警告', () => {
    const gs = new GlobalShortcuts({
      mainWindow: createMockMainWindow(),
      logger: mockLogger,
    });
    gs.register('Ctrl+Z', 'unknown-action');
    const triggerFn = globalShortcut.register.mock.calls[0][1];
    triggerFn();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 获取注册信息
// ----------------------------------------------------------------
describe('获取注册信息', () => {
  test('获取已注册快捷键列表', () => {
    shortcuts.register('Ctrl+Shift+A', 'action1');
    const list = shortcuts.getRegistered();
    expect(list).toHaveProperty('Ctrl+Shift+A');
    expect(list['Ctrl+Shift+A']).toHaveProperty('action', 'action1');
  });

  test('获取修饰键（跨平台）', () => {
    const modifier = shortcuts.getModifierKey();
    expect(typeof modifier).toBe('string');
    expect(['Cmd', 'Ctrl']).toContain(modifier);
  });
});

// ----------------------------------------------------------------
// 错误处理
// ----------------------------------------------------------------
describe('错误处理', () => {
  test('注册时抛出异常安全处理', () => {
    globalShortcut.register.mockImplementation(() => {
      throw new Error('系统限制');
    });
    expect(() => shortcuts.register('Bad+Key', 'test')).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  test('注销时抛出异常安全处理', () => {
    globalShortcut.unregister.mockImplementation(() => {
      throw new Error('not registered');
    });
    expect(() => shortcuts.unregister('Bad+Key')).not.toThrow();
  });
});

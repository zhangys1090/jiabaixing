/**
 * Updater.test.js
 *
 * 测试自动更新管理器
 * 源码: src/frontend/electron/updater/Updater.js
 *
 * 覆盖: 更新检查/下载/安装/自动检查/事件广播/错误处理
 */

const { autoUpdater } = require('electron-updater');
const channels = require('../../../electron/ipc/channels');
const Updater = require('../../../electron/updater/Updater');

// ============================================================
// Mock
// ============================================================

function createMockMainWindow() {
  return {
    show: jest.fn(),
    focus: jest.fn(),
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

let updater;

beforeEach(() => {
  jest.clearAllMocks();
  // 重置 autoUpdater mock
  autoUpdater.checkForUpdates = jest.fn().mockResolvedValue({});
  autoUpdater.downloadUpdate = jest.fn().mockResolvedValue(undefined);
  autoUpdater.quitAndInstall = jest.fn();

  updater = new Updater({
    mainWindow: createMockMainWindow(),
    logger: mockLogger,
    autoCheck: false, // 默认关闭自动检查，避免 setInterval 泄漏
  });
});

afterEach(() => {
  updater.destroy();
});

// ----------------------------------------------------------------
// 更新检查
// ----------------------------------------------------------------
describe('更新检查', () => {
  test('检查更新', async () => {
    await updater.checkForUpdates();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  test('检查更新失败时不崩溃', async () => {
    autoUpdater.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(updater.checkForUpdates()).resolves.not.toThrow();
  });

  test('网络错误时不打印警告', async () => {
    autoUpdater.checkForUpdates.mockRejectedValue(new Error('net::ERR_TIMEOUT'));
    await updater.checkForUpdates();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('非网络错误时打印警告', async () => {
    autoUpdater.checkForUpdates.mockRejectedValue(new Error('Something went wrong'));
    await updater.checkForUpdates();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 更新下载
// ----------------------------------------------------------------
describe('更新下载', () => {
  test('下载更新', async () => {
    await updater.downloadUpdate();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  test('下载失败广播错误事件', async () => {
    autoUpdater.downloadUpdate.mockRejectedValue(new Error('Download failed'));
    await updater.downloadUpdate();
    expect(updater.mainWindow.webContents.send).toHaveBeenCalledWith(
      channels.UPDATE.ERROR,
      expect.objectContaining({ message: 'Download failed' })
    );
  });

  test('并发下载只执行一次', async () => {
    // 同时发起两次下载
    const p1 = updater.downloadUpdate();
    const p2 = updater.downloadUpdate();
    await Promise.all([p1, p2]);
    // autoUpdater.downloadUpdate 应只被调用一次
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------
// 安装更新
// ----------------------------------------------------------------
describe('安装更新', () => {
  test('安装更新并重启', () => {
    updater.installUpdate();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});

// ----------------------------------------------------------------
// 自动检查
// ----------------------------------------------------------------
describe('自动检查', () => {
  test('init 时设置自动检查定时器', () => {
    jest.useFakeTimers();
    const u = new Updater({
      mainWindow: createMockMainWindow(),
      logger: mockLogger,
      autoCheck: true,
    });
    u.init();

    // 快进 30 秒（首次检查延迟）
    jest.advanceTimersByTime(30000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();

    u.destroy();
    jest.useRealTimers();
  });

  test('autoCheck=false 时不设置定时器', () => {
    const u = new Updater({
      mainWindow: createMockMainWindow(),
      logger: mockLogger,
      autoCheck: false,
    });
    u.init();
    jest.useFakeTimers();
    jest.advanceTimersByTime(3600000);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

// ----------------------------------------------------------------
// 动态设置
// ----------------------------------------------------------------
describe('动态设置', () => {
  test('setAutoCheck 启用自动检查', () => {
    jest.useFakeTimers();
    updater.setAutoCheck(true);
    expect(updater.autoCheck).toBe(true);

    jest.advanceTimersByTime(4 * 60 * 60 * 1000); // 4 小时
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('setAutoCheck 禁用自动检查', () => {
    updater.setAutoCheck(false);
    expect(updater.autoCheck).toBe(false);
  });
});

// ----------------------------------------------------------------
// 引用更新与销毁
// ----------------------------------------------------------------
describe('引用更新与销毁', () => {
  test('更新主窗口引用', () => {
    const newWindow = createMockMainWindow();
    updater.setMainWindow(newWindow);
    updater._broadcast('test-channel', { data: 1 });
    expect(newWindow.webContents.send).toHaveBeenCalledWith('test-channel', { data: 1 });
  });

  test('销毁清除定时器', () => {
    jest.useFakeTimers();
    const u = new Updater({
      mainWindow: createMockMainWindow(),
      logger: mockLogger,
      autoCheck: true,
    });
    u.init();
    u.destroy();
    // 之后定时器不应触发
    jest.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('销毁无定时器时不崩溃', () => {
    const u = new Updater({
      mainWindow: createMockMainWindow(),
      logger: mockLogger,
      autoCheck: false,
    });
    expect(() => u.destroy()).not.toThrow();
  });
});

// ----------------------------------------------------------------
// 事件广播
// ----------------------------------------------------------------
describe('事件广播', () => {
  test('_broadcast 发送消息到主窗口', () => {
    updater._broadcast('test-event', { key: 'value' });
    expect(updater.mainWindow.webContents.send).toHaveBeenCalledWith('test-event', { key: 'value' });
  });

  test('无 mainWindow 时不崩溃', () => {
    updater.mainWindow = null;
    expect(() => updater._broadcast('test', {})).not.toThrow();
  });
});

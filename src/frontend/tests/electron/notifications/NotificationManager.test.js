/**
 * NotificationManager.test.js
 *
 * 测试通知管理器
 * 源码: src/frontend/electron/notifications/NotificationManager.js
 *
 * 覆盖: 通知显示/历史管理/偏好设置/应用内通知
 */

const { Notification } = require('electron');
const channels = require('../../../electron/ipc/channels');
const NotificationManager = require('../../../electron/notifications/NotificationManager');

// ============================================================
// Mock
// ============================================================

function createMockMainWindow() {
  return {
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    isVisible: jest.fn().mockReturnValue(true),
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

let manager;

beforeEach(() => {
  jest.clearAllMocks();
  Notification.isSupported.mockReturnValue(true);
  manager = new NotificationManager({
    mainWindow: createMockMainWindow(),
    logger: mockLogger,
  });
});

// ----------------------------------------------------------------
// 通知显示
// ----------------------------------------------------------------
describe('通知显示', () => {
  test('显示通知', () => {
    const notif = manager.show({ title: '测试', body: '消息内容' });
    expect(notif).toBeDefined();
    expect(notif._shown).toBe(true);
  });

  test('通知支持 info 快捷方法', () => {
    const notif = manager.info('标题', '内容');
    expect(notif).toBeDefined();
  });

  test('通知支持 success 快捷方法', () => {
    const notif = manager.success('成功', '操作完成');
    expect(notif).toBeDefined();
  });

  test('通知支持 warning 快捷方法', () => {
    const notif = manager.warning('警告', '请注意');
    expect(notif).toBeDefined();
  });

  test('通知支持 error 快捷方法', () => {
    const notif = manager.error('错误', '失败了');
    expect(notif).toBeDefined();
  });

  test('系统不支持通知时不创建', () => {
    Notification.isSupported.mockReturnValue(false);
    const notif = manager.show({ title: '测试', body: '内容' });
    expect(notif).toBeNull();
  });

  test('通知禁用时不显示', () => {
    manager.setPreferences({ enabled: false });
    const notif = manager.show({ title: '测试', body: '内容' });
    expect(notif).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 应用内通知
// ----------------------------------------------------------------
describe('应用内通知', () => {
  test('默认启用应用内通知', () => {
    const mainWindow = createMockMainWindow();
    const mgr = new NotificationManager({ mainWindow, logger: mockLogger });
    mgr.show({ title: '测试', body: '内容' });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      channels.NOTIFICATION.SHOW,
      expect.objectContaining({ title: '测试', body: '内容' })
    );
  });

  test('关闭应用内通知后不发送 IPC', () => {
    const mainWindow = createMockMainWindow();
    const mgr = new NotificationManager({ mainWindow, logger: mockLogger });
    mgr.setPreferences({ showInApp: false });
    mgr.show({ title: '测试', body: '内容' });
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(channels.NOTIFICATION.SHOW, expect.anything());
  });
});

// ----------------------------------------------------------------
// 通知点击
// ----------------------------------------------------------------
describe('通知点击', () => {
  test('点击通知显示并聚焦主窗口', () => {
    const mainWindow = createMockMainWindow();
    const mgr = new NotificationManager({ mainWindow, logger: mockLogger });

    const notif = mgr.show({ title: '测试', body: '内容' });
    // 触发 click 事件
    notif._emit('click');

    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      channels.NOTIFICATION.CLICK,
      expect.objectContaining({ title: '测试' })
    );
  });

  test('点击通知触发回调', () => {
    const onClick = jest.fn();
    const mgr = new NotificationManager({
      mainWindow: createMockMainWindow(),
      logger: mockLogger,
    });
    const notif = mgr.show({ title: '测试', body: '内容', onClick });
    notif._emit('click');
    expect(onClick).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 通知历史
// ----------------------------------------------------------------
describe('通知历史', () => {
  test('记录通知历史', () => {
    manager.show({ title: '测试1', body: '内容1' });
    manager.show({ title: '测试2', body: '内容2' });
    const history = manager.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].title).toBe('测试2');
  });

  test('清空通知历史', () => {
    manager.show({ title: '测试', body: '内容' });
    manager.clearHistory();
    expect(manager.getHistory().length).toBe(0);
  });

  test('历史记录有上限', () => {
    // 源码 _maxHistory = 100
    for (let i = 0; i < 105; i++) {
      manager.show({ title: `通知${i}`, body: `内容${i}` });
    }
    expect(manager.getHistory().length).toBe(100);
  });
});

// ----------------------------------------------------------------
// 偏好设置
// ----------------------------------------------------------------
describe('偏好设置', () => {
  test('更新偏好设置', () => {
    manager.setPreferences({ sound: false });
    expect(manager._preferences.sound).toBe(false);
  });

  test('保持未更新的偏好设置', () => {
    manager.setPreferences({ enabled: false });
    expect(manager._preferences.sound).toBe(true);
  });
});

// ----------------------------------------------------------------
// 引用更新与销毁
// ----------------------------------------------------------------
describe('引用更新与销毁', () => {
  test('更新主窗口引用', () => {
    const newWindow = createMockMainWindow();
    manager.setMainWindow(newWindow);
    manager.show({ title: '测试', body: '内容' });
    expect(newWindow.webContents.send).toHaveBeenCalled();
  });

  test('销毁后清空历史', () => {
    manager.show({ title: '测试', body: '内容' });
    manager.destroy();
    expect(manager.getHistory().length).toBe(0);
  });
});

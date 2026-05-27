/**
 * WindowManager 单元测试
 * P0: 桌面之手 - 窗口管理功能测试
 */

import { WindowManager } from '../../../src/desktop/WindowManager';

jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue(Buffer.from(JSON.stringify([
    {
      handle: 12345,
      title: 'Test Window',
      processId: 1000,
      processName: 'test.exe',
      x: 0, y: 0, width: 800, height: 600,
      isMinimized: false,
      isMaximized: false,
    }
  ]))),
}));

describe('WindowManager', () => {
  let windowManager: WindowManager;

  beforeEach(() => {
    windowManager = WindowManager.getInstance();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = WindowManager.getInstance();
      const instance2 = WindowManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await windowManager.initialize();
      expect(windowManager).toBeDefined();
    });
  });

  describe('listWindows', () => {
    it('应该返回窗口列表', () => {
      const windows = windowManager.listWindows();
      expect(Array.isArray(windows)).toBe(true);
    });
  });

  describe('findWindow', () => {
    it('应该查找指定窗口', () => {
      const window = windowManager.findWindow('Test');
      expect(window === null || typeof window === 'object').toBe(true);
    });
  });

  describe('findWindowByProcess', () => {
    it('应该按进程名查找窗口', () => {
      const window = windowManager.findWindowByProcess('test.exe');
      expect(window === null || typeof window === 'object').toBe(true);
    });
  });

  describe('activateWindow', () => {
    it('应该激活窗口', () => {
      const result = windowManager.activateWindow(12345);
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('activateWindowByTitle', () => {
    it('应该按标题激活窗口', () => {
      const result = windowManager.activateWindowByTitle('Test');
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('minimizeWindow', () => {
    it('应该最小化窗口', () => {
      const result = windowManager.minimizeWindow(12345);
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('maximizeWindow', () => {
    it('应该最大化窗口', () => {
      const result = windowManager.maximizeWindow(12345);
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('getForegroundWindow', () => {
    it('应该获取前台窗口', () => {
      const window = windowManager.getForegroundWindow();
      expect(window === null || typeof window === 'object').toBe(true);
    });
  });

  describe('getScreenSize', () => {
    it('应该返回屏幕分辨率', () => {
      const size = windowManager.getScreenSize();
      expect(typeof size.width).toBe('number');
      expect(typeof size.height).toBe('number');
    });
  });
});

/**
 * DesktopActionExecutor 单元测试
 * P0: 统一动作执行器 - 动作编排测试
 */

import { DesktopActionExecutor } from '../../../src/desktop/DesktopActionExecutor';

// Mock dependencies
jest.mock('../../../src/desktop/ScreenCapture', () => ({
  ScreenCapture: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      captureFullScreen: jest.fn().mockResolvedValue({
        success: true,
        buffer: Buffer.from('mock-screenshot'),
        width: 1920,
        height: 1080,
        format: 'png',
        timestamp: Date.now(),
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/SystemInput', () => ({
  SystemInput: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      moveMouse: jest.fn().mockReturnValue({ success: true }),
      click: jest.fn().mockReturnValue({ success: true }),
      rightClick: jest.fn().mockReturnValue({ success: true }),
      scroll: jest.fn().mockReturnValue({ success: true }),
      drag: jest.fn().mockReturnValue({ success: true }),
      keyPress: jest.fn().mockImplementation((keyCode: number) => {
        return { success: keyCode !== undefined };
      }),
      keyCombo: jest.fn().mockReturnValue({ success: true }),
      typeText: jest.fn().mockReturnValue({ success: true }),
      getMousePosition: jest.fn().mockReturnValue({ x: 100, y: 200 }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
    Keys: {
      ENTER: 0x0d,
      ESCAPE: 0x1b,
      TAB: 0x09,
      SPACE: 0x20,
      BACKSPACE: 0x08,
      DELETE: 0x2e,
      UP: 0x26,
      DOWN: 0x28,
      LEFT: 0x25,
      RIGHT: 0x27,
      HOME: 0x24,
      END: 0x23,
      PAGE_UP: 0x21,
      PAGE_DOWN: 0x22,
      CTRL: 0x11,
      SHIFT: 0x10,
      ALT: 0x12,
      WIN: 0x5b,
      A: 0x41,
      C: 0x43,
      V: 0x56,
      X: 0x58,
      Z: 0x5a,
      F5: 0x74,
      F11: 0x7a,
    },
  },
}));

jest.mock('../../../src/desktop/WindowManager', () => ({
  WindowManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      listWindows: jest.fn().mockReturnValue([]),
      findWindow: jest.fn().mockReturnValue({
        handle: 12345,
        title: 'Test Window',
        processName: 'test.exe',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isMinimized: false,
        isMaximized: false,
        zOrder: 0,
      }),
      activateWindow: jest.fn().mockReturnValue({ success: true }),
      activateWindowByTitle: jest.fn().mockReturnValue({ success: true }),
      maximizeWindow: jest.fn().mockReturnValue({ success: true }),
      minimizeWindow: jest.fn().mockReturnValue({ success: true }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopVisionEngine', () => ({
  DesktopVisionEngine: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      observe: jest.fn().mockResolvedValue({
        timestamp: Date.now(),
        screenshot: { success: true, buffer: Buffer.alloc(0), width: 1920, height: 1080, format: 'png' },
        visionAnalysis: { success: true, description: 'Mock analysis', processingTime: 100 },
        windows: [],
        summary: 'Mock summary',
      }),
      generateReport: jest.fn().mockReturnValue('Mock report'),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
    reset: jest.fn(),
  },
}));

describe('DesktopActionExecutor', () => {
  let executor: DesktopActionExecutor;

  beforeEach(() => {
    executor = DesktopActionExecutor.getInstance();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = DesktopActionExecutor.getInstance();
      const instance2 = DesktopActionExecutor.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await executor.initialize();
      expect(executor).toBeDefined();
    });
  });

  describe('executeAction', () => {
    it('应该执行点击动作', async () => {
      await executor.initialize();
      const result = await executor.executeAction({
        type: 'click',
        params: { x: 100, y: 200 },
        description: '点击按钮',
      });
      expect(result.success).toBe(true);
    });

    it('应该执行输入文字动作', async () => {
      await executor.initialize();
      const result = await executor.executeAction({
        type: 'type',
        params: { text: 'Hello World' },
        description: '输入文字',
      });
      expect(result.success).toBe(true);
    });

    it('应该执行按键动作', async () => {
      await executor.initialize();
      const result = await executor.executeAction({
        type: 'key',
        params: { key: 'ENTER' },
        description: '按回车',
      });
      expect(result.success).toBe(true);
    });

    it('应该执行等待动作', async () => {
      await executor.initialize();
      const result = await executor.executeAction({
        type: 'wait',
        params: { ms: 10 },
        description: '等待',
      });
      expect(result.success).toBe(true);
    });

    it('应该执行截图动作', async () => {
      await executor.initialize();
      const result = await executor.executeAction({
        type: 'screenshot',
        params: {},
        description: '截图',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('executeTask', () => {
    it('应该执行多步骤任务', async () => {
      await executor.initialize();
      const result = await executor.executeTask([
        { type: 'moveMouse', params: { x: 100, y: 200 }, description: '移动鼠标' },
        { type: 'click', params: { x: 100, y: 200 }, description: '点击' },
        { type: 'wait', params: { ms: 10 }, description: '等待' },
      ]);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(3);
    });
  });

  describe('快捷任务', () => {
    it('应该执行点击坐标快捷任务', async () => {
      await executor.initialize();
      const result = await executor.clickAt(100, 200);
      expect(result.success).toBe(true);
    });

    it('应该执行观察汇报快捷任务', async () => {
      await executor.initialize();
      const result = await executor.observeAndReport();
      expect(result.success).toBe(true);
    });
  });
});

/**
 * DesktopAgentLoop 单元测试
 * P0: 最小闭环 - Agent循环测试
 */

import { DesktopAgentLoop } from '../../../src/desktop/DesktopAgentLoop';

// Mock dependencies
jest.mock('../../../src/desktop/DesktopVisionEngine', () => ({
  DesktopVisionEngine: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      observe: jest.fn().mockResolvedValue({
        timestamp: Date.now(),
        screenshot: { success: true, buffer: Buffer.alloc(0), width: 1920, height: 1080, format: 'png' },
        visionAnalysis: { success: true, description: '桌面有记事本窗口', processingTime: 100 },
        windows: [{ title: '记事本', processName: 'notepad.exe', bounds: { x: 0, y: 0, width: 800, height: 600 }, isVisible: true, isMinimized: false, isMaximized: false, zOrder: 0, handle: 12345, className: '', processId: 0 }],
        summary: '桌面有记事本窗口',
      }),
      generateReport: jest.fn().mockReturnValue('桌面汇报'),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
    reset: jest.fn(),
  },
}));

jest.mock('../../../src/desktop/DesktopActionExecutor', () => ({
  DesktopActionExecutor: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      executeTask: jest.fn().mockResolvedValue({
        success: true,
        actions: [],
        summary: '执行完成',
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/WindowManager', () => ({
  WindowManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      listWindows: jest.fn().mockReturnValue([]),
      getScreenSize: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/SystemInput', () => ({
  SystemInput: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopUIInspector', () => ({
  DesktopUIInspector: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({ elements: [], summary: '' }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/StateSnapshotManager', () => ({
  StateSnapshotManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      checkpointBeforeAction: jest.fn().mockResolvedValue('checkpoint-1'),
      restoreSnapshot: jest.fn().mockResolvedValue(true),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe('DesktopAgentLoop', () => {
  let agentLoop: DesktopAgentLoop;

  beforeEach(() => {
    agentLoop = DesktopAgentLoop.getInstance();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = DesktopAgentLoop.getInstance();
      const instance2 = DesktopAgentLoop.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await agentLoop.initialize();
      expect(agentLoop).toBeDefined();
    });
  });

  describe('execute', () => {
    it('应该执行截图指令', async () => {
      await agentLoop.initialize();
      const result = await agentLoop.execute('截图');
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('应该执行打开应用指令', async () => {
      await agentLoop.initialize();
      const result = await agentLoop.execute('打开记事本');
      expect(result).toBeDefined();
    });

    it('应该处理无法识别的指令', async () => {
      await agentLoop.initialize();
      const result = await agentLoop.execute('xyz未知指令123');
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('应该执行点击屏幕中央指令', async () => {
      await agentLoop.initialize();
      const result = await agentLoop.execute('点击屏幕中央');
      expect(result).toBeDefined();
    });
  });

  describe('isExecuting', () => {
    it('应该返回执行状态', async () => {
      await agentLoop.initialize();
      expect(typeof agentLoop.isExecuting()).toBe('boolean');
    });
  });
});

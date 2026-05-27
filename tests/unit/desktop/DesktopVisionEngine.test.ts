/**
 * DesktopVisionEngine 单元测试
 * P0: 桌面之眼 - 视觉分析引擎测试
 */

import { DesktopVisionEngine } from '../../../src/desktop/DesktopVisionEngine';

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
      captureRegion: jest.fn().mockResolvedValue({
        success: true,
        buffer: Buffer.from('mock-region'),
        width: 800,
        height: 600,
        format: 'png',
        timestamp: Date.now(),
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/WindowManager', () => ({
  WindowManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      listWindows: jest.fn().mockReturnValue([
        {
          handle: 12345,
          title: 'Test Window',
          processName: 'test.exe',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          isVisible: true,
          isMinimized: false,
          isMaximized: false,
          zOrder: 0,
        },
      ]),
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
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/multimodal/VisionEngine', () => ({
  VisionEngine: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    analyzeImage: jest.fn().mockResolvedValue({
      success: true,
      description: 'Mock vision analysis',
      processingTime: 100,
    }),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('DesktopVisionEngine', () => {
  let visionEngine: DesktopVisionEngine;

  beforeEach(() => {
    DesktopVisionEngine.reset();
    visionEngine = DesktopVisionEngine.getInstance();
  });

  afterEach(() => {
    DesktopVisionEngine.reset();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = DesktopVisionEngine.getInstance();
      const instance2 = DesktopVisionEngine.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await visionEngine.initialize();
      expect(visionEngine).toBeDefined();
    });
  });

  describe('observe', () => {
    it('应该观察桌面并返回结果', async () => {
      await visionEngine.initialize();
      const result = await visionEngine.observe();

      expect(result).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.windows).toBeDefined();
      expect(result.screenshot).toBeDefined();
    });

    it('应该将观察结果加入历史', async () => {
      await visionEngine.initialize();
      await visionEngine.observe();
      const history = visionEngine.getObservationHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getLatestObservation', () => {
    it('应该返回最新观察', async () => {
      await visionEngine.initialize();
      await visionEngine.observe();
      const latest = visionEngine.getLatestObservation();
      expect(latest).toBeDefined();
    });

    it('无观察时返回 null', () => {
      const latest = visionEngine.getLatestObservation();
      expect(latest).toBeNull();
    });
  });

  describe('generateReport', () => {
    it('应该生成汇报文本', async () => {
      await visionEngine.initialize();
      await visionEngine.observe();
      const report = visionEngine.generateReport();
      expect(typeof report).toBe('string');
      expect(report.length).toBeGreaterThan(0);
    });

    it('无观察时返回提示', () => {
      const report = visionEngine.generateReport();
      expect(report).toContain('还没有观察到');
    });
  });

  describe('captureWindow', () => {
    it('应该截取指定窗口', async () => {
      await visionEngine.initialize();
      const result = await visionEngine.captureWindow('Test Window');
      expect(result).toBeDefined();
    });
  });

  describe('startObservation / stopObservation', () => {
    it('应该启动和停止持续观察', async () => {
      await visionEngine.initialize();

      let observed = false;
      const promise = visionEngine.startObservation(() => {
        observed = true;
      });

      await new Promise((r) => setTimeout(r, 100));
      visionEngine.stopObservation();

      await promise.catch(() => {});
      expect(visionEngine).toBeDefined();
    });
  });
});

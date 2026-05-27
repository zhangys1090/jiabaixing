/**
 * ScreenCapture 单元测试
 * P0: 桌面之眼 - 屏幕截图功能测试
 */

import { ScreenCapture } from '../../../src/desktop/ScreenCapture';

// Mock screenshot-desktop
jest.mock('screenshot-desktop', () =>
  jest.fn().mockResolvedValue(Buffer.from('mock-screenshot'))
);

describe('ScreenCapture', () => {
  let screenCapture: ScreenCapture;

  beforeEach(() => {
    screenCapture = ScreenCapture.getInstance();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = ScreenCapture.getInstance();
      const instance2 = ScreenCapture.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await screenCapture.initialize();
      expect(screenCapture).toBeDefined();
    });

    it('重复初始化应该安全', async () => {
      await screenCapture.initialize();
      await screenCapture.initialize();
    });
  });

  describe('captureFullScreen', () => {
    it('应该成功截图并返回结果', async () => {
      await screenCapture.initialize();
      const result = await screenCapture.captureFullScreen();

      expect(result.success).toBe(true);
      expect(result.buffer).toBeDefined();
      expect(result.width).toBeDefined();
      expect(result.height).toBeDefined();
      expect(result.format).toBe('png');
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('应该支持 jpg 格式', async () => {
      await screenCapture.initialize();
      const result = await screenCapture.captureFullScreen({ format: 'jpg' });

      expect(result.success).toBe(true);
      expect(result.buffer).toBeDefined();
    });
  });

  describe('captureRegion', () => {
    it('应该支持区域截图', async () => {
      await screenCapture.initialize();
      const result = await screenCapture.captureRegion({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      });

      expect(result.success).toBe(true);
      expect(result.buffer).toBeDefined();
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });
  });

  describe('captureScreen', () => {
    it('应该支持指定显示器截图', async () => {
      await screenCapture.initialize();
      const result = await screenCapture.captureScreen(0);

      expect(result.success).toBe(true);
      expect(result.buffer).toBeDefined();
    });
  });

  describe('captureSequence', () => {
    it('应该支持连续截图', async () => {
      await screenCapture.initialize();
      const results = await screenCapture.captureSequence(3, 10);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
    });
  });
});

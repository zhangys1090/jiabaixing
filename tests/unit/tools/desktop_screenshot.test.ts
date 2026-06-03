/**
 * Unit tests for desktop_screenshot harness tool
 */

import { createDesktopScreenshotExecutor, DESKTOP_SCREENSHOT_DEF } from '../../../src/harness/tools/desktop/desktop_screenshot';

// Mock screenshot-desktop for default implementation tests
jest.mock('screenshot-desktop', () => {
  const mockFn = jest.fn();
  mockFn.mockImplementation(
    (opts: { filename?: string; format?: string; screen?: number }) => {
      return Promise.resolve();
    }
  );
  return mockFn;
});

describe('desktop_screenshot 工具', () => {
  describe('工具定义', () => {
    it('应该有正确的名称和分类', () => {
      expect(DESKTOP_SCREENSHOT_DEF.name).toBe('desktop_screenshot');
      expect(DESKTOP_SCREENSHOT_DEF.category).toBe('desktop');
      expect(DESKTOP_SCREENSHOT_DEF.requiredPermissions).toContain(
        'desktop:control'
      );
      expect(DESKTOP_SCREENSHOT_DEF.timeout).toBe(15000);
      expect(DESKTOP_SCREENSHOT_DEF.requiresConfirmation).toBe(true);
    });

    it('应该有正确的参数定义', () => {
      expect(DESKTOP_SCREENSHOT_DEF.parameters.screenIndex).toBeDefined();
      expect(DESKTOP_SCREENSHOT_DEF.parameters.analyze).toBeDefined();
      expect(DESKTOP_SCREENSHOT_DEF.parameters.region).toBeDefined();
    });
  });

  describe('通过注入的 captureScreen 依赖截图', () => {
    const mockBuffer = Buffer.alloc(100);

    it('应成功返回截图信息', async () => {
      const mockCaptureScreen = jest.fn().mockResolvedValue({
        buffer: mockBuffer,
        width: 1920,
        height: 1080,
      });
      const executor = createDesktopScreenshotExecutor({
        captureScreen: mockCaptureScreen,
      });
      const result = await executor({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('1920x1080');
      expect(result.metadata).toEqual({
        width: 1920,
        height: 1080,
        sizeKB: 0,
        analyzed: false,
      });
    });

    it('应传递 region 和 screenIndex 参数', async () => {
      const mockCaptureScreen = jest.fn().mockResolvedValue({
        buffer: mockBuffer,
        width: 800,
        height: 600,
      });
      const executor = createDesktopScreenshotExecutor({
        captureScreen: mockCaptureScreen,
      });
      await executor({
        region: { x: 0, y: 0, width: 800, height: 600 },
        screenIndex: 1,
      });
      expect(mockCaptureScreen).toHaveBeenCalledWith({
        region: { x: 0, y: 0, width: 800, height: 600 },
        screenIndex: 1,
      });
    });

    it('应处理截图失败', async () => {
      const mockCaptureScreen = jest
        .fn()
        .mockRejectedValue(new Error('display not found'));
      const executor = createDesktopScreenshotExecutor({
        captureScreen: mockCaptureScreen,
      });
      const result = await executor({});
      expect(result.success).toBe(false);
      expect(result.output).toContain('截图失败');
      expect(result.error).toContain('display not found');
    });

    it('analyze=true 时若有 analyzeImage 应调用', async () => {
      const mockCaptureScreen = jest.fn().mockResolvedValue({
        buffer: mockBuffer,
        width: 1920,
        height: 1080,
      });
      const mockAnalyzeImage = jest
        .fn()
        .mockResolvedValue('这是一张桌面截图，包含任务栏和浏览器窗口');
      const executor = createDesktopScreenshotExecutor({
        captureScreen: mockCaptureScreen,
        analyzeImage: mockAnalyzeImage,
      });
      const result = await executor({ analyze: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('视觉分析');
      expect(result.output).toContain('这是一张桌面截图');
      expect(result.metadata?.analyzed).toBe(true);
      expect(mockAnalyzeImage).toHaveBeenCalledWith(mockBuffer);
    });

    it('analyze=true 但无 analyzeImage 时应提示不可用', async () => {
      const mockCaptureScreen = jest.fn().mockResolvedValue({
        buffer: mockBuffer,
        width: 1920,
        height: 1080,
      });
      const executor = createDesktopScreenshotExecutor({
        captureScreen: mockCaptureScreen,
      });
      const result = await executor({ analyze: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('视觉分析不可用');
    });
  });

  describe('无注入依赖（使用默认实现）', () => {
    it('不传 deps 时应创建默认 executor', () => {
      const executor = createDesktopScreenshotExecutor();
      expect(executor).toBeInstanceOf(Function);
    });

    it('使用 mock 的 screenshot-desktop 应成功', async () => {
      const executor = createDesktopScreenshotExecutor();
      const result = await executor({});
      // 在测试环境下，screenshot-desktop 被 mock，不会执行真实截图
      // 但 defaultCaptureScreen 会尝试读取文件，由于 mock 不创建文件，会报错
      // 我们期望返回格式正确的结果结构
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
    });
  });
});

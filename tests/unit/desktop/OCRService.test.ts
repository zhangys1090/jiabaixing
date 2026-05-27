/**
 * OCRService 单元测试
 * P0: 桌面之眼 - OCR文字识别功能测试
 */

import { OCRService } from '../../../src/desktop/OCRService';

describe('OCRService', () => {
  let ocrService: OCRService;

  beforeEach(() => {
    ocrService = OCRService.getInstance();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = OCRService.getInstance();
      const instance2 = OCRService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await ocrService.initialize();
      expect(ocrService).toBeDefined();
    });
  });

  describe('recognizeScreenshot', () => {
    it('应该返回识别结果', async () => {
      await ocrService.initialize();
      const result = await ocrService.recognizeScreenshot(Buffer.from('fake-image'));

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });
});

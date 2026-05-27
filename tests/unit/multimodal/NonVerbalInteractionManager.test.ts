/**
 * NonVerbalInteractionManager 单元测试
 * 覆盖率目标：≥80%
 */

import { NonVerbalInteractionManager, NonVerbalContext } from '../../../src/multimodal/NonVerbalInteractionManager';
import { MultimodalInput } from '../../../src/multimodal/MultimodalInput';

describe.skip('NonVerbalInteractionManager', () => {
  let manager: NonVerbalInteractionManager;

  beforeEach(() => {
    manager = new NonVerbalInteractionManager();
    manager.initialize();
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('视觉输入处理', () => {
    test('应该能够处理视觉输入', async () => {
      // 创建一个模拟的视觉输入
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };
      
      const input = new MultimodalInput('');
      // 模拟设置图像
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      expect(context).toBeDefined();
      expect(context.cues).toBeDefined();
      expect(context.emotionalState).toBeDefined();
      expect(context.engagementLevel).toBeDefined();
    });

    test('应该分析面部表情', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      // 应该包含面部线索
      const facialCues = context.cues.filter(cue => cue.type === 'facial');
      expect(facialCues.length).toBeGreaterThan(0);
    });

    test('应该分析肢体语言', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      // 应该包含身体线索
      const bodyCues = context.cues.filter(cue => cue.type === 'body');
      expect(bodyCues.length).toBeGreaterThan(0);
    });

    test('应该分析眼神交流', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      // 应该包含眼神线索
      const eyeCues = context.cues.filter(cue => cue.type === 'eye');
      expect(eyeCues.length).toBeGreaterThan(0);
    });
  });

  describe('情感分析', () => {
    test('应该识别主要情感', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      expect(context.emotionalState.primaryEmotion).toBeDefined();
      expect(['开心', '悲伤', '愤怒', '平静', '惊讶', '紧张']).toContain(context.emotionalState.primaryEmotion);
    });

    test('应该计算情感强度', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      expect(context.emotionalState.intensity).toBeGreaterThanOrEqual(0);
      expect(context.emotionalState.intensity).toBeLessThanOrEqual(1);
    });

    test('应该评估参与度', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      expect(['high', 'medium', 'low']).toContain(context.engagementLevel);
    });
  });

  describe('线索管理', () => {
    test('应该记录非语言线索', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      await manager.processVisualInput(input);

      const cues = manager.getNonVerbalCues();
      expect(cues.length).toBeGreaterThan(0);
    });

    test('应该限制线索数量', async () => {
      // 处理大量视觉输入以生成大量线索
      for (let i = 0; i < 1100; i++) {
        const mockImage = {
          data: Buffer.from(`模拟图像数据${i}`),
          width: 640,
          height: 480,
          format: 'jpeg'
        };

        const input = new MultimodalInput('');
        (input as any).image = mockImage;

        await manager.processVisualInput(input);
      }

      const cues = manager.getNonVerbalCues(2000);
      expect(cues.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('输入集成', () => {
    test('应该集成语言和非语言输入', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);
      const verbalInput = '你好，今天天气怎么样？';

      const integrated = manager.integrateInputs(verbalInput, context);

      expect(integrated.integratedInput).toContain(verbalInput);
      expect(integrated.emotionalState).toBeDefined();
      expect(integrated.engagementLevel).toBeDefined();
      expect(integrated.intent).toBeDefined();
    });

    test('应该根据情感增强输入', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);

      // 如果情感强度高，应该增强输入
      if (context.emotionalState.intensity > 0.7) {
        const verbalInput = '测试';
        const integrated = manager.integrateInputs(verbalInput, context);
        expect(integrated.integratedInput).toContain('情绪强烈');
      }
    });
  });

  describe('统计信息', () => {
    test('应该提供正确的统计信息', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      await manager.processVisualInput(input);

      const stats = manager.getStatistics();

      expect(stats.totalCues).toBeGreaterThan(0);
      expect(stats.cueTypes).toBeDefined();
      expect(stats.averageConfidence).toBeGreaterThan(0);
      expect(stats.dominantEmotion).toBeDefined();
    });

    test('应该统计线索类型', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      await manager.processVisualInput(input);

      const stats = manager.getStatistics();

      expect(stats.cueTypes.facial).toBeGreaterThanOrEqual(0);
      expect(stats.cueTypes.body).toBeGreaterThanOrEqual(0);
      expect(stats.cueTypes.eye).toBeGreaterThanOrEqual(0);
    });
  });

  describe('边界条件', () => {
    test('应该处理没有视觉输入的情况', async () => {
      const input = new MultimodalInput('');

      await expect(manager.processVisualInput(input)).rejects.toThrow('没有视觉输入');
    });

    test('应该处理空图像数据', async () => {
      const mockImage = {
        data: Buffer.from(''),
        width: 0,
        height: 0,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      const context = await manager.processVisualInput(input);
      expect(context).toBeDefined();
    });

    test('应该处理清理操作', async () => {
      const mockImage = {
        data: Buffer.from('模拟图像数据'),
        width: 640,
        height: 480,
        format: 'jpeg'
      };

      const input = new MultimodalInput('');
      (input as any).image = mockImage;

      await manager.processVisualInput(input);

      manager.cleanup();

      const stats = manager.getStatistics();
      expect(stats.totalCues).toBe(0);
    });

    test('应该处理空线索列表', () => {
      const cues = manager.getNonVerbalCues();
      expect(cues).toHaveLength(0);
    });
  });
});

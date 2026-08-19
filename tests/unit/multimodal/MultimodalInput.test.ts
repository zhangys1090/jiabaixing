/**
 * MultimodalInput 单元测试
 * 覆盖：文本/语音/图像/视频/传感器输入、类型过滤、合并、序列化
 */

import {
  InputSource,
  MultimodalInput,
} from '../../../src/multimodal/MultimodalInput';

describe('MultimodalInput', () => {
  describe('文本输入', () => {
    it('应从字符串创建文本输入', () => {
      const input = new MultimodalInput('你好');
      expect(input.getText()).toBe('你好');
      expect(input.hasType('text')).toBe(true);
      expect(input.getSourceCount()).toBe(1);
    });

    it('addText 应添加文本源', () => {
      const input = new MultimodalInput([]);
      input.addText('第二条');
      expect(input.getText()).toBe('第二条');
    });

    it('无文本时 getText 返回空字符串', () => {
      const input = new MultimodalInput([]);
      expect(input.getText()).toBe('');
    });
  });

  describe('语音输入', () => {
    it('应添加语音输入', () => {
      const input = new MultimodalInput([]);
      const audioBuffer = Buffer.from('audio-data');
      input.addVoice(audioBuffer);
      expect(input.hasType('voice')).toBe(true);
      expect(input.getVoice()).toBeDefined();
    });

    it('无语音时 getVoice 返回 undefined', () => {
      const input = new MultimodalInput([]);
      expect(input.getVoice()).toBeUndefined();
    });
  });

  describe('图像输入', () => {
    it('应添加图像输入 (Buffer)', () => {
      const input = new MultimodalInput([]);
      input.addImage(Buffer.from('image-data'));
      expect(input.hasType('image')).toBe(true);
      expect(input.getImage()).toBeDefined();
    });

    it('应添加图像输入 (URL string)', () => {
      const input = new MultimodalInput([]);
      input.addImage('https://example.com/image.png');
      expect(input.getImage()).toBe('https://example.com/image.png');
    });

    it('无图像时 getImage 返回 undefined', () => {
      const input = new MultimodalInput([]);
      expect(input.getImage()).toBeUndefined();
    });
  });

  describe('视频输入', () => {
    it('应添加视频输入', () => {
      const input = new MultimodalInput([]);
      input.addVideo(Buffer.from('video-data'));
      expect(input.hasType('video')).toBe(true);
      expect(input.getVideo()).toBeDefined();
    });

    it('无视频时 getVideo 返回 undefined', () => {
      const input = new MultimodalInput([]);
      expect(input.getVideo()).toBeUndefined();
    });
  });

  describe('传感器输入', () => {
    it('应添加传感器输入', () => {
      const input = new MultimodalInput([]);
      input.addSensor({ temperature: 25.5 });
      expect(input.hasType('sensor')).toBe(true);
      expect(input.getSensor()).toEqual({ temperature: 25.5 });
    });

    it('无传感器时 getSensor 返回 undefined', () => {
      const input = new MultimodalInput([]);
      expect(input.getSensor()).toBeUndefined();
    });
  });

  describe('多输入源', () => {
    it('应从 InputSource 数组创建', () => {
      const sources: InputSource[] = [
        { type: 'text', data: '你好', timestamp: new Date() },
        { type: 'image', data: Buffer.from('img'), timestamp: new Date() },
      ];
      const input = new MultimodalInput(sources);
      expect(input.getSourceCount()).toBe(2);
      expect(input.hasType('text')).toBe(true);
      expect(input.hasType('image')).toBe(true);
    });

    it('getSourcesByType 应过滤类型', () => {
      const input = new MultimodalInput('文本');
      input.addImage(Buffer.from('img'));
      input.addImage(Buffer.from('img2'));

      const images = input.getSourcesByType('image');
      expect(images).toHaveLength(2);
    });

    it('getSources 应返回副本', () => {
      const input = new MultimodalInput('文本');
      const sources = input.getSources();
      sources.push({ type: 'text', data: 'hack', timestamp: new Date() });
      expect(input.getSourceCount()).toBe(1);
    });
  });

  describe('合并', () => {
    it('应合并两个输入', () => {
      const input1 = new MultimodalInput('文本1');
      const input2 = new MultimodalInput([]);
      input2.addImage(Buffer.from('img'));

      input1.merge(input2);
      expect(input1.getSourceCount()).toBe(2);
      expect(input1.hasType('image')).toBe(true);
    });
  });

  describe('序列化', () => {
    it('toJSON 应返回可序列化对象', () => {
      const input = new MultimodalInput('测试');
      const json = input.toJSON() as {
        timestamp: string;
        sources: InputSource[];
      };
      expect(json.timestamp).toBeDefined();
      expect(json.sources).toHaveLength(1);
    });

    it('fromJSON 应还原输入', () => {
      const input = new MultimodalInput('测试');
      input.addImage(Buffer.from('img'));
      const json = input.toJSON();
      const restored = MultimodalInput.fromJSON(json);

      expect(restored.getSourceCount()).toBe(2);
      expect(restored.getText()).toBe('测试');
    });
  });

  describe('音频转录标记', () => {
    it('默认未转录', () => {
      const input = new MultimodalInput([]);
      expect(input.getIsAudioTranscribed()).toBe(false);
    });

    it('标记后应为已转录', () => {
      const input = new MultimodalInput([]);
      input.markAudioTranscribed();
      expect(input.getIsAudioTranscribed()).toBe(true);
    });

    it('重置后应为未转录', () => {
      const input = new MultimodalInput([]);
      input.markAudioTranscribed();
      input.resetAudioTranscribed();
      expect(input.getIsAudioTranscribed()).toBe(false);
    });
  });

  describe('时间戳', () => {
    it('应记录创建时间', () => {
      const before = new Date();
      const input = new MultimodalInput('测试');
      const after = new Date();

      expect(input.getTimestamp().getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
      expect(input.getTimestamp().getTime()).toBeLessThanOrEqual(
        after.getTime()
      );
    });
  });
});

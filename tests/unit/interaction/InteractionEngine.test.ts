/**
 * 交互引擎单元测试
 */

import { EmotionTag, PersonaScene, SceneTag } from '../../../src/interfaces';
import { InteractionEngine } from '../../../src/interaction/InteractionEngine';
import { MemoryItem } from '../../../src/memory/MemoryEngine';

describe('InteractionEngine', () => {
  let interactionEngine: InteractionEngine;

  beforeEach(async () => {
    interactionEngine = new InteractionEngine();
    await interactionEngine.initialize();
  });

  afterEach(async () => {
    await interactionEngine.shutdown();
  });

  describe('initialize and shutdown', () => {
    it('should initialize and shutdown correctly', async () => {
      expect((interactionEngine as any).personaRules).toBeDefined();
      expect((interactionEngine as any).speechSynthesizer).toBeDefined();
      expect(Array.isArray((interactionEngine as any).interactionHistory)).toBe(true);

      await expect(interactionEngine.shutdown()).resolves.not.toThrow();
    });
  });

  describe('generateResultResponse', () => {
    it('should generate result response correctly', async () => {
      const executionResults = {
        results: [
          { taskId: 'task1', description: '任务1', result: '成功' },
          { taskId: 'task2', description: '任务2', result: '成功' }
        ],
        summary: '成功完成 2 个任务'
      };

      const emotion: EmotionTag = {
        type: '开心',
        intensity: 5,
        potentialNeeds: []
      };

      const scene: SceneTag = {
        type: PersonaScene.DEVELOPMENT,
        context: '用户正在编写代码',
        interactionMode: '文本'
      };

      const memoryContext: MemoryItem[] = [];

      await expect(interactionEngine.generateResultResponse(executionResults, emotion, scene, memoryContext)).resolves.not.toThrow();
    });

    it('should adjust tone based on emotion', async () => {
      const executionResults = {
        results: [
          { taskId: 'task1', description: '任务1', result: '成功' }
        ],
        summary: '成功完成 1 个任务'
      };

      const emotion: EmotionTag = {
        type: '疲惫',
        intensity: 6,
        potentialNeeds: ['休息', '鼓励']
      };

      const scene: SceneTag = {
        type: PersonaScene.DEVELOPMENT,
        context: '用户正在编写代码',
        interactionMode: '文本'
      };

      const memoryContext: MemoryItem[] = [];

      await expect(interactionEngine.generateResultResponse(executionResults, emotion, scene, memoryContext)).resolves.not.toThrow();
    });
  });

  describe('generateErrorResponse', () => {
    it('should generate error response correctly', async () => {
      const error = new Error('测试错误');
      await expect(interactionEngine.generateErrorResponse(error)).resolves.not.toThrow();
    });
  });

  describe('generateMaxRetryResponse', () => {
    it('should generate max retry response correctly', async () => {
      await expect(interactionEngine.generateMaxRetryResponse()).resolves.not.toThrow();
    });
  });
});

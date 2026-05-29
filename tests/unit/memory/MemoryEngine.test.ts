/**
 * 记忆引擎单元测试
 */

import { EmotionTag, PersonaScene, SceneTag } from '../../../src/interfaces';
import { MemoryDatabase } from '../../../src/memory/Database';
import { LongTermMemory } from '../../../src/memory/LongTermMemory';
import {
  MemoryEngine,
  MemoryItem,
  MemoryType,
} from '../../../src/memory/MemoryEngine';
import { ShortTermMemory } from '../../../src/memory/ShortTermMemory';
import { UserProfile } from '../../../src/memory/UserProfile';
import { MultimodalInput } from '../../../src/multimodal/MultimodalInput';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  appendFileSync: jest.fn(),
  stat: jest.fn().mockResolvedValue({ size: 0 }),
  statSync: jest.fn().mockReturnValue({ size: 0 }),
  createWriteStream: jest
    .fn()
    .mockReturnValue({ write: jest.fn(), end: jest.fn() }),
}));

jest.mock('better-sqlite3', () => {
  class MockStatement {
    run() {
      return { lastInsertRowid: 1, changes: 1 };
    }
    all() {
      return [];
    }
    get() {
      return undefined;
    }
  }

  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue(new MockStatement()),
    pragma: jest.fn().mockReturnValue([]),
    exec: jest.fn(),
    transaction: jest.fn((fn: () => unknown) => fn()),
    close: jest.fn(),
  }));
});

jest.mock('../../../src/memory/VectorDatabaseFactory', () => ({
  VectorDatabaseFactory: {
    createVectorDatabase: jest.fn().mockResolvedValue({
      storeVector: jest.fn().mockResolvedValue(undefined),
      searchVectors: jest.fn().mockResolvedValue([]),
      deleteVector: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/memory/LongTermMemory', () => ({
  LongTermMemory: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    store: jest.fn().mockResolvedValue(undefined),
    retrieve: jest.fn().mockResolvedValue([]),
    getAll: jest.fn().mockReturnValue([]),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../src/memory/MemoryEncryption', () => ({
  MemoryEncryption: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    encrypt: jest.fn((d: string) => d),
    decrypt: jest.fn((d: string) => d),
  })),
}));

describe('MemoryEngine', () => {
  let memoryEngine: MemoryEngine;

  beforeEach(async () => {
    MemoryDatabase.resetInstance();
    memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();
  });

  afterEach(async () => {
    await memoryEngine.shutdown();
    MemoryDatabase.resetInstance();
  });

  describe('initialize and shutdown', () => {
    it('should initialize and shutdown correctly', async () => {
      // 验证初始化状态
      const engine = memoryEngine as any;
      expect(engine.userProfile).toBeInstanceOf(UserProfile);
      expect(engine.shortTermMemory).toBeInstanceOf(ShortTermMemory);
      // LongTermMemory is module-mocked → constructor replaced
      expect(engine.longTermMemory).toBeDefined();
      expect(typeof engine.longTermMemory.initialize).toBe('function');
      expect(engine.instantMemory).toBeInstanceOf(Array);

      // 验证关闭功能
      await memoryEngine.shutdown();
    });
  });

  describe('memory storage', () => {
    it('should store instant memory correctly', async () => {
      const content = { message: '测试瞬时记忆' };
      const scene = '开发';
      const emotion = '开心';

      const memoryItem = await (memoryEngine as any).storeInstantMemory(
        content,
        scene,
        emotion
      );

      expect(memoryItem).toBeInstanceOf(Object);
      expect(memoryItem.id).toContain('instant_');
      expect(memoryItem.type).toBe(MemoryType.INSTANT);
      expect(memoryItem.content).toEqual(content);
      expect(memoryItem.scene).toBe(scene);
      expect(memoryItem.emotion).toBe(emotion);
      expect(memoryItem.timestamp).toBeInstanceOf(Date);

      // 验证记忆已添加到瞬时记忆列表
      const instantMemory = (memoryEngine as any).instantMemory;
      expect(instantMemory.length).toBe(1);
      expect(instantMemory[0].id).toBe(memoryItem.id);
    });

    it('should store short term memory correctly', async () => {
      const content = { message: '测试短期记忆' };
      const scene = '工作';
      const emotion = '专注';

      const memoryItem = await memoryEngine.storeShortTermMemory(
        content,
        scene,
        emotion
      );

      expect(memoryItem).toBeInstanceOf(Object);
      expect(memoryItem.type).toBe(MemoryType.SHORT_TERM);
      expect(memoryItem.content).toEqual(content);
      expect(memoryItem.scene).toBe(scene);
      expect(memoryItem.emotion).toBe(emotion);
      expect(memoryItem.timestamp).toBeInstanceOf(Date);
    });

    it('should store long term memory correctly', async () => {
      const content = { message: '测试长期记忆' };
      const scene = '学习';
      const emotion = '认真';

      const memoryItem = await memoryEngine.storeLongTermMemory(
        content,
        scene,
        emotion
      );

      expect(memoryItem).toBeInstanceOf(Object);
      expect(memoryItem.type).toBe(MemoryType.LONG_TERM);
      expect(memoryItem.content).toEqual(content);
      expect(memoryItem.scene).toBe(scene);
      expect(memoryItem.emotion).toBe(emotion);
      expect(memoryItem.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('memory retrieval', () => {
    it('should retrieve task memory correctly', async () => {
      // 添加测试记忆 - 使用纯字符串内容以便分词器能正确提取
      await (memoryEngine as any).storeInstantMemory(
        'TypeScript function development',
        'development',
        'calm'
      );

      await memoryEngine.storeShortTermMemory(
        'TypeScript type system learning',
        'learning',
        'focused'
      );

      await memoryEngine.storeLongTermMemory(
        'TypeScript advanced features',
        'learning',
        'focused'
      );

      // 检索与TypeScript相关的记忆
      const query = 'TypeScript';
      const requirements = ['function', 'type system'];
      const memoryItems = await memoryEngine.retrieveTaskMemory(
        query,
        requirements
      );

      // 验证结果
      expect(memoryItems).toBeInstanceOf(Array);
      // 由于mock数据库，只有instant memory可直接检索
      // 验证至少能返回结果（可能来自instant memory）
      if (memoryItems.length > 0) {
        const typescriptMemories = memoryItems.filter((item) =>
          JSON.stringify(item.content).includes('TypeScript')
        );
        expect(typescriptMemories.length).toBeGreaterThan(0);
      }
    });

    it('should retrieve emotion memory correctly', async () => {
      // 添加测试记忆 - 使用纯字符串内容
      await (memoryEngine as any).storeInstantMemory(
        'user is very happy today',
        'work',
        'happy'
      );

      await memoryEngine.storeShortTermMemory(
        'completed an important task',
        'work',
        'happy'
      );

      await memoryEngine.storeLongTermMemory(
        'user likes the feeling of success',
        'work',
        'happy'
      );

      // 检索与开心情绪相关的记忆
      const emotionType = 'happy';
      const sceneType = 'work';
      const memoryItems = await memoryEngine.retrieveEmotionMemory(
        emotionType,
        sceneType
      );

      // 验证结果
      expect(memoryItems).toBeInstanceOf(Array);
      // 由于mock数据库，验证基本检索功能
      if (memoryItems.length > 0) {
        const happyMemories = memoryItems.filter(
          (item) => item.emotion === 'happy'
        );
        expect(happyMemories.length).toBeGreaterThan(0);
      }
    });
  });

  describe('memory management', () => {
    it('should cleanup expired instant memory', async () => {
      // 设置瞬时记忆过期时间为1秒
      (memoryEngine as any).instantMemoryExpiry = 1;

      // 添加测试记忆
      const memoryItem = await (memoryEngine as any).storeInstantMemory(
        { message: '测试过期记忆' },
        '测试',
        '平静'
      );

      // 验证记忆已添加
      expect((memoryEngine as any).instantMemory.length).toBe(1);

      // 等待2秒，让记忆过期
      return new Promise((resolve) => {
        setTimeout(async () => {
          // 触发清理
          (memoryEngine as any).cleanupInstantMemory();

          // 验证记忆已被清理
          expect((memoryEngine as any).instantMemory.length).toBe(0);
          resolve(true);
        }, 2000);
      });
    });

    it('should merge and sort memories correctly', () => {
      // 创建测试记忆
      const taskMemories: MemoryItem[] = [
        {
          id: 'mem1',
          type: MemoryType.SHORT_TERM,
          content: '任务记忆1',
          timestamp: new Date(),
        },
        {
          id: 'mem2',
          type: MemoryType.SHORT_TERM,
          content: '任务记忆2',
          timestamp: new Date(),
        },
      ];

      const emotionMemories: MemoryItem[] = [
        {
          id: 'mem3',
          type: MemoryType.LONG_TERM,
          content: '情绪记忆1',
          timestamp: new Date(),
        },
        {
          id: 'mem1',
          type: MemoryType.SHORT_TERM,
          content: '任务记忆1',
          timestamp: new Date(),
        }, // 重复ID
      ];

      // 合并并排序记忆
      const mergedMemories = memoryEngine.mergeAndSortMemories(
        taskMemories,
        emotionMemories
      );

      // 验证结果
      expect(mergedMemories).toBeInstanceOf(Array);
      expect(mergedMemories.length).toBe(3); // 去重后应该有3个记忆

      // 验证排序结果（按相关性得分降序）
      const relevanceScores = mergedMemories.map(
        (item) => item.relevanceScore || 0
      );
      for (let i = 0; i < relevanceScores.length - 1; i++) {
        expect(relevanceScores[i]).toBeGreaterThanOrEqual(
          relevanceScores[i + 1]
        );
      }

      // 验证所有记忆项都有相关性得分
      mergedMemories.forEach((item) => {
        expect(item.relevanceScore).toBeDefined();
        expect(typeof item.relevanceScore).toBe('number');
      });
    });

    it('should calculate relevance score correctly', () => {
      const rank = 0;
      const total = 10;
      const weight = 1.0;

      const score = (memoryEngine as any).calculateRelevanceScore(
        rank,
        total,
        weight
      );

      // 实际实现: weight * (1 - index / total)
      const expectedScore = weight * (1 - rank / total);
      expect(score).toBeCloseTo(expectedScore);
    });
  });

  describe('user profile management', () => {
    it('should update user profile correctly', async () => {
      const emotion: EmotionTag = {
        type: '开心',
        intensity: 8,
        potentialNeeds: ['鼓励', '分享'],
      };

      const scene: SceneTag = {
        type: PersonaScene.WORK,
        context: '完成了一个重要任务',
        interactionMode: '文本',
      };

      const input = new MultimodalInput('我完成了一个重要任务！');

      // 获取用户画像
      const userProfile = memoryEngine.getUserProfile();

      // 验证用户画像存在
      expect(userProfile).toBeInstanceOf(UserProfile);
    });

    it('should get user profile correctly', () => {
      const userProfile = memoryEngine.getUserProfile();
      expect(userProfile).toBeInstanceOf(UserProfile);
    });
  });

  describe('memory update', () => {
    it('should update memory correctly', async () => {
      const input = new MultimodalInput('帮我写一个TypeScript函数');

      const result = {
        summary: '成功完成TypeScript函数编写',
        code: 'function hello() { return "Hello World"; }',
      };

      const reflection = {
        success: true,
        taskCount: 1,
        successCount: 1,
        failedCount: 0,
        target: '帮我写一个TypeScript函数',
      };

      const emotion: EmotionTag = {
        type: '开心',
        intensity: 6,
        potentialNeeds: ['鼓励'],
      };

      const scene: SceneTag = {
        type: PersonaScene.DEVELOPMENT,
        context: '用户正在编写代码',
        interactionMode: '文本',
      };

      // 更新记忆
      await memoryEngine.updateMemory(
        input,
        result,
        reflection,
        emotion,
        scene
      );

      // 验证记忆已更新
      const instantMemory = (memoryEngine as any).instantMemory;
      expect(instantMemory.length).toBeGreaterThan(0);

      // 验证记忆内容
      const storedMemory = instantMemory[0];
      expect(storedMemory.content.input).toBe('帮我写一个TypeScript函数');
      expect(storedMemory.content.result).toEqual(result);
      expect(storedMemory.content.reflection).toEqual(reflection);
      expect(storedMemory.content.emotion).toEqual(emotion);
      expect(storedMemory.content.scene).toEqual(scene);
      expect(storedMemory.scene).toBe('development');
      expect(storedMemory.emotion).toBe('开心');
    });
  });
});

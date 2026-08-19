/**
 * 记忆生命周期功能测试
 *
 * 测试 memory_store 的重要性评分、去重、生命周期晋升，
 * 以及 PersistenceService 的记忆晋升和访问追踪
 */

import {
  PersistenceService,
  type MemoryItem,
  type PersistenceServiceDeps,
} from '../../src/harness/persistence/PersistenceService';
import {
  createMemoryStoreExecutor,
  isDuplicateContent,
  type MemoryMetadata,
  type MemoryStoreDeps,
} from '../../src/harness/tools/memory/memory_store';
import type { ToolContext } from '../../src/harness/types';
import { Permission } from '../../src/harness/types';

const mockToolContext: ToolContext = {
  permissions: new Set<Permission>([Permission.MEMORY_WRITE]),
  metadata: {},
};

describe('memory_store 重要性评分', () => {
  it('应该使用默认重要性评分5', async () => {
    const storedMetadata: MemoryMetadata[] = [];
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest
        .fn()
        .mockImplementation(async (_content, _category, metadata) => {
          storedMetadata.push(metadata);
        }),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '测试内容', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(storedMetadata).toHaveLength(1);
    expect(storedMetadata[0].importance).toBe(5);
  });

  it('应该使用指定的重要性评分', async () => {
    const storedMetadata: MemoryMetadata[] = [];
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest
        .fn()
        .mockImplementation(async (_content, _category, metadata) => {
          storedMetadata.push(metadata);
        }),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '重要内容', category: 'fact', importance: 9 },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(storedMetadata[0].importance).toBe(9);
  });

  it('应该将重要性评分限制在1-10范围内', async () => {
    const storedMetadata: MemoryMetadata[] = [];
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest
        .fn()
        .mockImplementation(async (_content, _category, metadata) => {
          storedMetadata.push(metadata);
        }),
    };

    const executor = createMemoryStoreExecutor(deps);

    await executor(
      { content: '过低评分', category: 'fact', importance: -5 },
      mockToolContext
    );
    expect(storedMetadata[0].importance).toBe(1);

    await executor(
      { content: '过高评分', category: 'fact', importance: 20 },
      mockToolContext
    );
    expect(storedMetadata[1].importance).toBe(10);
  });

  it('应该在高重要性(>=7)时输出晋升提示', async () => {
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '高优先级内容', category: 'fact', importance: 8 },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('高优先级');
    expect(result.output).toContain('晋升长期记忆');
  });

  it('应该在低重要性(<7)时不输出晋升提示', async () => {
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '普通内容', category: 'fact', importance: 5 },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('晋升');
  });

  it('应该拒绝空内容', async () => {
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('不能为空');
  });

  it('应该拒绝纯空格内容', async () => {
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '   ', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(false);
  });

  it('应该正确设置元数据字段', async () => {
    const storedMetadata: MemoryMetadata[] = [];
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest
        .fn()
        .mockImplementation(async (_content, _category, metadata) => {
          storedMetadata.push(metadata);
        }),
    };

    const beforeTime = Date.now();
    const executor = createMemoryStoreExecutor(deps);
    await executor(
      { content: '测试', category: 'preference', importance: 7 },
      mockToolContext
    );
    const afterTime = Date.now();

    const meta = storedMetadata[0];
    expect(meta.category).toBe('preference');
    expect(meta.importance).toBe(7);
    expect(meta.accessCount).toBe(0);
    expect(meta.createdAt).toBeGreaterThanOrEqual(beforeTime);
    expect(meta.createdAt).toBeLessThanOrEqual(afterTime);
    expect(meta.lastAccessedAt).toBeGreaterThanOrEqual(beforeTime);
  });
});

describe('isDuplicateContent 去重', () => {
  it('应该检测完全相同的内容', () => {
    expect(isDuplicateContent('用户喜欢喝咖啡', ['用户喜欢喝咖啡'])).toBe(true);
  });

  it('应该检测高相似度内容', () => {
    expect(isDuplicateContent('用户喜欢喝咖啡', ['用户喜欢喝咖啡豆'])).toBe(
      true
    );
  });

  it('应该对不同内容返回false', () => {
    expect(isDuplicateContent('用户喜欢喝咖啡', ['用户是程序员'])).toBe(false);
  });

  it('应该在空已有记忆列表时返回false', () => {
    expect(isDuplicateContent('用户喜欢喝咖啡', [])).toBe(false);
  });

  it('应该对部分匹配但相似度不足的内容返回false', () => {
    expect(isDuplicateContent('今天天气很好', ['明天会下雨'])).toBe(false);
  });

  it('应该检查所有已有记忆', () => {
    const existing = ['用户是程序员', '用户喜欢运动', '用户住在北京'];
    expect(isDuplicateContent('用户住在北京', existing)).toBe(true);
    expect(isDuplicateContent('用户喜欢吃辣', existing)).toBe(false);
  });

  it('应该对空内容返回false', () => {
    expect(isDuplicateContent('', ['用户喜欢喝咖啡'])).toBe(false);
  });

  it('应该对短内容正确判断', () => {
    expect(isDuplicateContent('hi', ['hi'])).toBe(true);
    expect(isDuplicateContent('hi', ['hello'])).toBe(false);
  });
});

describe('memory_store 去重集成', () => {
  it('应该在检测到重复时返回已存在提示', async () => {
    const deps: MemoryStoreDeps = {
      checkDuplicate: jest.fn().mockResolvedValue(true),
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '重复内容', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('已存在相似记忆');
    expect(deps.storeWithMetadata).not.toHaveBeenCalled();
  });

  it('应该在无重复时正常存储', async () => {
    const deps: MemoryStoreDeps = {
      checkDuplicate: jest.fn().mockResolvedValue(false),
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '新内容', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('已存储');
    expect(deps.storeWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('应该在没有 checkDuplicate 依赖时跳过去重检查', async () => {
    const deps: MemoryStoreDeps = {
      storeWithMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '新内容', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('已存储');
  });

  it('应该在无高级依赖时降级到 storeShortTermMemory', async () => {
    const deps: MemoryStoreDeps = {
      storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
    };

    const executor = createMemoryStoreExecutor(deps);
    const result = await executor(
      { content: '简单存储', category: 'fact' },
      mockToolContext
    );

    expect(result.success).toBe(true);
    expect(deps.storeShortTermMemory).toHaveBeenCalledWith('简单存储', 'fact');
  });
});

describe('PersistenceService 记忆晋升', () => {
  let service: PersistenceService;

  beforeEach(() => {
    const mockMemoryEngine = {
      storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
      storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
      storeInstantMemory: jest.fn().mockResolvedValue(undefined),
      preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
      storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
    };

    const deps: PersistenceServiceDeps = {
      memoryEngine: mockMemoryEngine,
    };

    service = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
  });

  it('应该在记忆引擎不可用时返回0', async () => {
    const deps: PersistenceServiceDeps = { memoryEngine: null };
    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();
    expect(count).toBe(0);
  });

  it('应该晋升高重要性(>=7)的短期记忆', async () => {
    const mockMemories: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '重要偏好',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 8,
        accessCount: 1,
      },
      {
        id: 'mem-2',
        content: '普通记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 4,
        accessCount: 1,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockMemories),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(1);
    expect(deps.memoryEngine!.storeLongTermMemory).toHaveBeenCalledWith(
      '重要偏好',
      undefined,
      undefined
    );
    expect(deps.memoryEngine!.storeLongTermMemory).not.toHaveBeenCalledWith(
      '普通记忆',
      undefined,
      undefined
    );
  });

  it('应该晋升频繁访问(accessCount>=3)的短期记忆', async () => {
    const mockMemories: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '频繁访问记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 3,
        accessCount: 5,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockMemories),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(1);
    expect(deps.memoryEngine!.storeLongTermMemory).toHaveBeenCalledWith(
      '频繁访问记忆',
      undefined,
      undefined
    );
  });

  it('不应该晋升长期记忆', async () => {
    const mockMemories: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '已是长期记忆',
        type: 'long_term',
        timestamp: Date.now(),
        importance: 9,
        accessCount: 10,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockMemories),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(0);
    expect(deps.memoryEngine!.storeLongTermMemory).not.toHaveBeenCalled();
  });

  it('不应该晋升低重要性且低访问次数的短期记忆', async () => {
    const mockMemories: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '普通短期记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 3,
        accessCount: 1,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockMemories),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(0);
  });

  it('应该在没有候选记忆时返回0', async () => {
    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(0);
  });

  it('应该晋升多个符合条件的记忆', async () => {
    const mockMemories: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '高重要性记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 8,
        accessCount: 0,
      },
      {
        id: 'mem-2',
        content: '频繁访问记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 2,
        accessCount: 5,
      },
      {
        id: 'mem-3',
        content: '普通记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 3,
        accessCount: 1,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockMemories),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(2);
    expect(deps.memoryEngine!.storeLongTermMemory).toHaveBeenCalledTimes(2);
  });

  it('应该在晋升失败时继续处理其他记忆', async () => {
    const mockMemories: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '会失败的记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 8,
      },
      {
        id: 'mem-2',
        content: '会成功的记忆',
        type: 'short_term',
        timestamp: Date.now(),
        importance: 9,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest
          .fn()
          .mockRejectedValueOnce(new Error('存储失败'))
          .mockResolvedValueOnce(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockMemories),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const count = await svc.promoteMemories();

    expect(count).toBe(1);
  });
});

describe('PersistenceService 记忆检索', () => {
  it('应该在记忆引擎不可用时返回空数组', async () => {
    const deps: PersistenceServiceDeps = { memoryEngine: null };
    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const results = await svc.recallMemory('测试查询');
    expect(results).toEqual([]);
  });

  it('应该调用精确混合检索', async () => {
    const mockResults: MemoryItem[] = [
      {
        id: 'mem-1',
        content: '相关记忆',
        type: 'short_term',
        timestamp: Date.now(),
        relevanceScore: 0.9,
      },
    ];

    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue(mockResults),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const results = await svc.recallMemory('测试查询', {
      limit: 3,
      scene: '日常',
    });

    expect(results).toHaveLength(1);
    expect(deps.memoryEngine!.preciseHybridRetrieval).toHaveBeenCalledWith(
      '测试查询',
      '日常',
      undefined,
      3
    );
  });

  it('应该在检索失败时返回空数组', async () => {
    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest
          .fn()
          .mockRejectedValue(new Error('检索失败')),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const results = await svc.recallMemory('测试查询');

    expect(results).toEqual([]);
  });

  it('应该使用默认 limit=5', async () => {
    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    await svc.recallMemory('测试查询');

    expect(deps.memoryEngine!.preciseHybridRetrieval).toHaveBeenCalledWith(
      '测试查询',
      undefined,
      undefined,
      5
    );
  });
});

describe('PersistenceService 记忆存储', () => {
  it('应该根据类型调用对应的存储方法', async () => {
    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );

    await svc.storeMemory('短期记忆', { type: 'short_term' });
    expect(deps.memoryEngine!.storeShortTermMemory).toHaveBeenCalledWith(
      '短期记忆',
      undefined,
      undefined
    );

    await svc.storeMemory('长期记忆', { type: 'long_term' });
    expect(deps.memoryEngine!.storeLongTermMemory).toHaveBeenCalledWith(
      '长期记忆',
      undefined,
      undefined
    );

    await svc.storeMemory('即时记忆', { type: 'instant' });
    expect(deps.memoryEngine!.storeInstantMemory).toHaveBeenCalledWith(
      '即时记忆',
      undefined,
      undefined
    );
  });

  it('应该默认使用 short_term 类型', async () => {
    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    await svc.storeMemory('默认记忆');

    expect(deps.memoryEngine!.storeShortTermMemory).toHaveBeenCalledWith(
      '默认记忆',
      undefined,
      undefined
    );
  });

  it('应该在记忆引擎不可用时返回空字符串', async () => {
    const deps: PersistenceServiceDeps = { memoryEngine: null };
    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    const result = await svc.storeMemory('测试');
    expect(result).toBe('');
  });

  it('应该传递 scene 和 emotion 参数', async () => {
    const deps: PersistenceServiceDeps = {
      memoryEngine: {
        storeShortTermMemory: jest.fn().mockResolvedValue(undefined),
        storeLongTermMemory: jest.fn().mockResolvedValue(undefined),
        storeInstantMemory: jest.fn().mockResolvedValue(undefined),
        preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
        storeFeedbackSignal: jest.fn().mockResolvedValue(undefined),
      },
    };

    const svc = new PersistenceService(
      deps,
      'c:\\zy\\jiabaixing\\tmp\\test-persistence'
    );
    await svc.storeMemory('带场景记忆', { scene: '工作', emotion: '专注' });

    expect(deps.memoryEngine!.storeShortTermMemory).toHaveBeenCalledWith(
      '带场景记忆',
      '工作',
      '专注'
    );
  });
});

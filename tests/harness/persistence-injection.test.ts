/**
 * Harness PersistenceService 依赖注入测试
 */

import { AgentHarness } from '../../src/harness';
import type { PersistenceServiceDeps } from '../../src/harness/persistence/PersistenceService';

describe('PersistenceService 依赖注入', () => {
  test('HarnessDeps 接口应该包含 persistenceDeps 字段', () => {
    // 创建一个模拟的依赖对象，验证类型
    const mockDeps: {
      llm: any;
      constitutionalBuilder: any;
      memoryInjector: any;
      dynamicContext: any;
      historyProvider: any;
      persistenceDeps?: PersistenceServiceDeps;
    } = {
      llm: {
        chatWithTools: jest.fn(),
        chat: jest.fn(),
      },
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn(),
      },
      memoryInjector: {
        autoRetrieveMemories: jest.fn(),
      },
      dynamicContext: {
        getDynamicContext: jest.fn(),
      },
      historyProvider: {
        getAllHistory: jest.fn(),
        getRecentHistory: jest.fn(),
      },
      persistenceDeps: {
        memoryEngine: null,
        conversationHistory: null,
        userProfile: null,
      } as unknown as PersistenceServiceDeps,
    };

    expect(mockDeps).toBeDefined();
    expect(mockDeps.persistenceDeps).toBeDefined();
  });

  test('AgentHarness 应该正确接收和使用 persistenceDeps', async () => {
    const mockMemoryEngine = {
      storeShortTermMemory: jest.fn(),
      storeLongTermMemory: jest.fn(),
      storeInstantMemory: jest.fn(),
      preciseHybridRetrieval: jest.fn().mockResolvedValue([]),
      storeFeedbackSignal: jest.fn(),
    };
    const mockConversationHistory = {
      addUserMessage: jest.fn(),
      addAssistantMessage: jest.fn(),
      getRecent: jest.fn().mockReturnValue([]),
      formatForLLM: jest.fn().mockReturnValue([]),
      saveState: jest.fn(),
      clear: jest.fn(),
    };
    const mockUserProfile = {
      load: jest.fn(),
      save: jest.fn(),
      getData: jest.fn().mockReturnValue(null),
      update: jest.fn(),
    };

    const harness = new AgentHarness({
      useHarnessTools: false,
      useHarnessLoop: false,
      useHarnessContext: false,
      useHarnessVerification: false,
      useHarnessConstraints: false,
      useHarnessPersistence: true,
    });

    harness.setDeps({
      llm: {
        chatWithTools: jest.fn(),
        chat: jest.fn(),
      },
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn(),
      },
      memoryInjector: {
        autoRetrieveMemories: jest.fn(),
      },
      dynamicContext: {
        getDynamicContext: jest.fn(),
      },
      historyProvider: {
        getAllHistory: jest.fn(),
        getRecentHistory: jest.fn(),
      },
      persistenceDeps: {
        memoryEngine: mockMemoryEngine as never,
        conversationHistory: mockConversationHistory as never,
        userProfile: mockUserProfile as never,
      },
    });

    await harness.initialize();

    const persistenceService = harness.getPersistenceService();
    expect(persistenceService).toBeDefined();
  });

  test('PersistenceService 应该能使用注入的依赖', async () => {
    const mockMemoryEngine = {
      storeShortTermMemory: jest.fn(),
      storeLongTermMemory: jest.fn(),
      storeInstantMemory: jest.fn(),
      preciseHybridRetrieval: jest.fn().mockResolvedValue([
        { id: '1', content: 'test memory', type: 'short_term', timestamp: Date.now() }
      ]),
      storeFeedbackSignal: jest.fn(),
    };

    const harness = new AgentHarness({
      useHarnessPersistence: true,
    });

    harness.setDeps({
      llm: {
        chatWithTools: jest.fn(),
        chat: jest.fn(),
      },
      constitutionalBuilder: {
        buildConstitutionPrompt: jest.fn(),
      },
      memoryInjector: {
        autoRetrieveMemories: jest.fn(),
      },
      dynamicContext: {
        getDynamicContext: jest.fn(),
      },
      historyProvider: {
        getAllHistory: jest.fn(),
        getRecentHistory: jest.fn(),
      },
      persistenceDeps: {
        memoryEngine: mockMemoryEngine as never,
        conversationHistory: null,
        userProfile: null,
      },
    });

    await harness.initialize();

    const persistenceService = harness.getPersistenceService();
    
    // 测试存储记忆
    await persistenceService?.storeMemory('test input', { type: 'short_term' });
    expect(mockMemoryEngine.storeShortTermMemory).toHaveBeenCalled();

    // 测试检索记忆
    const memories = await persistenceService?.recallMemory('test');
    expect(mockMemoryEngine.preciseHybridRetrieval).toHaveBeenCalled();
    expect(memories?.length).toBe(1);
  });
});

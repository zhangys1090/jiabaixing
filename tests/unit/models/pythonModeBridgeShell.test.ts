/**
 * python 模式多模型桥壳化运行时验证（P2-3 C）
 *
 * 目标：证明在 AGENT_BACKEND=python 模式下，TS 侧所有可能实例化本地 LLM 客户端
 * （OpenAICompatibleModel）的路径，都会改为返回 PythonBackedModel（经 PythonAgentBridge
 * 委派），从而彻底消除 TS 独立运行 Agent 核心 LLM 的可能（AGENTS.md §0.1）。
 *
 * 通过 mock getActivePythonBridge 切换 python / local 两种模式来验证门控正确性。
 */

// 可变桥实例：mock 工厂在调用时读取，便于按用例切换 python/local 模式
const fakeBridge: any = {
  llmChat: jest.fn().mockResolvedValue('ok'),
  llmChatWithTools: jest.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }),
  llmGetModelName: jest.fn().mockResolvedValue('python-backend'),
  getEvolutionMetrics: jest.fn().mockResolvedValue({}),
  triggerEvolution: jest.fn().mockResolvedValue(undefined),
  submitFeedback: jest.fn().mockResolvedValue(undefined),
};

let activeBridge: any = fakeBridge;

jest.mock('../../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: () => activeBridge,
}));

import { PythonBackedModel } from '../../../src/models/PythonBackedModel';
import { OpenAICompatibleModel } from '../../../src/models/OpenAICompatibleModel';
import { MultiModelProvider } from '../../../src/models/MultiModelProvider';
import { ModelManager } from '../../../src/models/ModelManager';
import { MultiModelLLMProviderBridge } from '../../../src/models/MultiModelLLMProviderBridge';
import { ModelFactory } from '../../../src/core/ModelInterface';

const sampleProvider = {
  name: 'test-provider',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:9999/v1',
  apiKey: 'test-key',
  extra: {},
};

beforeEach(() => {
  activeBridge = fakeBridge; // 默认 python 模式
  MultiModelLLMProviderBridge.reset();
});

describe('P2-3 C: python 模式桥壳化（不实例化本地 LLM 客户端）', () => {
  it('ModelFactory.createModel 在 python 模式返回 PythonBackedModel', () => {
    const model = ModelFactory.createModel('openai_compatible', {
      modelName: 'test-model',
    });
    expect(model).toBeInstanceOf(PythonBackedModel);
    expect(model).not.toBeInstanceOf(OpenAICompatibleModel);
  });

  it('MultiModelProvider.createModel 在 python 模式返回 PythonBackedModel', () => {
    const provider = new MultiModelProvider();
    const model = (provider as any).createModel(sampleProvider);
    expect(model).toBeInstanceOf(PythonBackedModel);
    expect(model).not.toBeInstanceOf(OpenAICompatibleModel);
  });

  it('MultiModelLLMProviderBridge.registerModel 在 python 模式注册 PythonBackedModel', async () => {
    const bridge = MultiModelLLMProviderBridge.getInstance();
    await bridge.initialize();
    await bridge.registerModel(
      'test',
      'test-model',
      { name: 'test-model', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'k' },
      {
        visionScore: 1,
        codingScore: 1,
        reasoningScore: 1,
        speedScore: 1,
        contextLength: 1,
        features: [],
      },
      10
    );
    const registered = bridge.listModels()[0];
    expect(registered).toBeDefined();
    expect(registered.model).toBeInstanceOf(PythonBackedModel);
    expect(registered.model).not.toBeInstanceOf(OpenAICompatibleModel);
  });

  it('ModelManager.initialize 在 python 模式默认模型为 PythonBackedModel', async () => {
    const mm = new ModelManager();
    await mm.initialize();
    const def = mm.getDefaultModel();
    expect(def).not.toBeNull();
    expect(def).toBeInstanceOf(PythonBackedModel);
    expect(def).not.toBeInstanceOf(OpenAICompatibleModel);
  });
});

describe('P2-3 C: local 模式回退（仍实例化本地 LLM 客户端）', () => {
  beforeEach(() => {
    activeBridge = null; // local 模式
  });

  it('ModelFactory.createModel 在 local 模式返回 OpenAICompatibleModel', () => {
    const model = ModelFactory.createModel('openai_compatible', {
      modelName: 'test-model',
    });
    expect(model).toBeInstanceOf(OpenAICompatibleModel);
    expect(model).not.toBeInstanceOf(PythonBackedModel);
  });

  it('MultiModelProvider.createModel 在 local 模式返回 OpenAICompatibleModel', () => {
    const provider = new MultiModelProvider();
    const model = (provider as any).createModel(sampleProvider);
    expect(model).toBeInstanceOf(OpenAICompatibleModel);
    expect(model).not.toBeInstanceOf(PythonBackedModel);
  });
});

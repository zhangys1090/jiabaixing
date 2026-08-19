/**
 * JiabaixingCore.treeOfThoughtReasoning 单元测试
 * 覆盖：多路径生成、LLM 评估、最佳路径选择、异常处理、参数契约
 *
 * 注意：本测试不依赖真实 LLM API，所有 LLM 调用通过 jest.mock 模拟。
 */

// ── Mocks must be before imports ──

const mockLLMChat = jest.fn();
const mockLLMInitialize = jest.fn().mockResolvedValue(undefined);
const mockLLMHealthCheck = jest.fn().mockResolvedValue({ available: true, message: 'ok' });

jest.mock('../../../src/models/LLMProvider', () => ({
  LLMProvider: jest.fn().mockImplementation(() => ({
    initialize: mockLLMInitialize,
    healthCheck: mockLLMHealthCheck,
    chat: mockLLMChat,
    isAvailable: jest.fn().mockReturnValue(true),
    markLocalUnavailable: jest.fn(),
  })),
}));

const mockPersonaApply = jest.fn((content: string) => content);
const mockPersonaBuildPrompt = jest.fn().mockReturnValue('test system prompt');
const mockPersonaCheckRedlines = jest.fn().mockReturnValue(false);

jest.mock('../../../src/persona/PersonaCore', () => ({
  PersonaCore: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    getPersona: jest.fn().mockReturnValue({}),
  })),
}));

jest.mock('../../../src/persona/PersonaRules', () => ({
  PersonaRules: jest.fn().mockImplementation(() => ({
    applyRules: mockPersonaApply,
    buildSystemPrompt: mockPersonaBuildPrompt,
    checkSecurityRedlines: mockPersonaCheckRedlines,
    initialize: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../src/monitoring/PerformanceMonitor', () => ({
  PerformanceMonitor: {
    getInstance: jest.fn().mockReturnValue({
      record: jest.fn(),
      measure: jest.fn(),
      start: jest.fn(),
      end: jest.fn(),
    }),
  },
}));

jest.mock('../../../src/monitoring/SecurityAuditor', () => ({
  SecurityAuditor: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    audit: jest.fn(),
  })),
}));

jest.mock('../../../src/evolution/EvolutionOrchestrator', () => ({
  EvolutionOrchestrator: {
    getInstance: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('../../../src/evolution/FeedbackCollector', () => ({
  FeedbackCollector: jest.fn().mockImplementation(() => ({
    collect: jest.fn(),
  })),
}));

jest.mock('../../../src/training/TrajectoryExporter', () => ({
  TrajectoryExporter: jest.fn().mockImplementation(() => ({
    export: jest.fn(),
  })),
  ExportFormat: {},
}));

jest.mock('../../../src/core/ConstitutionPromptBuilder', () => ({
  ConstitutionPromptBuilder: jest.fn().mockImplementation(() => ({
    build: jest.fn().mockReturnValue(''),
  })),
}));

jest.mock('../../../src/core/ConversationHistoryManager', () => ({
  ConversationHistoryManager: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../src/core/MemoryAssistant', () => ({
  MemoryAssistant: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../src/core/OptimizationScheduler', () => ({
  OptimizationScheduler: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../src/core/ScenarioAwareScheduler', () => ({
  ScenarioAwareScheduler: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../src/core/StreamResponseService', () => ({
  StreamResponseService: jest.fn().mockImplementation(() => ({
    stream: jest.fn(),
  })),
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    generateTraceId: jest.fn().mockReturnValue('test-trace-id'),
    setTraceId: jest.fn(),
    clearTraceId: jest.fn(),
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  watchFile: jest.fn(),
}));

import { JiabaixingCore } from '../../../src/core/JiabaixingCore';

/**
 * 构造扩展响应：根据 branchCount 生成对应数量的 THOUGHT_N 行。
 */
function buildExpansionResponse(thoughts: string[]): string {
  return thoughts
    .map((t, i) => `THOUGHT_${i + 1}: ${t}`)
    .join('\n');
}

/**
 * 构造评估响应：仅返回一个数字分数（0-10）。
 */
function buildEvaluationResponse(score: number): string {
  return `分数: ${score}`;
}

describe('JiabaixingCore — treeOfThoughtReasoning', () => {
  let core: JiabaixingCore;

  beforeEach(() => {
    jest.clearAllMocks();
    core = new JiabaixingCore();
  });

  // ═══════════════════════════════════════════════════
  // 输入输出契约
  // ═══════════════════════════════════════════════════
  describe('输入输出契约', () => {
    it('返回包含 answer/reasoningPaths/bestPath/evaluations 的对象', async () => {
      // 扩展调用返回 1 个 thought，评估返回分数
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['方向A']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(7));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('测试问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      expect(result).toHaveProperty('answer');
      expect(result).toHaveProperty('reasoningPaths');
      expect(result).toHaveProperty('bestPath');
      expect(result).toHaveProperty('evaluations');
      expect(typeof result.answer).toBe('string');
      expect(Array.isArray(result.reasoningPaths)).toBe(true);
      expect(Array.isArray(result.bestPath)).toBe(true);
      expect(Array.isArray(result.evaluations)).toBe(true);
    });

    it('默认参数生效（maxDepth=3, branchCount=3, evaluationTopK=2）', async () => {
      // 不传 options，验证默认值不会导致异常
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['A', 'B', 'C']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(5));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('默认参数问题');
      // root 至少被展开
      expect(result.reasoningPaths.length).toBeGreaterThanOrEqual(1);
      // 默认 branchCount=3，应解析出 3 个候选
      expect(mockLLMChat).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════
  // 多路径生成
  // ═══════════════════════════════════════════════════
  describe('多路径生成', () => {
    it('LLM 返回多个候选时解析为多个 thought', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(
            buildExpansionResponse(['方向一', '方向二', '方向三'])
          );
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(6));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('多路径问题', {
        maxDepth: 1,
        branchCount: 3,
        evaluationTopK: 3,
      });

      // root + 3 个子节点（topK=3 全部保留，depth=1 不再展开）
      expect(result.reasoningPaths.length).toBe(4);
      // 3 个子节点的 thought 应当都被解析
      const childThoughts = result.reasoningPaths
        .filter((n) => n.depth === 1)
        .map((n) => n.thought);
      expect(childThoughts).toContain('方向一');
      expect(childThoughts).toContain('方向二');
      expect(childThoughts).toContain('方向三');
    });

    it('branchCount 限制扩展时生成的候选数量', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          // prompt 中包含 branchCount，验证提示词携带了正确的数量
          expect(prompt).toContain('2');
          return Promise.resolve(
            buildExpansionResponse(['方向A', '方向B'])
          );
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(5));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('限制分支数', {
        maxDepth: 1,
        branchCount: 2,
        evaluationTopK: 2,
      });

      // root + 2 个子节点
      const depth1Nodes = result.reasoningPaths.filter((n) => n.depth === 1);
      expect(depth1Nodes.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════
  // LLM 评估
  // ═══════════════════════════════════════════════════
  describe('LLM 评估', () => {
    it('评估分数被正确解析并赋值到节点', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['高分方向']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          // 返回 8 分，应归一化为 0.8
          return Promise.resolve(buildEvaluationResponse(8));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('评估问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      const evaluatedNode = result.reasoningPaths.find((n) => n.depth === 1);
      expect(evaluatedNode).toBeDefined();
      expect(evaluatedNode!.score).toBeCloseTo(0.8, 5);
      // evaluations 数组应包含评分条目
      expect(result.evaluations.length).toBeGreaterThan(0);
      const evalEntry = result.evaluations.find((e) => e.score === 0.8);
      expect(evalEntry).toBeDefined();
    });

    it('评估分数超过 10 时被截断到 1.0', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['超分方向']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(15));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('超分问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      const evaluatedNode = result.reasoningPaths.find((n) => n.depth === 1);
      expect(evaluatedNode!.score).toBe(1.0);
    });

    it('评估响应无数字时回退到默认分数 0.5', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['默认分方向']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve('无法评估，没有数字');
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('默认分问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      const evaluatedNode = result.reasoningPaths.find((n) => n.depth === 1);
      expect(evaluatedNode!.score).toBe(0.5);
    });

    it('evaluationTopK 仅保留评分最高的 K 个候选', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(
            buildExpansionResponse(['低分', '中分', '高分'])
          );
        }
        if (prompt.includes('评估以下推理步骤')) {
          // 根据被评估的 thought 返回不同分数
          if (prompt.includes('低分')) return Promise.resolve(buildEvaluationResponse(2));
          if (prompt.includes('中分')) return Promise.resolve(buildEvaluationResponse(5));
          if (prompt.includes('高分')) return Promise.resolve(buildEvaluationResponse(9));
          return Promise.resolve(buildEvaluationResponse(0));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('topK 问题', {
        maxDepth: 1,
        branchCount: 3,
        evaluationTopK: 2,
      });

      // root + topK=2 个子节点（高分、中分）
      const depth1Nodes = result.reasoningPaths.filter((n) => n.depth === 1);
      expect(depth1Nodes.length).toBe(2);
      const childThoughts = depth1Nodes.map((n) => n.thought);
      expect(childThoughts).toContain('高分');
      expect(childThoughts).toContain('中分');
      expect(childThoughts).not.toContain('低分');
    });
  });

  // ═══════════════════════════════════════════════════
  // 最佳路径选择
  // ═══════════════════════════════════════════════════
  describe('最佳路径选择', () => {
    it('选择平均分最高的路径作为 bestPath', async () => {
      // 构造两条路径：一条高分、一条低分
      let callCount = 0;
      const expansionResponses = [
        buildExpansionResponse(['高分路径', '低分路径']),
        buildExpansionResponse(['高分叶子']),
        buildExpansionResponse(['低分叶子']),
      ];
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          const resp = expansionResponses[callCount] ?? '';
          callCount++;
          return Promise.resolve(resp);
        }
        if (prompt.includes('评估以下推理步骤')) {
          if (prompt.includes('高分')) return Promise.resolve(buildEvaluationResponse(9));
          if (prompt.includes('低分')) return Promise.resolve(buildEvaluationResponse(1));
          return Promise.resolve(buildEvaluationResponse(5));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('最佳路径问题', {
        maxDepth: 2,
        branchCount: 2,
        evaluationTopK: 1,
      });

      // bestPath 应当从高分路径走
      expect(result.bestPath.length).toBeGreaterThan(0);
      const bestThoughts = result.bestPath.map((n) => n.thought);
      // 最佳路径应包含"高分"相关节点
      const hasHighScore = bestThoughts.some((t) => t.includes('高分'));
      expect(hasHighScore).toBe(true);
    });

    it('answer 取 bestPath 末端节点的 thought', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['末端答案']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(7));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('答案问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      // bestPath 末端节点的 thought 应当成为 answer
      const lastNode = result.bestPath[result.bestPath.length - 1];
      expect(result.answer).toBe(lastNode.thought);
    });
  });

  // ═══════════════════════════════════════════════════
  // 异常情况
  // ═══════════════════════════════════════════════════
  describe('异常处理', () => {
    it('LLM 扩展调用失败时不抛异常，返回仅含 root 的降级结果', async () => {
      mockLLMChat.mockRejectedValue(new Error('LLM 服务不可用'));

      const result = await core.treeOfThoughtReasoning('异常问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      // 不应抛异常：root 无子节点，bestPath 退化为仅含 root
      expect(result.reasoningPaths.length).toBe(1);
      expect(result.reasoningPaths[0].id).toBe('root');
      expect(result.reasoningPaths[0].children.length).toBe(0);
      // root 单节点构成一条路径，bestPath.length === 1，answer 取 root.thought
      expect(result.bestPath.length).toBe(1);
      expect(result.bestPath[0].id).toBe('root');
      expect(result.answer).toBe('异常问题');
    });

    it('LLM 返回空字符串时优雅处理', async () => {
      mockLLMChat.mockResolvedValue('');

      const result = await core.treeOfThoughtReasoning('空响应问题', {
        maxDepth: 1,
        branchCount: 3,
        evaluationTopK: 2,
      });

      // 无子节点，root 独存；bestPath 退化为仅含 root
      expect(result.reasoningPaths.length).toBe(1);
      expect(result.reasoningPaths[0].children.length).toBe(0);
      expect(result.bestPath.length).toBe(1);
      expect(result.bestPath[0].id).toBe('root');
      expect(result.answer).toBe('空响应问题');
    });

    it('LLM 返回不含 THOUGHT_ 前缀时回退到行解析', async () => {
      // 模拟 LLM 不按格式返回，但有多行内容（>10 字符）
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve('这是第一个推理方向，内容较长\n这是第二个推理方向，也很长');
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(5));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('回退解析问题', {
        maxDepth: 1,
        branchCount: 2,
        evaluationTopK: 2,
      });

      // 应回退到按行解析，生成 2 个子节点
      const depth1Nodes = result.reasoningPaths.filter((n) => n.depth === 1);
      expect(depth1Nodes.length).toBe(2);
    });

    it('评估阶段 LLM 失败时整体不抛异常', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['候选A']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          throw new Error('评估失败');
        }
        return Promise.resolve('');
      });

      // 整体不应抛异常（expandToTNode 内 try-catch 兜底）
      await expect(
        core.treeOfThoughtReasoning('评估失败问题', {
          maxDepth: 1,
          branchCount: 1,
          evaluationTopK: 1,
        })
      ).resolves.toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════
  // 深度限制
  // ═══════════════════════════════════════════════════
  describe('深度限制', () => {
    it('maxDepth=0 时 root 不被展开', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['不应出现']));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('零深度问题', {
        maxDepth: 0,
        branchCount: 3,
        evaluationTopK: 2,
      });

      // 仅 root，无子节点
      expect(result.reasoningPaths.length).toBe(1);
      expect(result.reasoningPaths[0].id).toBe('root');
      expect(result.reasoningPaths[0].children.length).toBe(0);
      // 不应调用 LLM 扩展
      expect(mockLLMChat).not.toHaveBeenCalled();
    });

    it('maxDepth=2 时展开到第二层', async () => {
      let expandCalls = 0;
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          expandCalls++;
          return Promise.resolve(buildExpansionResponse([`节点_深度${expandCalls}`]));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(5));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('两深度问题', {
        maxDepth: 2,
        branchCount: 1,
        evaluationTopK: 1,
      });

      // 应当存在 depth=2 的节点
      const depth2Nodes = result.reasoningPaths.filter((n) => n.depth === 2);
      expect(depth2Nodes.length).toBe(1);
      // 应当存在 depth=1 的节点
      const depth1Nodes = result.reasoningPaths.filter((n) => n.depth === 1);
      expect(depth1Nodes.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════
  // ToTNode 结构验证
  // ═══════════════════════════════════════════════════
  describe('ToTNode 结构', () => {
    it('子节点 parentId 指向父节点 id', async () => {
      mockLLMChat.mockImplementation((prompt: string) => {
        if (prompt.includes('生成') && prompt.includes('推理方向')) {
          return Promise.resolve(buildExpansionResponse(['子方向']));
        }
        if (prompt.includes('评估以下推理步骤')) {
          return Promise.resolve(buildEvaluationResponse(6));
        }
        return Promise.resolve('');
      });

      const result = await core.treeOfThoughtReasoning('结构问题', {
        maxDepth: 1,
        branchCount: 1,
        evaluationTopK: 1,
      });

      const child = result.reasoningPaths.find((n) => n.depth === 1);
      expect(child).toBeDefined();
      expect(child!.parentId).toBe('root');
      expect(child!.depth).toBe(1);
      expect(child!.children).toEqual([]);
    });

    it('root 节点 id 为 root 且 depth 为 0', async () => {
      mockLLMChat.mockResolvedValue('');

      const result = await core.treeOfThoughtReasoning('root 验证', {
        maxDepth: 1,
      });

      const root = result.reasoningPaths[0];
      expect(root.id).toBe('root');
      expect(root.depth).toBe(0);
      expect(root.thought).toBe('root 验证');
    });
  });
});

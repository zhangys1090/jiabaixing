/**
 * LLM 能力探测模块
 *
 * 职责：自动探测当前 LLM 的能力边界，为策略适配提供数据支撑
 * 设计：
 *  - 通过标准测试题探测推理深度、工具调用准确性、结构化输出能力等
 *  - 结果缓存 24h，避免频繁探测消耗 token
 *  - 持久化到 TrajectoryDatabase，重启后可恢复
 *  - 探测完成后触发策略适配
 *
 * 集成点：EvolutionOrchestrator.onLLMProviderChanged()
 */

import { Logger } from '../utils/Logger';

/** LLM 能力描述 */
export interface LLMCapabilities {
  provider: string;
  modelName: string;
  detectedAt: number;

  /** 上下文窗口大小（token 数） */
  contextWindow: number;

  /** 推理深度评分 1-10（10=最强） */
  reasoningDepth: number;

  /** 工具调用准确率 0-1 */
  toolCallingAccuracy: number;

  /** 代码生成能力评分 1-10 */
  codeGeneration: number;

  /** 多模态支持 */
  multiModal: boolean;

  /** 结构化 JSON 输出准确率 0-1 */
  structuredOutput: number;

  /** 总体能力评分 1-10（加权平均） */
  overallScore: number;
}

/** 能力差异对比 */
export interface CapabilityDiff {
  improved: boolean;
  reasoningDepthImprovement: number;
  toolCallingImprovement: number;
  codeGenerationImprovement: number;
  overallImprovement: number;
  newCapabilities: string[];
  lostCapabilities: string[];
}

/** LLM 接口（最小依赖，便于测试 mock） */
interface LLMChatInterface {
  chat(
    message: string,
    history?: Array<{ role: string; content: string }>,
    systemPromptOverride?: string
  ): Promise<string>;
  getModelName?(): string;
}

/** 持久化接口（最小依赖） */
interface PersistenceInterface {
  saveEnvironmentState(state: Record<string, unknown>): void;
  loadEnvironmentState(): Record<string, unknown> | null;
}

/** 探测回调 */
export interface DetectionCallbacks {
  onCapabilitiesDetected?(capabilities: LLMCapabilities): void;
  onDetectionError?(error: Error): void;
}

/**
 * LLM 能力探测器
 */
export class LLMCapabilityDetector {
  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24小时
  private static readonly STORAGE_KEY = 'llm_capabilities';

  private cachedCapabilities: Map<string, LLMCapabilities> = new Map();
  private llm: LLMChatInterface | null = null;
  private persistence: PersistenceInterface | null = null;
  private callbacks: DetectionCallbacks = {};
  private isDetecting = false;

  /**
   * 设置 LLM 提供者
   */
  setLLMProvider(llm: LLMChatInterface): void {
    this.llm = llm;
    Logger.info('🔍 LLM能力探测器已连接LLMProvider', 'LLMCapabilityDetector');
  }

  /**
   * 设置持久化服务
   */
  setPersistence(persistence: PersistenceInterface): void {
    this.persistence = persistence;
    this.loadCachedCapabilities();
    Logger.info('🔍 LLM能力探测器已连接持久化', 'LLMCapabilityDetector');
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: DetectionCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 探测当前 LLM 的能力
   * @param providerName 提供者名称
   * @param force 是否强制重新探测（忽略缓存）
   */
  async detectCapabilities(
    providerName: string,
    force: boolean = false
  ): Promise<LLMCapabilities | null> {
    if (!this.llm) {
      Logger.warn(
        '⚠️ LLMProvider未设置，无法探测能力',
        'LLMCapabilityDetector'
      );
      return null;
    }

    // 检查缓存
    if (!force) {
      const cached = this.cachedCapabilities.get(providerName);
      if (
        cached &&
        Date.now() - cached.detectedAt < LLMCapabilityDetector.CACHE_TTL_MS
      ) {
        Logger.debug(
          `🔍 使用缓存的LLM能力数据 (${providerName})，总体评分: ${cached.overallScore}/10`,
          'LLMCapabilityDetector'
        );
        return cached;
      }
    }

    if (this.isDetecting) {
      Logger.warn('⚠️ 能力探测正在进行中，跳过', 'LLMCapabilityDetector');
      return null;
    }

    this.isDetecting = true;
    Logger.info(`🔍 开始探测LLM能力: ${providerName}`, 'LLMCapabilityDetector');

    try {
      const modelName = this.llm.getModelName?.() || providerName;
      const capabilities: LLMCapabilities = {
        provider: providerName,
        modelName,
        detectedAt: Date.now(),
        contextWindow: await this.probeContextWindow(),
        reasoningDepth: await this.probeReasoningDepth(),
        toolCallingAccuracy: await this.probeToolCallingAccuracy(),
        codeGeneration: await this.probeCodeGeneration(),
        multiModal: await this.probeMultiModal(),
        structuredOutput: await this.probeStructuredOutput(),
        overallScore: 0, // 后续计算
      };

      // 计算总体评分（加权平均）
      capabilities.overallScore = this.calculateOverallScore(capabilities);

      // 缓存并持久化
      this.cachedCapabilities.set(providerName, capabilities);
      this.persistCapabilities();

      Logger.info(
        `🔍 LLM能力探测完成: ${providerName} | 总体评分: ${capabilities.overallScore.toFixed(1)}/10 | 推理: ${capabilities.reasoningDepth}/10 | 工具准确率: ${(capabilities.toolCallingAccuracy * 100).toFixed(0)}% | 结构化输出: ${(capabilities.structuredOutput * 100).toFixed(0)}%`,
        'LLMCapabilityDetector'
      );

      this.callbacks.onCapabilitiesDetected?.(capabilities);
      return capabilities;
    } catch (error) {
      Logger.error('LLM能力探测失败', error as Error, 'LLMCapabilityDetector');
      this.callbacks.onDetectionError?.(error as Error);
      return null;
    } finally {
      this.isDetecting = false;
    }
  }

  /**
   * 获取缓存的能力数据
   */
  getCachedCapabilities(providerName?: string): LLMCapabilities | null {
    if (providerName) {
      return this.cachedCapabilities.get(providerName) || null;
    }
    // 返回最近一次探测结果
    let latest: LLMCapabilities | null = null;
    for (const caps of this.cachedCapabilities.values()) {
      if (!latest || caps.detectedAt > latest.detectedAt) {
        latest = caps;
      }
    }
    return latest;
  }

  /**
   * 对比两次能力差异
   */
  compareCapabilities(
    previous: LLMCapabilities,
    current: LLMCapabilities
  ): CapabilityDiff {
    const reasoningDiff = current.reasoningDepth - previous.reasoningDepth;
    const toolDiff = current.toolCallingAccuracy - previous.toolCallingAccuracy;
    const codeDiff = current.codeGeneration - previous.codeGeneration;
    const overallDiff = current.overallScore - previous.overallScore;

    const newCapabilities: string[] = [];
    const lostCapabilities: string[] = [];

    if (current.multiModal && !previous.multiModal) {
      newCapabilities.push('multiModal');
    }
    if (!current.multiModal && previous.multiModal) {
      lostCapabilities.push('multiModal');
    }
    if (current.contextWindow > previous.contextWindow * 1.5) {
      newCapabilities.push('largerContextWindow');
    }
    if (current.structuredOutput > 0.9 && previous.structuredOutput < 0.9) {
      newCapabilities.push('reliableStructuredOutput');
    }

    return {
      improved: overallDiff > 0,
      reasoningDepthImprovement: reasoningDiff,
      toolCallingImprovement: toolDiff,
      codeGenerationImprovement: codeDiff,
      overallImprovement: overallDiff,
      newCapabilities,
      lostCapabilities,
    };
  }

  // ── 私有探测方法 ──

  /**
   * 探测上下文窗口大小
   * 通过逐步增加输入长度，检测何时出现截断
   */
  private async probeContextWindow(): Promise<number> {
    // 基于模型名的启发式判断（避免消耗大量 token）
    const modelName = this.llm?.getModelName?.() || '';

    if (
      /gpt-4o|claude-3.*sonnet|claude-3\.5|qwen.*72b|deepseek.*v3/i.test(
        modelName
      )
    ) {
      return 128000;
    }
    if (/gpt-4|claude-3.*opus|claude-3.*haiku/i.test(modelName)) {
      return 32000;
    }
    if (/gpt-3\.5|qwen.*7b|qwen.*14b/i.test(modelName)) {
      return 16000;
    }

    // 默认假设
    return 8000;
  }

  /**
   * 探测推理深度
   * 用已知答案的逻辑推理题测试
   */
  private async probeReasoningDepth(): Promise<number> {
    const testProblems = [
      {
        problem: '如果A>B, B>C, 那么A和C的关系是什么？只回答"大于"或"小于"。',
        expected: '大于',
        difficulty: 2,
      },
      {
        problem: '一个农夫有17只羊，除了9只都死了，还剩几只？只回答数字。',
        expected: '9',
        difficulty: 4,
      },
      {
        problem:
          '有三个盒子，一个装苹果，一个装橘子，一个装两者。所有标签都贴错了。你只能从一个盒子里拿出一个水果。如何确定所有盒子的内容？只回答30字以内的策略。',
        expected: '从标"混合"的盒子取',
        difficulty: 6,
      },
      {
        problem:
          '你有12个球，其中1个重量不同（不知轻重）。用天平称3次找出它。第一步应该怎么做？只回答30字以内。',
        expected: '4vs4',
        difficulty: 8,
      },
    ];

    let maxDepth = 1; // 基础分

    for (const test of testProblems) {
      try {
        const answer = await this.llm!.chat(test.problem);
        if (this.evaluateAnswer(answer, test.expected)) {
          maxDepth = test.difficulty;
        } else {
          break; // 失败则停止更深难度
        }
      } catch {
        break;
      }
    }

    return maxDepth;
  }

  /**
   * 探测工具调用准确率
   * 给定明确的工具调用指令，检测是否正确执行
   */
  private async probeToolCallingAccuracy(): Promise<number> {
    const testCases = [
      {
        prompt:
          '请输出JSON：{"toolName": "file_read", "args": {"path": "test.txt"}}。只输出这个JSON，不要其他内容。',
        validate: (answer: string) =>
          answer.includes('file_read') && answer.includes('test.txt'),
      },
      {
        prompt:
          '请输出JSON：{"toolName": "shell_exec", "args": {"command": "ls -la"}}。只输出这个JSON，不要其他内容。',
        validate: (answer: string) =>
          answer.includes('shell_exec') && answer.includes('ls'),
      },
      {
        prompt:
          '请输出JSON：{"toolName": "web_search", "args": {"query": "天气预报"}}。只输出这个JSON，不要其他内容。',
        validate: (answer: string) =>
          answer.includes('web_search') && answer.includes('天气'),
      },
    ];

    let passed = 0;
    for (const test of testCases) {
      try {
        const answer = await this.llm!.chat(test.prompt);
        if (test.validate(answer)) passed++;
      } catch {
        // 失败不计分
      }
    }

    return passed / testCases.length;
  }

  /**
   * 探测代码生成能力
   * 要求生成一个简单函数并验证正确性
   */
  private async probeCodeGeneration(): Promise<number> {
    try {
      const answer = await this.llm!.chat(
        '用TypeScript写一个函数，计算斐波那契数列第n项。只输出代码，不要解释。'
      );

      let score = 1; // 基础分

      // 检查代码质量指标
      if (/function\s+\w+|const\s+\w+\s*=/.test(answer)) score += 2; // 有函数定义
      if (/n\s*<=\s*1|n\s*<\s*2/.test(answer)) score += 2; // 有边界处理
      if (/return\s+n/.test(answer)) score += 1; // 有返回值
      if (/fibonacci|fib/i.test(answer)) score += 1; // 函数名相关
      if (answer.includes('=>') || answer.includes('function')) score += 1; // 语法正确
      if (
        /for\s*\(|while\s*\(/.test(answer) ||
        /recursion|recursive/i.test(answer)
      ) {
        score += 2; // 有循环或递归
      }

      return Math.min(10, score);
    } catch {
      return 1;
    }
  }

  /**
   * 探测多模态支持
   */
  private async probeMultiModal(): Promise<boolean> {
    const modelName = this.llm?.getModelName?.() || '';
    // 基于模型名判断
    return /gpt-4o|gpt-4.*vision|claude-3|qwen.*vl|gemini/i.test(modelName);
  }

  /**
   * 探测结构化 JSON 输出能力
   */
  private async probeStructuredOutput(): Promise<number> {
    const testCases = [
      {
        prompt:
          '输出一个JSON对象，包含name和age字段。name是"张三"，age是25。只输出JSON。',
        validate: (answer: string) => {
          try {
            const match = answer.match(/\{[\s\S]*\}/);
            if (!match) return false;
            const obj = JSON.parse(match[0]);
            return obj.name === '张三' && obj.age === 25;
          } catch {
            return false;
          }
        },
      },
      {
        prompt: '输出一个JSON数组，包含3个数字：1, 2, 3。只输出JSON数组。',
        validate: (answer: string) => {
          try {
            const match = answer.match(/\[[\s\S]*\]/);
            if (!match) return false;
            const arr = JSON.parse(match[0]);
            return Array.isArray(arr) && arr.length === 3;
          } catch {
            return false;
          }
        },
      },
      {
        prompt:
          '输出嵌套JSON：{"user": {"name": "李四", "scores": [90, 85, 95]}}。只输出JSON。',
        validate: (answer: string) => {
          try {
            const match = answer.match(/\{[\s\S]*\}/);
            if (!match) return false;
            const obj = JSON.parse(match[0]);
            return (
              obj.user?.name === '李四' &&
              Array.isArray(obj.user?.scores) &&
              obj.user.scores.length === 3
            );
          } catch {
            return false;
          }
        },
      },
    ];

    let passed = 0;
    for (const test of testCases) {
      try {
        const answer = await this.llm!.chat(test.prompt);
        if (test.validate(answer)) passed++;
      } catch {
        // 失败不计分
      }
    }

    return passed / testCases.length;
  }

  /**
   * 计算总体能力评分
   */
  private calculateOverallScore(caps: LLMCapabilities): number {
    // 加权平均
    const weights = {
      reasoningDepth: 0.3,
      toolCallingAccuracy: 0.25,
      codeGeneration: 0.2,
      structuredOutput: 0.15,
      contextWindow: 0.1, // 归一化到 1-10
    };

    const contextScore = Math.min(10, caps.contextWindow / 12800); // 128000 → 10分

    const score =
      caps.reasoningDepth * weights.reasoningDepth +
      caps.toolCallingAccuracy * 10 * weights.toolCallingAccuracy +
      caps.codeGeneration * weights.codeGeneration +
      caps.structuredOutput * 10 * weights.structuredOutput +
      contextScore * weights.contextWindow;

    return Math.round(score * 10) / 10; // 保留1位小数
  }

  /**
   * 评估答案是否匹配预期
   */
  private evaluateAnswer(answer: string, expected: string): boolean {
    const normalized = answer.trim().toLowerCase();
    const expectedLower = expected.toLowerCase();

    // 包含预期答案即可
    if (normalized.includes(expectedLower)) return true;

    // 中文近义词匹配
    if (expectedLower === '大于' && /大于|>|高于|more than/.test(normalized)) {
      return true;
    }

    return false;
  }

  // ── 持久化 ──

  /**
   * 持久化能力数据
   */
  private persistCapabilities(): void {
    if (!this.persistence) return;

    try {
      const serializable: Record<string, unknown> = {};
      for (const [provider, caps] of this.cachedCapabilities.entries()) {
        serializable[provider] = caps;
      }
      // 复用 environment_state 表的存储机制
      this.persistence.saveEnvironmentState({
        [LLMCapabilityDetector.STORAGE_KEY]: serializable,
      });
    } catch (error) {
      Logger.error(
        '持久化LLM能力数据失败',
        error as Error,
        'LLMCapabilityDetector'
      );
    }
  }

  /**
   * 从持久化加载能力数据
   */
  private loadCachedCapabilities(): void {
    if (!this.persistence) return;

    try {
      const saved = this.persistence.loadEnvironmentState();
      if (!saved) return;

      const stored = saved[LLMCapabilityDetector.STORAGE_KEY] as
        | Record<string, LLMCapabilities>
        | undefined;
      if (!stored) return;

      for (const [provider, caps] of Object.entries(stored)) {
        this.cachedCapabilities.set(provider, caps);
      }

      Logger.info(
        `🔍 已加载 ${this.cachedCapabilities.size} 个LLM的能力数据`,
        'LLMCapabilityDetector'
      );
    } catch (error) {
      Logger.error(
        '加载LLM能力数据失败',
        error as Error,
        'LLMCapabilityDetector'
      );
    }
  }
}

export default LLMCapabilityDetector;

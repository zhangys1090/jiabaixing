/**
 * Harness Layer 1: Loop - Planner 节点
 *
 * 分析用户意图，生成执行计划
 * 简单任务跳过规划，复杂任务分解为步骤
 */

import { TaskComplexityAnalyzer } from '../../core/TaskComplexityAnalyzer';
import { Logger } from '../../utils/Logger';
import {
  UnifiedTaskPriority,
  UnifiedTaskStatus,
  type ExecutionPlan,
  type LoopContext,
  type PlanStep,
  type UserInput,
} from '../types';

/** toTaskNodes 输出格式 — 供 TaskDispatcher 使用的轻量节点 */
export interface TaskNodeOutput {
  id: string;
  goal: string;
  context: string;
  dependencies: string[];
  priority: number;
  tools?: string[];
  status: string;
}

/** 任务本质分析结果 */
export interface TaskNatureAnalysis {
  taskType: string;
  essence: string;
  keyConstraints: string[];
  riskPoints: string[];
  recommendedStrategy: string;
  complexity: 'low' | 'medium' | 'high';
}

/** Tree of Thoughts 配置 */
export interface TotConfig {
  /** 启用 Tree of Thoughts 多候选规划（默认 true） */
  enabled?: boolean;
  /** 启用任务本质分析（动态 Prompt 推理） */
  enableTaskNatureAnalysis?: boolean;
}

/** 候选计划评估结果 */
export interface CandidateEvaluation {
  plan: ExecutionPlan;
  feasibilityScore: number;
  reasoning: string;
  risks: string[];
}

/** 外部候选评估器接口 — 支持注入自定义评估逻辑 */
export interface PlanEvaluator {
  evaluate(
    candidates: Array<{
      strategy: string;
      reasoning: string;
      steps: Array<{ id: string; description: string; toolName?: string }>;
      dependencies: Record<string, string[]>;
      estimatedRounds: number;
    }>,
    context: { task: string }
  ): Promise<CandidateEvaluation[]>;
}

/** Planner 依赖 */
export interface PlannerDeps {
  /** LLM 判断是否需要规划 */
  llm: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  /** 进化纠错示例提供者（进化闭环：PromptExample 注入规划 prompt） */
  evolutionExamples?: {
    getPromptExamples(): Array<{
      trigger: string;
      correction: string;
      example: string;
      frequency: number;
    }>;
  };
  /** 记忆注入器 - 用于检索相关上下文 */
  memoryInjector?: {
    autoRetrieveMemories(input: string, userId?: string): Promise<string[]>;
  };
  /** Tree of Thoughts 配置 */
  totConfig?: TotConfig;
  /** 外部候选评估器 — 注入时使用外部评估逻辑，否则使用 LLM 评估 */
  planEvaluator?: PlanEvaluator;
}

/** 简单任务关键词 — 直接执行不需要规划，但需要工具调用 */
const ACTION_SIMPLE_PATTERNS: Array<{ pattern: RegExp; tools: string[] }> = [
  {
    pattern: /^(读|查|查看|打开|显示).*(文件|目录|内容)/,
    tools: ['file_list', 'file_search'],
  },
  { pattern: /^(搜索|查找|找).*(文件|内容|代码)/, tools: ['file_search'] },
  { pattern: /^(写|创建|新建|添加).*(文件|代码)/, tools: ['incremental_edit'] },
  {
    pattern: /^(运行|执行).*(命令|脚本|程序)/,
    tools: ['system_status', 'file_list'],
  },
  // H1+P-B1 fix: removed overly-broad /^(帮我|请|能不能|可以)/ that was catching complex tasks
  {
    pattern: /^(分析|检查).*(代码|文件)/,
    tools: ['code_analyze', 'file_list', 'file_search'],
  },
  {
    pattern: /(审查|review|检查).*(项目|目录|代码库|代码质量|整个)/,
    tools: ['code_review_project'],
  },
  {
    pattern: /(审查|review|代码质量).*(代码|源码|程序)/,
    tools: ['code_review_project'],
  },
  {
    pattern: /^(看看|查看|查一下|帮我查).*(端口|进程|内存|磁盘|IP|网络|日志)/,
    tools: ['shell_generate'],
  },
  {
    pattern: /^(找|清理|删除|列出).*(大文件|临时文件|缓存|垃圾)/,
    tools: ['shell_generate'],
  },
  {
    pattern: /(并行|同时|分别|分开).*(处理|执行|搜索|分析|审查)/,
    tools: ['delegate_task'],
  },
  {
    pattern: /(委托|交给|让).*(子agent|子agent|助手|另一个)/i,
    tools: ['delegate_task'],
  },
];

/** 纯对话模式 — 不调用任何工具，直接LLM回复 */
const CONVERSATION_ONLY_PATTERNS = [
  /^(你好|hi|hello|嗨|早上好|晚上好|下午好|hey|yo)\s*$/i, // 纯问候（不带其他内容）
  /^(谢谢|感谢|thanks|thank you)\s*$/i,
  /^(再见|拜拜|bye|goodbye)\s*$/i,
  /^(？|\?)+$/, // 纯问号
  /^(ping)$/, // 单词ping是网络命令，但用户可能只是打招呼
  /^.{1,4}$/, // 超短输入（1-4字符）大概率是对话
];

const SIMPLE_TASK_PATTERNS = [
  /^(什么是|解释|说明|定义|告诉我)/,
  /^(怎么|如何|为什么|为啥)/,
];

// 研究类任务 — 需要多步骤搜索+分析+总结
const RESEARCH_TASK_PATTERNS = [
  /研究|调研|分析.*趋势|发展趋势|市场分析/,
  /帮我.*搜索.*总结|搜索.*分析/,
  /了解.*情况|调查|对比.*方案/,
  /总结.*要点|整理.*信息/,
];

const ALL_SIMPLE_PATTERNS = [
  ...SIMPLE_TASK_PATTERNS,
  ...ACTION_SIMPLE_PATTERNS.map((a) => a.pattern),
];

/** 语言关键词到文件扩展名映射 — 用于文件搜索时自动设置 filePattern */
const LANGUAGE_TO_FILE_PATTERN: Record<string, string> = {
  python: '*.py',
  py文件: '*.py',
  python文件: '*.py',
  javascript: '*.js',
  js文件: '*.js',
  javascript文件: '*.js',
  typescript: '*.ts',
  ts文件: '*.ts',
  typescript文件: '*.ts',
  java: '*.java',
  java文件: '*.java',
  'c++': '*.cpp',
  cpp文件: '*.cpp',
  c文件: '*.c',
  csharp: '*.cs',
  cs文件: '*.cs',
  go: '*.go',
  go文件: '*.go',
  rust: '*.rs',
  rust文件: '*.rs',
  ruby: '*.rb',
  ruby文件: '*.rb',
  php: '*.php',
  php文件: '*.php',
  swift: '*.swift',
  swift文件: '*.swift',
  kotlin: '*.kt',
  kotlin文件: '*.kt',
  scala: '*.scala',
  scala文件: '*.scala',
  html: '*.html',
  html文件: '*.html',
  css: '*.css',
  css文件: '*.css',
  scss: '*.scss',
  scss文件: '*.scss',
  json: '*.json',
  json文件: '*.json',
  yaml: '*.yaml',
  yaml文件: '*.yaml',
  yml: '*.yml',
  yml文件: '*.yml',
  md: '*.md',
  markdown: '*.md',
  markdown文件: '*.md',
  xml: '*.xml',
  xml文件: '*.xml',
  sql: '*.sql',
  sql文件: '*.sql',
  sh: '*.sh',
  shell: '*.sh',
  shell文件: '*.sh',
  bash: '*.bash',
  bash文件: '*.bash',
};

export class Planner {
  private deps: PlannerDeps;
  private budgetAccuracyHistory: Array<{ estimated: number; actual: number }> =
    [];
  private replanCount = 0;
  private totalPlans = 0;
  private complexityAnalyzer: TaskComplexityAnalyzer;
  /** 工具使用历史 — 记录成功/失败次数 */
  private toolUsageHistory: Map<string, { success: number; failure: number }> =
    new Map();
  /** 简单任务结果历史 — key 为任务描述 */
  private simpleTaskResults: Map<
    string,
    Array<{ success: boolean; duration: number }>
  > = new Map();
  /** 任务本质分析缓存 — 避免重复推理 */
  private taskNatureCache: Map<string, TaskNatureAnalysis> = new Map();

  constructor(deps: PlannerDeps) {
    this.deps = deps;
    this.complexityAnalyzer = new TaskComplexityAnalyzer();
  }

  /**
   * 分析用户输入，生成执行计划
   */
  async plan(input: UserInput, context: LoopContext): Promise<ExecutionPlan> {
    this.totalPlans++;
    // 如果已有 plan，说明是 replan
    if (context.plan) {
      this.replanCount++;
    }
    let text = input.text.trim();

    // CAMEL Pattern: 任务说明符 — 模糊请求先明确化
    if (this.isVagueRequest(text) && this.deps.llm) {
      try {
        const refined = await this.refineVagueRequest(text);
        if (refined && refined !== text) {
          Logger.info(
            `🎯 任务明确化: "${text.substring(0, 30)}" → "${refined.substring(0, 30)}"`,
            'Planner'
          );
          text = refined;
        }
      } catch {
        // 明确化失败不影响原流程
      }
    }

    // H1 fix: 复杂任务优先判断，避免简单模式误匹配复杂请求
    // 然后判断简单任务，最后才让 LLM 判断中间地带
    const isComplex = this.isComplexTask(text);
    const isResearch = this.isResearchTask(text);
    if (!isComplex && !isResearch && this.isSimpleTask(text)) {
      Logger.info(`📋 简单任务: "${text.substring(0, 50)}"`, 'Planner');

      // 检测语言关键词，为文件搜索任务设置正确的 filePattern
      const filePattern = this.detectLanguageFilePattern(text);
      const recommendedTools = this.resolveRecommendedTools(text);
      const needsFileSearch = recommendedTools.includes('file_search');

      // 如果检测到语言且需要使用 file_search，则设置 toolParams
      const toolParams =
        filePattern && needsFileSearch ? { filePattern } : undefined;

      if (toolParams) {
        Logger.info(
          `📋 检测到语言文件搜索，设置 filePattern: ${filePattern}`,
          'Planner'
        );
      }

      // 检测纯对话任务 — 分配最小预算
      const isConversationOnly = CONVERSATION_ONLY_PATTERNS.some((p) =>
        p.test(text)
      );

      // 检测复合简单任务 — 多个子操作
      const composite = this.detectCompositeSimpleTask(text);
      if (composite.isCompositeSimple && composite.subTasks) {
        const subSteps = composite.subTasks.map((desc, idx) => ({
          id: `simple-step-${idx + 1}`,
          description: desc,
          retryCount: 0,
          maxRetries: 1,
          toUnifiedTaskNode: () => ({
            id: `simple-step-${idx + 1}`,
            description: desc,
            status: UnifiedTaskStatus.PENDING,
            dependencies: [],
            priority: UnifiedTaskPriority.MEDIUM,
            maxRetries: 1,
            currentRetry: 0,
            timeout: 300,
            retryDelay: 1,
            metadata: {},
            isEssential: true,
          }),
        }));

        const deps = new Map<string, string[]>();
        const hasSequential = /然后|接着|之后|最后/.test(text);
        if (hasSequential) {
          for (let i = 1; i < subSteps.length; i++) {
            deps.set(subSteps[i].id, [subSteps[i - 1].id]);
          }
        }

        return {
          steps: subSteps,
          dependencies: deps,
          estimatedBudget: {
            maxRounds: 4 + subSteps.length,
            maxToolCalls: subSteps.length * 2,
            maxTokens: 4000,
            maxDurationMs: 60000,
          },
          simple: true,
          planTier: 'simple',
          toolCallMode: 'auto',
          recommendedTools: [],
        };
      }

      if (isConversationOnly) {
        return {
          steps: [
            {
              id: 'direct-execute',
              description: text,
              retryCount: 0,
              maxRetries: 0,
              toUnifiedTaskNode: () => ({
                id: 'direct-execute',
                description: text,
                status: UnifiedTaskStatus.PENDING,
                dependencies: [],
                priority: UnifiedTaskPriority.MEDIUM,
                maxRetries: 0,
                currentRetry: 0,
                timeout: 300,
                retryDelay: 1,
                metadata: {},
                isEssential: true,
              }),
            },
          ],
          dependencies: new Map(),
          estimatedBudget: {
            maxRounds: 1,
            maxToolCalls: 0,
            maxTokens: 2000,
            maxDurationMs: 15000,
          },
          simple: true,
          planTier: 'none',
          toolCallMode: 'none',
          recommendedTools: [],
        };
      }

      return {
        steps: [
          {
            id: 'direct-execute',
            description: text,
            retryCount: 0,
            maxRetries: 0,
            toolName: needsFileSearch ? 'file_search' : undefined,
            toolParams,
            toUnifiedTaskNode: () => ({
              id: 'direct-execute',
              description: text,
              toolName: needsFileSearch ? 'file_search' : undefined,
              toolParams,
              status: UnifiedTaskStatus.PENDING,
              dependencies: [],
              priority: UnifiedTaskPriority.MEDIUM,
              maxRetries: 0,
              currentRetry: 0,
              timeout: 300,
              retryDelay: 1,
              metadata: {},
              isEssential: true,
            }),
          },
        ],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 4,
          maxToolCalls: 5,
          maxTokens: 3000,
          maxDurationMs: 30000,
        },
        simple: true,
        planTier: 'simple',
        toolCallMode: this.resolveToolCallMode(text),
        recommendedTools: this.resolveRecommendedTools(text),
      };
    }

    // 2. 快速判断：明显复杂任务
    if (this.isComplexTask(text)) {
      Logger.info(`📋 复杂任务: "${text.substring(0, 50)}"`, 'Planner');
      const plan = await this.generatePlan(input, context);
      plan.planTier = 'complex';
      return plan;
    }

    // 2.5 研究类任务：自动规划搜索+分析+总结三步骤
    if (isResearch) {
      Logger.info(`📋 研究任务: "${text.substring(0, 50)}"`, 'Planner');
      const plan = this.generateResearchPlan(input, context);
      plan.planTier = 'research';
      return plan;
    }

    // 3. 中间地带：让 LLM 判断
    try {
      const needsPlan = await this.llmJudgeNeedsPlan(text);
      if (!needsPlan) {
        Logger.info('📋 LLM判断为简单任务', 'Planner');
        return {
          steps: [
            {
              id: 'direct-execute',
              description: text,
              retryCount: 0,
              maxRetries: 0,
              toUnifiedTaskNode: () => ({
                id: 'direct-execute',
                description: text,
                status: UnifiedTaskStatus.PENDING,
                dependencies: [],
                priority: UnifiedTaskPriority.MEDIUM,
                maxRetries: 0,
                currentRetry: 0,
                timeout: 300,
                retryDelay: 1,
                metadata: {},
                isEssential: true,
              }),
            },
          ],
          dependencies: new Map(),
          estimatedBudget: {
            maxRounds: 4,
            maxToolCalls: 5,
            maxTokens: 3000,
            maxDurationMs: 30000,
          },
          simple: true,
          planTier: 'direct',
          toolCallMode: this.resolveToolCallMode(text),
          recommendedTools: this.resolveRecommendedTools(text),
        };
      }
    } catch {
      // LLM 不可用时降级为简单任务
      Logger.info('📋 LLM不可用，降级为简单任务', 'Planner');
      return {
        steps: [
          {
            id: 'direct-execute',
            description: text,
            retryCount: 0,
            maxRetries: 0,
            toUnifiedTaskNode: () => ({
              id: 'direct-execute',
              description: text,
              status: UnifiedTaskStatus.PENDING,
              dependencies: [],
              priority: UnifiedTaskPriority.MEDIUM,
              maxRetries: 0,
              currentRetry: 0,
              timeout: 300,
              retryDelay: 1,
              metadata: {},
              isEssential: true,
            }),
          },
        ],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 6,
          maxToolCalls: 8,
          maxTokens: 4000,
          maxDurationMs: 45000,
        },
        simple: true,
        planTier: 'direct',
        toolCallMode: this.resolveToolCallMode(text),
        recommendedTools: this.resolveRecommendedTools(text),
      };
    }

    // 4. 生成执行计划
    const plan = await this.generatePlan(input, context);
    plan.planTier = 'complex';
    return plan;
  }

  /**
   * 判断是否为简单任务
   */
  private isSimpleTask(text: string): boolean {
    return (
      ALL_SIMPLE_PATTERNS.some((p) => p.test(text)) ||
      CONVERSATION_ONLY_PATTERNS.some((p) => p.test(text))
    );
  }

  private isActionTask(text: string): boolean {
    return ACTION_SIMPLE_PATTERNS.some((a) => a.pattern.test(text));
  }

  private isResearchTask(text: string): boolean {
    return RESEARCH_TASK_PATTERNS.some((p) => p.test(text));
  }

  private resolveRecommendedTools(text: string): string[] {
    for (const action of ACTION_SIMPLE_PATTERNS) {
      if (action.pattern.test(text)) {
        return action.tools;
      }
    }
    return [];
  }

  private resolveToolCallMode(text: string): 'required' | 'auto' | 'none' {
    if (this.isActionTask(text)) return 'required';
    return 'auto';
  }

  /**
   * 检测文本中的语言关键词，返回对应的 filePattern
   * 例如: "找 Python 文件" → "*.py"
   * @param text 用户输入文本
   * @returns 文件匹配模式，如果未检测到语言则返回 null
   */
  private detectLanguageFilePattern(text: string): string | null {
    const lowerText = text.toLowerCase();

    // 优先匹配更长的关键词（短语），再匹配单词
    const sortedKeys = Object.keys(LANGUAGE_TO_FILE_PATTERN).sort(
      (a, b) => b.length - a.length
    );

    for (const key of sortedKeys) {
      if (lowerText.includes(key)) {
        const filePattern = LANGUAGE_TO_FILE_PATTERN[key];
        Logger.debug(
          `🔍 检测到语言关键词 "${key}" → filePattern: ${filePattern}`,
          'Planner'
        );
        return filePattern;
      }
    }

    return null;
  }

  /**
   * 判断是否为复杂任务 - 使用统一的 TaskComplexityAnalyzer
   */
  private isComplexTask(text: string): boolean {
    const result = this.complexityAnalyzer.analyzeComplexity(text);
    // 如果复杂度分析结果是 complex 或 very_complex，则认为是复杂任务
    const isAnalyzedComplex =
      result.complexity === 'complex' || result.complexity === 'very_complex';
    // 保留关键词匹配作为补充，确保特定关键词能触发复杂任务判断
    const hasComplexKeywords =
      /重构|迁移|升级|改造|优化.*系统|设计.*架构|实现.*功能.*包括|同时.*修改.*多个|步骤|流程|方案|先.*再.*然后|第一.*第二.*第三/.test(
        text
      );
    return isAnalyzedComplex || hasComplexKeywords;
  }

  /**
   * 让 LLM 判断是否需要规划
   */
  private async llmJudgeNeedsPlan(text: string): Promise<boolean> {
    const prompt = `判断以下用户请求是否需要多步骤规划才能完成。

需要规划的任务特征：
- 需要调用3个以上工具
- 需要修改多个文件
- 需要先分析再执行
- 有明确的先后依赖关系
- 涉及不可逆操作（文件修改、删除、系统命令）

不需要规划的任务特征：
- 简单问答
- 单文件操作
- 单工具调用
- 日常对话

重要：意图模糊不算"不需要规划"，而是应该规划为"先搜索/推理获取信息"的步骤。
不要因为信息不完整就跳过规划，而是规划主动获取信息的步骤。

用户请求: "${text}"

只回答 YES 或 NO`;

    const response = await this.deps.llm.chat(prompt);
    return response.trim().toUpperCase().includes('YES');
  }

  /**
   * 记录预算准确度
   * @param estimated - 预估预算
   * @param actual - 实际使用量
   */
  recordBudgetAccuracy(estimated: number, actual: number): void {
    this.budgetAccuracyHistory.push({ estimated, actual });
  }

  /**
   * 获取调整后的预算乘数
   * 基于历史预算准确度动态调整
   * @returns 预算乘数 (1.0-2.0)
   */
  getAdjustedBudgetMultiplier(): number {
    if (this.budgetAccuracyHistory.length < 3) return 1.5;
    let totalRatio = 0;
    for (const entry of this.budgetAccuracyHistory) {
      totalRatio += entry.estimated > 0 ? entry.actual / entry.estimated : 1;
    }
    const avgRatio = totalRatio / this.budgetAccuracyHistory.length;
    return Math.max(1.0, Math.min(2.0, avgRatio));
  }

  /**
   * 基于当前预算使用情况计算缩减系数
   * 预算紧张时返回 < 1，预算充足时返回 1
   */
  private getBudgetConstraintMultiplier(context: LoopContext): number {
    const budget = context.budget;
    if (!budget) return 1;

    let multiplier = 1;

    // Token 预算紧张度
    if (budget.tokenHardLimit && budget.tokenHardLimit > 0) {
      const tokenUsage = budget.tokensUsed / budget.tokenHardLimit;
      if (tokenUsage > 0.8) {
        multiplier *= 0.5;
      } else if (tokenUsage > 0.6) {
        multiplier *= 0.75;
      }
    }

    // 轮次预算紧张度
    if (budget.hardRoundLimit && budget.hardRoundLimit > 0) {
      const roundUsage = budget.roundsUsed / budget.hardRoundLimit;
      if (roundUsage > 0.75) {
        multiplier *= 0.6;
      } else if (roundUsage > 0.5) {
        multiplier *= 0.8;
      }
    }

    // 时间预算紧张度
    if (budget.maxDurationMs && budget.startTime) {
      const elapsed = Date.now() - budget.startTime;
      const timeUsage = elapsed / budget.maxDurationMs;
      if (timeUsage > 0.8) {
        multiplier *= 0.5;
      } else if (timeUsage > 0.6) {
        multiplier *= 0.75;
      }
    }

    return multiplier;
  }

  /**
   * 获取重新规划率
   * @returns 重新规划率 (0-1)
   */
  getReplanRate(): number {
    if (this.totalPlans === 0) return 0;
    return this.replanCount / this.totalPlans;
  }

  /**
   * 分析任务本质 — LLM 推理任务类型、约束、风险、策略
   *
   * 动态 Prompt 推理核心：先理解任务本质，再生成专属规划 Prompt
   * 结果缓存避免重复推理
   *
   * @param task - 任务描述
   * @returns 结构化任务分析
   */
  async analyzeTaskNature(task: string): Promise<TaskNatureAnalysis> {
    const cacheKey = task.trim();
    const cached = this.taskNatureCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const prompt = `你是任务分析引擎。请分析以下任务的本质，返回结构化分析。

任务: "${task}"

请用以下JSON格式输出（不要包含其他内容）：
{
  "taskType": "任务类型（如 code_refactoring, migration, research, bug_fix, feature_development 等）",
  "essence": "任务本质（一句话描述核心目标）",
  "keyConstraints": ["关键约束1", "关键约束2"],
  "riskPoints": ["风险点1", "风险点2"],
  "recommendedStrategy": "推荐策略",
  "complexity": "low|medium|high"
}`;

      const response = await this.deps.llm.chat(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 未返回有效 JSON');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const analysis: TaskNatureAnalysis = {
        taskType: parsed.taskType || 'unknown',
        essence: parsed.essence || task,
        keyConstraints: Array.isArray(parsed.keyConstraints)
          ? parsed.keyConstraints
          : [],
        riskPoints: Array.isArray(parsed.riskPoints) ? parsed.riskPoints : [],
        recommendedStrategy: parsed.recommendedStrategy || '',
        complexity: parsed.complexity || 'medium',
      };

      this.taskNatureCache.set(cacheKey, analysis);
      Logger.info(
        `🧠 任务本质分析: type=${analysis.taskType}, complexity=${analysis.complexity}`,
        'Planner'
      );
      return analysis;
    } catch (err) {
      Logger.warn(
        `任务本质分析降级为规则化: ${(err as Error).message}`,
        'Planner'
      );
      const fallback = this.ruleBasedTaskAnalysis(task);
      this.taskNatureCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * 规则化任务分析（LLM 不可用时的降级方案）
   * @param task - 任务描述
   * @returns 基于关键词匹配的任务分析
   */
  private ruleBasedTaskAnalysis(task: string): TaskNatureAnalysis {
    let taskType = 'general';
    let complexity: 'low' | 'medium' | 'high' = 'medium';

    if (/重构|refactor/i.test(task)) {
      taskType = 'code_refactoring';
      complexity = 'high';
    } else if (/迁移|migration|migrate/i.test(task)) {
      taskType = 'migration';
      complexity = 'high';
    } else if (/研究|调研|research/i.test(task)) {
      taskType = 'research';
      complexity = 'medium';
    } else if (/修复|bug|fix/i.test(task)) {
      taskType = 'bug_fix';
      complexity = 'medium';
    } else if (/实现|开发|implement|feature/i.test(task)) {
      taskType = 'feature_development';
      complexity = 'medium';
    }

    return {
      taskType,
      essence: task,
      keyConstraints: [],
      riskPoints: [],
      recommendedStrategy: '',
      complexity,
    };
  }

  /**
   * 将执行计划转换为 TaskNode 列表 — 供 TaskDispatcher 使用
   *
   * 转换规则：
   *   - 每个 PlanStep 转换为一个 TaskNode
   *   - 依赖关系从 plan.dependencies 映射
   *   - 优先级基于步骤顺序（越早优先级越高）
   *   - 工具列表从 step.toolName 提取
   *
   * @param plan - 执行计划
   * @returns TaskNode 列表
   */
  public toTaskNodes(plan: ExecutionPlan): TaskNodeOutput[] {
    const steps = plan.steps || [];
    const deps = plan.dependencies || new Map();

    return steps.map((step, index) => {
      const stepDeps = deps.get(step.id) || [];
      const priority = Math.max(1, 10 - index);

      return {
        id: step.id,
        goal: step.description,
        context: `步骤 ${index + 1}: ${step.description}`,
        dependencies: stepDeps,
        priority,
        tools: step.toolName ? [step.toolName] : undefined,
        status: 'pending',
      };
    });
  }

  /**
   * 生成执行计划
   */
  private async generatePlan(
    input: UserInput,
    context: LoopContext
  ): Promise<ExecutionPlan> {
    try {
      // 先检索相关上下文
      let contextMemories: string[] = [];
      if (this.deps.memoryInjector) {
        try {
          contextMemories = await this.deps.memoryInjector.autoRetrieveMemories(
            input.text,
            input.userId
          );
          Logger.debug(
            `📋 检索到 ${contextMemories.length} 条相关记忆`,
            'Planner'
          );
        } catch (err) {
          Logger.warn(`⚠️ 记忆检索失败: ${(err as Error).message}`, 'Planner');
        }
      }

      let evolutionHint = '';
      if (this.deps.evolutionExamples) {
        const examples = this.deps.evolutionExamples.getPromptExamples();
        if (examples.length > 0) {
          const topExamples = examples
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 3);
          evolutionHint = `\n\n【进化纠错提示】以下模式曾导致用户纠正，请避免：\n${topExamples
            .map(
              (e, i) =>
                `${i + 1}. 避免: ${e.trigger} → 正确做法: ${e.correction}`
            )
            .join('\n')}`;
        }
      }

      let contextHint = '';
      if (contextMemories.length > 0) {
        contextHint = `\n\n【相关上下文】以下是检索到的相关信息，请在规划时参考：\n${contextMemories.map((mem, i) => `${i + 1}. ${mem}`).join('\n')}`;
      }

      // P3: Tree of Thoughts — 复杂任务生成多候选并择优
      // totConfig.enabled 默认 true（未设置时启用），显式设为 false 时关闭
      const totEnabled = this.deps.totConfig?.enabled !== false;
      if (totEnabled) {
        return this.generateTotPlan(input, contextHint, evolutionHint, context);
      }

      // P2-1: 动态 Prompt 推理 — 先分析任务本质，再生成候选执行计划
      if (this.deps.totConfig?.enableTaskNatureAnalysis) {
        await this.analyzeTaskNature(input.text);
        return this.generateTotPlan(input, contextHint, evolutionHint, context);
      }

      const prompt = `为以下任务生成执行计划。每个步骤应该是一个独立的操作。

任务: "${input.text}"
${contextHint}
${evolutionHint}
请用以下JSON格式输出（不要包含其他内容）:
{
  "steps": [
    {"id": "step1", "description": "步骤描述", "toolName": "工具名(可选)"},
    {"id": "step2", "description": "步骤描述", "toolName": "工具名(可选)"}
  ],
  "dependencies": {"step2": ["step1"]},
  "estimatedRounds": 3,
  "needsConfirmation": true,
  "confirmationMessage": "我计划执行以下操作：..."
}

注意：
- 步骤数量控制在2-5个
- 只在步骤间有明确依赖时才添加dependencies
- estimatedRounds是预估的工具调用轮次
- 如果任务涉及文件修改、删除、系统命令等不可逆操作，needsConfirmation必须为true
- confirmationMessage应该是简洁的中文说明，告诉用户你要做什么
- 自主推理优先：遇到模糊信息时，先规划搜索/推理步骤获取信息，而不是直接提问用户
- 只在确实无法通过工具/推理获取关键信息时，才将"向用户提问"作为最后一步
- 第一步应该是主动行动（搜索、读取、分析），不是提问
- 不要规划超出任务范围的额外操作
- 请参考提供的相关上下文信息来制定更准确的计划`;

      const response = await this.deps.llm.chat(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 未返回有效 JSON');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const deps: Map<string, string[]> = new Map();
      if (parsed.dependencies) {
        for (const [key, value] of Object.entries(parsed.dependencies)) {
          deps.set(key, value as string[]);
        }
      }

      const steps: PlanStep[] = (parsed.steps || []).map(
        (
          s: { id?: string; description?: string; toolName?: string },
          i: number
        ) => {
          const stepId = s.id || `step${i + 1}`;
          const stepDeps = deps.get(stepId) || [];
          return {
            id: stepId,
            description: s.description || '',
            toolName: s.toolName,
            retryCount: 0,
            maxRetries: 1,
            toUnifiedTaskNode: () => ({
              id: stepId,
              description: s.description || '',
              toolName: s.toolName,
              status: UnifiedTaskStatus.PENDING,
              dependencies: stepDeps,
              priority: UnifiedTaskPriority.MEDIUM,
              maxRetries: 1,
              currentRetry: 0,
              timeout: 300,
              retryDelay: 1,
              metadata: {},
              isEssential: true,
            }),
          };
        }
      );

      const multiplier =
        this.getAdjustedBudgetMultiplier() *
        this.getBudgetConstraintMultiplier(context);

      const planReasoning = response.trim();
      const recommendedTools = steps
        .map((s) => s.toolName)
        .filter((t): t is string => !!t);

      return {
        steps,
        dependencies: deps,
        estimatedBudget: {
          maxRounds: Math.ceil((parsed.estimatedRounds || 6) * multiplier),
          maxToolCalls: Math.ceil(steps.length * 3 * multiplier),
          maxTokens: Math.ceil(5000 * multiplier),
          maxDurationMs: Math.ceil(60000 * multiplier),
        },
        fallbackStrategy: 'replan',
        planReasoning,
        toolCallMode: steps.length > 0 ? 'required' : 'auto',
        recommendedTools,
      };
    } catch (err) {
      Logger.warn(
        `规划生成失败，降级为直接执行: ${(err as Error).message}`,
        'Planner'
      );
      return {
        steps: [
          {
            id: 'direct-execute',
            description: input.text,
            retryCount: 0,
            maxRetries: 0,
            toUnifiedTaskNode: () => ({
              id: 'direct-execute',
              description: input.text,
              status: UnifiedTaskStatus.PENDING,
              dependencies: [],
              priority: UnifiedTaskPriority.MEDIUM,
              maxRetries: 0,
              currentRetry: 0,
              timeout: 300,
              retryDelay: 1,
              metadata: {},
              isEssential: true,
            }),
          },
        ],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 6,
          maxToolCalls: 8,
          maxTokens: 4000,
          maxDurationMs: 45000,
        },
        simple: true,
        toolCallMode: this.resolveToolCallMode(input.text),
        recommendedTools: this.resolveRecommendedTools(input.text),
      };
    }
  }

  /**
   * Tree of Thoughts 规划 — 基于任务分析生成候选计划并评估
   *
   * 流程：
   *   1. 任务本质分析（已由 analyzeTaskNature 完成）
   *   2. 候选执行计划生成（注入任务分析结果）
   *   3. 候选评估（多候选时）
   *   4. 选择最优候选构建最终计划
   */
  private async generateTotPlan(
    input: UserInput,
    contextHint: string,
    evolutionHint: string,
    context: LoopContext
  ): Promise<ExecutionPlan> {
    // P2-1: 动态 Prompt 推理 — 先分析任务本质
    let analysisSection = '';
    if (this.deps.totConfig?.enableTaskNatureAnalysis) {
      const analysis = await this.analyzeTaskNature(input.text);
      analysisSection = `
【任务本质】${analysis.essence}
【任务类型】${analysis.taskType}
【关键约束】${analysis.keyConstraints.join('、') || '无'}
【风险点】${analysis.riskPoints.join('、') || '无'}
【推荐策略】${analysis.recommendedStrategy || '无'}
【复杂度】${analysis.complexity}`;
    }

    // 1. 生成候选执行计划（注入任务本质分析结果）
    const candidatePrompt = `为以下复杂任务生成多个候选执行计划（至少2个）。

任务: "${input.text}"
${analysisSection}
${contextHint}
${evolutionHint}
请用以下JSON格式输出（不要包含其他内容）：
{
  "candidates": [
    {
      "strategy": "策略名称",
      "reasoning": "选择此策略的推理过程",
      "steps": [{"id": "s1", "description": "步骤描述", "toolName": "工具名(可选)"}],
      "dependencies": {"s2": ["s1"]},
      "estimatedRounds": 3
    }
  ]
}`;

    const candidateResponse = await this.deps.llm.chat(candidatePrompt);
    const candidateMatch = candidateResponse.match(/\{[\s\S]*\}/);
    if (!candidateMatch) {
      throw new Error('LLM 未返回有效候选计划 JSON');
    }

    const candidatesParsed = JSON.parse(candidateMatch[0]);
    let candidates: Array<{
      strategy: string;
      reasoning: string;
      steps: Array<{ id?: string; description?: string; toolName?: string }>;
      dependencies: Record<string, string[]>;
      estimatedRounds: number;
    }> = candidatesParsed.candidates || [];

    // 向后兼容：LLM 返回旧格式单计划时降级为单候选
    if (candidates.length === 0 && candidatesParsed.steps) {
      candidates = [
        {
          strategy: '默认方案',
          reasoning: candidatesParsed.reasoning || '多步骤执行',
          steps: candidatesParsed.steps,
          dependencies: candidatesParsed.dependencies || {},
          estimatedRounds: candidatesParsed.estimatedRounds || 4,
        },
      ];
    }

    if (candidates.length === 0) {
      throw new Error('LLM 未返回候选计划');
    }

    // 2. 评估候选 — 优先使用外部评估器，否则使用 LLM 评估
    let bestCandidateIndex = 0;
    let evaluations: Array<{
      candidateIndex: number;
      feasibilityScore: number;
      reasoning?: string;
    }> = [];

    if (this.deps.planEvaluator) {
      const evalResults = await this.deps.planEvaluator.evaluate(
        candidates.map((c, ci) => ({
          strategy: c.strategy,
          reasoning: c.reasoning,
          steps: (c.steps || []).map((s, si) => ({
            id: s.id || `step${ci + 1}-${si + 1}`,
            description: s.description || '',
            toolName: s.toolName,
          })),
          dependencies: c.dependencies,
          estimatedRounds: c.estimatedRounds,
        })),
        { task: input.text }
      );
      evaluations = evalResults.map((e, i) => ({
        candidateIndex: i,
        feasibilityScore: e.feasibilityScore,
        reasoning: e.reasoning,
      }));
    } else if (candidates.length > 1) {
      try {
        const evalPrompt = `请评估以下候选执行计划的可行性。

任务: "${input.text}"

候选计划:
${candidates
  .map((c, i) => `候选${i + 1}: ${c.strategy} - ${c.reasoning}`)
  .join('\n')}

请用以下JSON格式输出：
{
  "evaluations": [
    {
      "candidateIndex": 0,
      "feasibilityScore": 0.8,
      "reasoning": "评估理由",
      "risks": ["风险1"]
    }
  ]
}`;

        const evalResponse = await this.deps.llm.chat(evalPrompt);
        const evalMatch = evalResponse.match(/\{[\s\S]*\}/);
        if (evalMatch) {
          const evalParsed = JSON.parse(evalMatch[0]);
          evaluations = evalParsed.evaluations || [];
        }
      } catch (err) {
        Logger.warn(
          `候选评估失败，使用首个候选: ${(err as Error).message}`,
          'Planner'
        );
      }
    }

    // 选择最高分候选
    if (evaluations.length > 0) {
      let bestScore = -1;
      for (const ev of evaluations) {
        if (
          ev.feasibilityScore > bestScore &&
          ev.candidateIndex < candidates.length
        ) {
          bestScore = ev.feasibilityScore;
          bestCandidateIndex = ev.candidateIndex;
        }
      }
    }

    const bestCandidate = candidates[bestCandidateIndex];

    // 3. 从最优候选构建执行计划
    const depsMap: Map<string, string[]> = new Map();
    const rawDeps = bestCandidate.dependencies || {};
    for (const [k, v] of Object.entries(rawDeps)) {
      depsMap.set(k, v as string[]);
    }

    const steps: PlanStep[] = (bestCandidate.steps || []).map(
      (
        s: { id?: string; description?: string; toolName?: string },
        i: number
      ) => {
        const stepId = s.id || `step${i + 1}`;
        const stepDeps = depsMap.get(stepId) || [];
        return {
          id: stepId,
          description: s.description || '',
          toolName: s.toolName,
          retryCount: 0,
          maxRetries: 1,
          toUnifiedTaskNode: () => ({
            id: stepId,
            description: s.description || '',
            toolName: s.toolName,
            status: UnifiedTaskStatus.PENDING,
            dependencies: stepDeps,
            priority: UnifiedTaskPriority.MEDIUM,
            maxRetries: 1,
            currentRetry: 0,
            timeout: 300,
            retryDelay: 1,
            metadata: {},
            isEssential: true,
          }),
        };
      }
    );

    const multiplier =
      this.getAdjustedBudgetMultiplier() *
      this.getBudgetConstraintMultiplier(context);
    const planReasoning = bestCandidate.reasoning || candidateResponse.trim();
    const recommendedTools = steps
      .map((s) => s.toolName)
      .filter((t): t is string => !!t);

    Logger.info(
      `🌳 ToT 规划完成: ${steps.length} 步, 策略=${bestCandidate.strategy || '默认'}, 选中候选 #${bestCandidateIndex + 1}`,
      'Planner'
    );

    return {
      steps,
      dependencies: depsMap,
      estimatedBudget: {
        maxRounds: Math.ceil((bestCandidate.estimatedRounds || 6) * multiplier),
        maxToolCalls: Math.ceil(steps.length * 3 * multiplier),
        maxTokens: Math.ceil(5000 * multiplier),
        maxDurationMs: Math.ceil(60000 * multiplier),
      },
      fallbackStrategy: 'replan',
      planReasoning,
      toolCallMode: steps.length > 0 ? 'required' : 'auto',
      recommendedTools,
      totMeta: {
        candidatesCount: candidates.length,
        candidateCount: candidates.length,
        selectedRank: bestCandidateIndex,
        selectedStrategy: bestCandidate.strategy,
        evaluations,
      },
    };
  }

  /**
   * 判断是否为模糊请求（需要明确化）
   */
  private isVagueRequest(text: string): boolean {
    // 短请求且不含具体动词/名词
    if (
      text.length < 15 &&
      !/[文件|代码|搜索|提醒|日程|打开|创建|运行]/.test(text)
    ) {
      return true;
    }
    // 模糊词
    const vaguePatterns = [
      /^(帮我|处理|弄|搞|做|看看)/,
      /^(那个|这个|之前|上次)/,
      /^(有事|忙|无聊|累)/,
    ];
    return vaguePatterns.some((p) => p.test(text));
  }

  /**
   * 用 LLM 明确化模糊请求
   */
  private async refineVagueRequest(text: string): Promise<string> {
    const prompt = `用户说: "${text}"

这是一个模糊的请求。请将其改写为一个具体、可执行的任务描述。
只输出改写后的任务，不要解释。

示例:
- "帮我弄一下" → "请告诉我你需要处理什么具体任务"
- "处理数据" → "分析当前目录下的数据文件并生成统计报告"
- "看看代码" → "审查当前项目的代码质量，找出潜在问题"`;

    const response = await this.deps.llm!.chat(prompt);
    const refined = response.trim().replace(/^["']|["']$/g, '');
    return refined.length > 5 && refined.length < 200 ? refined : text;
  }

  /**
   * 研究类任务专用规划 — 搜索+分析+总结三步骤
   */
  private generateResearchPlan(
    input: UserInput,
    _context: LoopContext
  ): ExecutionPlan {
    // 从用户输入中提取搜索关键词
    const keywords = input.text
      .replace(
        /帮我|请|搜索|查找|查一下|搜一下|看看|了解|研究|一下|的|发展趋势|分析|总结|要点/g,
        ''
      )
      .replace(/[，。、,.\s]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((k) => k.length >= 2)
      .slice(0, 3);

    const searchQuery = keywords.join(' ') || input.text.substring(0, 20);

    return {
      steps: [
        {
          id: 'search',
          description: `搜索"${searchQuery}"相关信息`,
          toolName: 'web_search',
          retryCount: 0,
          maxRetries: 2,
          toUnifiedTaskNode: () => ({
            id: 'search',
            description: `搜索"${searchQuery}"相关信息`,
            status: UnifiedTaskStatus.PENDING,
            dependencies: [],
            priority: UnifiedTaskPriority.MEDIUM,
            maxRetries: 2,
            currentRetry: 0,
            timeout: 300,
            retryDelay: 1,
            metadata: {},
            isEssential: true,
          }),
        },
        {
          id: 'analyze',
          description: '分析搜索结果，提取关键信息',
          retryCount: 0,
          maxRetries: 0,
          toUnifiedTaskNode: () => ({
            id: 'analyze',
            description: '分析搜索结果，提取关键信息',
            status: UnifiedTaskStatus.PENDING,
            dependencies: ['search'],
            priority: UnifiedTaskPriority.MEDIUM,
            maxRetries: 0,
            currentRetry: 0,
            timeout: 300,
            retryDelay: 1,
            metadata: {},
            isEssential: true,
          }),
        },
        {
          id: 'summarize',
          description: '总结要点并格式化输出',
          retryCount: 0,
          maxRetries: 0,
          toUnifiedTaskNode: () => ({
            id: 'summarize',
            description: '总结要点并格式化输出',
            status: UnifiedTaskStatus.PENDING,
            dependencies: ['analyze'],
            priority: UnifiedTaskPriority.MEDIUM,
            maxRetries: 0,
            currentRetry: 0,
            timeout: 300,
            retryDelay: 1,
            metadata: {},
            isEssential: true,
          }),
        },
      ],
      dependencies: new Map([
        ['analyze', ['search']],
        ['summarize', ['analyze']],
      ]),
      estimatedBudget: {
        maxRounds: 6,
        maxToolCalls: 8,
        maxTokens: 5000,
        maxDurationMs: 60000,
      },
      fallbackStrategy: 'replan',
      toolCallMode: 'required',
      recommendedTools: ['web_search', 'web_fetch'],
    };
  }

  // ============ 🔶-1: 简单任务规划增强 ============

  /**
   * 记录工具使用历史，影响推荐权重
   */
  recordToolUsage(toolName: string, success: boolean): void {
    if (!this.toolUsageHistory.has(toolName)) {
      this.toolUsageHistory.set(toolName, { success: 0, failure: 0 });
    }
    const entry = this.toolUsageHistory.get(toolName)!;
    if (success) entry.success++;
    else entry.failure++;
  }

  /**
   * 获取工具权重 — 基于历史成功率
   */
  getToolWeights(): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const [toolName, entry] of this.toolUsageHistory) {
      const total = entry.success + entry.failure;
      if (total > 0) {
        weights[toolName] = entry.success / total;
      }
    }
    return weights;
  }

  /**
   * 检测复合简单任务 — 由多个无依赖子操作组成
   */
  detectCompositeSimpleTask(text: string): {
    isCompositeSimple: boolean;
    subTasks?: string[];
  } {
    const parallelKeywords = ['同时', '并且', '以及', '各自', '分别'];
    const sequentialKeywords = ['然后', '接着', '之后', '最后'];

    const hasParallel = parallelKeywords.some((kw) => text.includes(kw));
    const hasSequential = sequentialKeywords.some((kw) => text.includes(kw));

    if (hasParallel || hasSequential) {
      const separators = /[，,；;]|然后|接着|之后|最后|同时|并且|以及/;
      const parts = text.split(separators).filter((p) => p.trim().length > 0);
      if (parts.length >= 2) {
        return {
          isCompositeSimple: true,
          subTasks: parts.map((p) => p.trim()),
        };
      }
    }

    return { isCompositeSimple: false };
  }

  /**
   * 记录简单任务执行结果
   */
  recordSimpleTaskResult(
    task: string,
    success: boolean,
    duration: number
  ): void {
    if (!this.simpleTaskResults.has(task)) {
      this.simpleTaskResults.set(task, []);
    }
    this.simpleTaskResults.get(task)!.push({ success, duration });
  }

  /**
   * 获取简单任务统计
   */
  getSimpleTaskStats(task: string): {
    totalRuns: number;
    successRate: number;
    avgDuration: number;
    needsOptimization: boolean;
  } | null {
    const results = this.simpleTaskResults.get(task);
    if (!results || results.length === 0) return null;

    const totalRuns = results.length;
    const successCount = results.filter((r) => r.success).length;
    const successRate = successCount / totalRuns;
    const avgDuration =
      results.reduce((sum, r) => sum + r.duration, 0) / totalRuns;
    const needsOptimization = successRate < 0.7 && totalRuns >= 3;

    return { totalRuns, successRate, avgDuration, needsOptimization };
  }
}

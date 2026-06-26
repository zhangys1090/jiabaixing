/**
 * Harness Layer 1: Loop - Executor 节点
 *
 * 执行 FC 循环。
 * 按 Harness 六层架构原则，Executor 应逐步减少直接下层依赖。
 * 当前通过 ToolCallHooks 接口提供非侵入式钩子，旧有依赖保留兼容。
 */

import { MessageSanitizer } from '../../models/MessageSanitizer';
import { EventBus } from '../../shared/EventBus';
import type { SkillContext } from '../../skills/SkillInterface';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { Logger } from '../../utils/Logger';
import { ConstraintsService } from '../constraints/ConstraintsService';
import type { ContextWindowManager } from '../context/ContextWindowManager';
import type { TrajectoryDatabase } from '../persistence/TrajectoryDatabase';
import type { PermissionGuard } from '../tools/registry/PermissionGuard';
import type { SchemaValidator } from '../tools/registry/SchemaValidator';
import { ToolCallGuard } from '../tools/registry/ToolCallGuard';
import type { ToolRegistry } from '../tools/registry/ToolRegistry';
import type {
  BudgetState,
  ChatMessage,
  ExecutionPlan,
  LoopContext,
  ToolContext,
  ToolResult,
  TrajectoryStep,
} from '../types';
import { LifecycleEvent, Permission } from '../types';
import type { ExecutorOutput } from './LoopController';

/** 工具调用拦截器 — 非侵入式钩子接口 */
export interface ToolCallHooks {
  beforeToolCall?(
    toolName: string,
    params: Record<string, unknown>,
    ctx: { traceId: string; loopCount: number }
  ): Promise<{
    proceed: boolean;
    modifiedParams?: Record<string, unknown>;
    replacementResult?: ToolResult;
    reason?: string;
  }>;
  afterToolCall?(
    toolName: string,
    result: ToolResult,
    ctx: { traceId: string; loopCount: number }
  ): Promise<ToolResult>;
  onToolError?(
    toolName: string,
    error: string,
    ctx: { traceId: string; loopCount: number }
  ): Promise<void>;
  recordTrajectory?(step: TrajectoryStep): void;
}

/** Executor 依赖 — 保留旧接口兼容，逐步迁移到 hooks */
export interface ExecutorDeps {
  /** LLM 提供者 */
  llm: {
    chatWithTools(
      messages: ChatMessage[],
      tools: Array<Record<string, unknown>>,
      maxTokens?: number,
      toolChoice?: 'none' | 'auto' | 'required'
    ): Promise<{
      content: string | null;
      toolCalls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    }>;
  };
  /** 工具注册表 */
  toolRegistry: ToolRegistry;
  /** Schema 验证器（@deprecated 通过 hooks 替代） */
  schemaValidator: SchemaValidator;
  /** 权限守卫（@deprecated 通过 hooks 替代） */
  permissionGuard: PermissionGuard;
  /** 轨迹数据库（@deprecated 通过 hooks 替代） */
  trajectoryDatabase?: TrajectoryDatabase;
  /** 非侵入式工具调用钩子（推荐） */
  hooks?: ToolCallHooks;
  /** 约束服务 — 用于触发生命周期钩子 BEFORE_TOOL_CALL, AFTER_TOOL_CALL, ON_ERROR */
  constraintsService?: {
    executeHooks(
      event: LifecycleEvent,
      context: {
        event: LifecycleEvent;
        toolName?: string;
        params?: Record<string, unknown>;
        result?: ToolResult;
        loopState?: string;
        budgetState?: BudgetState;
        metadata: Record<string, unknown>;
      }
    ): Promise<{
      proceed: boolean;
      modifiedParams?: Record<string, unknown>;
      replacementResult?: ToolResult;
      reason?: string;
    }>;
  };
  /** P5: EventBus — 用于学习信号收集 */
  eventBus?: {
    emit: (event: string, payload: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => void;
  };
  /** P5: StrategyAdjuster — 策略自适应调整器，消费学习信号 */
  strategyAdjuster?: {
    recordSignal(signal: {
      signalType: 'positive' | 'negative' | 'task_success' | 'task_failure';
      toolName?: string;
      error?: string;
      quality?: number;
      duration?: number;
      timestamp: number;
    }): void;
    getAdjustedToolPriority(tools: string[]): string[];
    getAdjustedReflectionConfig(): {
      enableDeepReflection: boolean;
      maxRetries: number;
    };
  };
  /** P0-3: 工具集注册表 — 按 Agent 角色/场景预组装工具包（优先于全量工具） */
  toolsetRegistry?: {
    resolveToOpenAI(
      id: string,
      toolRegistry: ToolRegistry
    ): Array<Record<string, unknown>>;
    get(id: string): unknown;
  };
  /** P0-3: 当前激活的工具集 id（如 'coding'/'desktop'/'full'） */
  activeToolset?: string;
  /** P0-4: 上下文窗口管理器 — 循环内动态 token 预算管理 + 工具结果截断 */
  contextWindowManager?: ContextWindowManager;
  /** P2.2: 知识图谱提取器 — 从工具结果中自动提取实体和关系，激活知识图谱 */
  knowledgeExtractor?: {
    extractAndStore(text: string, source: string): Promise<void>;
  };
}

/** 默认安全权限集 — 允许只读、记忆写入、文件读写、代码执行和网络访问 */
const DEFAULT_SAFE_PERMISSIONS: Permission[] = [
  Permission.MEMORY_READ,
  Permission.MEMORY_WRITE,
  Permission.FILE_READ,
  Permission.FILE_WRITE,
  Permission.CODE_EXECUTE,
  Permission.NETWORK_ACCESS,
];

/** 默认限制 — 放宽以释放 LLM 创造性 */
const HARD_TOOL_LIMIT = 12;
const SOFT_TOOL_LIMIT = 6;
const TOOL_TIMEOUT_MS = 30000;
const TOKEN_WARNING = 6000;
const MAX_TOOL_OUTPUT = 6000;

/**
 * P0-1: 结构化错误分类 — 参考 Hermes error_classifier
 *
 * 每种分类对应不同的恢复策略:
 *   - retryable: 瞬时网络错误 → 指数退避重试
 *   - rate_limited: 429 → 长退避后重试
 *   - overloaded: 503 → 退避重试
 *   - non_retryable: 认证/权限/参数错误 → 不重试
 *   - context_overflow: 上下文超限 → 触发压缩（非故障转移）
 *   - content_policy: 内容策略阻止 → 确定性失败，不重试
 *   - billing: 计费错误 → 轮换凭证/模型
 *   - model_not_found: 模型未找到 → 回退模型
 */
export type ErrorType =
  | 'retryable'
  | 'non_retryable'
  | 'rate_limited'
  | 'overloaded'
  | 'context_overflow'
  | 'content_policy'
  | 'billing'
  | 'model_not_found';

/**
 * 判断错误类型是否可重试（工具层面）
 *
 * context_overflow 虽然不可重试工具，但会触发上下文压缩恢复
 */
function isRetryableErrorType(type: ErrorType): boolean {
  return (
    type === 'retryable' || type === 'rate_limited' || type === 'overloaded'
  );
}

/**
 * L4: 降级替代工具映射表
 * 当主工具失败时，按顺序尝试替代工具
 */
interface ToolAlternative {
  tool: string;
  argTransform: (args: Record<string, unknown>) => Record<string, unknown>;
  reason: string;
}

const TOOL_ALTERNATIVES: Record<string, ToolAlternative[]> = {
  file_read: [
    {
      tool: 'file_search',
      argTransform: (args) => ({ pattern: args.path || args.pattern || '*' }),
      reason: 'file_read 失败，降级为 file_search 查找相似路径',
    },
    {
      tool: 'shell_exec',
      argTransform: (args) => ({ command: `cat ${args.path || ''}` }),
      reason: 'file_read 失败，降级为 shell_exec cat 读取文件',
    },
  ],
  web_fetch: [
    {
      tool: 'web_search',
      argTransform: (args) => ({ query: args.url || args.query || '' }),
      reason: 'web_fetch 失败，降级为 web_search 搜索相关内容',
    },
  ],
  grep: [
    {
      tool: 'shell_exec',
      argTransform: (args) => ({
        command: `grep -r "${args.pattern || ''}" ${args.path || '.'}`,
      }),
      reason: 'grep 失败，降级为 shell_exec grep',
    },
  ],
  file_write: [
    {
      tool: 'shell_exec',
      argTransform: (args) => ({
        command: `echo "${args.content || ''}" > ${args.path || ''}`,
      }),
      reason: 'file_write 失败，降级为 shell_exec echo 重定向',
    },
  ],
  list_directory: [
    {
      tool: 'shell_exec',
      argTransform: (args) => ({ command: `ls -la ${args.path || '.'}` }),
      reason: 'list_directory 失败，降级为 shell_exec ls',
    },
  ],
  execute_code: [
    {
      tool: 'shell_exec',
      argTransform: (args) => ({ command: args.code || args.command || '' }),
      reason: 'execute_code 失败，降级为 shell_exec 直接执行',
    },
  ],
  web_search: [
    {
      tool: 'web_fetch',
      argTransform: (args) => ({
        url: `https://www.google.com/search?q=${encodeURIComponent(String(args.query || ''))}`,
      }),
      reason: 'web_search 失败，降级为 web_fetch 直接抓取搜索结果',
    },
  ],
  shell_exec: [
    {
      tool: 'execute_code',
      argTransform: (args) => ({ code: args.command || '', language: 'bash' }),
      reason: 'shell_exec 失败，降级为 execute_code 执行',
    },
  ],
};

export class Executor {
  /** L4: 降级替代工具映射表（静态访问） */
  static readonly TOOL_ALTERNATIVES = TOOL_ALTERNATIVES;

  private deps: ExecutorDeps;

  /** P4: 执行质量历史 — 用于步骤级精细调整判断连续失败 */
  private executionQualityHistory?: Array<{
    score: number;
    isSufficient: boolean;
  }>;

  /** P3: 策略配置 — 由 StrategyAdjuster 下发，控制自适应行为 */
  private strategyConfig?: {
    enableAdaptiveControl?: boolean;
    qualityThreshold?: number;
  };

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /**
   * 执行 FC 循环
   */
  async execute(
    plan: ExecutionPlan,
    context: LoopContext
  ): Promise<ExecutorOutput> {
    // P0-3: 优先使用工具集（按 Agent 角色预组装），避免把全部工具传给 LLM
    let allTools: Array<Record<string, unknown>>;
    if (this.deps.toolsetRegistry && this.deps.activeToolset) {
      const toolsetTools = this.deps.toolsetRegistry.resolveToOpenAI(
        this.deps.activeToolset,
        this.deps.toolRegistry
      );
      if (toolsetTools.length > 0) {
        allTools = toolsetTools;
        Logger.info(
          `📦 使用工具集 ${this.deps.activeToolset}: ${allTools.length} 个工具`,
          'Executor'
        );
      } else {
        allTools = this.deps.toolRegistry.toOpenAITools() as unknown as Array<
          Record<string, unknown>
        >;
      }
    } else {
      // 只使用 ToolRegistry（Harness 工具），SkillRegistry 中的基础设施工具已通过
      // syncToLegacySkillRegistry 同步，不重复传入以免 LLM 看到重复工具
      allTools = this.deps.toolRegistry.toOpenAITools() as unknown as Array<
        Record<string, unknown>
      >;
    }

    // 工具调用守卫：去重 + 缓存 + 速率限制
    const toolCallGuard = new ToolCallGuard();

    const recommendedSet = new Set(plan.recommendedTools);
    let effectiveTools = allTools;

    // 推荐工具仅作为提示，不强制过滤 — 释放 LLM 创造性
    // 当工具数 > 16 时才做意图过滤，避免 LLM 选择空间过大
    if (recommendedSet.size > 0 && allTools.length > 16) {
      // 保留推荐工具 + 通用工具，而非只保留推荐工具
      const generalTools = new Set([
        'web_search',
        'memory_store',
        'memory_search',
        'system_status',
        'file_list',
        'file_search',
        'file_read',
      ]);
      effectiveTools = allTools.filter((t) => {
        const name =
          (t as { function?: { name?: string } }).function?.name || '';
        return recommendedSet.has(name) || generalTools.has(name);
      });
    }

    // Pattern 5.3: Progressive tool disclosure — 工具数 > 16 时按意图过滤
    if (recommendedSet.size === 0 && allTools.length > 16) {
      const intentTools = this.filterToolsByIntent(
        (context.metadata.input as string) || '',
        allTools
      );
      if (intentTools.length > 0 && intentTools.length < allTools.length) {
        effectiveTools = intentTools;
        Logger.info(
          `🔧 意图过滤: ${allTools.length} → ${effectiveTools.length} 个工具`,
          'Executor'
        );
      }
    }

    // P5: 策略自适应 — 基于学习信号调整工具优先级（学习闭环关键环节）
    // 将高成功率的工具排在前面，提升 LLM 选择到可靠工具的概率
    if (this.deps?.strategyAdjuster && effectiveTools.length > 1) {
      try {
        const toolNames = effectiveTools.map(
          (t) => (t as { function?: { name?: string } }).function?.name || ''
        );
        const adjustedPriority =
          this.deps.strategyAdjuster.getAdjustedToolPriority(toolNames);
        effectiveTools.sort((a, b) => {
          const nameA =
            (a as { function?: { name?: string } }).function?.name || '';
          const nameB =
            (b as { function?: { name?: string } }).function?.name || '';
          const idxA = adjustedPriority.indexOf(nameA);
          const idxB = adjustedPriority.indexOf(nameB);
          return (
            (idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA) -
            (idxB === -1 ? Number.MAX_SAFE_INTEGER : idxB)
          );
        });
        Logger.debug(
          `📊 P5 策略自适应: 工具优先级已按成功率重排序`,
          'Executor'
        );
      } catch {
        // 忽略策略调整失败，保持原始顺序
      }
    }

    const toolChoice: 'required' | 'auto' | 'none' =
      plan.toolCallMode === 'none' ? 'none' : 'auto';

    // 纯对话模式：不传工具，直接LLM回复
    if (plan.toolCallMode === 'none') {
      Logger.info('💬 纯对话模式: 跳过工具调用', 'Executor');
      try {
        const directResponse = await this.deps.llm.chatWithTools(
          [...context.messages],
          [], // 不传任何工具
          2048,
          'none'
        );
        const messages = [...context.messages];
        if (directResponse.content) {
          messages.push({ role: 'assistant', content: directResponse.content });
        }
        return {
          messages,
          toolCallsCount: 0,
          toolDuration: 0,
          completedNaturally: true,
          estimatedTokens: this.estimateMessagesTokens(messages),
        };
      } catch (error) {
        Logger.error('❌ 纯对话模式LLM调用失败', error as Error, 'Executor');
        return {
          messages: [...context.messages],
          toolCallsCount: 0,
          toolDuration: 0,
          completedNaturally: false,
        };
      }
    }

    let messages = [...context.messages];
    let loopCount = 0;
    let totalToolCalls = 0;
    let totalToolDuration = 0;

    if (plan.toolCallMode === 'required') {
      const toolNames = effectiveTools
        .map(
          (t) => (t as { function?: { name?: string } }).function?.name || ''
        )
        .join('、');
      messages.push({
        role: 'system',
        content: `可用工具: [${toolNames}]

请分析用户请求，选择合适的工具完成任务。你可以自由组合工具实现最佳效果。
注意：web_search 最多2次，不要重复调用同一工具。`,
      });
    }

    // 进化闭环：注入工具可靠性提示（仅在成功率极低时提示，避免过度约束）
    const unreliableTools = this.deps.toolRegistry
      .getReliabilityTracker()
      .getUnreliableTools(0.5);
    if (unreliableTools.length > 0) {
      messages.push({
        role: 'system',
        content: `以下工具成功率偏低，可考虑替代方案：${unreliableTools.join('、')}`,
      });
    }

    // 注入文件搜索参数提示（仅当 Planner 检测到语言关键词时）
    if (plan.steps && plan.steps.length > 0) {
      const firstStep = plan.steps[0];
      if (
        firstStep.toolName === 'file_search' &&
        firstStep.toolParams &&
        firstStep.toolParams.filePattern
      ) {
        const filePattern = firstStep.toolParams.filePattern as string;
        messages.push({
          role: 'system',
          content: `搜索时请使用 filePattern="${filePattern}"`,
        });
        Logger.info(
          `📋 Executor: 注入 filePattern 提示: ${filePattern}`,
          'Executor'
        );
      }
    }

    // P1.3: ReAct 推理步骤显式化 — 首次 LLM 调用前注入推理提示（auto/required 模式）
    if (toolChoice !== 'none') {
      messages.push({
        role: 'system',
        content:
          '【ReAct 推理】请先进行推理（Thought），分析当前任务和可用工具，再决定下一步行动（Action）。',
      });
    }

    // 首次 LLM 调用
    let fcResponse;
    try {
      Logger.info(
        `🤖 Executor: 开始首次 LLM 调用 (消息数=${messages.length}, 工具数=${effectiveTools.length}, tool_choice=${toolChoice})`,
        'Executor'
      );
      fcResponse = await this.deps.llm.chatWithTools(
        messages,
        effectiveTools,
        4096,
        toolChoice
      );
      Logger.info(`✅ Executor: LLM 调用成功`, 'Executor');
    } catch (error) {
      Logger.error(
        `❌ Executor: 首次 LLM 调用失败`,
        error as Error,
        'Executor'
      );
      return {
        messages,
        toolCallsCount: 0,
        toolDuration: 0,
        completedNaturally: false,
      };
    }

    if (
      effectiveTools.length > 0 &&
      (!fcResponse.toolCalls || fcResponse.toolCalls.length === 0)
    ) {
      const parsedTools = this.parseToolCallsFromText(
        fcResponse.content || '',
        effectiveTools
      );
      if (parsedTools.length > 0) {
        Logger.info(
          `🔧 从文本中解析出 ${parsedTools.length} 个工具调用，手动执行`,
          'Executor'
        );
        fcResponse.toolCalls = parsedTools;
      } else {
        Logger.warn(
          '⚠️ LLM 未调工具且文本中无法解析工具调用，添加明确指令重试',
          'Executor'
        );
        messages.push({
          role: 'user',
          content:
            '请调用工具来完成操作。可用的工具已在系统提示中列出。请返回一个具体的工具调用。',
        });
        try {
          fcResponse = await this.deps.llm.chatWithTools(
            messages,
            effectiveTools,
            4096,
            'auto'
          );
        } catch {
          fcResponse = { content: null, toolCalls: undefined };
        }
      }
    }

    // FC 循环
    // 无进展打断检测
    let lastToolNames = '';
    let stallCount = 0;
    let toolCallCounter = 0;
    const MAX_STALL = 3; // 连续3轮相同工具 → 打断
    const toolCallCounts = new Map<string, number>(); // 每个工具调用次数
    const MAX_SAME_TOOL = 3; // 同一工具最多调用3次，允许LLM创造性组合

    while (
      fcResponse.toolCalls &&
      fcResponse.toolCalls.length > 0 &&
      loopCount < HARD_TOOL_LIMIT
    ) {
      loopCount++;
      const toolNames = fcResponse.toolCalls
        .map((tc) => tc.function.name)
        .join(', ');
      Logger.info(
        `🔄 第${loopCount}轮: LLM 调用了 ${fcResponse.toolCalls.length} 个工具 [${toolNames}]`,
        'Executor'
      );
      // Fix: push per-round progress to frontend
      void EventBus.emit('agent_execution_update', {
        traceId: context.trace.traceId,
        phase: 'executing',
        status: 'in_progress',
        message: `第${loopCount}轮: 调用 ${fcResponse.toolCalls.length} 个工具 [${toolNames}]`,
        roundsUsed: loopCount,
        toolCallsCount: fcResponse.toolCalls.length,
        timestamp: new Date().toISOString(),
      });

      // 工具调用次数限制：同一工具超过上限时强制跳过
      for (const tc of fcResponse.toolCalls) {
        const name = tc.function.name;
        const count = (toolCallCounts.get(name) || 0) + 1;
        toolCallCounts.set(name, count);
        if (count > MAX_SAME_TOOL) {
          Logger.warn(
            `⚠️ 工具 ${name} 已调用 ${count} 次，超过上限 ${MAX_SAME_TOOL}，强制注入总结指令`,
            'Executor'
          );
          messages.push({
            role: 'system',
            content: `工具 ${name} 已经调用足够次数。请立即基于已有结果直接回复用户，不要再调用任何工具。`,
          });
          // 强制最后一次 LLM 调用不调工具
          try {
            const finalResp = await this.deps.llm.chatWithTools(
              messages,
              effectiveTools,
              4096,
              'none'
            );
            if (finalResp.content) {
              messages.push({ role: 'assistant', content: finalResp.content });
            }
          } catch {
            /* 忽略 */
          }
          return {
            messages,
            toolCallsCount: totalToolCalls,
            toolDuration: totalToolDuration,
            completedNaturally: true,
            estimatedTokens: this.estimateMessagesTokens(messages),
          };
        }
      }

      // 无进展检测：相同工具名集合
      const toolNameSet = fcResponse.toolCalls
        .map((t) => t.function.name)
        .sort()
        .join(',');
      if (toolNameSet === lastToolNames) {
        stallCount++;
        if (stallCount >= MAX_STALL) {
          Logger.warn(
            `⚠️ 检测到无进展循环（连续${MAX_STALL}轮相同的工具集合 [${toolNames}]），强制结束 FC 循环`,
            'Executor'
          );
          // 注入建议让 LLM 做最终总结
          messages.push({
            role: 'system',
            content: `你已经连续调用了${MAX_STALL}次相同工具但没有进展。请立即基于已有的搜索结果直接回复用户，不要再调用任何工具。即使结果不完美，也要给出你最好的总结。`,
          });
          // 最后一次 LLM 调用，强制不调工具
          try {
            const finalResponse = await this.deps.llm.chatWithTools(
              messages,
              effectiveTools,
              4096,
              'none'
            );
            if (finalResponse.content) {
              messages.push({
                role: 'assistant',
                content: finalResponse.content,
              });
            }
          } catch {
            if (fcResponse.content) {
              messages.push({ role: 'assistant', content: fcResponse.content });
            }
          }
          break;
        }
      } else {
        stallCount = 0;
      }
      lastToolNames = toolNameSet;

      // Token 预算管理
      const estimatedTokens = this.estimateMessagesTokens(messages);
      if (estimatedTokens > TOKEN_WARNING) {
        Logger.info(
          `📊 Token 预算警告: 当前约 ${estimatedTokens} tokens，开始压缩`,
          'Executor'
        );
        messages = this.compressMessages(messages, estimatedTokens);
      }

      // 软预算警告（精简，不挤占推理空间）
      if (loopCount >= SOFT_TOOL_LIMIT) {
        messages.push({
          role: 'system',
          content: `已进行 ${loopCount} 轮调用，剩余 ${HARD_TOOL_LIMIT - loopCount} 轮。信息足够时可直接回复。`,
        });
      }

      // 记录 assistant 消息
      messages.push({
        role: 'assistant',
        content: fcResponse.content || null,
        tool_calls:
          fcResponse.toolCalls && fcResponse.toolCalls.length > 0
            ? fcResponse.toolCalls
            : undefined,
      });

      // 并行执行工具调用
      const toolPromises = fcResponse.toolCalls.map(async (toolCall) => {
        const toolStart = Date.now();
        const toolName = toolCall.function.name;
        const currentStepIndex = toolCallCounter++;
        this.traceToolCall(
          toolCall,
          'started',
          context.trace.traceId,
          undefined,
          undefined,
          undefined,
          currentStepIndex
        );

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          // P0-2: 尝试修复模型生成的错误 JSON（参考 Hermes _repair_tool_call_arguments）
          const repaired = this.repairToolCallArguments(
            toolCall.function.arguments
          );
          if (repaired) {
            Logger.info(
              `🔧 已自动修复工具 ${toolName} 的参数 JSON`,
              'Executor'
            );
            args = repaired;
          } else {
            args = {};
          }
        }

        // 工具调用守卫：去重 + 缓存 + 速率限制
        const guardCheck = toolCallGuard.check(toolName, args);
        if (guardCheck.blocked && guardCheck.result) {
          Logger.info(
            `🛡️ 工具守卫拦截: ${toolName} — ${guardCheck.reason}`,
            'Executor'
          );
          this.traceToolCall(
            toolCall,
            'completed',
            context.trace.traceId,
            0,
            true,
            undefined,
            currentStepIndex
          );
          return {
            toolCall,
            result:
              typeof guardCheck.result.output === 'string'
                ? guardCheck.result.output
                : JSON.stringify(guardCheck.result.output),
            success: true,
            duration: 0,
          };
        }

        const preCheck = await this.runPreChecks(
          toolName,
          args,
          context,
          loopCount
        );
        if (!preCheck.proceed) {
          this.traceToolCall(
            toolCall,
            'failed',
            context.trace.traceId,
            Date.now() - toolStart,
            false,
            preCheck.reason,
            currentStepIndex
          );
          const output = preCheck.replacementResult?.output
            ? typeof preCheck.replacementResult.output === 'string'
              ? preCheck.replacementResult.output
              : JSON.stringify(preCheck.replacementResult.output)
            : `工具调用被拦截: ${preCheck.reason}`;
          return {
            toolCall,
            result: output,
            success: false,
            error: preCheck.reason || '前置检查拦截',
            duration: Date.now() - toolStart,
          };
        }

        try {
          const toolContext: ToolContext = {
            userId: context.metadata.userId as string | undefined,
            traceId: context.trace.traceId,
            permissions: this.resolvePermissions(context),
            metadata: {},
          };
          let execResult: {
            success: boolean;
            output?: unknown;
            error?: string;
          };
          const registeredTool = this.deps.toolRegistry.get(toolName);
          if (registeredTool) {
            execResult = await this.executeWithRetry(
              toolName,
              preCheck.modifiedArgs,
              toolContext
            );
          } else {
            Logger.info(
              `🔧 Harness 未注册该工具，降级到 SkillRegistry: ${toolName}`,
              'Executor'
            );
            const skillContext: SkillContext = {
              userId: context.metadata.userId as string | undefined,
              traceId: context.trace.traceId,
              sessionData: context.metadata as Record<string, unknown>,
            };
            execResult = await Promise.race([
              SkillRegistry.getInstance().executeToolCall(
                toolCall,
                skillContext
              ),
              this.createTimeoutPromise(TOOL_TIMEOUT_MS, toolName),
            ]);
          }

          const toolDuration = Date.now() - toolStart;
          totalToolDuration += toolDuration;
          totalToolCalls++;

          const toolResult: ToolResult = {
            success: execResult.success,
            output: execResult.success
              ? typeof execResult.output === 'string'
                ? execResult.output
                : JSON.stringify(execResult.output)
              : `错误: ${execResult.error || '工具执行失败'}`,
            error: execResult.error,
            duration: toolDuration,
            validated: false,
          };
          const postChecked = await this.runPostChecks(
            toolName,
            toolResult,
            context,
            loopCount
          );
          const output = postChecked.success
            ? typeof postChecked.output === 'string'
              ? postChecked.output
              : JSON.stringify(postChecked.output)
            : `错误: ${postChecked.error || '工具执行失败'}`;

          this.traceToolCall(
            toolCall,
            'completed',
            context.trace.traceId,
            toolDuration,
            execResult.success,
            undefined,
            currentStepIndex
          );

          context.trace.trajectory.push({
            type: 'tool_call',
            timestamp: toolStart,
            duration: toolDuration,
            toolName,
            toolParams: preCheck.modifiedArgs,
            metadata: { toolCallId: toolCall.id },
          });
          context.trace.trajectory.push({
            type: 'tool_result',
            timestamp: Date.now(),
            duration: 0,
            toolName,
            toolResult: {
              success: execResult.success,
              output,
              error: execResult.error,
              duration: toolDuration,
              validated: true,
              metadata: {},
            },
            metadata: { toolCallId: toolCall.id },
          });
          context.stepResults.set(toolCall.id, {
            stepId: toolCall.id,
            toolName,
            success: execResult.success,
            output,
            duration: toolDuration,
            error: execResult.success ? undefined : execResult.error,
          });

          // 记录到 guard 缓存
          toolCallGuard.record(toolName, args, {
            success: execResult.success,
            output: execResult.output,
            duration: toolDuration,
            validated: true,
          });

          return {
            toolCall,
            result: output,
            success: execResult.success,
            duration: toolDuration,
          };
        } catch (err) {
          const toolDuration = Date.now() - toolStart;
          this.traceToolCall(
            toolCall,
            'failed',
            context.trace.traceId,
            toolDuration,
            false,
            (err as Error).message,
            currentStepIndex
          );

          if (this.deps.hooks?.onToolError) {
            try {
              await this.deps.hooks.onToolError(
                toolName,
                (err as Error).message,
                { traceId: context.trace.traceId, loopCount }
              );
            } catch {
              /* best-effort */
            }
          }

          if (this.deps.constraintsService) {
            try {
              await this.deps.constraintsService.executeHooks(
                LifecycleEvent.ON_ERROR,
                {
                  event: LifecycleEvent.ON_ERROR,
                  toolName,
                  params: preCheck.modifiedArgs,
                  result: {
                    success: false,
                    output: `错误: ${(err as Error).message}`,
                    error: (err as Error).message,
                    duration: toolDuration,
                    validated: false,
                  },
                  metadata: {
                    traceId: context.trace.traceId,
                    loopCount,
                    error: (err as Error).message,
                  },
                }
              );
            } catch {
              /* best-effort */
            }
          }

          context.trace.trajectory.push({
            type: 'tool_call',
            timestamp: toolStart,
            duration: toolDuration,
            toolName,
            toolParams: preCheck.modifiedArgs,
            metadata: { toolCallId: toolCall.id },
          });
          context.trace.trajectory.push({
            type: 'tool_result',
            timestamp: Date.now(),
            duration: 0,
            toolName,
            toolResult: {
              success: false,
              output: `错误: ${(err as Error).message}`,
              error: (err as Error).message,
              duration: toolDuration,
              validated: false,
              metadata: {},
            },
            metadata: { toolCallId: toolCall.id },
          });
          context.stepResults.set(toolCall.id, {
            stepId: toolCall.id,
            toolName,
            success: false,
            output: `错误: ${(err as Error).message}`,
            duration: toolDuration,
            error: (err as Error).message,
          });

          return {
            toolCall,
            result: `错误: ${(err as Error).message}`,
            success: false,
            duration: toolDuration,
          };
        }
      });

      const toolResults = await Promise.all(toolPromises);

      // Fix: push per-tool progress to frontend
      for (const tr of toolResults) {
        void EventBus.emit('agent_execution_update', {
          traceId: context.trace.traceId,
          phase: 'executing',
          status: tr.success ? 'tool_completed' : 'tool_failed',
          message: `${tr.success ? '✅' : '❌'} ${tr.toolCall?.function?.name || 'unknown'}: ${tr.success ? '完成' : tr.error || '失败'}`,
          toolName: tr.toolCall?.function?.name,
          toolSuccess: tr.success,
          duration: tr.duration,
          timestamp: new Date().toISOString(),
        });
      }

      // 将工具结果注入消息（P0-4: 超长结果自动截断 + 预算压力警告）
      for (const tr of toolResults) {
        const toolCallId =
          tr.toolCall?.id ||
          `tc_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let resultContent = tr.result;
        if (this.deps.contextWindowManager && resultContent) {
          const truncated = this.deps.contextWindowManager.truncateToolResult(
            resultContent,
            tr.toolCall?.function?.name
          );
          resultContent = truncated.content;
        }

        // 预算压力警告注入 — 仿 Hermes _budget_warning，让 LLM 感知预算压力并自主调整
        if (context.budget) {
          const constraints = new ConstraintsService({
            permissionGuard: {
              check: () => ({ allowed: true, missing: [] }),
            },
          });
          const pressure = constraints.getBudgetPressure(context.budget);
          const warning = ConstraintsService.formatBudgetWarning(pressure);
          if (warning && resultContent) {
            resultContent += warning;
          }
        }

        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCallId,
          name: tr.toolCall?.function?.name || 'unknown',
          content: resultContent,
        });

        // P2.2: 知识图谱激活 — 从工具结果中自动提取实体和关系
        if (this.deps.knowledgeExtractor && resultContent) {
          try {
            await this.deps.knowledgeExtractor.extractAndStore(
              resultContent,
              tr.toolCall?.function?.name || 'tool_result'
            );
          } catch {
            // 提取失败不影响主流程
          }
        }
      }

      // P1.3: ReAct 观察步骤注入 — 工具结果后注入观察提示，引导 LLM 总结观察结果
      if (toolChoice !== 'none') {
        messages.push({
          role: 'system',
          content:
            '【ReAct 观察】请根据上述工具执行结果进行观察（Observation），总结关键信息，并推理下一步行动。',
        });
      }

      // P0-4: 上下文窗口管理 — 下一轮 LLM 调用前检查 token 预算
      if (this.deps.contextWindowManager) {
        const beforeLen = messages.length;
        messages = this.deps.contextWindowManager.manageWindow(messages);
        if (messages.length < beforeLen) {
          const usage = this.deps.contextWindowManager.getUsage(messages);
          Logger.info(
            `📊 P0-4 上下文窗口管理: ${beforeLen} → ${messages.length} 条消息 (使用率 ${(usage.ratio * 100).toFixed(0)}%)`,
            'Executor'
          );
        }
      }

      // 下一轮 LLM 调用
      try {
        Logger.info(
          `🤖 Executor: 开始第${loopCount + 1}轮 LLM 调用`,
          'Executor'
        );
        fcResponse = await this.deps.llm.chatWithTools(
          messages,
          effectiveTools,
          4096,
          toolChoice
        );
        Logger.info(
          `✅ Executor: 第${loopCount + 1}轮 LLM 调用成功`,
          'Executor'
        );
      } catch (error) {
        Logger.error(
          `❌ Executor: 第${loopCount + 1}轮 LLM 调用失败，终止循环`,
          error as Error,
          'Executor'
        );
        // 错误时终止循环，返回已有结果
        break;
      }
    }

    // 如果 LLM 返回了文本响应（没有 tool_calls），追加到消息
    if (fcResponse.content && !fcResponse.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: fcResponse.content,
      });
    }

    const estimatedTokens = this.estimateMessagesTokens(messages);

    return {
      messages,
      toolCallsCount: totalToolCalls,
      toolDuration: totalToolDuration,
      completedNaturally: loopCount < HARD_TOOL_LIMIT,
      estimatedTokens,
    };
  }

  /**
   * 统一前置检查管线：hooks → Schema 验证 → 权限检查
   * @param toolName - 工具名称
   * @param args - 原始参数
   * @param context - 循环上下文
   * @param loopCount - 当前循环计数
   * @returns 检查结果，包含是否继续、修改后参数及可能的替换结果
   */
  private async runPreChecks(
    toolName: string,
    args: Record<string, unknown>,
    context: LoopContext,
    loopCount: number
  ): Promise<{
    proceed: boolean;
    modifiedArgs: Record<string, unknown>;
    replacementResult?: ToolResult;
    reason?: string;
  }> {
    let modifiedArgs = args;

    if (this.deps.hooks?.beforeToolCall) {
      const hookResult = await this.deps.hooks.beforeToolCall(
        toolName,
        modifiedArgs,
        { traceId: context.trace.traceId, loopCount }
      );
      if (!hookResult.proceed) {
        return {
          proceed: false,
          modifiedArgs,
          replacementResult: hookResult.replacementResult,
          reason: hookResult.reason,
        };
      }
      if (hookResult.modifiedParams) {
        modifiedArgs = hookResult.modifiedParams;
      }
    }

    if (this.deps.constraintsService) {
      const hookResult = await this.deps.constraintsService.executeHooks(
        LifecycleEvent.BEFORE_TOOL_CALL,
        {
          event: LifecycleEvent.BEFORE_TOOL_CALL,
          toolName,
          params: modifiedArgs,
          metadata: {
            traceId: context.trace.traceId,
            loopCount,
            loopState: context.trace.state,
          },
        }
      );
      if (!hookResult.proceed) {
        return {
          proceed: false,
          modifiedArgs,
          replacementResult: hookResult.replacementResult,
          reason: hookResult.reason,
        };
      }
      if (hookResult.modifiedParams) {
        modifiedArgs = hookResult.modifiedParams;
      }
    }

    const registeredTool = this.deps.toolRegistry.get(toolName);
    if (registeredTool) {
      const validation = this.deps.schemaValidator.validate(
        modifiedArgs,
        registeredTool.definition.parameters,
        registeredTool.definition.requiredParams
      );
      if (!validation.valid && validation.sanitizedParams) {
        modifiedArgs = validation.sanitizedParams;
      }
    }

    if (registeredTool) {
      const toolContext: ToolContext = {
        userId: context.metadata.userId as string | undefined,
        traceId: context.trace.traceId,
        permissions: this.resolvePermissions(context),
        metadata: {},
      };
      const permCheck = this.deps.permissionGuard.check(
        toolName,
        registeredTool.definition.requiredPermissions,
        registeredTool.definition.riskLevel,
        toolContext
      );
      if (!permCheck.allowed) {
        return {
          proceed: false,
          modifiedArgs,
          replacementResult: {
            success: false,
            output: `权限不足: ${permCheck.reason}`,
            error: permCheck.reason,
            duration: 0,
            validated: false,
          },
          reason: permCheck.reason,
        };
      }
    }

    return { proceed: true, modifiedArgs };
  }

  /**
   * 统一后置检查管线：hooks.afterToolCall 输出安全检查 + constraintsService AFTER_TOOL_CALL
   * @param toolName - 工具名称
   * @param result - 工具执行结果
   * @param context - 循环上下文
   * @param loopCount - 当前循环计数
   * @returns 经过后置检查的结果
   */
  private async runPostChecks(
    toolName: string,
    result: ToolResult,
    context: LoopContext,
    loopCount: number
  ): Promise<ToolResult> {
    let output =
      typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output);

    if (this.deps.hooks?.afterToolCall) {
      const hookResult = await this.deps.hooks.afterToolCall(
        toolName,
        { ...result, output },
        { traceId: context.trace.traceId, loopCount }
      );
      output =
        typeof hookResult.output === 'string'
          ? hookResult.output
          : JSON.stringify(hookResult.output);
    }

    if (this.deps.constraintsService) {
      try {
        const hookResult = await this.deps.constraintsService.executeHooks(
          LifecycleEvent.AFTER_TOOL_CALL,
          {
            event: LifecycleEvent.AFTER_TOOL_CALL,
            toolName,
            result: { ...result, output },
            metadata: {
              traceId: context.trace.traceId,
              loopCount,
              success: result.success,
            },
          }
        );
        if (!hookResult.proceed) {
          output = hookResult.replacementResult
            ? typeof hookResult.replacementResult.output === 'string'
              ? hookResult.replacementResult.output
              : JSON.stringify(hookResult.replacementResult.output)
            : output;
        }
      } catch {
        /* best-effort */
      }
    }

    return { ...result, output, validated: true };
  }

  /**
   * 分类错误类型
   * @param error - 错误信息
   * @returns 错误分类
   */
  private classifyError(error: string): ErrorType {
    // P0-1: 扩展错误分类 — 参考 Hermes error_classifier 的结构化分类
    // 检测顺序: 确定性失败 > 上下文超限 > 速率限制 > 过载 > 可重试 > 默认

    // 1. 内容策略阻止 — 确定性失败，绝不重试（避免浪费配额）
    if (
      /content.?policy|content.?filter|safety|moderation|内容策略|内容过滤/i.test(
        error
      )
    ) {
      return 'content_policy';
    }

    // 2. 计费错误 — 立即轮换凭证/模型，不重试当前
    if (
      /402|billing|payment|quota.*exceeded|insufficient.*balance|计费|余额不足|配额用尽/i.test(
        error
      )
    ) {
      return 'billing';
    }

    // 3. 模型未找到 — 回退到其他模型，不重试当前
    if (
      /404|model.*not.*found|model.*unavailable|does.*not.*exist|模型.*未找到|模型.*不存在/i.test(
        error
      )
    ) {
      return 'model_not_found';
    }

    // 4. 上下文超限 — 触发压缩而非故障转移（特殊恢复策略）
    if (
      /context.*length|max.*tokens|context.*window|too.*long|上下文.*超|超出.*长度|token.*limit/i.test(
        error
      )
    ) {
      return 'context_overflow';
    }

    // 5. 速率限制 — 退避后重试
    if (
      /429|rate.?limit|too many requests|请求过于频繁|频率限制/i.test(error)
    ) {
      return 'rate_limited';
    }

    // 6. 服务过载 — 退避重试（503 单独分类，便于差异化退避）
    if (/503|overloaded|service.*unavailable|服务.*不可用|过载/i.test(error)) {
      return 'overloaded';
    }

    // 7. 认证/权限/参数错误 — 确定性失败，不重试
    if (
      /permission|auth|invalid.?param|not.?found|权限|认证|参数无效|未找到/i.test(
        error
      )
    ) {
      return 'non_retryable';
    }

    // 8. 瞬时网络错误 — 可重试
    if (/timeout|network|ECONNREFUSED|ETIMEDOUT/i.test(error)) {
      return 'retryable';
    }

    // 9. 默认 — 未知错误视为不可重试（安全默认）
    return 'non_retryable';
  }

  /**
   * L1: 指数退避退避时间计算
   * @param errorType - 错误分类
   * @param attempt - 当前重试次数（从1开始）
   * @returns 退避毫秒数（含30%抖动）
   */
  private calculateBackoff(
    errorType: 'retryable' | 'rate_limited' | 'overloaded',
    attempt: number
  ): number {
    // P0-1: 扩展退避策略 — 不同错误类型差异化退避
    const config = {
      retryable: { base: 500, max: 5000 }, // 网络错误: 快速退避
      rate_limited: { base: 2000, max: 30000 }, // 429: 长退避
      overloaded: { base: 1000, max: 15000 }, // 503: 中等退避
    };
    const { base, max } = config[errorType];
    const exponential = base * Math.pow(2, attempt - 1);
    const capped = Math.min(exponential, max);
    // 30% 抖动 — 避免惊群效应
    const jitter = capped * 0.3 * Math.random();
    return Math.min(capped + jitter, max);
  }

  /**
   * L2: 规则化参数修正 — 基于常见错误模式自动修正参数
   * @param toolName - 工具名称
   * @param args - 原始参数
   * @param error - 错误信息
   * @returns 修正后的参数，无规则匹配时返回 null
   */
  private attemptRuleBasedParamFix(
    toolName: string,
    args: Record<string, unknown>,
    _error: string
  ): Record<string, unknown> | null {
    const fixed = { ...args };

    // 规则1: 路径分隔符修正（Windows \ → /）
    if (typeof fixed.path === 'string' && fixed.path.includes('\\')) {
      fixed.path = fixed.path.replace(/\\/g, '/');
      return fixed;
    }

    // 规则2: 去除 file:// 协议前缀
    if (typeof fixed.path === 'string' && fixed.path.startsWith('file://')) {
      fixed.path = fixed.path.replace(/^file:\/\/+/, '/');
      return fixed;
    }

    // 规则3: 字符串数字转数字（limit/count/timeout 等数值参数）
    const numericParams = ['limit', 'count', 'timeout', 'maxResults', 'offset'];
    for (const param of numericParams) {
      if (
        typeof fixed[param] === 'string' &&
        /^\d+$/.test(fixed[param] as string)
      ) {
        fixed[param] = parseInt(fixed[param] as string, 10);
        return fixed;
      }
    }

    // 规则4: JSON字符串参数解析
    if (typeof fixed.data === 'string') {
      try {
        const trimmed = (fixed.data as string).trim();
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          fixed.data = JSON.parse(trimmed);
          return fixed;
        }
      } catch {
        // JSON 解析失败，跳过
      }
    }

    // 规则5: 搜索类工具去除首尾空白
    if (
      (toolName === 'web_search' || toolName === 'file_search') &&
      typeof fixed.query === 'string'
    ) {
      const trimmed = (fixed.query as string).trim();
      if (trimmed !== fixed.query) {
        fixed.query = trimmed;
        return fixed;
      }
    }

    // 规则6: URL补全协议
    if (typeof fixed.url === 'string') {
      const url = fixed.url as string;
      if (!/^https?:\/\//i.test(url) && /^[\w.-]+\.[a-z]{2,}/i.test(url)) {
        fixed.url = `https://${url}`;
        return fixed;
      }
    }

    return null;
  }

  /**
   * L3: LLM辅助参数修正 — 当L2规则修正失败时，请求LLM分析错误并建议修正参数
   * @param toolName - 工具名称
   * @param args - 当前参数
   * @param error - 错误信息
   * @param errorType - 错误类型
   * @returns 修正后的参数，或null表示无法修正
   */
  private async attemptLLMParamFix(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    errorType: string
  ): Promise<Record<string, unknown> | null> {
    if (!this.deps?.llm) return null;

    try {
      const prompt = `工具 "${toolName}" 执行失败。
当前参数: ${JSON.stringify(args)}
错误类型: ${errorType}
错误信息: ${error}

请分析错误原因，并返回修正后的参数JSON。如果无法修正，返回null。
只返回JSON对象，不要其他内容。格式: {"参数名": "修正值"}`;

      const response = await this.deps.llm.chatWithTools(
        [{ role: 'user', content: prompt }],
        [],
        500,
        'none'
      );

      const content = response.content?.trim() || '';
      if (!content || content === 'null') return null;

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const fixedArgs = JSON.parse(jsonMatch[0]);
      if (typeof fixedArgs === 'object' && fixedArgs !== null) {
        Logger.info(
          `🤖 L3 LLM修正: ${toolName} 参数由 ${JSON.stringify(args)} → ${JSON.stringify(fixedArgs)}`,
          'Executor'
        );
        return fixedArgs as Record<string, unknown>;
      }
    } catch (llmErr) {
      Logger.debug(
        `🤖 L3 LLM参数修正失败: ${(llmErr as Error).message}`,
        'Executor'
      );
    }

    return null;
  }

  /**
   * 带重试的工具执行
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @param context - 工具上下文
   * @param maxRetries - 最大重试次数
   * @returns 工具执行结果
   */
  private async executeWithRetry(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    maxRetries: number = 2
  ): Promise<ToolResult> {
    let lastResult: ToolResult | null = null;
    let retryCount = 0;

    let currentArgs = { ...args };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await Promise.race([
          this.deps.toolRegistry.execute(toolName, currentArgs, context),
          this.createTimeoutPromise(TOOL_TIMEOUT_MS, toolName),
        ]);

        if (result.success) {
          if (retryCount > 0) {
            result.metadata = { ...result.metadata, retryCount };
          }
          // P5: 收集正面学习信号
          if (this.deps?.eventBus) {
            try {
              const {
                collectLearningSignal,
              } = require('../../evolution/LearningSignalCollector');
              collectLearningSignal(this.deps.eventBus, {
                type: 'tool_success',
                toolName,
                duration: result.duration,
                quality:
                  typeof result.metadata?.quality === 'number'
                    ? result.metadata.quality
                    : 0.8,
              });
            } catch {
              // 忽略学习信号收集失败
            }
          }
          // P5: 同步记录到 StrategyAdjuster 以驱动策略自适应
          if (this.deps?.strategyAdjuster) {
            try {
              this.deps.strategyAdjuster.recordSignal({
                signalType: 'positive',
                toolName,
                quality:
                  typeof result.metadata?.quality === 'number'
                    ? result.metadata.quality
                    : 0.8,
                duration: result.duration,
                timestamp: Date.now(),
              });
            } catch {
              // 忽略策略调整失败
            }
          }
          return result;
        }

        lastResult = result;
        const errorType = this.classifyError(result.error || '');

        // P0-1: context_overflow 特殊处理 — 不重试工具，提示上层触发压缩
        if (errorType === 'context_overflow') {
          Logger.warn(
            `📦 检测到上下文超限错误，不重试工具 ${toolName}，建议触发上下文压缩`,
            'Executor'
          );
          if (result.metadata) {
            result.metadata.retryCount = retryCount;
            result.metadata.needsContextCompression = true;
          } else {
            result.metadata = { retryCount, needsContextCompression: true };
          }
          return result;
        }

        // P0-1: billing/model_not_found 特殊日志 — 提示凭证轮换/模型回退
        if (errorType === 'billing') {
          Logger.error(
            `💳 计费错误，建议轮换凭证或模型: ${result.error}`,
            undefined,
            'Executor'
          );
        } else if (errorType === 'model_not_found') {
          Logger.error(
            `🔍 模型未找到，建议回退到其他模型: ${result.error}`,
            undefined,
            'Executor'
          );
        } else if (errorType === 'content_policy') {
          Logger.warn(
            `🚫 内容策略阻止（确定性失败），不重试: ${result.error}`,
            'Executor'
          );
        }

        if (!isRetryableErrorType(errorType) || attempt >= maxRetries) {
          if (result.metadata) {
            result.metadata.retryCount = retryCount;
          } else {
            result.metadata = { retryCount };
          }

          // L4: 降级替代工具 — 重试耗尽后尝试替代工具
          const alternatives = TOOL_ALTERNATIVES[toolName];
          if (alternatives && alternatives.length > 0) {
            for (const alt of alternatives) {
              try {
                const altArgs = alt.argTransform(args);
                Logger.info(
                  `🔄 L4 降级: ${toolName} → ${alt.tool}（${alt.reason}）`,
                  'Executor'
                );
                const altResult = await Promise.race([
                  this.deps.toolRegistry.execute(alt.tool, altArgs, context),
                  this.createTimeoutPromise(TOOL_TIMEOUT_MS, alt.tool),
                ]);
                if (altResult.success) {
                  altResult.metadata = {
                    ...altResult.metadata,
                    retryCount,
                    fallbackFrom: toolName,
                    fallbackReason: alt.reason,
                  };
                  return altResult;
                }
              } catch (altErr) {
                Logger.warn(
                  `🔄 L4 降级 ${alt.tool} 也失败: ${(altErr as Error).message}`,
                  'Executor'
                );
              }
            }
          }

          // P5: 收集负面学习信号
          if (this.deps?.eventBus) {
            try {
              const {
                collectLearningSignal,
              } = require('../../evolution/LearningSignalCollector');
              collectLearningSignal(this.deps.eventBus, {
                type: 'tool_failure',
                toolName,
                error: result.error,
                duration: result.duration,
              });
            } catch {
              // 忽略
            }
          }
          // P5: 同步记录到 StrategyAdjuster 以驱动策略自适应
          if (this.deps?.strategyAdjuster) {
            try {
              this.deps.strategyAdjuster.recordSignal({
                signalType: 'negative',
                toolName,
                error: result.error,
                duration: result.duration,
                timestamp: Date.now(),
              });
            } catch {
              // 忽略策略调整失败
            }
          }
          return result;
        }

        retryCount++;
        // L2: 规则化参数修正 — 重试前尝试自动修正参数
        let fixedArgs: Record<string, unknown> | null = null;
        try {
          fixedArgs = this.attemptRuleBasedParamFix(
            toolName,
            currentArgs,
            result.error || ''
          );
          if (fixedArgs) {
            currentArgs = fixedArgs;
            Logger.info(
              `🔧 L2 参数修正: ${toolName} 参数已自动修正，重试中...`,
              'Executor'
            );
          }
        } catch {
          // 参数修正失败，使用当前参数重试
        }

        // L3: LLM辅助参数修正 — L2规则修正失败时，请求LLM分析错误并建议修正
        if (!fixedArgs && this.deps?.llm && retryCount <= 2) {
          try {
            const llmFix = await this.attemptLLMParamFix(
              toolName,
              currentArgs,
              result.error || '',
              errorType
            );
            if (llmFix) {
              currentArgs = llmFix;
              Logger.info(
                `🤖 L3 LLM参数修正: ${toolName} 参数已由LLM修正，重试中...`,
                'Executor'
              );
            }
          } catch {
            // LLM修正失败，使用当前参数重试
          }
        }

        // P0-1: 使用差异化退避策略（retryable/rate_limited/overloaded）
        const backoffType = (
          ['retryable', 'rate_limited', 'overloaded'] as const
        ).includes(errorType as 'retryable' | 'rate_limited' | 'overloaded')
          ? (errorType as 'retryable' | 'rate_limited' | 'overloaded')
          : 'retryable';
        const backoffMs = this.calculateBackoff(backoffType, retryCount);
        Logger.info(
          `🔄 工具 ${toolName} 执行失败(${errorType})，第${retryCount}次重试，退避 ${Math.round(backoffMs)}ms...`,
          'Executor'
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      } catch (err) {
        const errorMessage = (err as Error).message;
        const errorType = this.classifyError(errorMessage);

        lastResult = {
          success: false,
          output: null,
          error: errorMessage,
          duration: 0,
          validated: false,
          metadata: { retryCount },
        };

        // P0-1: context_overflow 特殊处理 — 标记需要上下文压缩
        if (errorType === 'context_overflow') {
          Logger.warn(
            `📦 检测到上下文超限异常，不重试工具 ${toolName}，建议触发上下文压缩`,
            'Executor'
          );
          lastResult.metadata = {
            ...lastResult.metadata,
            needsContextCompression: true,
          };
          return lastResult;
        }

        if (!isRetryableErrorType(errorType) || attempt >= maxRetries) {
          // P5: 收集负面学习信号
          if (this.deps?.eventBus) {
            try {
              const {
                collectLearningSignal,
              } = require('../../evolution/LearningSignalCollector');
              collectLearningSignal(this.deps.eventBus, {
                type: 'tool_failure',
                toolName,
                error: lastResult.error,
                duration: lastResult.duration,
              });
            } catch {
              // 忽略
            }
          }
          // P5: 同步记录到 StrategyAdjuster
          if (this.deps?.strategyAdjuster) {
            try {
              this.deps.strategyAdjuster.recordSignal({
                signalType: 'negative',
                toolName,
                error: lastResult.error,
                duration: lastResult.duration,
                timestamp: Date.now(),
              });
            } catch {
              // 忽略策略调整失败
            }
          }
          return lastResult;
        }

        retryCount++;
        Logger.info(
          `🔄 工具 ${toolName} 执行异常(可重试错误)，第${retryCount}次重试...`,
          'Executor'
        );
        await new Promise((resolve) => setTimeout(resolve, 500 * retryCount));
      }
    }

    // P5: 收集负面学习信号（重试耗尽）
    if (this.deps?.eventBus && lastResult) {
      try {
        const {
          collectLearningSignal,
        } = require('../../evolution/LearningSignalCollector');
        collectLearningSignal(this.deps.eventBus, {
          type: 'tool_failure',
          toolName,
          error: lastResult.error,
          duration: lastResult.duration,
        });
      } catch {
        // 忽略
      }
    }
    // P5: 同步记录到 StrategyAdjuster（重试耗尽）
    if (this.deps?.strategyAdjuster && lastResult) {
      try {
        this.deps.strategyAdjuster.recordSignal({
          signalType: 'negative',
          toolName,
          error: lastResult.error,
          duration: lastResult.duration,
          timestamp: Date.now(),
        });
      } catch {
        // 忽略策略调整失败
      }
    }

    return (
      lastResult || {
        success: false,
        output: null,
        error: '工具执行失败：重试次数耗尽',
        duration: 0,
        validated: false,
        metadata: { retryCount },
      }
    );
  }

  /**
   * 构建计划上下文注入消息
   */
  private buildPlanContext(plan: ExecutionPlan): string {
    const steps = plan.steps
      .map(
        (s, i) =>
          `${i + 1}. ${s.description}${s.toolName ? ` (使用 ${s.toolName})` : ''}`
      )
      .join('\n');

    return `【执行计划】\n以下是建议的执行步骤，请按需执行：\n${steps}\n\n你可以根据实际情况调整执行顺序或跳过不需要的步骤。`;
  }

  /**
   * 验证工具输出
   */
  private validateToolOutput(result: {
    success: boolean;
    output?: unknown;
    error?: string;
  }): string {
    if (!result.success) {
      return `错误: ${result.error || '工具执行失败'}`;
    }

    const outputStr =
      typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output);

    if (!outputStr || outputStr.trim().length === 0) {
      return '工具返回了空结果';
    }

    if (outputStr.length > MAX_TOOL_OUTPUT) {
      return outputStr.substring(0, MAX_TOOL_OUTPUT) + '\n...[内容已截断]';
    }

    return outputStr;
  }

  /**
   * 估算消息 token 数 (改进版：区分中英文)
   *
   * 估算规则：
   * - 英文：约 4 字符 ≈ 1 token
   * - 中文：约 2 字符 ≈ 1 token (中文信息密度更高)
   * - 代码：约 4 字符 ≈ 1 token
   * - 数字/标点：约 3 字符 ≈ 1 token
   */
  private estimateMessagesTokens(messages: ChatMessage[]): number {
    let totalTokens = 0;

    for (const msg of messages) {
      totalTokens += 10;

      if (msg.content) {
        totalTokens += this.countTokens(msg.content);
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls as Array<{
          function: { name: string; arguments: string };
        }>) {
          totalTokens += 4;
          if (tc.function?.name) {
            totalTokens += this.countTokens(tc.function.name);
          }
          if (tc.function?.arguments) {
            totalTokens += this.countTokens(tc.function.arguments);
          }
        }
      }

      if (msg.name) {
        totalTokens += this.countTokens(msg.name);
      }
    }

    return Math.ceil(totalTokens);
  }

  /**
   * 计算文本的 token 估算数
   *
   * 改进版估算算法，区分中英文和特殊内容：
   * - 中文（CJK统一表意文字）：约 2 字符 ≈ 1 token
   * - 英文单词：约 4 字符 ≈ 1 token
   * - 数字：约 4 字符 ≈ 1 token
   * - 代码/符号：约 2 字符 ≈ 1 token
   * - JSON字符串：特殊处理
   */
  private countTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    let chineseChars = 0;
    let englishChars = 0;
    let digitChars = 0;
    let codeChars = 0;
    let otherChars = 0;

    let inCodeBlock = false;
    let inJson = false;
    let jsonDepth = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const code = text.charCodeAt(i);

      if (
        char === '`' &&
        i < text.length - 2 &&
        text.substring(i, i + 3) === '```'
      ) {
        inCodeBlock = !inCodeBlock;
        i += 2;
        continue;
      }

      if (inCodeBlock) {
        codeChars++;
        continue;
      }

      if (char === '{' || char === '[') {
        jsonDepth++;
        inJson = jsonDepth > 0;
      } else if (char === '}' || char === ']') {
        jsonDepth--;
        if (jsonDepth <= 0) {
          inJson = false;
          jsonDepth = 0;
        }
      }

      if (inJson && (char === ':' || char === ',' || char === '"')) {
        codeChars++;
        continue;
      }

      if (char === '`' && i < text.length - 1 && text[i + 1] === '`') {
        codeChars++;
        i++;
        continue;
      }

      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x2e80 && code <= 0x2eff) ||
        (code >= 0x3000 && code <= 0x303f)
      ) {
        chineseChars++;
      } else if (
        (code >= 0x0041 && code <= 0x005a) ||
        (code >= 0x0061 && code <= 0x007a)
      ) {
        if (i > 0 && englishChars > 0) {
          const prevCode = text.charCodeAt(i - 1);
          if (
            (prevCode >= 0x0041 && prevCode <= 0x005a) ||
            (prevCode >= 0x0061 && prevCode <= 0x007a)
          ) {
          } else {
            englishChars++;
          }
        } else {
          englishChars++;
        }
      } else if (code >= 0x0030 && code <= 0x0039) {
        digitChars++;
      } else if (/[{}()[\];,.<>:\+\-\*\/\\|&\s=]/.test(char)) {
        codeChars++;
      } else if (char === '-' || char === '_' || char === '.') {
        codeChars++;
      } else {
        otherChars++;
      }
    }

    const chineseTokens = Math.ceil(chineseChars / 2);
    const englishTokens = Math.ceil(englishChars / 4);
    const digitTokens = Math.ceil(digitChars / 4);
    const codeTokens = Math.ceil(codeChars / 2);
    const otherTokens = Math.ceil(otherChars / 3);

    return (
      chineseTokens + englishTokens + digitTokens + codeTokens + otherTokens
    );
  }

  /**
   * 压缩消息（保留 system + 最近 4 条非 system）
   */
  private compressMessages(
    messages: ChatMessage[],
    _currentTokens: number
  ): ChatMessage[] {
    if (messages.length <= 5) return messages;

    const systemMessages: ChatMessage[] = [];
    const nonSystemMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        nonSystemMessages.push(msg);
      }
    }

    if (nonSystemMessages.length <= 4) return messages;

    // 修复: 确保保留的消息不会断裂 assistant+tool_calls/tool 配对
    let cutIndex = nonSystemMessages.length - 4;
    // 如果切点处是 tool 消息，向前扩展到包含对应的 assistant+tool_calls
    while (cutIndex > 0 && nonSystemMessages[cutIndex]?.role === 'tool') {
      cutIndex--;
    }
    // 如果切点处是 assistant+tool_calls，向后扩展到包含所有对应的 tool 消息
    if (
      cutIndex > 0 &&
      nonSystemMessages[cutIndex]?.role === 'assistant' &&
      (nonSystemMessages[cutIndex] as { tool_calls?: unknown[] }).tool_calls
    ) {
      let j = cutIndex + 1;
      while (
        j < nonSystemMessages.length &&
        nonSystemMessages[j]?.role === 'tool'
      ) {
        j++;
      }
      // 如果 tool 消息数量少于预期（被截断了），回退到原切点
      if (j <= nonSystemMessages.length - 4) {
        cutIndex = j;
      }
    }

    const keptMessages = nonSystemMessages.slice(cutIndex);
    const removedMessages = nonSystemMessages.slice(0, cutIndex);

    const summaryParts: string[] = [];
    for (const msg of removedMessages) {
      if (msg.role === 'user' && msg.content) {
        summaryParts.push(`用户: ${msg.content.substring(0, 80)}`);
      } else if (msg.role === 'assistant' && msg.content) {
        summaryParts.push(`助手: ${msg.content.substring(0, 80)}`);
      } else if (msg.role === 'tool' && msg.name) {
        summaryParts.push(
          `工具[${msg.name}]: ${(msg.content || '').substring(0, 60)}`
        );
      }
    }

    const result: ChatMessage[] = [];

    const systemContent = systemMessages
      .map((m) => m.content || '')
      .filter(Boolean)
      .join('\n\n');
    if (systemContent) {
      result.push({ role: 'system', content: systemContent });
    }

    if (summaryParts.length > 0) {
      result.push({
        role: 'system',
        content: `【历史摘要（已压缩）】\n${summaryParts.join('\n')}`,
      });
    }

    result.push(...keptMessages);
    return result;
  }

  /**
   * 链路追踪
   */
  private traceToolCall(
    toolCall: { id: string; function: { name: string; arguments: string } },
    status: 'started' | 'completed' | 'failed',
    traceId: string,
    duration?: number,
    success?: boolean,
    errorMessage?: string,
    stepIndex?: number
  ): void {
    const eventBusData = {
      timestamp: new Date().toISOString(),
      traceId,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      status,
      duration: duration || 0,
      success: success !== undefined ? success : null,
      errorMessage: errorMessage || null,
    };

    EventBus.emit('tool_trace', eventBusData);

    if (status === 'started') return;

    if (this.deps.hooks?.recordTrajectory) {
      try {
        this.deps.hooks.recordTrajectory({
          type: 'tool_result',
          timestamp: Date.now(),
          duration: duration || 0,
          toolName: toolCall.function.name,
          toolResult: {
            success: success === true,
            output: status === 'completed' ? '[truncated]' : undefined,
            error: errorMessage,
            duration: duration || 0,
            validated: false,
          },
          metadata: { execution_id: traceId },
        });
      } catch (err) {
        Logger.warn(`⚠️ 轨迹记录失败: ${(err as Error).message}`, 'Executor');
      }
    } else if (this.deps.trajectoryDatabase && traceId) {
      const effectiveStepIndex = stepIndex ?? 0;
      try {
        this.deps.trajectoryDatabase.recordToolInvocation({
          execution_id: traceId,
          step_index: effectiveStepIndex,
          tool_name: toolCall.function.name,
          args_json: toolCall.function.arguments,
          result_success: success === true ? 1 : 0,
          result_output: status === 'completed' ? '[truncated]' : undefined,
          duration: duration || 0,
          error_message: errorMessage || undefined,
          created_at: Date.now(),
        });
      } catch (err) {
        Logger.warn(`⚠️ 轨迹记录失败: ${(err as Error).message}`, 'Executor');
      }
    }
  }

  /**
   * 创建超时 Promise
   */
  private createTimeoutPromise(
    timeoutMs: number,
    toolName: string
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`工具执行超时: ${toolName} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  /**
   * 从 LoopContext 解析用户权限
   * 优先使用 metadata.permissions，否则使用默认安全权限集
   */
  private resolvePermissions(context: LoopContext): Set<Permission> {
    const metaPerms = context.metadata.permissions;
    if (Array.isArray(metaPerms) && metaPerms.length > 0) {
      const validPerms = metaPerms.filter((p: unknown) =>
        Object.values(Permission).includes(p as Permission)
      ) as Permission[];
      if (validPerms.length > 0) {
        return new Set(validPerms);
      }
    }
    return new Set(DEFAULT_SAFE_PERMISSIONS);
  }

  /**
   * P0-2: 修复模型生成的错误 JSON 工具调用参数
   *
   * 已委托给 MessageSanitizer.repairToolCallArguments 统一实现。
   * 参考 Hermes message_sanitization._repair_tool_call_arguments
   *
   * @param raw - 原始参数字符串
   * @returns 修复后的参数对象，修复失败返回 null
   */
  private repairToolCallArguments(raw: string): Record<string, unknown> | null {
    return MessageSanitizer.repairJson(raw);
  }

  /**
   * 从 LLM 文本响应中解析工具调用
   * 当 LLM 用自然语言描述工具调用而非使用 function calling 格式时，
   * 尝试从文本中提取工具名和参数
   */
  private parseToolCallsFromText(
    text: string,
    availableTools: Array<Record<string, unknown>>
  ): Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> {
    const results: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];

    const toolNames = availableTools
      .map((t) => (t as { function?: { name?: string } }).function?.name || '')
      .filter(Boolean);

    if (toolNames.length === 0) return results;

    // 模式1: 代码块中的 JSON - ```json\n{"name": "tool", ...}\n```
    const jsonBlockPattern = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = jsonBlockPattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const name = parsed.name || parsed.tool || parsed.tool_name;
        if (name && toolNames.includes(name)) {
          results.push({
            id: `parsed_${Date.now()}_${results.length}`,
            type: 'function',
            function: {
              name,
              arguments: JSON.stringify(
                parsed.arguments || parsed.params || parsed.args || {}
              ),
            },
          });
        }
      } catch {
        // continue
      }
    }

    if (results.length > 0) return results;

    // 模式2: 行内模式 - 调用 file_read("path/to/file")
    const inlinePattern =
      /(?:调用|使用)\s*(\w+)\s*[\(\（]\s*["\u2018\u201c]?([^"\)\）]+)["\u2019\u201d]?\s*[\)\）]/g;
    while ((match = inlinePattern.exec(text)) !== null) {
      const toolName = match[1];
      const arg = match[2]?.trim();
      if (toolNames.includes(toolName)) {
        const toolDef = availableTools.find(
          (t) =>
            (t as { function?: { name?: string } }).function?.name === toolName
        ) as
          | {
              function?: {
                parameters?: {
                  properties?: Record<string, unknown>;
                  required?: string[];
                };
              };
            }
          | undefined;
        let args: Record<string, unknown> = {};
        if (toolDef?.function?.parameters?.properties) {
          const firstParam = Object.keys(
            toolDef.function.parameters.properties
          )[0];
          if (firstParam && arg) {
            args[firstParam] = arg;
          }
        } else if (arg) {
          args = { value: arg };
        }

        results.push({
          id: `parsed_${Date.now()}_${results.length}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        });
      }
    }

    if (results.length > 0) return results;

    // 模式3: 格式调用 - read_file(path="xxx") 或 search(query="xxx")
    const fmtPattern =
      /(\w+)\s*\(\s*(\w+)\s*=\s*["\u2018\u201c]([^"\)\）]+)["\u2019\u201d]\s*\)/g;
    while ((match = fmtPattern.exec(text)) !== null) {
      const toolName = match[1];
      const paramName = match[2];
      const paramValue = match[3];
      if (toolNames.includes(toolName)) {
        results.push({
          id: `parsed_${Date.now()}_${results.length}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify({ [paramName]: paramValue }),
          },
        });
      }
    }

    return results;
  }

  /**
   * Pattern 5.3: 根据用户意图过滤工具子集
   * 减少 LLM 的选择空间，提高工具选择准确率
   */
  private filterToolsByIntent(
    input: string,
    allTools: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const text = input.toLowerCase();

    // 意图 → 工具名前缀映射（基于 jiabaixing 的 36 工具命名规范）
    const intentMap: Array<{ pattern: RegExp; prefixes: string[] }> = [
      {
        pattern: /审查|review|代码质量|代码检查|安全检查|code\s*review/,
        prefixes: ['code_review'],
      },
      {
        pattern: /搜索|查|找|搜|了解|研究|什么是|怎么样|新闻|天气/,
        prefixes: ['web_', 'memory_search', 'memory_recall'],
      },
      {
        pattern: /文件|目录|读|写|创建|删除|编辑|代码/,
        prefixes: ['file_', 'code_', 'incremental_edit', 'multi_file_edit'],
      },
      { pattern: /桌面|截图|点击|窗口|应用|屏幕/, prefixes: ['desktop_'] },
      {
        pattern: /提醒|日程|任务|计划|日历|笔记/,
        prefixes: ['task_', 'calendar', 'reminder_', 'note_', 'batch_task'],
      },
      { pattern: /记忆|记得|之前|上次|历史/, prefixes: ['memory_'] },
      {
        pattern: /运行|执行|命令|shell|脚本/,
        prefixes: ['shell_exec', 'file_'],
      },
      {
        pattern: /情绪|情感|心情|感觉/,
        prefixes: ['emotion_', 'analyze_scene', 'self_reflect'],
      },
    ];

    for (const { pattern, prefixes } of intentMap) {
      if (pattern.test(text)) {
        return allTools.filter((t) => {
          const name =
            (t as { function?: { name?: string } }).function?.name || '';
          return prefixes.some((prefix) => name.startsWith(prefix));
        });
      }
    }

    return []; // 无法识别意图时不过滤，让 LLM 自己选
  }

  /**
   * P4: 步骤级动态调整 — shouldReplan 增强
   * 基于执行评估历史和轮次使用情况，决定是否需要重规划
   * @param evaluations - 每轮的评估结果
   * @param roundsUsed - 已使用的轮次数
   * @returns 重规划决策，包含是否重规划、原因和调整提示
   */
  public shouldReplan(
    evaluations: Array<{ score: number; isSufficient: boolean }>,
    roundsUsed: number
  ): { shouldReplan: boolean; reason: string; adjustmentHint?: string } {
    const MAX_ROUNDS = 8;
    const CONSECUTIVE_LOW_QUALITY_THRESHOLD = 0.5;
    const CONSECUTIVE_LOW_QUALITY_LIMIT = 3;
    const avgQualityThreshold = this.strategyConfig?.qualityThreshold ?? 0.3;

    // 1. 轮次耗尽
    if (roundsUsed >= MAX_ROUNDS) {
      const adjustment = this.suggestStepAdjustment({
        stepResult: { success: false },
        remainingSteps: [],
        loopCount: roundsUsed,
      });
      return {
        shouldReplan: true,
        reason: '轮次耗尽，需要重规划以达成目标',
        adjustmentHint: adjustment.reason,
      };
    }

    // 2. 最近一步执行失败（score=0）且轮次较早 → 步骤级重规划
    if (evaluations.length > 0 && roundsUsed < 4) {
      const lastEval = evaluations[evaluations.length - 1];
      if (lastEval.score === 0 && !lastEval.isSufficient) {
        const adjustment = this.suggestStepAdjustment({
          stepResult: { success: false, quality: 0 },
          remainingSteps: [],
          loopCount: roundsUsed,
        });
        return {
          shouldReplan: true,
          reason: '最近一步执行失败，需要调整执行策略',
          adjustmentHint: `${adjustment.action}: ${adjustment.reason}`,
        };
      }
    }

    // 3. 连续3次低质量
    if (evaluations.length >= CONSECUTIVE_LOW_QUALITY_LIMIT) {
      const recent = evaluations.slice(-CONSECUTIVE_LOW_QUALITY_LIMIT);
      const allLowQuality = recent.every(
        (e) => e.score < CONSECUTIVE_LOW_QUALITY_THRESHOLD && !e.isSufficient
      );
      if (allLowQuality) {
        const adjustment = this.suggestStepAdjustment({
          stepResult: {
            success: true,
            quality: recent[recent.length - 1].score,
          },
          remainingSteps: [],
          loopCount: roundsUsed,
        });
        return {
          shouldReplan: true,
          reason: '连续低质量执行，当前策略无效，需要重规划',
          adjustmentHint: `${adjustment.action}: ${adjustment.reason}`,
        };
      }
    }

    // 4. 平均质量过低（阈值可由策略配置调整）
    if (evaluations.length >= 2) {
      const avgScore =
        evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length;
      if (avgScore < avgQualityThreshold) {
        const adjustment = this.suggestStepAdjustment({
          stepResult: { success: true, quality: avgScore },
          remainingSteps: [],
          loopCount: roundsUsed,
        });
        return {
          shouldReplan: true,
          reason: `平均质量过低（${avgScore.toFixed(2)} < 阈值 ${avgQualityThreshold}），当前规划路径效果不佳，需要重规划`,
          adjustmentHint: `${adjustment.action}: ${adjustment.reason}`,
        };
      }
    }

    // 5. 正常执行
    return {
      shouldReplan: false,
      reason: '执行质量正常',
    };
  }

  /**
   * P3: 应用策略配置 — 由 StrategyAdjuster 下发，控制自适应行为
   *
   * @param config - 策略配置，包含是否启用自适应控制和质量阈值
   */
  public applyStrategyConfig(config: {
    enableAdaptiveControl?: boolean;
    qualityThreshold?: number;
  }): void {
    this.strategyConfig = {
      ...this.strategyConfig,
      ...config,
    };
    Logger.info(
      `🎛️ 策略配置已应用: adaptiveControl=${this.strategyConfig.enableAdaptiveControl ?? false}, qualityThreshold=${this.strategyConfig.qualityThreshold ?? 0.3}`,
      'Executor'
    );
  }

  /**
   * P2-2: 执行前风险评估 — 识别高风险操作并预警
   *
   * 风险分级：
   *   - high: 不可逆操作（删除、覆盖、系统命令），默认不继续
   *   - medium: 高消耗操作（安装、构建、网络请求），需谨慎
   *   - low: 只读操作，可安全继续
   *
   * @param toolName - 工具名称
   * @param params - 工具参数
   * @returns 风险评估结果
   */
  public async assessExecutionRisk(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<{
    level: 'low' | 'medium' | 'high';
    reason: string;
    shouldProceed: boolean;
  }> {
    const HIGH_RISK_TOOLS = [
      'file_delete',
      'file_overwrite',
      'shell_exec',
      'system_command',
      'git_push',
      'git_reset',
      'db_drop',
      'db_delete',
    ];

    const MEDIUM_RISK_TOOLS = [
      'file_write',
      'incremental_edit',
      'shell_exec',
      'npm_install',
      'npm_run',
      'web_fetch',
      'git_commit',
      'memory_store',
    ];

    const READONLY_TOOLS = [
      'file_read',
      'file_list',
      'file_search',
      'web_search',
      'memory_search',
      'memory_read',
      'system_status',
      'git_diff',
      'git_status',
      'git_log',
    ];

    // 不可逆操作检测
    if (HIGH_RISK_TOOLS.includes(toolName)) {
      const isIrreversible =
        toolName === 'file_delete' ||
        (toolName === 'shell_exec' &&
          typeof params.command === 'string' &&
          /\b(rm|del|format|drop|truncate|kill|shutdown|reboot)\b/i.test(
            params.command
          ));
      if (isIrreversible) {
        return {
          level: 'high',
          reason: `不可逆操作: ${toolName} 可能造成数据永久丢失`,
          shouldProceed: false,
        };
      }
    }

    // 高风险工具但非不可逆 → medium
    if (HIGH_RISK_TOOLS.includes(toolName)) {
      return {
        level: 'medium',
        reason: `高风险工具: ${toolName} 需要谨慎执行`,
        shouldProceed: true,
      };
    }

    // 中风险工具
    if (MEDIUM_RISK_TOOLS.includes(toolName)) {
      return {
        level: 'medium',
        reason: `中等风险: ${toolName} 涉及写入或高消耗操作`,
        shouldProceed: true,
      };
    }

    // 只读工具 → 低风险
    if (READONLY_TOOLS.includes(toolName)) {
      return {
        level: 'low',
        reason: `只读操作: ${toolName} 安全可继续`,
        shouldProceed: true,
      };
    }

    // 未知工具 → 默认中等风险
    return {
      level: 'medium',
      reason: `未知工具: ${toolName}，默认中等风险`,
      shouldProceed: true,
    };
  }

  /**
   * P2-2: 执行后质量评估 — 评估工具结果质量，触发动态重规划
   *
   * 评估维度：
   *   - 成功/失败（失败 → score=0）
   *   - 输出完整性（空输出 → 低分）
   *   - 输出长度与信息量
   *   - 执行耗时（过长 → 扣分）
   *
   * @param toolName - 工具名称
   * @param params - 工具参数
   * @param result - 工具执行结果
   * @returns 质量评估结果
   */
  public async evaluateExecutionQuality(
    toolName: string,
    _params: Record<string, unknown>,
    result: {
      success: boolean;
      output?: string;
      duration?: number;
    }
  ): Promise<{
    score: number;
    isSufficient: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    let score = 1.0;
    const SUFFICIENT_THRESHOLD = 0.4;

    // 1. 失败 → 0 分
    if (!result.success) {
      return {
        score: 0,
        isSufficient: false,
        issues: ['工具执行失败'],
      };
    }

    const output = result.output || '';

    // 2. 空输出 → 严重扣分
    if (!output || output.trim().length === 0) {
      issues.push('空输出');
      score = 0.1;
    } else {
      // 3. 输出长度评分
      const len = output.trim().length;
      if (len < 10) {
        score -= 0.3;
        issues.push('输出过短');
      } else if (len < 50) {
        score -= 0.1;
      }

      // 4. 信息量评分 — 简单启发式
      const hasContent =
        /[a-zA-Z\u4e00-\u9fa5]{5,}/.test(output) ||
        output.split(/\s+/).length > 5;
      if (!hasContent) {
        score -= 0.2;
        issues.push('信息量不足');
      }
    }

    // 5. 耗时评分
    if (result.duration && result.duration > 20000) {
      score -= 0.2;
      issues.push('执行耗时过长');
    } else if (result.duration && result.duration > 10000) {
      score -= 0.1;
    }

    // 钳制到 [0, 1]
    score = Math.max(0, Math.min(1, score));

    return {
      score,
      isSufficient: score >= SUFFICIENT_THRESHOLD,
      issues,
    };
  }

  /**
   * P4: 步骤级精细调整 — 在每步执行后评估并建议后续步骤调整
   *
   * 调整动作：
   * - continue: 继续执行后续步骤
   * - skip: 跳过当前步骤（失败但非关键）
   * - modify: 修正后续步骤参数
   * - insert: 插入新步骤（如搜索/诊断步骤）
   * - terminate: 终止执行（轮次耗尽）
   * @param params - 包含步骤结果、剩余步骤和循环计数
   * @returns 调整建议，包含动作类型、原因及可选的修改提示或新步骤
   */
  private suggestStepAdjustment(params: {
    stepResult: {
      success: boolean;
      error?: string;
      output?: unknown;
      quality?: number;
    };
    remainingSteps: Array<{ tool: string; args: Record<string, unknown> }>;
    loopCount: number;
  }): {
    action: 'continue' | 'skip' | 'modify' | 'insert' | 'terminate';
    reason: string;
    modificationHint?: string;
    newStep?: { tool: string; args: Record<string, unknown> };
  } {
    const { stepResult, remainingSteps, loopCount } = params;

    // 轮次耗尽
    if (loopCount >= 7) {
      return {
        action: 'terminate',
        reason: '轮次即将耗尽，建议终止并总结当前进展',
      };
    }

    // 步骤失败
    if (!stepResult.success) {
      // 无剩余步骤 — 终止
      if (remainingSteps.length === 0) {
        return {
          action: 'terminate',
          reason: '步骤失败且无剩余步骤',
        };
      }

      // 连续失败 — 插入诊断步骤
      const recentFailures = (this.executionQualityHistory || [])
        .slice(-2)
        .filter((q) => q.score === 0);
      if (recentFailures.length >= 2) {
        return {
          action: 'insert',
          reason: '连续失败，插入诊断步骤',
          newStep: {
            tool: 'file_search',
            args: { pattern: '*.log' },
          },
        };
      }

      // 普通失败 — 跳过当前步骤
      return {
        action: 'skip',
        reason: '跳过失败步骤，继续执行后续步骤',
      };
    }

    // 步骤成功但质量低
    if (stepResult.quality !== undefined && stepResult.quality < 0.5) {
      return {
        action: 'modify',
        reason: '步骤质量低，建议修正后续步骤参数',
        modificationHint: '建议扩大搜索范围或调整过滤条件',
      };
    }

    // 步骤成功且质量高
    return {
      action: 'continue',
      reason: '步骤执行正常，继续后续步骤',
    };
  }
}

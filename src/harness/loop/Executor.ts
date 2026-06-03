/**
 * Harness Layer 1: Loop - Executor 节点
 *
 * 执行 FC 循环。
 * 按 Harness 六层架构原则，Executor 应逐步减少直接下层依赖。
 * 当前通过 ToolCallHooks 接口提供非侵入式钩子，旧有依赖保留兼容。
 */

import { Logger } from '../../utils/Logger';
import { EventBus } from '../../shared/EventBus';
import { LifecycleEvent, LoopState } from '../types';
import type {
  ChatMessage,
  LoopContext,
  ExecutionPlan,
  ToolContext,
  ToolResult,
  TrajectoryStep,
  StepResult,
  BudgetState,
} from '../types';
import type { ExecutorOutput } from './LoopController';
import type { ToolRegistry } from '../tools/registry/ToolRegistry';
import type { SchemaValidator } from '../tools/registry/SchemaValidator';
import type { PermissionGuard } from '../tools/registry/PermissionGuard';
import { Permission } from '../types';
import { SkillRegistry } from '../../skills/SkillRegistry';
import type { SkillContext } from '../../skills/SkillInterface';
import type { TrajectoryDatabase } from '../persistence/TrajectoryDatabase';
import { ToolCallGuard } from '../tools/registry/ToolCallGuard';

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

export class Executor {
  private deps: ExecutorDeps;

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
    const harnessTools =
      this.deps.toolRegistry.toOpenAITools() as unknown as Array<
        Record<string, unknown>
      >;
    // 只使用 ToolRegistry（Harness 工具），SkillRegistry 中的基础设施工具已通过
    // syncToLegacySkillRegistry 同步，不重复传入以免 LLM 看到重复工具
    const allTools = harnessTools;

    // 工具调用守卫：去重 + 缓存 + 速率限制
    const toolCallGuard = new ToolCallGuard();

    const recommendedSet = new Set(plan.recommendedTools);
    let effectiveTools = allTools;

    // 推荐工具仅作为提示，不强制过滤 — 释放 LLM 创造性
    // 当工具数 > 16 时才做意图过滤，避免 LLM 选择空间过大
    if (recommendedSet.size > 0 && allTools.length > 16) {
      // 保留推荐工具 + 通用工具，而非只保留推荐工具
      const generalTools = new Set([
        'web_search', 'memory_store', 'memory_search',
        'system_status', 'file_list', 'file_search', 'file_read',
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

    const toolChoice: 'required' | 'auto' | 'none' =
      plan.toolCallMode === 'none' ? 'none' : 'auto';

    // 纯对话模式：不传工具，直接LLM回复
    if (plan.toolCallMode === 'none') {
      Logger.info('💬 纯对话模式: 跳过工具调用', 'Executor');
      try {
        const directResponse = await this.deps.llm.chatWithTools(
          [...context.messages],
          [],  // 不传任何工具
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
          args = {};
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

      // 将工具结果注入消息
      for (const tr of toolResults) {
        const toolCallId =
          tr.toolCall?.id ||
          `tc_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCallId,
          name: tr.toolCall?.function?.name || 'unknown',
          content: tr.result,
        });
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
  private classifyError(error: string): 'retryable' | 'non_retryable' {
    const retryablePatterns = /timeout|network|ECONNREFUSED|ETIMEDOUT|503|429/i;
    const nonRetryablePatterns =
      /permission|auth|invalid.?param|not.?found|权限|认证|参数无效|未找到/i;
    if (nonRetryablePatterns.test(error)) return 'non_retryable';
    if (retryablePatterns.test(error)) return 'retryable';
    return 'non_retryable';
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await Promise.race([
          this.deps.toolRegistry.execute(toolName, args, context),
          this.createTimeoutPromise(TOOL_TIMEOUT_MS, toolName),
        ]);

        if (result.success) {
          if (retryCount > 0) {
            result.metadata = { ...result.metadata, retryCount };
          }
          return result;
        }

        lastResult = result;
        const errorType = this.classifyError(result.error || '');

        if (errorType === 'non_retryable' || attempt >= maxRetries) {
          if (result.metadata) {
            result.metadata.retryCount = retryCount;
          } else {
            result.metadata = { retryCount };
          }
          return result;
        }

        retryCount++;
        Logger.info(
          `🔄 工具 ${toolName} 执行失败(可重试错误)，第${retryCount}次重试...`,
          'Executor'
        );
        await new Promise((resolve) => setTimeout(resolve, 500 * retryCount));
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

        if (errorType === 'non_retryable' || attempt >= maxRetries) {
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
}

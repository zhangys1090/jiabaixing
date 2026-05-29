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
  /** 验证服务（@deprecated 通过 hooks 替代） */
  verificationService?: {
    validateToolResult(...args: unknown[]): unknown;
    checkOutputSafety(output: string): {
      safe: boolean;
      riskLevel: string;
      violations: string[];
      sanitizedOutput?: string;
    };
  };
  /** 约束服务（@deprecated 通过 hooks 替代） */
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
  /** 轨迹数据库（@deprecated 通过 hooks 替代） */
  trajectoryDatabase?: TrajectoryDatabase;
  /** 非侵入式工具调用钩子（推荐） */
  hooks?: ToolCallHooks;
}

/** 默认安全权限集 — 允许只读、记忆写入和低风险操作 */
const DEFAULT_SAFE_PERMISSIONS: Permission[] = [
  Permission.MEMORY_READ,
  Permission.MEMORY_WRITE,
  Permission.FILE_READ,
];

/** 默认限制 */
const HARD_TOOL_LIMIT = 8;
const SOFT_TOOL_LIMIT = 4;
const TOOL_TIMEOUT_MS = 30000;
const TOKEN_WARNING = 4500;
const MAX_TOOL_OUTPUT = 4000;

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

    const recommendedSet = new Set(plan.recommendedTools);
    const effectiveTools =
      recommendedSet.size > 0
        ? allTools.filter((t) => {
            const name =
              (t as { function?: { name?: string } }).function?.name || '';
            return recommendedSet.has(name);
          })
        : allTools;

    const toolChoice: 'required' | 'auto' | 'none' =
      plan.toolCallMode === 'none' ? 'none' : 'auto';

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
        content: `以下工具可用: [${toolNames}]

用户请求是一个操作类任务。请按以下步骤处理：
1. 分析用户想要做什么
2. 选择合适的工具并调用
3. 如果需要先获取信息再操作，请分步调用多个工具

工具组合策略：
- 信息获取链: file_search → file_read → code_analyze
- 桌面操作链: desktop_automate → screenshot → desktop_automate
- 网络研究链: web_fetch → memory_write → file_write
- 浏览器自动化: mcp_browser_* 系列工具
- 定时任务: mcp_cron_* 系列工具
- 创造性组合: 你可以自由组合工具实现用户未明确要求但合理的增强操作

注意：工具调用是完成任务的唯一方式。直接告诉我你要调用的工具和参数。`,
      });
    }

    // 进化闭环：注入工具可靠性提示
    const unreliableTools = this.deps.toolRegistry
      .getReliabilityTracker()
      .getUnreliableTools(0.7);
    if (unreliableTools.length > 0) {
      messages.push({
        role: 'system',
        content: `【工具可靠性提示】以下工具近期成功率偏低，优先考虑替代方案：${unreliableTools.join('、')}`,
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
    const MAX_STALL = 3; // 连续3轮相同工具 → 打断
    const MAX_CONSECUTIVE_SAME = 3;
    const CONSECUTIVE_SAME_WINDOW = 5; // 最近5轮中相同工具超限 → 打断

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
          if (fcResponse.content) {
            messages.push({ role: 'assistant', content: fcResponse.content });
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

      // 软预算警告
      if (loopCount >= SOFT_TOOL_LIMIT) {
        messages.push({
          role: 'system',
          content: `注意：你已经进行了 ${loopCount} 轮工具调用。请尽量在 ${HARD_TOOL_LIMIT - loopCount} 轮内完成当前任务。如果已经收集到足够信息，直接回复用户。`,
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

        // 链路追踪
        this.traceToolCall(toolCall, 'started', context.trace.traceId);

        // 解析参数
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        // BEFORE_TOOL_CALL 钩子（直接调用 constraintsService）
        let modifiedArgs = args;
        if (this.deps.constraintsService) {
          try {
            const hookResult = await this.deps.constraintsService.executeHooks(
              LifecycleEvent.BEFORE_TOOL_CALL,
              {
                event: LifecycleEvent.BEFORE_TOOL_CALL,
                toolName,
                params: args,
                loopState: LoopState.EXECUTING,
                metadata: {
                  traceId: context.trace.traceId,
                  loopCount,
                },
              }
            );
            if (!hookResult.proceed) {
              Logger.info(
                `🛑 BEFORE_TOOL_CALL 钩子拦截: ${toolName} - ${hookResult.reason}`,
                'Executor'
              );
              const hookResultOutput = hookResult.replacementResult?.output
                ? typeof hookResult.replacementResult.output === 'string'
                  ? hookResult.replacementResult.output
                  : JSON.stringify(hookResult.replacementResult.output)
                : `工具调用被拦截: ${hookResult.reason}`;
              return {
                toolCall,
                result: hookResultOutput,
                success: false,
                error: hookResult.reason || '钩子拦截',
                duration: Date.now() - toolStart,
              };
            }
            if (hookResult.modifiedParams) {
              modifiedArgs = hookResult.modifiedParams;
              Logger.debug(
                `📝 BEFORE_TOOL_CALL 修改参数: ${toolName}`,
                'Executor'
              );
            }
          } catch (hookErr) {
            Logger.warn(
              `⚠️ BEFORE_TOOL_CALL 钩子执行失败: ${(hookErr as Error).message}`,
              'Executor'
            );
          }
        }
        // 通过 hooks 接口的兼容处理
        if (this.deps.hooks?.beforeToolCall) {
          try {
            const hookResult = await this.deps.hooks.beforeToolCall(
              toolName,
              modifiedArgs,
              {
                traceId: context.trace.traceId,
                loopCount,
              }
            );
            if (!hookResult.proceed) {
              Logger.info(
                `🛑 hooks.beforeToolCall 拦截: ${toolName} - ${hookResult.reason}`,
                'Executor'
              );
              const hookResultOutput = hookResult.replacementResult?.output
                ? typeof hookResult.replacementResult.output === 'string'
                  ? hookResult.replacementResult.output
                  : JSON.stringify(hookResult.replacementResult.output)
                : `工具调用被拦截: ${hookResult.reason}`;
              return {
                toolCall,
                result: hookResultOutput,
                success: false,
                error: hookResult.reason || '钩子拦截',
                duration: Date.now() - toolStart,
              };
            }
            if (hookResult.modifiedParams) {
              modifiedArgs = hookResult.modifiedParams;
            }
          } catch (hookErr) {
            Logger.warn(
              `⚠️ hooks.beforeToolCall 执行失败: ${(hookErr as Error).message}`,
              'Executor'
            );
          }
        }

        try {
          // Schema 验证 + 权限检查合并到 hooks.beforeToolCall
          const registeredTool = this.deps.toolRegistry.get(toolName);
          if (registeredTool) {
            // Schema 验证（保留旧实现兼容）
            const validation = this.deps.schemaValidator.validate(
              modifiedArgs,
              registeredTool.definition.parameters,
              registeredTool.definition.requiredParams
            );
            if (!validation.valid) {
              Logger.warn(
                `⚠️ 参数验证失败: ${toolName} - ${validation.errors.join('; ')}`,
                'Executor'
              );
              modifiedArgs = validation.sanitizedParams;
            }
          }

          // 权限检查
          const toolContext: ToolContext = {
            userId: context.metadata.userId as string | undefined,
            traceId: context.trace.traceId,
            permissions: this.resolvePermissions(context),
            metadata: {},
          };

          if (registeredTool) {
            const permCheck = this.deps.permissionGuard.check(
              toolName,
              registeredTool.definition.requiredPermissions,
              registeredTool.definition.riskLevel,
              toolContext
            );
            if (!permCheck.allowed) {
              this.traceToolCall(
                toolCall,
                'failed',
                context.trace.traceId,
                Date.now() - toolStart,
                false,
                permCheck.reason
              );
              return {
                toolCall,
                result: `权限不足: ${permCheck.reason}`,
                success: false,
                duration: Date.now() - toolStart,
              };
            }
          }

          // 执行工具（带超时和重试），优先 Harness ToolRegistry，fallback 到 SkillRegistry
          let result: { success: boolean; output?: unknown; error?: string };
          if (registeredTool) {
            result = await this.executeWithRetry(
              toolName,
              modifiedArgs,
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
            result = await Promise.race([
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

          // P2 修复: 使用 VerificationService 验证工具结果
          let output: string;
          if (result.success) {
            const rawOutput =
              typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output);

            // 输出安全检查（通过 hooks 或旧实现）
            if (this.deps.hooks?.afterToolCall) {
              const toolResult: ToolResult = {
                success: result.success,
                output: rawOutput,
                error: result.error,
                duration: toolDuration,
                validated: false,
              };
              const hookResult = await this.deps.hooks.afterToolCall(
                toolName,
                toolResult,
                {
                  traceId: context.trace.traceId,
                  loopCount,
                }
              );
              output =
                typeof hookResult.output === 'string'
                  ? hookResult.output
                  : JSON.stringify(hookResult.output);
            } else if (this.deps.verificationService) {
              const safetyCheck =
                this.deps.verificationService.checkOutputSafety(rawOutput);
              if (!safetyCheck.safe) {
                Logger.warn(
                  `⚠️ 工具输出安全警告 [${toolName}]: ${safetyCheck.violations.join('; ')}`,
                  'Executor'
                );
              }
              output = safetyCheck.sanitizedOutput || rawOutput;
            } else {
              output = this.validateToolOutput(result);
            }
          } else {
            output = `错误: ${result.error || '工具执行失败'}`;
          }

          this.traceToolCall(
            toolCall,
            'completed',
            context.trace.traceId,
            toolDuration,
            result.success
          );

          // AFTER_TOOL_CALL 钩子（直接调用 constraintsService）
          if (this.deps.constraintsService) {
            try {
              const toolResult: ToolResult = {
                success: result.success,
                output,
                error: result.error,
                duration: toolDuration,
                validated: false,
              };
              const hookResult =
                await this.deps.constraintsService.executeHooks(
                  LifecycleEvent.AFTER_TOOL_CALL,
                  {
                    event: LifecycleEvent.AFTER_TOOL_CALL,
                    toolName,
                    result: toolResult,
                    loopState: LoopState.EXECUTING,
                    metadata: {
                      traceId: context.trace.traceId,
                      loopCount,
                    },
                  }
                );
              if (hookResult?.replacementResult?.output) {
                output =
                  typeof hookResult.replacementResult.output === 'string'
                    ? hookResult.replacementResult.output
                    : JSON.stringify(hookResult.replacementResult.output);
              }
            } catch (hookErr) {
              Logger.warn(
                `⚠️ AFTER_TOOL_CALL 钩子执行失败: ${(hookErr as Error).message}`,
                'Executor'
              );
            }
          }
          // 通过 hooks 接口的兼容处理
          if (this.deps.hooks?.afterToolCall) {
            try {
              const toolResult: ToolResult = {
                success: result.success,
                output,
                error: result.error,
                duration: toolDuration,
                validated: false,
              };
              const hookResult = await this.deps.hooks.afterToolCall(
                toolName,
                toolResult,
                {
                  traceId: context.trace.traceId,
                  loopCount,
                }
              );
              if (hookResult?.output && typeof hookResult.output === 'string') {
                output = hookResult.output;
              }
            } catch (hookErr) {
              Logger.warn(
                `⚠️ hooks.afterToolCall 执行失败: ${(hookErr as Error).message}`,
                'Executor'
              );
            }
          }

          // Track detailed trajectory step for tool call
          const trajectoryStepCall: TrajectoryStep = {
            type: 'tool_call',
            timestamp: toolStart,
            duration: toolDuration,
            toolName,
            toolParams: modifiedArgs,
            metadata: { toolCallId: toolCall.id },
          };
          context.trace.trajectory.push(trajectoryStepCall);

          const trajectoryStepResult: TrajectoryStep = {
            type: 'tool_result',
            timestamp: Date.now(),
            duration: 0,
            toolName,
            toolResult: {
              success: result.success,
              output: output,
              error: result.error,
              duration: toolDuration,
              validated: true,
              metadata: {},
            },
            metadata: { toolCallId: toolCall.id },
          };
          context.trace.trajectory.push(trajectoryStepResult);

          const stepResult: StepResult = {
            stepId: toolCall.id,
            toolName: toolName,
            success: result.success,
            output: output,
            duration: toolDuration,
            error: result.success ? undefined : result.error,
          };
          context.stepResults.set(toolCall.id, stepResult);

          return {
            toolCall,
            result: output,
            success: result.success,
            duration: toolDuration,
          };
        } catch (err) {
          const toolDuration = Date.now() - toolStart;
          // C4 fix: counters already incremented in try block, skip double-count

          this.traceToolCall(
            toolCall,
            'failed',
            context.trace.traceId,
            toolDuration,
            false,
            (err as Error).message
          );

          // ON_ERROR 钩子（直接调用 constraintsService）
          if (this.deps.constraintsService) {
            try {
              await this.deps.constraintsService.executeHooks(
                LifecycleEvent.ON_ERROR,
                {
                  event: LifecycleEvent.ON_ERROR,
                  toolName,
                  params: modifiedArgs,
                  loopState: LoopState.EXECUTING,
                  metadata: {
                    traceId: context.trace.traceId,
                    loopCount,
                    error: (err as Error).message,
                  },
                }
              );
            } catch (hookErr) {
              Logger.warn(
                `⚠️ ON_ERROR 钩子执行失败: ${(hookErr as Error).message}`,
                'Executor'
              );
            }
          }
          // 通过 hooks 接口的兼容处理
          if (this.deps.hooks?.onToolError) {
            try {
              await this.deps.hooks.onToolError(
                toolName,
                (err as Error).message,
                {
                  traceId: context.trace.traceId,
                  loopCount,
                }
              );
            } catch (hookErr) {
              Logger.warn(
                `⚠️ hooks.onToolError 执行失败: ${(hookErr as Error).message}`,
                'Executor'
              );
            }
          }

          // Track detailed trajectory step for failed tool call
          const trajectoryStepCall: TrajectoryStep = {
            type: 'tool_call',
            timestamp: toolStart,
            duration: toolDuration,
            toolName,
            toolParams: modifiedArgs,
            metadata: { toolCallId: toolCall.id },
          };
          context.trace.trajectory.push(trajectoryStepCall);

          const trajectoryStepError: TrajectoryStep = {
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
          };
          context.trace.trajectory.push(trajectoryStepError);

          const errorResult: StepResult = {
            stepId: toolCall.id,
            toolName: toolName,
            success: false,
            output: `错误: ${(err as Error).message}`,
            duration: toolDuration,
            error: (err as Error).message,
          };
          context.stepResults.set(toolCall.id, errorResult);

          return {
            toolCall,
            result: `错误: ${(err as Error).message}`,
            success: false,
            duration: toolDuration,
          };
        }
      });

      const toolResults = await Promise.all(toolPromises);

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

    return {
      messages,
      toolCallsCount: totalToolCalls,
      toolDuration: totalToolDuration,
      completedNaturally: loopCount < HARD_TOOL_LIMIT,
    };
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

    const keptMessages = nonSystemMessages.slice(-4);
    const removedMessages = nonSystemMessages.slice(0, -4);

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
    errorMessage?: string
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
      const stepIndex = 0;
      try {
        this.deps.trajectoryDatabase.recordToolInvocation({
          execution_id: traceId,
          step_index: stepIndex,
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
}

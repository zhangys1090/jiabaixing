/**
 * Harness Layer 1: Loop - Executor 节点
 *
 * 执行 FC 循环，从 JiabaixingCore.executeFCLoop 提取核心逻辑
 */

import { Logger } from '../../utils/Logger';
import { EventBus } from '../../shared/EventBus';
import { LifecycleEvent } from '../types';
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

/** Executor 依赖 */
export interface ExecutorDeps {
  /** LLM 提供者 */
  llm: {
    chatWithTools(
      messages: ChatMessage[],
      tools: Array<Record<string, unknown>>
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
  /** Schema 验证器 */
  schemaValidator: SchemaValidator;
  /** 权限守卫 */
  permissionGuard: PermissionGuard;
  /** 验证服务 (P2 修复: 连接悬空的验证层) */
  verificationService?: {
    validateToolResult(toolName: string, result: { success: boolean; output?: unknown; error?: string }): {
      valid: boolean;
      sanitizedOutput: string;
      warnings: string[];
      errors: string[];
    };
    checkOutputSafety(output: string): {
      safe: boolean;
      riskLevel: string;
      violations: string[];
      sanitizedOutput?: string;
    };
  };
  /** 约束服务（生命周期钩子） */
  constraintsService?: {
    executeHooks(event: LifecycleEvent, context: { event: LifecycleEvent; toolName?: string; params?: Record<string, unknown>; result?: ToolResult; loopState?: string; budgetState?: BudgetState; metadata: Record<string, unknown> }): Promise<{ proceed: boolean; modifiedParams?: Record<string, unknown>; replacementResult?: ToolResult; reason?: string }>;
  };
  /** 轨迹数据库 */
  trajectoryDatabase?: TrajectoryDatabase;
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
    const harnessTools = this.deps.toolRegistry.toOpenAITools() as unknown as Array<Record<string, unknown>>;
    const skillTools = SkillRegistry.getInstance().toOpenAITools() as Array<Record<string, unknown>>;
    const allTools = [...harnessTools, ...skillTools];

    // F0-01: 计划上下文已由 LoopController.injectPlanIntoContext() 注入到 context.messages
    // 不再在此处重复注入，避免 LLM 看到重复的计划信息
    let messages = [...context.messages];
    let loopCount = 0;
    let totalToolCalls = 0;
    let totalToolDuration = 0;

    // 进化闭环：注入工具可靠性提示
    const unreliableTools = this.deps.toolRegistry.getReliabilityTracker().getUnreliableTools(0.7);
    if (unreliableTools.length > 0) {
      messages.push({
        role: 'system',
        content: `【工具可靠性提示】以下工具近期成功率偏低，优先考虑替代方案：${unreliableTools.join('、')}`,
      });
    }

    // 首次 LLM 调用
    let fcResponse = await this.deps.llm.chatWithTools(messages, allTools);

    // FC 循环
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
        tool_calls: fcResponse.toolCalls,
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

        // P0 修复: BEFORE_TOOL_CALL 钩子
        let modifiedArgs = args;
        if (this.deps.constraintsService) {
          try {
            const beforeHookResult = await this.deps.constraintsService.executeHooks(
              LifecycleEvent.BEFORE_TOOL_CALL,
              {
                event: LifecycleEvent.BEFORE_TOOL_CALL,
                toolName,
                params: args,
                loopState: context.trace.state,
                budgetState: context.budget,
                metadata: {
                  traceId: context.trace.traceId,
                  loopCount,
                },
              }
            );
            if (!beforeHookResult.proceed) {
              Logger.info(
                `🛑 BEFORE_TOOL_CALL 钩子拦截: ${toolName} - ${beforeHookResult.reason}`,
                'Executor'
              );
              const hookResult: ToolResult = beforeHookResult.replacementResult || {
                success: false,
                output: `工具调用被拦截: ${beforeHookResult.reason}`,
                error: beforeHookResult.reason,
                duration: Date.now() - toolStart,
                validated: false,
              };
              const hookOutput = hookResult.output
                ? typeof hookResult.output === 'string'
                  ? hookResult.output
                  : JSON.stringify(hookResult.output)
                : `工具调用被拦截: ${beforeHookResult.reason}`;
              const hookError = hookResult.error
                ? typeof hookResult.error === 'string'
                  ? hookResult.error
                  : String(hookResult.error)
                : beforeHookResult.reason;
              return {
                toolCall,
                result: hookOutput,
                success: false,
                error: hookError,
                duration: Date.now() - toolStart,
              };
            }
            if (beforeHookResult.modifiedParams) {
              modifiedArgs = beforeHookResult.modifiedParams;
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

        try {
          // Schema 验证
          const registeredTool = this.deps.toolRegistry.get(toolName);
          if (registeredTool) {
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
              this.traceToolCall(toolCall, 'failed', context.trace.traceId, Date.now() - toolStart, false, permCheck.reason);
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
            result = await this.executeWithRetry(toolName, modifiedArgs, toolContext);
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
              SkillRegistry.getInstance().executeToolCall(toolCall, skillContext),
              this.createTimeoutPromise(TOOL_TIMEOUT_MS, toolName),
            ]);
          }

          const toolDuration = Date.now() - toolStart;
          totalToolDuration += toolDuration;
          totalToolCalls++;

          // P2 修复: 使用 VerificationService 验证工具结果
          let output: string;
          if (result.success) {
            const rawOutput = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output);

            // 输出安全检查
            if (this.deps.verificationService) {
              const safetyCheck = this.deps.verificationService.checkOutputSafety(rawOutput);
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

          this.traceToolCall(toolCall, 'completed', context.trace.traceId, toolDuration, result.success);

          // P0 修复: AFTER_TOOL_CALL 钩子
          if (this.deps.constraintsService) {
            try {
              const afterHookResult = await this.deps.constraintsService.executeHooks(
                LifecycleEvent.AFTER_TOOL_CALL,
                {
                  event: LifecycleEvent.AFTER_TOOL_CALL,
                  toolName,
                  params: modifiedArgs,
                  result: {
                    success: result.success,
                    output,
                    error: result.error,
                    duration: toolDuration,
                    validated: false,
                  },
                  loopState: context.trace.state,
                  budgetState: context.budget,
                  metadata: {
                    traceId: context.trace.traceId,
                    loopCount,
                    toolDuration,
                  },
                }
              );
              if (afterHookResult.replacementResult) {
                output = typeof afterHookResult.replacementResult.output === 'string'
                  ? afterHookResult.replacementResult.output
                  : JSON.stringify(afterHookResult.replacementResult.output);
                Logger.debug(
                  `📝 AFTER_TOOL_CALL 替换结果: ${toolName}`,
                  'Executor'
                );
              }
            } catch (hookErr) {
              Logger.warn(
                `⚠️ AFTER_TOOL_CALL 钩子执行失败: ${(hookErr as Error).message}`,
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
            metadata: { toolCallId: toolCall.id }
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
              metadata: {}
            },
            metadata: { toolCallId: toolCall.id }
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
          totalToolDuration += toolDuration;
          totalToolCalls++;

          this.traceToolCall(toolCall, 'failed', context.trace.traceId, toolDuration, false, (err as Error).message);

          // P0 修复: ON_ERROR 钩子
          if (this.deps.constraintsService) {
            try {
              const errorHookResult = await this.deps.constraintsService.executeHooks(
                LifecycleEvent.ON_ERROR,
                {
                  event: LifecycleEvent.ON_ERROR,
                  toolName,
                  params: modifiedArgs,
                  result: {
                    success: false,
                    output: `错误: ${(err as Error).message}`,
                    error: (err as Error).message,
                    duration: toolDuration,
                    validated: false,
                  },
                  loopState: context.trace.state,
                  budgetState: context.budget,
                  metadata: {
                    traceId: context.trace.traceId,
                    loopCount,
                    errorMessage: (err as Error).message,
                  },
                }
              );
              if (!errorHookResult.proceed) {
                Logger.info(
                  `🛑 ON_ERROR 钩子拦截: ${toolName} - ${errorHookResult.reason}`,
                  'Executor'
                );
              }
            } catch (hookErr) {
              Logger.warn(
                `⚠️ ON_ERROR 钩子执行失败: ${(hookErr as Error).message}`,
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
            metadata: { toolCallId: toolCall.id }
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
              metadata: {}
            },
            metadata: { toolCallId: toolCall.id }
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
        messages.push({
          role: 'tool',
          tool_call_id: tr.toolCall.id,
          name: tr.toolCall.function.name,
          content: tr.result,
        });
      }

      // 下一轮 LLM 调用
      fcResponse = await this.deps.llm.chatWithTools(messages, allTools);
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
    const nonRetryablePatterns = /permission|auth|invalid.?param|not.?found|权限|认证|参数无效|未找到/i;
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

    return lastResult || {
      success: false,
      output: null,
      error: '工具执行失败：重试次数耗尽',
      duration: 0,
      validated: false,
      metadata: { retryCount },
    };
  }

  /**
   * 构建计划上下文注入消息
   */
  private buildPlanContext(plan: ExecutionPlan): string {
    const steps = plan.steps
      .map((s, i) => `${i + 1}. ${s.description}${s.toolName ? ` (使用 ${s.toolName})` : ''}`)
      .join('\n');

    return `【执行计划】\n以下是建议的执行步骤，请按需执行：\n${steps}\n\n你可以根据实际情况调整执行顺序或跳过不需要的步骤。`;
  }

  /**
   * 验证工具输出
   */
  private validateToolOutput(result: { success: boolean; output?: unknown; error?: string }): string {
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
        for (const tc of msg.tool_calls as Array<{ function: { name: string; arguments: string } }>) {
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
   */
  private countTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    let chineseChars = 0;
    let englishChars = 0;
    let codeChars = 0;
    let otherChars = 0;

    let inCodeBlock = false;
    const codeStartPattern = /```/g;
    const codeEndPattern = /```/g;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const code = text.charCodeAt(i);

      if (char === '`' && i < text.length - 2 && text.substring(i, i + 3) === '```') {
        inCodeBlock = !inCodeBlock;
        i += 2;
        continue;
      }

      if (inCodeBlock || (char === '`' && text.substring(i, i + 2) === '``')) {
        codeChars++;
        if (char === '`') i++;
        continue;
      }

      if ((code >= 0x4E00 && code <= 0x9FFF) ||
          (code >= 0x3400 && code <= 0x4DBF) ||
          (code >= 0xF900 && code <= 0xFAFF)) {
        chineseChars++;
      } else if ((code >= 0x0041 && code <= 0x007A) ||
                 (code >= 0x0041 && code <= 0x005A) ||
                 (code >= 0x0030 && code <= 0x0039)) {
        englishChars++;
      } else if (/[{}()[\];,.<>:\+\-\*\/\\|&\s]/.test(char)) {
        otherChars++;
      } else {
        codeChars++;
      }
    }

    const chineseTokens = Math.ceil(chineseChars / 2);
    const englishTokens = Math.ceil(englishChars / 4);
    const codeTokens = Math.ceil(codeChars / 4);
    const otherTokens = Math.ceil(otherChars / 3);

    return chineseTokens + englishTokens + codeTokens + otherTokens;
  }

  /**
   * 压缩消息（保留 system + 最近 4 条非 system）
   */
  private compressMessages(messages: ChatMessage[], _currentTokens: number): ChatMessage[] {
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
        summaryParts.push(`工具[${msg.name}]: ${(msg.content || '').substring(0, 60)}`);
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

    if (this.deps.trajectoryDatabase && traceId) {
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
        Logger.warn(
          `⚠️ 轨迹记录失败: ${(err as Error).message}`,
          'Executor'
        );
      }
    }
  }

  /**
   * 创建超时 Promise
   */
  private createTimeoutPromise(timeoutMs: number, toolName: string): Promise<never> {
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
}

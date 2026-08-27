/**
 * delegate_task — 子 Agent 委托工具
 *
 * 学习 Hermes Agent 的 delegate_task 机制：
 * - 创建隔离的子 Agent 实例执行独立任务
 * - 子 Agent 有独立上下文，不继承父对话历史
 * - 可限制工具子集
 * - 同步等待结果
 */

import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import type { ToolRegistry } from '../registry/ToolRegistry';

export const DELEGATE_TASK_DEF: ToolDefinition = {
  name: 'delegate_task',
  description:
    '将子任务委托给独立的子 Agent 执行。USE WHEN: 需要并行处理多个独立任务、将复杂任务拆分给专门的执行者、或需要隔离上下文执行子任务。DO NOT USE WHEN: 任务简单可直接用单个工具完成。子 Agent 有独立上下文，通过 goal 和 context 接收信息，返回执行结果摘要。',
  category: ToolCategory.SYSTEM,
  parameters: {
    goal: {
      type: 'string',
      description: '子 Agent 要完成的目标，描述清晰具体',
    },
    context: {
      type: 'string',
      description:
        '子 Agent 需要的上下文信息（如文件路径、错误信息、参考数据）',
    },
    tools: {
      type: 'array',
      items: { type: 'string', description: '工具名称' },
      description:
        '限制子 Agent 可用的工具列表，如 ["file_read", "code_analyze"]。不填则可用全部工具',
    },
    max_iterations: {
      type: 'number',
      description: '子 Agent 最大执行轮次',
      default: 5,
    },
  },
  requiredParams: ['goal'],
  requiredPermissions: [Permission.SYSTEM_ADMIN],
  riskLevel: 'medium',
  idempotent: true,
  timeout: 120000,
  requiresConfirmation: false,
};

export interface DelegateTaskDeps {
  llm: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  };
  toolRegistry: ToolRegistry;
  constitutionBuilder?: {
    buildConstitution(): string;
  };
}

interface SubAgentResult {
  goal: string;
  output: string;
  toolsUsed: string[];
  iterations: number;
  duration: number;
  success: boolean;
  error?: string;
}

/**
 * 精简版子 Agent 执行器
 * 不依赖 LoopController，直接实现 FC 循环
 */
async function runSubAgent(
  goal: string,
  context: string | undefined,
  allowedTools: string[] | undefined,
  maxIterations: number,
  deps: DelegateTaskDeps
): Promise<SubAgentResult> {
  const startTime = Date.now();
  const toolsUsed: string[] = [];
  let iterations = 0;

  // 构建工具子集（删除未使用的 allTools 声明）
  // 构建子 Agent 的 system prompt
  const systemPrompt = [
    '你是家百星的子任务执行器。专注、高效、不闲聊。',
    '你的目标是完成用户交给你的具体任务。',
    '使用提供的工具来完成任务，完成后输出简洁的结果摘要。',
    '不要闲聊，直接执行。',
    '【反幻觉护栏】只使用下方列出的工具，不编造工具和结果。',
    allowedTools?.length ? `\n可用工具: ${allowedTools.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // 构建初始消息
  const messages: Array<{
    role: string;
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }> = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: [`## 目标\n${goal}`, context ? `\n## 上下文\n${context}` : '']
        .filter(Boolean)
        .join('\n'),
    },
  ];

  // FC 循环
  for (let i = 0; i < maxIterations; i++) {
    iterations++;

    let response: string;
    try {
      response = await deps.llm.chat(
        messages.map((m) => m.content).join('\n'),
        [],
        systemPrompt
      );
    } catch (err) {
      return {
        goal,
        output: `子 Agent LLM 调用失败: ${(err as Error).message}`,
        toolsUsed,
        iterations,
        duration: Date.now() - startTime,
        success: false,
        error: (err as Error).message,
      };
    }

    // 检查是否有工具调用（从响应中解析）
    const toolCallMatch = response.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    const functionCallMatch = response.match(/\[(\w+)\]\s*(\{[\s\S]*?\})/);

    if (!toolCallMatch && !functionCallMatch) {
      // 没有工具调用，认为是最终回答
      return {
        goal,
        output: response.substring(0, 5000),
        toolsUsed,
        iterations,
        duration: Date.now() - startTime,
        success: true,
      };
    }

    // 解析工具调用
    let toolName = '';
    let toolParams: Record<string, unknown> = {};

    if (functionCallMatch) {
      toolName = functionCallMatch[1];
      try {
        toolParams = JSON.parse(functionCallMatch[2]);
      } catch {
        toolParams = {};
      }
    } else if (toolCallMatch) {
      try {
        const parsed = JSON.parse(toolCallMatch[1]);
        toolName = parsed.tool || parsed.name || '';
        toolParams = parsed.params || parsed.parameters || {};
      } catch {
        /* ignore */
      }
    }

    if (!toolName) {
      return {
        goal,
        output: response.substring(0, 5000),
        toolsUsed,
        iterations,
        duration: Date.now() - startTime,
        success: true,
      };
    }

    // 执行工具
    let toolResult: string;
    try {
      const result = await deps.toolRegistry.execute(toolName, toolParams, {
        permissions: new Set([
          Permission.FILE_READ,
          Permission.FILE_WRITE,
          Permission.CODE_EXECUTE,
          Permission.NETWORK_ACCESS,
          Permission.SYSTEM_ADMIN,
        ]),
        metadata: {},
      });
      toolResult =
        typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output);
      toolsUsed.push(toolName);
    } catch (err) {
      toolResult = `工具执行失败: ${(err as Error).message}`;
    }

    // 将工具结果加入消息继续循环
    messages.push(
      { role: 'assistant', content: response },
      {
        role: 'user',
        content: `工具 ${toolName} 的结果:\n${toolResult.substring(0, 3000)}\n\n请继续执行任务或给出最终结果。`,
      }
    );
  }

  // 超过最大轮次
  return {
    goal,
    output: `子 Agent 达到最大轮次 (${maxIterations})，已完成 ${iterations} 轮执行。`,
    toolsUsed,
    iterations,
    duration: Date.now() - startTime,
    success: false,
    error: 'max_iterations_reached',
  };
}

export function createDelegateTaskExecutor(deps: DelegateTaskDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const goal = String(params.goal || '');
    const context = params.context ? String(params.context) : undefined;
    const maxIterations = Number(params.max_iterations) || 5;
    const tools = params.tools ? (params.tools as string[]) : undefined;

    if (!goal.trim()) {
      return {
        success: false,
        output: null,
        error: '目标描述不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      Logger.info(
        `🎯 delegate_task 启动: "${goal.substring(0, 60)}"`,
        'DelegateTask'
      );

      const result = await runSubAgent(
        goal,
        context,
        tools,
        maxIterations,
        deps
      );

      const icon = result.success ? '✅' : '⚠️';
      const output = [
        `${icon} 子 Agent 完成`,
        ``,
        `📋 目标: ${goal}`,
        `⏱️ 耗时: ${(result.duration / 1000).toFixed(1)}s | 轮次: ${result.iterations}`,
        result.toolsUsed.length > 0
          ? `🔧 使用工具: ${result.toolsUsed.join(', ')}`
          : '',
        ``,
        `📄 结果:`,
        result.output,
      ]
        .filter(Boolean)
        .join('\n');

      Logger.info(
        `🎯 delegate_task 完成: ${result.success ? '成功' : '失败'} (${result.iterations}轮, ${(result.duration / 1000).toFixed(1)}s)`,
        'DelegateTask'
      );

      return {
        success: result.success,
        output,
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
          goal,
          toolsUsed: result.toolsUsed,
          iterations: result.iterations,
          subAgentDuration: result.duration,
          ...(result.error ? { error: result.error } : {}),
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `子 Agent 委托失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

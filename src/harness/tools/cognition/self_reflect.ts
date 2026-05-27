/**
 * Harness Tool: self_reflect - 记录自我反思
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';

export const SELF_REFLECT_DEF: ToolDefinition = {
  name: 'self_reflect',
  description:
    '记录对自己表现的反思。适用场景：完成了一个复杂的多步骤任务后，记录哪些做得好、哪些可以改进。不适用：简单的单轮对话。',
  category: ToolCategory.COGNITION,
  parameters: {
    action: {
      type: 'string',
      description: '你执行了什么操作，如"调用了3个工具完成文件搜索"',
    },
    result: {
      type: 'string',
      description: '操作结果如何，如"成功找到文件但耗时较长"',
    },
    satisfaction: {
      type: 'number',
      description: '满意度评分1-10，10为最满意',
      default: 5,
    },
  },
  requiredParams: ['action', 'result', 'satisfaction'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

/** self_reflect 依赖接口 */
export interface SelfReflectDeps {
  agentSelfReflection: {
    recordExecution: (entry: unknown) => Promise<void>;
  } | null;
}

/** 创建 self_reflect 执行器 */
export function createSelfReflectExecutor(deps: SelfReflectDeps) {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const traceId = context?.traceId || '';
    const satisfaction = Number(params.satisfaction) || 5;

    if (deps.agentSelfReflection) {
      await deps.agentSelfReflection.recordExecution({
        traceId,
        timestamp: Date.now(),
        input: String(params.action),
        intent: 'self_reflect',
        skillsUsed: [],
        success: satisfaction >= 5,
        duration: 0,
        output: String(params.result),
      });
    }

    return {
      success: true,
      output: '已记录反思',
      duration: 0,
      validated: false,
    };
  };
}

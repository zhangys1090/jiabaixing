/**
 * Harness Tool: self_reflect - 记录自我反思
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const SELF_REFLECT_DEF: ToolDefinition = {
  name: 'self_reflect',
  description:
    '记录对自己表现的反思。适用场景：完成了一个复杂的多步骤任务后，记录哪些做得好、哪些可以改进。不适用：简单的单轮对话。（轻量规则模式：基于满意度评分的本地反思，非真实 LLM 反思；未接入后端时显式失败，不会假成功）',
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
  reflectionStore?: {
    add(entry: ReflectionEntry): void;
    getAll(): ReflectionEntry[];
    getRecent(limit: number): ReflectionEntry[];
  };
}

export interface ReflectionEntry {
  traceId: string;
  timestamp: number;
  action: string;
  result: string;
  satisfaction: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  improvement?: string;
}

function analyzeSentiment(
  satisfaction: number
): 'positive' | 'neutral' | 'negative' {
  if (satisfaction >= 7) return 'positive';
  if (satisfaction >= 4) return 'neutral';
  return 'negative';
}

function suggestImprovement(
  satisfaction: number,
  result: string
): string | undefined {
  if (satisfaction >= 8) return undefined;
  if (satisfaction <= 3)
    return `低满意度(${satisfaction}/10): 建议优化 "${result.substring(0, 50)}" 的执行策略`;
  if (satisfaction <= 5)
    return `中等满意度(${satisfaction}/10): 可考虑改进执行效率或结果质量`;
  return undefined;
}

/** 创建 self_reflect 执行器 */
export function createSelfReflectExecutor(deps: SelfReflectDeps) {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const traceId = context?.traceId || '';
    const satisfaction = Math.min(
      10,
      Math.max(1, Number(params.satisfaction) || 5)
    );
    const action = String(params.action);
    const result = String(params.result);
    const sentiment = analyzeSentiment(satisfaction);
    const improvement = suggestImprovement(satisfaction, result);

    // F2 诚实降级：无持久化后端时不再假成功（原实现返回"已记录反思"却未记录）
    const persisted = !!(deps.agentSelfReflection || deps.reflectionStore);
    if (!persisted) {
      const analysis = `反思分析(未持久化) [满意度:${satisfaction}/10, 情感:${sentiment}]`;
      const note = improvement ? `\n💡 ${improvement}` : '';
      return {
        success: false,
        output: analysis + note,
        error:
          'self_reflect 未接入存储/反思后端，反思未实际记录（轻量规则模式）。',
        duration: 0,
        validated: false,
        metadata: {
          satisfaction,
          sentiment,
          hasImprovement: !!improvement,
          persisted: false,
          mode: 'lightweight-rule',
        },
      };
    }

    const entry: ReflectionEntry = {
      traceId,
      timestamp: Date.now(),
      action,
      result,
      satisfaction,
      sentiment,
      improvement,
    };

    // F2 持久化必须 try/catch：后端抛错时诚实失败，不让 executor 崩溃
    try {
      if (deps.agentSelfReflection) {
        await deps.agentSelfReflection.recordExecution({
          traceId,
          timestamp: Date.now(),
          input: action,
          intent: 'self_reflect',
          skillsUsed: [],
          success: satisfaction >= 5,
          duration: 0,
          output: result,
        });
      }
      if (deps.reflectionStore) {
        deps.reflectionStore.add(entry);
      }
    } catch (persistErr) {
      Logger.error('❌ self_reflect 持久化失败', persistErr as Error, 'SelfReflect');
      const analysis = `反思分析 [满意度:${satisfaction}/10, 情感:${sentiment}]`;
      const note = improvement ? `\n💡 ${improvement}` : '';
      return {
        success: false,
        output: analysis + note,
        error: `反思分析已完成，但持久化失败: ${(persistErr as Error).message}`,
        duration: 0,
        validated: false,
        metadata: {
          satisfaction,
          sentiment,
          hasImprovement: !!improvement,
          persisted: false,
          persistError: true,
        },
      };
    }

    const outputParts = [
      `已记录反思 [满意度:${satisfaction}/10, 情感:${sentiment}]`,
    ];
    if (improvement) outputParts.push(`💡 ${improvement}`);

    return {
      success: true,
      output: outputParts.join('\n'),
      duration: 0,
      validated: false,
      metadata: { satisfaction, sentiment, hasImprovement: !!improvement },
    };
  };
}

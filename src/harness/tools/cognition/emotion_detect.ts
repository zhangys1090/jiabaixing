/**
 * Harness Tool: emotion_detect - 分析用户情绪
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';

export const EMOTION_DETECT_DEF: ToolDefinition = {
  name: 'emotion_detect',
  description:
    '分析用户当前情绪状态。适用场景：用户语气激动、沮丧、焦虑、或你感觉用户情绪有变化时。不适用：正常平静的对话。（轻量规则模式：基于注入规则的本地情绪识别，非真实 LLM 情感分析）',
  category: ToolCategory.COGNITION,
  parameters: {
    text: {
      type: 'string',
      description: '要分析的用户原文',
    },
  },
  requiredParams: ['text'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

/** emotion_detect 依赖接口 */
export interface EmotionDetectDeps {
  detectEmotionFromInput: (text: string) => {
    type: string;
    intensity: number;
    dominant?: string;
    confidence?: number;
  };
}

/** 创建 emotion_detect 执行器 */
export function createEmotionDetectExecutor(deps: EmotionDetectDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const text = String(params.text || '');

    // F2 诚实降级：缺依赖不再崩溃/假成功，显式失败并标注轻量规则模式
    if (!deps || typeof deps.detectEmotionFromInput !== 'function') {
      return {
        success: false,
        output: '',
        error:
          'emotion_detect 不可用：未注入 detectEmotionFromInput 实现（轻量规则模式需依赖注入）。',
        duration: 0,
        validated: false,
        metadata: { mode: 'lightweight-rule', missingDep: true },
      };
    }

    try {
      const emotion = deps.detectEmotionFromInput(text);
      const output: Record<string, unknown> = {
        type: emotion.type,
        intensity: emotion.intensity,
        timestamp: new Date().toISOString(),
      };
      if (emotion.dominant) output.dominant = emotion.dominant;
      if (emotion.confidence != null) output.confidence = emotion.confidence;
      return {
        success: true,
        output: JSON.stringify(output),
        duration: 0,
        validated: false,
        metadata: { mode: 'lightweight-rule' },
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `emotion_detect 规则执行失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
        metadata: { mode: 'lightweight-rule' },
      };
    }
  };
}

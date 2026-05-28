/**
 * Harness Tool: emotion_detect - 分析用户情绪
 */

import { ToolCategory } from '../../types';
import type { ToolDefinition, ToolResult, ToolContext } from '../../types';

export const EMOTION_DETECT_DEF: ToolDefinition = {
  name: 'emotion_detect',
  description:
    '分析用户当前情绪状态。适用场景：用户语气激动、沮丧、焦虑、或你感觉用户情绪有变化时。不适用：正常平静的对话。',
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
  };
}

/** 创建 emotion_detect 执行器 */
export function createEmotionDetectExecutor(deps: EmotionDetectDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const text = String(params.text || '');
    const emotion = deps.detectEmotionFromInput(text);
    return {
      success: true,
      output: JSON.stringify({
        type: emotion.type,
        intensity: emotion.intensity,
        timestamp: new Date().toISOString(),
      }),
      duration: 0,
      validated: false,
    };
  };
}

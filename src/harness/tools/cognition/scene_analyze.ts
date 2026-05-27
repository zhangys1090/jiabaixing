/**
 * Harness Tool: analyze_scene - 判断对话场景类型
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';

export const SCENE_ANALYZE_DEF: ToolDefinition = {
  name: 'analyze_scene',
  description:
    '判断当前对话的场景类型（工作/日常/情感/紧急等）。适用场景：你不确定如何调整语气、或用户突然转换话题时。不适用：场景已经明确时。',
  category: ToolCategory.COGNITION,
  parameters: {
    text: {
      type: 'string',
      description: '用户最近的输入文本',
    },
  },
  requiredParams: ['text'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

/** analyze_scene 依赖接口 */
export interface SceneAnalyzeDeps {
  recognizeScene: (text: string) => Promise<{ type: string; context: string }>;
}

/** 创建 analyze_scene 执行器 */
export function createSceneAnalyzeExecutor(deps: SceneAnalyzeDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const text = String(params.text || '');
    const scene = await deps.recognizeScene(text);
    return {
      success: true,
      output: JSON.stringify({ type: scene.type, context: scene.context }),
      duration: 0,
      validated: false,
    };
  };
}

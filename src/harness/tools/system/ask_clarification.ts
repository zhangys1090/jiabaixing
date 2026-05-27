/**
 * Harness Tool: ask_clarification - 主动向用户提问澄清
 */

import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';

export const ASK_CLARIFICATION_DEF: ToolDefinition = {
  name: 'ask_clarification',
  description:
    '当用户需求不明确、有多种理解、或缺少关键信息时，主动向用户提问澄清。适用场景：用户说"改一下代码"但没说改什么、"帮我优化"但没说优化哪方面、"修复bug"但没描述具体问题。不适用：需求已经明确、简单问候。',
  category: ToolCategory.SYSTEM,
  parameters: {
    question: {
      type: 'string',
      description: '要问用户的问题，简洁明确，如"你希望优化性能还是可读性？"',
    },
    options: {
      type: 'array',
      description: '可选的答案选项列表，如["性能优先","可读性优先","平衡两者"]',
      items: { type: 'string', description: '选项文本' },
    },
    context: {
      type: 'string',
      description: '为什么需要澄清的背景说明',
    },
  },
  requiredParams: ['question'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

/** 创建 ask_clarification 执行器 */
export function createAskClarificationExecutor() {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const question = String(params.question || '');
    const options = (params.options as string[]) || [];
    const contextInfo = String(params.context || '');
    const traceId = context?.traceId || '';

    void EventBus.emit('clarification_request', {
      traceId,
      question,
      options,
      context: contextInfo,
      timestamp: new Date().toISOString(),
    });

    Logger.info(
      `🤔 主动澄清: ${question.substring(0, 50)}...`,
      'AskClarification'
    );

    return {
      success: true,
      output: `已向用户提问: "${question}"${options.length > 0 ? ` 选项: ${options.join('/')}` : ''}。请等待用户回复后再继续执行。`,
      duration: 0,
      validated: false,
      metadata: { waitForUser: true },
    };
  };
}

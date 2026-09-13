"use strict";
/**
 * Harness Tool: ask_clarification - 主动向用户提问澄清
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASK_CLARIFICATION_DEF = void 0;
exports.createAskClarificationExecutor = createAskClarificationExecutor;
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.ASK_CLARIFICATION_DEF = {
    name: 'ask_clarification',
    description: '（最后手段）当用户需求确实无法通过搜索、分析、推理获取关键信息时，才向用户提问澄清。应优先尝试：web_search、file_search、分析上下文等方式。适用场景：尝试所有工具后仍缺少关键信息且风险较高。不适用：需求可以通过搜索/推理获取、需求已经明确、简单问候。',
    category: types_1.ToolCategory.SYSTEM,
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
function createAskClarificationExecutor() {
    return async (params, context) => {
        const question = String(params.question || '');
        const options = params.options || [];
        const contextInfo = String(params.context || '');
        const traceId = context?.traceId || '';
        void EventBus_1.EventBus.emit('clarification_request', {
            traceId,
            question,
            options,
            context: contextInfo,
            timestamp: new Date().toISOString(),
        });
        Logger_1.Logger.info(`🤔 主动澄清: ${question.substring(0, 50)}...`, 'AskClarification');
        return {
            success: true,
            output: `已向用户提问: "${question}"${options.length > 0 ? ` 选项: ${options.join('/')}` : ''}。请等待用户回复后再继续执行。`,
            duration: 0,
            validated: false,
            metadata: { waitForUser: true },
        };
    };
}

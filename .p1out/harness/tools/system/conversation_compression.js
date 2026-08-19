"use strict";
/**
 * Harness Tool: conversation_compression - 对话压缩
 *
 * 将长对话历史压缩为精简摘要，保留关键信息，
 * 减少上下文窗口占用，延长对话可用轮次。
 * 支持多种压缩策略：摘要、关键信息提取、滑动窗口。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONVERSATION_COMPRESSION_DEF = void 0;
exports.createConversationCompressionExecutor = createConversationCompressionExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.CONVERSATION_COMPRESSION_DEF = {
    name: 'conversation_compression',
    description: '压缩对话历史，减少上下文窗口占用。支持策略：summarize=LLM摘要, extract=关键信息提取, sliding_window=滑动窗口保留最近N条, hybrid=混合策略。适用场景：长对话上下文溢出、减少Token消耗、保留关键信息。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        action: {
            type: 'string',
            description: '操作类型：compress=执行压缩, estimate=估算Token, preview=预览压缩效果',
            enum: ['compress', 'estimate', 'preview'],
            default: 'compress',
        },
        strategy: {
            type: 'string',
            description: '压缩策略：summarize|extract|sliding_window|hybrid',
            enum: ['summarize', 'extract', 'sliding_window', 'hybrid'],
            default: 'hybrid',
        },
        messages: {
            type: 'array',
            items: { type: 'object', description: '聊天消息' },
            description: '要压缩的消息列表（如不提供则使用内部状态）',
        },
        keep_recent: {
            type: 'number',
            description: '保留最近N条消息不压缩',
            default: 4,
        },
        max_tokens: {
            type: 'number',
            description: '压缩后最大Token数（估算），默认 2000',
            default: 2000,
        },
        focus: {
            type: 'string',
            description: '压缩关注点（如 "代码修改" "错误排查"），用于提取关键信息',
        },
    },
    requiredParams: ['action'],
    requiredPermissions: [types_1.Permission.MEMORY_READ, types_1.Permission.MEMORY_WRITE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 30000,
};
function estimateTokens(text) {
    if (!text)
        return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
}
function extractKeyPoints(messages, focus) {
    const keyPoints = [];
    const codeBlocks = [];
    const fileMentions = new Set();
    const errorMentions = [];
    for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const codeMatch = content.match(/```[\s\S]*?```/g);
        if (codeMatch) {
            for (const block of codeMatch) {
                if (block.length < 500) {
                    codeBlocks.push(block);
                }
            }
        }
        const fileMatch = content.match(/[\w/.-]+\.\w{1,10}/g);
        if (fileMatch) {
            for (const f of fileMatch) {
                if (f.length > 3 && f.length < 80) {
                    fileMentions.add(f);
                }
            }
        }
        if (/error|错误|失败|exception|traceback/i.test(content)) {
            const errorLine = content
                .split('\n')
                .find((line) => /error|错误|失败|exception/i.test(line));
            if (errorLine) {
                errorMentions.push(errorLine.trim().substring(0, 100));
            }
        }
    }
    if (errorMentions.length > 0) {
        keyPoints.push(`⚠️ 错误: ${errorMentions.slice(0, 3).join('; ')}`);
    }
    if (fileMentions.size > 0) {
        const files = Array.from(fileMentions).slice(0, 10);
        keyPoints.push(`📄 涉及文件: ${files.join(', ')}`);
    }
    if (codeBlocks.length > 0) {
        keyPoints.push(`💻 代码片段: ${codeBlocks.length}个`);
    }
    if (focus) {
        keyPoints.push(`🎯 关注点: ${focus}`);
    }
    return keyPoints;
}
function slidingWindowCompress(messages, keepRecent) {
    const total = messages.length;
    const preserved = messages.slice(-keepRecent);
    const toCompress = messages.slice(0, -keepRecent);
    const keyPoints = extractKeyPoints(toCompress);
    const summaryParts = [
        `[对话压缩摘要 — 前${toCompress.length}条消息]`,
        '',
        `原始消息数: ${total}`,
        `保留最近: ${keepRecent}条`,
        '',
    ];
    if (keyPoints.length > 0) {
        summaryParts.push('关键信息:');
        for (const point of keyPoints) {
            summaryParts.push(`  ${point}`);
        }
        summaryParts.push('');
    }
    const userMessages = toCompress.filter((m) => m.role === 'user');
    const assistantMessages = toCompress.filter((m) => m.role === 'assistant');
    summaryParts.push(`用户消息: ${userMessages.length}条, 助手消息: ${assistantMessages.length}条`);
    const summary = summaryParts.join('\n');
    const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
    const compressedTokens = estimateTokens(summary) +
        preserved.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
    return {
        originalCount: total,
        compressedCount: 1 + preserved.length,
        summary,
        keyPoints,
        preservedMessages: preserved,
        compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
        strategy: 'sliding_window',
    };
}
function extractCompress(messages, keepRecent, focus) {
    const total = messages.length;
    const preserved = messages.slice(-keepRecent);
    const toCompress = messages.slice(0, -keepRecent);
    const keyPoints = extractKeyPoints(toCompress, focus);
    const userIntents = toCompress
        .filter((m) => m.role === 'user')
        .map((m) => {
        const content = typeof m.content === 'string' ? m.content : '';
        return content.substring(0, 100);
    })
        .filter(Boolean);
    const summaryParts = [`[关键信息提取 — ${toCompress.length}条消息]`, ''];
    if (userIntents.length > 0) {
        summaryParts.push('用户意图:');
        for (const intent of userIntents.slice(0, 5)) {
            summaryParts.push(`  - ${intent}`);
        }
        summaryParts.push('');
    }
    if (keyPoints.length > 0) {
        summaryParts.push('关键信息:');
        for (const point of keyPoints) {
            summaryParts.push(`  ${point}`);
        }
    }
    const summary = summaryParts.join('\n');
    const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
    const compressedTokens = estimateTokens(summary) +
        preserved.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
    return {
        originalCount: total,
        compressedCount: 1 + preserved.length,
        summary,
        keyPoints,
        preservedMessages: preserved,
        compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
        strategy: 'extract',
    };
}
function createConversationCompressionExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const action = String(params.action || 'compress');
        const strategy = String(params.strategy || 'hybrid');
        const keepRecent = Number(params.keep_recent) || 4;
        const focus = params.focus ? String(params.focus) : undefined;
        const rawMessages = params.messages;
        const messages = (rawMessages || []).map((m) => ({
            role: m.role || 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            name: m.name,
            tool_calls: m.tool_calls,
            tool_call_id: m.tool_call_id,
        }));
        if (action === 'estimate') {
            const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
            const avgTokensPerMsg = messages.length > 0 ? Math.round(totalTokens / messages.length) : 0;
            const lines = [
                '📊 Token 估算',
                '',
                `消息数: ${messages.length}`,
                `总 Token (估算): ~${totalTokens}`,
                `平均每条: ~${avgTokensPerMsg}`,
                '',
                '压缩预估:',
                `  sliding_window (保留${keepRecent}条): ~${Math.round(totalTokens * 0.3)} Token`,
                `  extract: ~${Math.round(totalTokens * 0.2)} Token`,
                `  summarize: ~${Math.round(totalTokens * 0.15)} Token`,
            ];
            return {
                success: true,
                output: lines.join('\n'),
                duration: Date.now() - startTime,
                validated: false,
                metadata: {
                    messageCount: messages.length,
                    estimatedTokens: totalTokens,
                },
            };
        }
        if (action === 'preview') {
            const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
            const keyPoints = extractKeyPoints(messages, focus);
            const lines = [
                '👁️ 压缩预览',
                '',
                `当前: ${messages.length} 条消息, ~${totalTokens} Token`,
                `策略: ${strategy}`,
                `保留最近: ${keepRecent} 条`,
                '',
                '将提取的关键信息:',
            ];
            for (const point of keyPoints) {
                lines.push(`  ${point}`);
            }
            return {
                success: true,
                output: lines.join('\n'),
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        // action === 'compress'
        if (messages.length <= keepRecent) {
            return {
                success: true,
                output: `消息数(${messages.length})不超过保留数(${keepRecent})，无需压缩`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        let result;
        if (strategy === 'sliding_window') {
            result = slidingWindowCompress(messages, keepRecent);
        }
        else if (strategy === 'extract') {
            result = extractCompress(messages, keepRecent, focus);
        }
        else if (strategy === 'summarize' && deps.llm) {
            const toCompress = messages.slice(0, -keepRecent);
            const preserved = messages.slice(-keepRecent);
            const keyPoints = extractKeyPoints(toCompress, focus);
            try {
                const conversationText = toCompress
                    .map((m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content.substring(0, 300) : ''}`)
                    .join('\n');
                const llmSummary = await deps.llm.chat(`请将以下对话历史压缩为简洁摘要，保留关键决策、代码修改、错误信息。${focus ? `关注点: ${focus}` : ''}\n\n${conversationText}`, [], '你是一个对话压缩助手。输出简洁的对话摘要。');
                const originalTokens = messages.reduce((sum, m) => sum +
                    estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
                const compressedTokens = estimateTokens(llmSummary) +
                    preserved.reduce((sum, m) => sum +
                        estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
                result = {
                    originalCount: messages.length,
                    compressedCount: 1 + preserved.length,
                    summary: llmSummary,
                    keyPoints,
                    preservedMessages: preserved,
                    compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
                    strategy: 'summarize',
                };
            }
            catch (err) {
                Logger_1.Logger.warn(`LLM 摘要失败，降级到 extract 策略: ${err.message}`, 'ConversationCompression');
                result = extractCompress(messages, keepRecent, focus);
            }
        }
        else {
            // hybrid: extract + sliding_window
            result = extractCompress(messages, keepRecent, focus);
            result.strategy = 'hybrid';
        }
        const savings = ((1 - result.compressionRatio) * 100).toFixed(0);
        const output = [
            `🗜️ 对话压缩完成`,
            '',
            `策略: ${result.strategy}`,
            `原始: ${result.originalCount} 条消息`,
            `压缩后: ${result.compressedCount} 条 (1条摘要 + ${result.preservedMessages.length}条最近消息)`,
            `压缩率: ${savings}% Token 节省`,
            '',
            '--- 摘要 ---',
            result.summary,
        ].join('\n');
        Logger_1.Logger.info(`🗜️ conversation_compression: ${result.originalCount}→${result.compressedCount} (${savings}% 节省)`, 'ConversationCompression');
        return {
            success: true,
            output,
            duration: Date.now() - startTime,
            validated: false,
            metadata: {
                originalCount: result.originalCount,
                compressedCount: result.compressedCount,
                compressionRatio: result.compressionRatio,
                strategy: result.strategy,
                summary: result.summary,
                preservedMessages: result.preservedMessages.map((m) => ({
                    role: m.role,
                    contentLength: typeof m.content === 'string' ? m.content.length : 0,
                })),
            },
        };
    };
}

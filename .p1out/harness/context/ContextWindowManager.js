"use strict";
/**
 * ContextWindowManager - 上下文系统辅助组件
 *
 * 【架构定位】
 * 上下文系统辅助组件，负责循环级上下文窗口管理
 *
 * 【核心职责】
 * - Token 预算管理：根据模型上下文窗口动态调整
 * - 工具结果截断：防止 shell_exec 等工具输出撑爆上下文
 * - 动态上下文压缩：基于重要性的优先级排序，智能压缩
 * - 上下文窗口控制：确保不超过模型最大上下文限制
 *
 * 【与 ContextManager 的分工】
 * - ContextManager: 会话级上下文构建（宪法prompt + 记忆注入 + 初始历史）
 * - ContextWindowManager（本文件）: 循环级上下文窗口管理（token预算 + 工具结果截断 + 动态压缩）
 *
 * 【在整体架构中的位置】
 * ConstitutionPromptBuilder + 对话历史 → ContextWindowManager（本文件）→ 最终 Prompt
 *
 * 【优先级排序（高→低）】
 * 1. 系统 prompt（宪法 + 工具提示 + 守卫指令）
 * 2. 最近 N 轮对话（assistant + tool_calls + 工具结果）
 * 3. 工具结果（截断后）
 * 4. 早期历史（压缩为摘要）
 *
 * 【使用场景】
 * - 主循环每轮的上下文窗口管理
 * - 工具执行结果的截断与压缩
 * - 不同模型的上下文窗口适配
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextWindowManager = exports.DEFAULT_WINDOW_CONFIG = void 0;
const Logger_1 = require("../../utils/Logger");
const TokenEstimator_1 = require("../../shared/TokenEstimator");
/** 默认配置（动态适配模型上下文窗口，默认 32K，可通过 LLM_CONTEXT_WINDOW 环境变量覆盖） */
const _defaultContextTokens = parseInt(process.env.LLM_CONTEXT_WINDOW || '', 10) || 32768;
exports.DEFAULT_WINDOW_CONFIG = {
    maxContextTokens: _defaultContextTokens,
    compressionThreshold: 0.8,
    keepRecentMessages: 6,
    maxToolResultTokens: Math.floor(_defaultContextTokens * 0.06),
    reservedForCompletion: 1024,
};
/**
 * 上下文窗口管理器
 *
 * 在 Executor 循环中每次 LLM 调用前调用 manageWindow()
 * 确保 messages 不超过模型上下文窗口
 */
class ContextWindowManager {
    constructor(config = {}) {
        this.config = { ...exports.DEFAULT_WINDOW_CONFIG, ...config };
    }
    /**
     * 更新配置（运行时动态调整）
     */
    updateConfig(partial) {
        this.config = { ...this.config, ...partial };
    }
    /**
     * 获取当前配置
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * 主入口：管理上下文窗口
     *
     * 检查 token 预算，超阈值时自动压缩
     * 采用渐进式压缩策略：工具结果截断 → 语义重要性压缩 → 历史摘要
     *
     * @param messages - 当前消息列表
     * @returns 管理后的消息列表（可能被压缩）
     */
    manageWindow(messages) {
        const threshold = Math.floor(this.config.maxContextTokens * this.config.compressionThreshold);
        let managed = [...messages];
        let tokenCount = this.estimateTokens(managed);
        if (tokenCount <= threshold) {
            return managed;
        }
        Logger_1.Logger.info(`📊 上下文窗口管理: ${tokenCount} tokens 超阈值 ${threshold}，开始压缩`, 'ContextWindowManager');
        managed = this.truncateAllToolResults(managed);
        tokenCount = this.estimateTokens(managed);
        if (tokenCount <= threshold) {
            Logger_1.Logger.info(`📊 阶段1(工具结果截断)后: ${tokenCount} tokens`, 'ContextWindowManager');
            return managed;
        }
        managed = this.compressBySemanticImportance(managed, threshold);
        tokenCount = this.estimateTokens(managed);
        if (tokenCount <= threshold) {
            Logger_1.Logger.info(`📊 阶段2(语义重要性压缩)后: ${tokenCount} tokens`, 'ContextWindowManager');
            return managed;
        }
        const result = this.compressHistory(managed);
        Logger_1.Logger.info(`📊 阶段3(历史摘要压缩)后: ${result.compressedTokenCount} tokens (压缩比 ${result.compressionRatio.toFixed(2)})`, 'ContextWindowManager');
        return result.messages;
    }
    /**
     * 截断单个工具结果
     *
     * 策略: 保留头部 + 尾部 + 中间省略提示
     * 头部: 前 40% token
     * 尾部: 后 40% token
     * 中间: "[...已截断 N 字符...]" 提示
     *
     * @param content - 工具结果内容
     * @param toolName - 工具名（用于日志）
     * @returns 截断结果
     */
    truncateToolResult(content, toolName) {
        if (!content) {
            return {
                content: '',
                truncated: false,
                originalLength: 0,
                truncatedLength: 0,
            };
        }
        const originalTokens = this.estimateTextTokens(content);
        const maxTokens = this.config.maxToolResultTokens;
        if (originalTokens <= maxTokens) {
            return {
                content,
                truncated: false,
                originalLength: content.length,
                truncatedLength: content.length,
            };
        }
        // 按比例截断：头部 40% + 中间提示 + 尾部 40%
        const headRatio = 0.4;
        const tailRatio = 0.4;
        const headChars = Math.floor((content.length * maxTokens * headRatio) / originalTokens);
        const tailChars = Math.floor((content.length * maxTokens * tailRatio) / originalTokens);
        const head = content.substring(0, headChars);
        const tail = content.substring(content.length - tailChars);
        const omittedChars = content.length - headChars - tailChars;
        const truncatedContent = `${head}\n\n[...已截断 ${omittedChars} 字符...]\n\n${tail}`;
        Logger_1.Logger.debug(`✂️ 工具结果截断${toolName ? ` (${toolName})` : ''}: ${originalTokens} → ~${this.estimateTextTokens(truncatedContent)} tokens`, 'ContextWindowManager');
        return {
            content: truncatedContent,
            truncated: true,
            originalLength: content.length,
            truncatedLength: truncatedContent.length,
        };
    }
    /**
     * 截断消息列表中所有超长工具结果
     */
    truncateAllToolResults(messages) {
        return messages.map((msg) => {
            if (msg.role !== 'tool' || !msg.content)
                return msg;
            const tokenCount = this.estimateTextTokens(msg.content);
            if (tokenCount <= this.config.maxToolResultTokens)
                return msg;
            const truncated = this.truncateToolResult(msg.content, msg.name);
            return {
                ...msg,
                content: truncated.content,
            };
        });
    }
    /**
     * 基于语义重要性的渐进式压缩
     *
     * 对非system消息按重要性评分排序，逐步移除低重要性消息
     * 直到token数降到阈值以下
     *
     * 重要性评分规则:
     *   - system消息: 不可移除 (score=Infinity)
     *   - 最近3轮对话: 高优先保留 (score+=15)
     *   - 含工具调用/结果的assistant消息: 高重要性 (score+=10)
     *   - 含具体数据(路径/数字/代码块)的消息: 中重要性 (score+=5)
     *   - 纯确认/应答类消息: 低重要性 (score-=5)
     *   - 重复/冗余消息: 低重要性 (score-=8)
     */
    compressBySemanticImportance(messages, targetTokens) {
        const systemMsgs = [];
        const nonSystemMsgs = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                systemMsgs.push(msg);
            } else {
                nonSystemMsgs.push(msg);
            }
        }
        if (nonSystemMsgs.length <= 4) {
            return messages;
        }
        const recentCount = 6;
        const scored = nonSystemMsgs.map((msg, index) => {
            let score = 0;
            const distanceFromEnd = nonSystemMsgs.length - 1 - index;
            if (distanceFromEnd < recentCount) {
                score += 15;
            }
            if (msg.role === 'assistant') {
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    score += 10;
                }
                const content = msg.content || '';
                if (/```[\s\S]*?```/.test(content)) score += 6;
                if (/[\w/.-]+\/[\w/.-]+\.\w+/.test(content)) score += 5;
                if (/\d+\.?\d*/.test(content)) score += 3;
                if (/^(好的|收到|明白|了解|已|完成)/.test(content.trim()) && content.length < 30) {
                    score -= 5;
                }
            }
            if (msg.role === 'tool') {
                score += 7;
                const content = msg.content || '';
                if (/(?:成功|success|完成)/i.test(content)) score += 3;
                if (/(?:失败|error|failed)/i.test(content)) score += 5;
            }
            if (msg.role === 'user') {
                score += 8;
            }
            score -= Math.min(5, Math.floor(distanceFromEnd / 5));
            return { msg, score, index, distanceFromEnd };
        });
        scored.sort((a, b) => a.score - b.score);
        const currentTokens = this.estimateTokens(messages);
        let tokensToRemove = currentTokens - targetTokens;
        const removedIndices = new Set();
        const toolCallToAssistantIndex = new Map();
        const toolCallIdToAssistantIdx = new Map();
        const assistantIdxToToolIndices = new Map();
        for (let i = 0; i < nonSystemMsgs.length; i++) {
            const msg = nonSystemMsgs[i];
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.id) {
                        toolCallIdToAssistantIdx.set(tc.id, i);
                    }
                }
            }
        }
        for (let i = 0; i < nonSystemMsgs.length; i++) {
            const msg = nonSystemMsgs[i];
            if (msg.role === 'tool' && msg.tool_call_id) {
                const assistantIdx = toolCallIdToAssistantIdx.get(msg.tool_call_id);
                if (assistantIdx !== undefined) {
                    toolCallToAssistantIndex.set(i, assistantIdx);
                    if (!assistantIdxToToolIndices.has(assistantIdx)) {
                        assistantIdxToToolIndices.set(assistantIdx, []);
                    }
                    assistantIdxToToolIndices.get(assistantIdx).push(i);
                }
            }
        }
        for (const item of scored) {
            if (tokensToRemove <= 0) break;
            if (item.distanceFromEnd < 2) continue;
            if (item.msg.role === 'user' && item.distanceFromEnd < recentCount) continue;
            if (item.msg.role === 'assistant' && item.msg.tool_calls && item.msg.tool_calls.length > 0) {
                const pairedToolIndices = assistantIdxToToolIndices.get(item.index) || [];
                if (pairedToolIndices.length > 0) {
                    for (const pi of pairedToolIndices) {
                        if (!removedIndices.has(pi)) {
                            const pairedTokens = this.estimateTokens([nonSystemMsgs[pi]]);
                            removedIndices.add(pi);
                            tokensToRemove -= pairedTokens;
                        }
                    }
                }
            }
            if (item.msg.role === 'tool' && item.msg.tool_call_id) {
                const assistantIdx = toolCallToAssistantIndex.get(item.index);
                if (assistantIdx !== undefined && !removedIndices.has(assistantIdx)) {
                    removedIndices.add(assistantIdx);
                    tokensToRemove -= this.estimateTokens([nonSystemMsgs[assistantIdx]]);
                }
            }
            const msgTokens = this.estimateTokens([item.msg]);
            removedIndices.add(item.index);
            tokensToRemove -= msgTokens;
        }
        if (removedIndices.size === 0) {
            return messages;
        }
        const keptNonSystem = nonSystemMsgs.filter((_, index) => !removedIndices.has(index));
        Logger_1.Logger.info(`📊 语义重要性压缩: 移除${removedIndices.size}条低重要性消息`, 'ContextWindowManager');
        return [...systemMsgs, ...keptNonSystem];
    }

    /**
     * 压缩历史消息
     *
     * 策略:
     *   1. 分离 system / non-system 消息
     *   2. 保留最近 N 条 non-system 消息（确保 assistant+tool_calls/tool 配对完整）
     *   3. 早期消息压缩为摘要
     *   4. 合并 system + 摘要 + 近期消息
     */
    compressHistory(messages) {
        const originalTokenCount = this.estimateTokens(messages);
        if (messages.length <= this.config.keepRecentMessages) {
            return {
                messages,
                originalTokenCount,
                compressedTokenCount: originalTokenCount,
                compressionRatio: 1.0,
                strategy: 'no-op',
            };
        }
        const systemMessages = [];
        const nonSystemMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                systemMessages.push(msg);
            }
            else {
                nonSystemMessages.push(msg);
            }
        }
        if (nonSystemMessages.length <= this.config.keepRecentMessages) {
            return {
                messages,
                originalTokenCount,
                compressedTokenCount: originalTokenCount,
                compressionRatio: 1.0,
                strategy: 'no-op',
            };
        }
        // 确定切点，保持 assistant+tool_calls/tool 配对完整
        let cutIndex = nonSystemMessages.length - this.config.keepRecentMessages;
        while (cutIndex > 0 && nonSystemMessages[cutIndex]?.role === 'tool') {
            cutIndex--;
        }
        if (cutIndex > 0 &&
            nonSystemMessages[cutIndex]?.role === 'assistant' &&
            nonSystemMessages[cutIndex].tool_calls) {
            let j = cutIndex + 1;
            while (j < nonSystemMessages.length &&
                nonSystemMessages[j]?.role === 'tool') {
                j++;
            }
            if (j <= nonSystemMessages.length - this.config.keepRecentMessages) {
                cutIndex = j;
            }
        }
        const keptMessages = nonSystemMessages.slice(cutIndex);
        const removedMessages = nonSystemMessages.slice(0, cutIndex);
        // 生成结构化摘要
        const summaryParts = [];
        const topicSet = new Set();
        const toolSummary = new Map();
        for (const msg of removedMessages) {
            if (msg.role === 'user' && msg.content) {
                const content = msg.content;
                const topicKeywords = content.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
                topicKeywords.slice(0, 3).forEach((kw) => topicSet.add(kw));
                summaryParts.push(`用户: ${content.substring(0, 120)}`);
            }
            else if (msg.role === 'assistant' && msg.content) {
                const content = msg.content;
                const keyInfo = this.extractKeyInformation(content);
                summaryParts.push(`助手: ${keyInfo}`);
            }
            else if (msg.role === 'tool' && msg.name) {
                const count = (toolSummary.get(msg.name) || 0) + 1;
                toolSummary.set(msg.name, count);
                const content = (msg.content || '');
                const summary = this.summarizeToolResult(msg.name, content);
                if (summary) {
                    summaryParts.push(`工具[${msg.name}]: ${summary}`);
                }
            }
        }
        const toolSummaryStr = Array.from(toolSummary.entries())
            .map(([name, count]) => `${name}×${count}`)
            .join(', ');
        const result = [];
        // 合并 system 消息
        const systemContent = systemMessages
            .map((m) => m.content || '')
            .filter(Boolean)
            .join('\n\n');
        if (systemContent) {
            result.push({ role: 'system', content: systemContent });
        }
        // 添加历史摘要
        if (summaryParts.length > 0) {
            const topicStr = topicSet.size > 0 ? `\n涉及话题: ${Array.from(topicSet).slice(0, 8).join(', ')}` : '';
            const toolInfo = toolSummaryStr ? `\n工具调用统计: ${toolSummaryStr}` : '';
            result.push({
                role: 'system',
                content: `【历史摘要（已压缩 ${removedMessages.length} 条消息）】${topicStr}${toolInfo}\n${summaryParts.join('\n')}`,
            });
        }
        result.push(...keptMessages);
        const compressedTokenCount = this.estimateTokens(result);
        const compressionRatio = originalTokenCount > 0 ? compressedTokenCount / originalTokenCount : 1.0;
        return {
            messages: result,
            originalTokenCount,
            compressedTokenCount,
            compressionRatio,
            strategy: 'history-summary',
        };
    }
    /**
     * 估算消息列表的 token 数
     */
    estimateTokens(messages) {
        return TokenEstimator_1.TokenEstimator.estimateMessagesTokens(messages);
    }
    extractKeyInformation(content) {
        if (!content || content.length <= 120)
            return content || '';
        const sentences = content.split(/[。！？.!?]/).filter((s) => s.trim().length > 0);
        if (sentences.length <= 2)
            return content.substring(0, 120);
        const scored = sentences.map((s, i) => {
            let score = 0;
            if (i === 0)
                score += 2;
            if (/\d+/.test(s))
                score += 2;
            if (/[\w/.-]+\/[\w/.-]+/.test(s))
                score += 2;
            if (/(?:结果|成功|失败|错误|完成|找到|返回)/.test(s))
                score += 2;
            if (s.trim().length > 80)
                score -= 1;
            return { s, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 2).map((x) => x.s.trim());
        const result = top.join('。');
        return result.length > 120 ? result.substring(0, 120) + '...' : result;
    }
    summarizeToolResult(toolName, content) {
        if (!content)
            return '';
        if (content.length <= 80)
            return content;
        const successMatch = content.match(/(?:成功|success|完成|done|ok)/i);
        const errorMatch = content.match(/(?:失败|error|failed|异常)/i);
        const numberMatch = content.match(/\d+/g);
        const parts = [];
        if (successMatch)
            parts.push('执行成功');
        else if (errorMatch)
            parts.push('执行失败');
        if (numberMatch && numberMatch.length > 0) {
            parts.push(`含${numberMatch.length}个数值`);
        }
        const firstLine = content.split('\n')[0]?.trim() || '';
        if (firstLine.length > 0 && firstLine.length <= 60) {
            parts.push(firstLine);
        }
        else if (firstLine.length > 60) {
            parts.push(firstLine.substring(0, 60) + '...');
        }
        return parts.join(', ') || content.substring(0, 80);
    }
    /**
     * 估算文本的 token 数
     *
     * 区分中英文:
     *   - 中文（CJK）: 约 2 字符 ≈ 1 token
     *   - 英文: 约 4 字符 ≈ 1 token
     *   - 数字/符号: 约 3 字符 ≈ 1 token
     */
    estimateTextTokens(text) {
        return TokenEstimator_1.TokenEstimator.estimateTextTokens(text);
    }
    /**
     * 检查是否需要压缩
     */
    needsCompression(messages) {
        const threshold = Math.floor(this.config.maxContextTokens * this.config.compressionThreshold);
        return this.estimateTokens(messages) > threshold;
    }
    /**
     * 获取当前上下文使用情况
     */
    getUsage(messages) {
        const used = this.estimateTokens(messages);
        const total = this.config.maxContextTokens;
        return {
            used,
            total,
            ratio: used / total,
            needsCompression: used > total * this.config.compressionThreshold,
        };
    }
}
exports.ContextWindowManager = ContextWindowManager;

"use strict";
/**
 * TokenBudgetAllocator - 上下文系统辅助组件（已废弃）
 *
 * 【架构定位】
 * 上下文系统辅助组件，负责 Token 预算分配
 *
 * 【核心职责】
 * - 按优先级和比例分配 Token 预算
 * - 估算文本的 Token 数（区分中英文）
 * - 按预算截断文本
 *
 * 【在整体架构中的位置】
 * ContextManager → TokenBudgetAllocator（本文件）→ 各组件 Token 分配
 *
 * @deprecated 已迁移到 Python agent/core/context_pipeline.py。
 *
 * 废弃状态说明：
 * - 废弃版本：V5.0
 * - 迁移日期：2026-06-22
 * - 预计移除版本：V6.0（约 2026-09）
 * - 替代方案：Python 端 context_pipeline 中的预算分配
 * - 回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现（不推荐）
 * - 维护状态：仅安全修复，不再新增功能
 *
 * 注意：当 AGENT_BACKEND=python（默认）时，此文件不会被使用。
 *       仅当显式设置 AGENT_BACKEND=local 时才会使用此 TS 实现。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBudgetAllocator = void 0;
const TokenEstimator_1 = require("../../shared/TokenEstimator");
const ALLOCATION_RATIOS = {
    systemPrompt: 0.3,
    memory: 0.15,
    history: 0.25,
    dynamicContext: 0.15,
    toolResults: 0.15,
    reserve: 0.1,
};
class TokenBudgetAllocator {
    constructor(totalBudget) {
        this.totalBudget = totalBudget || (process.env.LLM_CONTEXT_WINDOW ? parseInt(process.env.LLM_CONTEXT_WINDOW, 10) : 8000);
    }
    /**
     * 设置总预算
     */
    setTotalBudget(budget) {
        this.totalBudget = budget;
    }
    /**
     * 分配 Token 预算
     */
    allocate() {
        return {
            systemPrompt: Math.floor(this.totalBudget * ALLOCATION_RATIOS.systemPrompt),
            memory: Math.floor(this.totalBudget * ALLOCATION_RATIOS.memory),
            history: Math.floor(this.totalBudget * ALLOCATION_RATIOS.history),
            dynamicContext: Math.floor(this.totalBudget * ALLOCATION_RATIOS.dynamicContext),
            toolResults: Math.floor(this.totalBudget * ALLOCATION_RATIOS.toolResults),
            reserve: Math.floor(this.totalBudget * ALLOCATION_RATIOS.reserve),
        };
    }
    /**
     * 估算文本的 Token 数
     * 改进算法：区分中英文
     * - 中文约 1.5 字/token
     * - 英文约 4 字/token
     * - 混排时分别计算后求和
     */
    estimateTokens(text) {
        return TokenEstimator_1.TokenEstimator.estimateTextTokens(text);
    }
    /**
     * 按预算截断文本
     */
    truncateToBudget(text, budget) {
        const maxChars = budget * 2;
        if (text.length <= maxChars)
            return text;
        return text.substring(0, maxChars) + '\n...[内容已截断以适应Token预算]';
    }
}
exports.TokenBudgetAllocator = TokenBudgetAllocator;

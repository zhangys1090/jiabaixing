"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptOptimizer = void 0;
const Logger_1 = require("../utils/Logger");
const TokenEstimator_1 = require("../shared/TokenEstimator");
class PromptOptimizer {
    static optimizePrompt(prompt, maxLength = 2000) {
        if (prompt.length <= maxLength) {
            return prompt;
        }
        Logger_1.Logger.warn(`Prompt过长 (${prompt.length} chars)，智能压缩到 ${maxLength} chars`, 'PromptOptimizer');
        const lines = prompt.split('\n');
        const scored = lines.map((line, index) => {
            let score = 0;
            const trimmed = line.trim();
            if (index === 0)
                score += 10;
            if (trimmed.startsWith('#'))
                score += 5;
            if (trimmed.startsWith('- ') || trimmed.startsWith('* '))
                score += 2;
            if (/```/.test(trimmed))
                score += 4;
            if (/\d+\.?\d*/.test(trimmed))
                score += 2;
            if (/[\w/.-]+\/[\w/.-]+\.\w+/.test(trimmed))
                score += 3;
            if (/(?:结果|输出|返回|错误|成功|失败|完成|注意|重要|警告|错误)/.test(trimmed))
                score += 3;
            if (/(?:当然|众所周知|需要注意的是|总之|综上|另外|此外)/.test(trimmed))
                score -= 3;
            if (trimmed.length === 0)
                score -= 5;
            else if (trimmed.length < 5)
                score -= 2;
            return { line, score, index };
        });
        const headCount = Math.min(5, lines.length);
        const tailCount = Math.min(3, lines.length);
        const headSet = new Set(scored.slice(0, headCount).map((s) => s.index));
        const tailSet = new Set(scored.slice(-tailCount).map((s) => s.index));
        const mandatory = new Set([...headSet, ...tailSet]);
        const middle = scored
            .filter((s) => !mandatory.has(s.index))
            .sort((a, b) => b.score - a.score);
        const selected = new Set(mandatory);
        let totalLen = 0;
        for (const m of mandatory) {
            totalLen += lines[m].length + 1;
        }
        for (const item of middle) {
            const lineLen = item.line.length + 1;
            if (totalLen + lineLen <= maxLength) {
                selected.add(item.index);
                totalLen += lineLen;
            }
        }
        const result = scored
            .filter((s) => selected.has(s.index))
            .sort((a, b) => a.index - b.index)
            .map((s) => s.line)
            .join('\n');
        return result.trim();
    }
    static compressHistory(history, maxTokens = 1000) {
        if (history.length <= 2) {
            return history;
        }
        const estimateTokens = (text) => TokenEstimator_1.TokenEstimator.estimateTextTokens(text);
        const scored = history.map((item, index) => {
            let score = 0;
            if (item.role === 'user')
                score += 2;
            if (item.role === 'tool')
                score += 1;
            if (index === history.length - 1)
                score += 10;
            if (index === history.length - 2)
                score += 5;
            const content = item.content || '';
            if (/(?:错误|失败|error|fail)/i.test(content))
                score += 3;
            if (/(?:成功|完成|success|done)/i.test(content))
                score += 2;
            if (/\d+/.test(content))
                score += 1;
            return { item, score, tokens: estimateTokens(content), index };
        });
        const recentCount = Math.min(4, history.length);
        const recentIndices = scored.slice(-recentCount).map((s) => s.index);
        const recentSet = new Set(recentIndices);
        const compressed = [];
        let totalTokens = 0;
        for (const idx of recentIndices) {
            const item = history[idx];
            const tokens = estimateTokens(item.content);
            if (totalTokens + tokens <= maxTokens) {
                compressed.push({ item, originalIndex: idx });
                totalTokens += tokens;
            }
        }
        const older = scored
            .filter((s) => !recentSet.has(s.index))
            .sort((a, b) => b.score - a.score);
        for (const entry of older) {
            if (totalTokens + entry.tokens <= maxTokens) {
                compressed.push({ item: entry.item, originalIndex: entry.index });
                totalTokens += entry.tokens;
            }
        }
        compressed.sort((a, b) => a.originalIndex - b.originalIndex);
        const result = compressed.map((c) => c.item);
        if (result.length < history.length) {
            Logger_1.Logger.warn(`历史对话已压缩: ${history.length} -> ${result.length} 条消息`, 'PromptOptimizer');
        }
        return result;
    }
}
exports.PromptOptimizer = PromptOptimizer;

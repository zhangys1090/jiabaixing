"use strict";
/**
 * Harness Layer 5: Evaluation - 五维质量评分器
 *
 * QualityScorer 对 Agent 的完整执行过程进行多维度质量评估：
 * - accuracy:   准确率 — 工具调用是否正确、结果是否符合预期
 * - efficiency: 效率   — 执行耗时、重试次数、资源消耗
 * - safety:     安全   — 敏感信息泄露、权限违规、风险内容
 * - persona:    人设一致性 — 输出是否符合御姐秘书人设风格
 * - stability:  稳定性 — 执行过程是否平稳、错误率
 *
 * 输入: StepEvaluationResult[] + 执行元数据
 * 输出: 各维度 0-100 分 + 综合评分 + 评分说明 + 改进建议
 *
 * Phase 11: 自评估与持续优化管道
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QualityScorer = void 0;
/** 默认权重 — 安全最高，准确率次之，新增幻觉检测 */
const DEFAULT_WEIGHTS = {
    accuracy: 0.2,
    efficiency: 0.12,
    safety: 0.25,
    persona: 0.12,
    stability: 0.13,
    groundedness: 0.18,
};
/** 人设一致性关键词（御姐秘书风格） */
const PERSONA_POSITIVE_KEYWORDS = [
    '您',
    '请',
    '建议',
    '提醒',
    '汇报',
    '记录',
    '整理',
    '安排',
    '查看',
    '确认',
    '好的',
    '明白',
    '收到',
    '已',
    '温馨',
    '贴心',
    '周到',
    '为您',
    '帮您',
    '需要',
    '已经',
    '完成',
    '正在',
    '稍等',
    '马上',
    '没问题',
    '放心',
    '注意',
    '重要',
    '推荐',
    '优化',
    '检查',
    '更新',
    '配置',
];
const PERSONA_NEGATIVE_PATTERNS = [
    /(?:哈哈|hhh|笑死)/i,
    /兄弟们?/i,
    /老铁/i,
    /卧槽/i,
    /(?:草|擦)$/im,
    /\btbh/i,
    /\blol\b/i,
    /yyds/i,
    /绝了/i,
    /666/i,
    /(?:nb|牛逼)/i,
    /(?:awsl|xswl)/i,
    /u1s1/i,
    /zqsg/i,
    /emmm/i,
];
class QualityScorer {
    constructor(weights) {
        this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    }
    /**
     * 主入口：对执行结果进行五维评分
     *
     * @param stepResults  每一步的评估结果
     * @param metadata     执行元数据（耗时、重试、错误数等）
     * @returns QualityScore 包含综合分、各维度分、说明和建议
     */
    score(stepResults, metadata) {
        const dimensions = this.computeDimensions(stepResults, metadata);
        const overall = this.weightedAverage(dimensions);
        const breakdown = this.generateBreakdown(dimensions, metadata);
        const suggestions = this.generateSuggestions(dimensions, stepResults, metadata);
        return {
            overall: Math.round(overall * 10) / 10,
            dimensions,
            breakdown,
            suggestions,
        };
    }
    /**
     * 更新权重配置
     */
    setWeights(weights) {
        this.weights = { ...this.weights, ...weights };
    }
    /**
     * 获取当前权重配置
     */
    getWeights() {
        return { ...this.weights };
    }
    // ── 维度评分方法 ──
    computeDimensions(stepResults, metadata) {
        return {
            accuracy: this.scoreAccuracy(stepResults, metadata),
            efficiency: this.scoreEfficiency(metadata),
            safety: this.scoreSafety(stepResults, metadata),
            persona: this.scorePersona(metadata),
            stability: this.scoreStability(stepResults, metadata),
            groundedness: this.scoreGroundedness(stepResults, metadata),
        };
    }
    /**
     * 准确率评分 (0-100)
     * - 步骤通过率
     * - 工具调用成功率
     * - 输出是否为空或错误
     */
    scoreAccuracy(stepResults, metadata) {
        if (stepResults.length === 0) {
            const successRate = metadata.totalToolCalls
                ? (metadata.successfulToolCalls ?? 0) / metadata.totalToolCalls
                : 0.5;
            const baseScore = Math.round(successRate * 70);
            const contentQuality = this.scoreContentQuality(metadata);
            return this.clampScore(baseScore * 0.7 + contentQuality.score * 0.3);
        }
        const passedSteps = stepResults.filter((s) => s.passed).length;
        const passRate = passedSteps / stepResults.length;
        const avgStepScore = stepResults.reduce((sum, s) => sum + s.score, 0) / stepResults.length;
        const raw = passRate * 0.5 * 100 + avgStepScore * 0.3 * 100;
        const contentQuality = this.scoreContentQuality(metadata);
        const combined = raw + contentQuality.score * 0.2;
        return this.clampScore(combined);
    }
    /**
     * 效率评分 (0-100)
     * - 执行耗时: 越短越高
     * - 重试次数: 越少越高
     * - 工具调用密度: 适中为好
     */
    scoreEfficiency(metadata) {
        let score = 100;
        // 耗时惩罚 (基准 5s，每多 5s 减 5 分)
        if (metadata.duration > 5000) {
            const penalty = Math.min(40, Math.floor((metadata.duration - 5000) / 5000) * 5);
            score -= penalty;
        }
        // 重试惩罚 (每次重试减 10 分)
        score -= Math.min(40, metadata.retries * 10);
        // 错误惩罚 (每次错误减 15 分)
        score -= Math.min(50, metadata.errors * 15);
        // 工具调用密度合理性
        const totalCalls = metadata.totalToolCalls ?? 0;
        if (totalCalls > 15) {
            score -= Math.min(20, (totalCalls - 15) * 2);
        }
        return this.clampScore(score);
    }
    /**
     * 安全评分 (0-100)
     * - 检查敏感信息泄露
     * - 检查错误/异常栈泄露
     * - 基于 StepEvaluationResult 中 issues 的类型
     */
    scoreSafety(stepResults, _metadata) {
        if (stepResults.length === 0) {
            return 100; // 无步骤时假设安全
        }
        let hasSensitiveLeak = false;
        let hasErrorSeverity = false;
        let hasErrorOutput = false;
        let hasExecutionFailure = false;
        let totalIssues = 0;
        for (const step of stepResults) {
            for (const issue of step.issues) {
                totalIssues++;
                if (issue.type === 'SENSITIVE_INFO_LEAK' ||
                    issue.type === 'SENSITIVE_DATA') {
                    hasSensitiveLeak = true;
                }
                if (issue.severity === 'error') {
                    hasErrorSeverity = true;
                }
                if (issue.type === 'ERROR_IN_OUTPUT') {
                    hasErrorOutput = true;
                }
                if (issue.type === 'EXECUTION_FAILED') {
                    hasExecutionFailure = true;
                }
            }
        }
        // 严重安全违规：敏感信息泄露 = 直接 0 分
        if (hasSensitiveLeak) {
            return 0;
        }
        let score = 100;
        // 存在 error 级别问题，安全分上限降至 20
        if (hasErrorSeverity) {
            score = 20;
        }
        // 输出含异常信息
        if (hasErrorOutput) {
            score -= 40;
        }
        // 执行失败
        if (hasExecutionFailure) {
            score -= 30;
        }
        // 每个 issue 减分
        score -= Math.min(30, totalIssues * 5);
        return this.clampScore(score);
    }
    /**
     * 人设一致性评分 (0-100)
     * - 使用正向关键词匹配评估风格符合度
     * - 检测负面模式
     * - 输出长度合理性
     */
    scorePersona(metadata) {
        const context = metadata.context || '';
        if (!context) {
            return 70; // 无文本时给中等分
        }
        let score = 60; // 基础分
        // 正向关键词加分
        const positiveHits = PERSONA_POSITIVE_KEYWORDS.filter((kw) => context.includes(kw)).length;
        score += Math.min(30, positiveHits * 5);
        // 负面模式扣分
        for (const pattern of PERSONA_NEGATIVE_PATTERNS) {
            if (pattern.test(context)) {
                score -= 20;
            }
        }
        // 输出长度合理性
        const outputLen = metadata.outputLength ?? context.length;
        if (outputLen < 10) {
            score -= 15; // 输出太短
        }
        else if (outputLen > 2000) {
            score -= 10; // 输出过长可能有冗余
        }
        return this.clampScore(score);
    }
    /**
     * 稳定性评分 (0-100)
     * - 步间评分方差
     * - 失败步骤占比
     * - 工具调用成功率
     */
    scoreStability(stepResults, metadata) {
        if (stepResults.length === 0) {
            // 无步骤记录，用元数据估算
            if (metadata.errors > 0) {
                return this.clampScore(100 - metadata.errors * 20);
            }
            return 85;
        }
        // 失败步骤占比
        const failedSteps = stepResults.filter((s) => !s.passed).length;
        const failRatio = failedSteps / stepResults.length;
        let score = 100 - failRatio * 60;
        // 分数方差 — 方差越大越不稳定
        const scores = stepResults.map((s) => s.score);
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
        // 方差惩罚: 方差 > 0.1 时扣分
        if (variance > 0.1) {
            const vPenalty = Math.min(20, Math.floor(variance * 50));
            score -= vPenalty;
        }
        // 错误次数惩罚
        score -= Math.min(30, metadata.errors * 10);
        return this.clampScore(score);
    }

    /**
     * 数据根植性/幻觉检测评分 (0-100)
     *
     * 评估输出是否基于实际工具数据而非LLM编造：
     * - 工具调用成功率：有工具调用且成功 = 高分
     * - 输出中数据引用：引用了工具返回的具体数据 = 加分
     * - 幻觉特征检测：虚构URL/路径/引用 = 重罚
     * - 无工具调用纯文本输出 = 中低分（可能基于模型知识）
     */
    scoreGroundedness(stepResults, metadata) {
        const context = metadata.context || '';
        const totalToolCalls = metadata.totalToolCalls ?? 0;
        const successfulToolCalls = metadata.successfulToolCalls ?? 0;
        let score = 40;
        if (totalToolCalls > 0) {
            const toolSuccessRate = successfulToolCalls / totalToolCalls;
            score += Math.round(toolSuccessRate * 35);
            if (totalToolCalls >= 2) {
                score += 5;
            }
        } else {
            score -= 15;
        }
        if (context) {
            const specificDataPatterns = [
                /[\w/.-]+\/[\w/.-]+\.\w+/,
                /\b\d+\.?\d*%\b/,
                /\b0x[0-9a-fA-F]+\b/,
                /```[\s\S]*?```/,
                /\b(https?:\/\/|www\.)\S+\b/,
            ];
            const specificCount = specificDataPatterns.filter(p => p.test(context)).length;
            score += Math.min(10, specificCount * 3);
            const hallucinationIndicators = [
                /https?:\/\/(?:example|fake|dummy|placeholder|test)\.[\w.]+/i,
                /(?:根据|据|引用|参考).*(?:虚构|编造|不存在|假设的)/i,
                /(?:我不确定|可能不准确|可能不正确).*(?:但|不过|然而)/i,
                /(?:20[5-9]\d|2[1-9]\d{2})年.*(?:预测|预计|估计)/,
            ];
            const hallucinationCount = hallucinationIndicators.filter(p => p.test(context)).length;
            score -= Math.min(30, hallucinationCount * 15);
            const fillerPatterns = [/当然[，,]/g, /众所周知[，,]/g, /需要注意的是[，,]/g, /总而言之/g, /综上所述/g];
            let fillerCount = 0;
            for (const p of fillerPatterns) {
                const matches = context.match(p);
                if (matches) fillerCount += matches.length;
            }
            if (fillerCount > 2 && totalToolCalls === 0) {
                score -= Math.min(15, fillerCount * 3);
            }
        }
        return this.clampScore(score);
    }

    // ── 辅助方法 ──
    /**
     * 加权平均计算综合评分
     */
    weightedAverage(dimensions) {
        return (dimensions.accuracy * this.weights.accuracy +
            dimensions.efficiency * this.weights.efficiency +
            dimensions.safety * this.weights.safety +
            dimensions.persona * this.weights.persona +
            dimensions.stability * this.weights.stability +
            dimensions.groundedness * (this.weights.groundedness || 0));
    }
    /**
     * 生成评分说明
     */
    generateBreakdown(dimensions, metadata) {
        const lines = [
            `六维质量评分报告`,
            `═══════════════════`,
            `准确率(accuracy):   ${dimensions.accuracy.toFixed(1)}/100 (权重 ${(this.weights.accuracy * 100).toFixed(0)}%)`,
            `效率(efficiency):   ${dimensions.efficiency.toFixed(1)}/100 (权重 ${(this.weights.efficiency * 100).toFixed(0)}%)`,
            `安全(safety):       ${dimensions.safety.toFixed(1)}/100 (权重 ${(this.weights.safety * 100).toFixed(0)}%)`,
            `人设(persona):      ${dimensions.persona.toFixed(1)}/100 (权重 ${(this.weights.persona * 100).toFixed(0)}%)`,
            `稳定性(stability):  ${dimensions.stability.toFixed(1)}/100 (权重 ${(this.weights.stability * 100).toFixed(0)}%)`,
            `根植性(groundedness): ${dimensions.groundedness.toFixed(1)}/100 (权重 ${((this.weights.groundedness || 0) * 100).toFixed(0)}%)`,
            `───────────────────────────────`,
            `综合评分: ${this.weightedAverage(dimensions).toFixed(1)}/100`,
            `───────────────────────────────`,
        ];
        // 执行信息
        lines.push(`执行信息:`);
        lines.push(`  耗时: ${metadata.duration}ms`);
        lines.push(`  重试: ${metadata.retries} 次`);
        lines.push(`  错误: ${metadata.errors} 次`);
        if (metadata.totalToolCalls !== undefined) {
            lines.push(`  工具调用: ${metadata.totalToolCalls} 次`);
        }
        if (metadata.loopRounds !== undefined) {
            lines.push(`  执行轮次: ${metadata.loopRounds} 轮`);
        }
        return lines.join('\n');
    }
    /**
     * 输出内容质量评分 (0-100)
     *
     * 基于输出文本本身的特征评估质量：
     * - 信息密度：有效信息 vs 冗余/套话
     * - 结构性：是否有列表、代码块、分段等结构
     * - 具体性：是否包含具体数据/路径/名称 vs 模糊描述
     * - 完整性：是否截断/省略
     */
    scoreContentQuality(metadata) {
        const context = metadata.context || '';
        if (!context || context.length < 10) {
            return { score: 30, details: '输出为空或过短' };
        }
        let score = 50;
        const structureIndicators = [
            /\n[-*•]\s/,
            /\n\d+[.)]\s/,
            /```[\s\S]*?```/,
            /\n#{1,6}\s/,
            /\|.*\|.*\|/,
            /\n>\s/,
        ];
        const structureCount = structureIndicators.filter((p) => p.test(context)).length;
        score += Math.min(20, structureCount * 5);
        const specificDataPatterns = [
            /\b\d+\.?\d*%?\b/,
            /[\w/.-]+\/[\w/.-]+\.\w+/,
            /\b[A-Z][\w]*\b/,
            /`[^`]+`/,
            /\b(https?:\/\/|www\.)\S+\b/,
        ];
        const specificCount = specificDataPatterns.filter((p) => p.test(context)).length;
        score += Math.min(15, specificCount * 4);
        const fillerPatterns = [
            /当然[，,]/g,
            /众所周知[，,]/g,
            /需要注意的是[，,]/g,
            /总而言之/g,
            /综上所述/g,
            /首先.*其次.*最后/gs,
        ];
        let fillerCount = 0;
        for (const p of fillerPatterns) {
            const matches = context.match(p);
            if (matches)
                fillerCount += matches.length;
        }
        score -= Math.min(15, fillerCount * 5);
        const truncationMarkers = ['...', '…', '[截断]', '[truncated]', '等更多', '等内容'];
        const hasTruncation = truncationMarkers.some((m) => context.includes(m));
        if (hasTruncation) {
            score -= 10;
        }
        const sentences = context.split(/[。！？.!?]/).filter((s) => s.trim().length > 0);
        const avgSentenceLen = sentences.length > 0
            ? context.length / sentences.length
            : context.length;
        if (avgSentenceLen > 200) {
            score -= 5;
        }
        else if (avgSentenceLen > 30 && avgSentenceLen <= 200) {
            score += 5;
        }
        score = Math.max(0, Math.min(100, score));
        const details = [];
        if (structureCount > 0)
            details.push(`${structureCount}种结构`);
        if (specificCount > 0)
            details.push(`${specificCount}种具体数据`);
        if (fillerCount > 0)
            details.push(`${fillerCount}处套话`);
        if (hasTruncation)
            details.push('输出截断');
        return { score, details: details.join(', ') || '基础内容' };
    }
    /**
     * 生成改进建议
     */
    generateSuggestions(dimensions, stepResults, metadata) {
        const suggestions = [];
        // 从步骤评估结果中聚合建议
        for (const step of stepResults) {
            for (const suggestion of step.suggestions) {
                if (!suggestions.includes(suggestion)) {
                    suggestions.push(suggestion);
                }
            }
        }
        // 维度级别建议
        if (dimensions.accuracy < 60) {
            suggestions.push('提高工具调用准确性，检查参数和返回结果');
        }
        if (dimensions.efficiency < 60) {
            suggestions.push('优化执行效率：减少重试次数，缩短工具调用耗时');
            if (metadata.totalToolCalls && metadata.totalToolCalls > 10) {
                suggestions.push('减少不必要的工具调用，考虑批量操作');
            }
        }
        if (dimensions.safety < 60) {
            suggestions.push('加强安全审查：检查敏感信息泄露和异常输出');
        }
        if (dimensions.persona < 60) {
            suggestions.push('保持御姐秘书人设：使用尊称和正式用语，避免网络用语');
        }
        if (dimensions.stability < 60) {
            suggestions.push('提升执行稳定性：减少错误和异常步骤');
        }
        if (dimensions.groundedness < 50) {
            suggestions.push('输出可能基于模型知识而非实际数据，增加工具调用验证');
        }
        else if (dimensions.groundedness < 70) {
            suggestions.push('数据根植性不足，确保关键结论有工具数据支撑');
        }
        const contentQuality = this.scoreContentQuality(metadata);
        if (contentQuality.score < 50) {
            suggestions.push('提升输出内容质量：增加具体数据、使用结构化格式、减少套话');
        }
        // 去重并限制数量
        return [...new Set(suggestions)].slice(0, 10);
    }
    /**
     * 将分数限制在 0-100 之间
     */
    clampScore(score) {
        return Math.round(Math.max(0, Math.min(100, score)));
    }
}
exports.QualityScorer = QualityScorer;
exports.default = QualityScorer;

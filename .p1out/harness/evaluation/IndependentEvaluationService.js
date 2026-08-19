"use strict";
/**
 * Harness Layer 5: Evaluation - 独立评估服务
 *
 * 完全独立的评估服务，不依赖执行上下文
 * 可独立调用，避免"自我评价"的失真问题
 *
 * P0 核心功能：Evaluator 独立化
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IndependentEvaluationService = void 0;
const Logger_1 = require("../../utils/Logger");
const SensitiveDetector_1 = require("../security/SensitiveDetector");
class IndependentEvaluationService {
    constructor(deps = {}) {
        this.deps = deps;
    }
    /**
     * 完整评估 - 主入口方法
     * 完全独立，不依赖任何执行上下文
     */
    async evaluate(input) {
        // 1. 规则基础评估（快速、可靠）
        const ruleEval = this.ruleBasedEvaluate(input);
        // 2. LLM 深度评估（可选，更高质量）
        let llmEval = {};
        if (this.deps.enableLLMEvaluation && this.deps.llm) {
            try {
                llmEval = await this.llmDeepEvaluate(input);
            }
            catch {
                Logger_1.Logger.warn('LLM 深度评估失败，使用规则评估', 'IndependentEvaluationService');
            }
        }
        // 3. 合并结果（LLM 评估优先级更高）
        return this.mergeEvaluationResults(ruleEval, llmEval);
    }
    /**
     * 规则基础评估 - 快速、无依赖
     */
    ruleBasedEvaluate(input) {
        const stepEvaluation = this.evaluateStepResults(input);
        const taskCompletion = this.evaluateTaskCompletion(input);
        const dataGroundedness = this.evaluateDataGroundedness(input);
        const safety = this.evaluateSafety(input);
        const quality = this.evaluateQuality(input);
        const overall = this.calculateOverall(taskCompletion, dataGroundedness, safety, quality, stepEvaluation);
        return {
            taskCompletion,
            dataGroundedness,
            safety,
            quality,
            overall,
        };
    }
    /**
     * 评估工具步骤结果（从 trace.trajectory 提取）
     * P0: 步骤级评估纳入独立评估服务
     */
    evaluateStepResults(input) {
        const toolResults = input.executionTrace?.toolResults || [];
        if (toolResults.length === 0) {
            return {
                allPassed: true,
                failedCount: 0,
                totalCount: 0,
                failedTools: [],
            };
        }
        let failedCount = 0;
        const failedTools = [];
        for (const result of toolResults) {
            if (!result.success) {
                failedCount++;
                failedTools.push(result.toolName);
            }
        }
        return {
            allPassed: failedCount === 0,
            failedCount,
            totalCount: toolResults.length,
            failedTools,
        };
    }
    /**
     * 任务完成评估
     */
    evaluateTaskCompletion(input) {
        const { conversationHistory, currentOutput, executionTrace } = input;
        const lastOutput = currentOutput || this.getLastAssistantContent(conversationHistory) || '';
        const hasToolResults = executionTrace?.toolResults &&
            executionTrace.toolResults.length > 0 &&
            executionTrace.toolResults.some((r) => r.success);
        const isAcknowledgmentOnly = this.isAcknowledgmentResponse(lastOutput);
        const hasFinalOutput = !!((this.hasFinalAssistantMessage(conversationHistory) &&
            !isAcknowledgmentOnly) ||
            (currentOutput && currentOutput.length > 0 && !isAcknowledgmentOnly) ||
            hasToolResults);
        let confidence = 0.5;
        let reason = '未检测到明确的任务完成信号，使用默认评估';
        if (hasToolResults) {
            confidence = 0.8;
            reason = '工具执行成功，任务可能已完成';
        }
        else if (hasFinalOutput) {
            const hasErrorMarkers = [
                '抱歉',
                '无法',
                '失败',
                '错误',
                'error',
                'failed',
            ].some((m) => lastOutput.toLowerCase().includes(m));
            if (hasErrorMarkers) {
                confidence = 0.4;
                reason = '检测到可能的错误信息，但仍有输出';
            }
            else if (lastOutput.length > 50) {
                confidence = 0.7;
                reason = '检测到合理长度的输出';
            }
            else {
                confidence = 0.5;
                reason = '有输出但较短';
            }
        }
        else if (isAcknowledgmentOnly) {
            confidence = 0.2;
            reason = '仅检测到确认响应，未见实际执行';
        }
        return {
            completed: hasFinalOutput && confidence >= 0.5,
            confidence,
            reason,
        };
    }
    /**
     * 判断是否为仅确认类响应（未实际执行）
     */
    isAcknowledgmentResponse(output) {
        if (!output || output.length === 0)
            return false;
        const ackPatterns = [
            /^好的?/,
            /好的[，,]?\s*(我|我们|这)/,
            /^收到/,
            /^明白/,
            /^了解/,
            /开始.+(执行|处理|操作)/,
        ];
        return ackPatterns.some((pattern) => pattern.test(output));
    }
    /**
     * 数据 groundedness 评估
     */
    evaluateDataGroundedness(input) {
        const { conversationHistory, executionTrace } = input;
        const hasToolCalls = executionTrace?.totalToolCalls && executionTrace.totalToolCalls > 0;
        const hasToolMessages = conversationHistory.some((m) => m.role === 'tool');
        const grounded = hasToolCalls || hasToolMessages;
        if (!grounded) {
            return {
                grounded: false,
                confidence: 0.2,
                toolDataRatio: 0,
                citationCount: 0,
                hallucinationRisk: 'high',
                reason: '无工具调用记录，输出完全基于模型知识，幻觉风险高',
            };
        }
        const toolResultCount = executionTrace?.toolResults?.length || conversationHistory.filter((m) => m.role === 'tool').length;
        const successfulToolCount = executionTrace?.toolResults?.filter((r) => r.success).length || toolResultCount;
        const toolDataRatio = toolResultCount > 0 ? successfulToolCount / toolResultCount : 0;
        const output = input.currentOutput || this.getLastAssistantContent(conversationHistory) || '';
        const citationCount = this.countDataCitations(output, conversationHistory);
        const outputLength = output.length;
        const hasSubstantialOutput = outputLength > 100;
        const hasErrorMarkers = ['抱歉', '无法', '失败', '错误', 'error', 'failed'].some((m) => output.toLowerCase().includes(m));
        let confidence = 0.4;
        let hallucinationRisk = 'medium';
        if (toolDataRatio >= 0.8 && hasSubstantialOutput && !hasErrorMarkers) {
            confidence = 0.8;
            hallucinationRisk = 'low';
        }
        else if (toolDataRatio >= 0.5 && hasSubstantialOutput && !hasErrorMarkers) {
            confidence = 0.6;
            hallucinationRisk = 'low';
        }
        else if (toolDataRatio >= 0.5 && hasErrorMarkers) {
            confidence = 0.35;
            hallucinationRisk = 'medium';
        }
        else if (hasSubstantialOutput && !hasErrorMarkers) {
            confidence = 0.45;
            hallucinationRisk = 'medium';
        }
        else {
            confidence = 0.25;
            hallucinationRisk = 'high';
        }
        if (citationCount > 0) {
            confidence = Math.min(1.0, confidence + citationCount * 0.05);
            hallucinationRisk = 'low';
        }
        const reasonParts = [];
        reasonParts.push(`${successfulToolCount}/${toolResultCount}工具调用成功`);
        if (citationCount > 0)
            reasonParts.push(`${citationCount}处数据引用`);
        if (hasErrorMarkers)
            reasonParts.push('输出含错误标记');
        if (!hasSubstantialOutput)
            reasonParts.push('输出过短');
        return {
            grounded: true,
            confidence,
            toolDataRatio,
            citationCount,
            hallucinationRisk,
            reason: `有数据支撑(置信度${confidence.toFixed(2)}): ${reasonParts.join(', ')}`,
        };
    }
    countDataCitations(output, conversationHistory) {
        let count = 0;
        const toolContents = conversationHistory
            .filter((m) => m.role === 'tool' && m.content)
            .map((m) => m.content);
        for (const toolContent of toolContents) {
            const fragments = this.extractDataFragments(toolContent);
            for (const frag of fragments) {
                if (frag.length >= 8 && output.includes(frag)) {
                    count++;
                }
            }
        }
        return count;
    }
    extractDataFragments(content) {
        const fragments = [];
        const numberPattern = /\b\d+\.?\d*\b/g;
        let match;
        while ((match = numberPattern.exec(content)) !== null) {
            if (match[0].length >= 3) {
                const start = Math.max(0, match.index - 15);
                const end = Math.min(content.length, match.index + match[0].length + 15);
                fragments.push(content.substring(start, end));
            }
        }
        const pathPattern = /[\w/.-]+\/[\w/.-]+/g;
        while ((match = pathPattern.exec(content)) !== null) {
            if (match[0].length >= 8) {
                fragments.push(match[0]);
            }
        }
        return fragments.slice(0, 20);
    }
    /**
     * 安全评估
     *
     * 委托给统一敏感信息检测器 SensitiveDetector
     */
    evaluateSafety(input) {
        const { conversationHistory, currentOutput } = input;
        const outputToCheck = currentOutput || this.getLastAssistantContent(conversationHistory) || '';
        // 委托给统一检测器
        const result = (0, SensitiveDetector_1.checkSensitiveInfo)(outputToCheck, 'output');
        const violations = result.violations.map((v) => `${v.name} (风险: ${v.risk})`);
        return {
            safe: result.safe,
            riskLevel: result.riskLevel,
            violations,
            sanitizedOutput: result.sanitizedOutput,
        };
    }
    /**
     * 质量评估
     */
    evaluateQuality(input) {
        const { executionTrace } = input;
        let overall = 0.7;
        let efficiency = 0.8;
        if (executionTrace) {
            if (executionTrace.loopRounds > 3) {
                const penalty = 0.1 * (executionTrace.loopRounds - 3);
                overall -= penalty;
                efficiency -= penalty;
            }
            if (executionTrace.totalDuration > 30000) {
                efficiency -= 0.2;
            }
            else if (executionTrace.totalDuration > 15000) {
                efficiency -= 0.1;
            }
        }
        overall = Math.max(0.1, Math.min(1.0, overall));
        efficiency = Math.max(0.1, Math.min(1.0, efficiency));
        return {
            overall,
            accuracy: Math.max(0.1, overall * 0.9),
            usefulness: Math.max(0.1, overall * 0.95),
            friendliness: Math.max(0.1, 0.8),
            efficiency,
            details: executionTrace
                ? `轮次=${executionTrace.loopRounds} 工具=${executionTrace.totalToolCalls} 时长=${executionTrace.totalDuration}ms`
                : '无执行轨迹数据',
        };
    }
    /**
     * 计算整体建议
     */
    calculateOverall(taskCompletion, dataGroundedness, safety, quality, stepEvaluation) {
        let suggestedAction = 'continue';
        let goalProgress = 0.5;
        let summary = '需要进一步评估';
        if (safety.riskLevel === 'critical') {
            suggestedAction = 'abort';
            goalProgress = 0.1;
            summary = '检测到严重安全风险，建议中止';
        }
        else if (safety.riskLevel === 'high') {
            suggestedAction = 'replan';
            goalProgress = 0.3;
            summary = '检测到高风险内容，建议重新规划';
        }
        else if (stepEvaluation && !stepEvaluation.allPassed) {
            if (stepEvaluation.failedCount === stepEvaluation.totalCount) {
                suggestedAction = 'abort';
                goalProgress = 0;
                summary = `所有工具调用失败 (${stepEvaluation.failedTools.join(', ')})`;
            }
            else {
                suggestedAction = 'replan';
                goalProgress = 0.4;
                summary = `部分工具调用失败: ${stepEvaluation.failedCount}/${stepEvaluation.totalCount} (${stepEvaluation.failedTools.join(', ')})`;
            }
        }
        else if (!taskCompletion.completed) {
            goalProgress = taskCompletion.confidence * 0.6;
            if (taskCompletion.confidence < 0.3) {
                suggestedAction = 'replan';
                summary = '任务进展不明确，建议重新规划';
            }
            else {
                summary = '任务进行中，继续执行';
            }
        }
        else if (taskCompletion.completed && quality.overall >= 0.7) {
            goalProgress = 0.7 + taskCompletion.confidence * 0.3;
            summary = '任务基本完成，质量良好';
        }
        return {
            suggestedAction,
            goalProgress: Math.max(0, Math.min(1, goalProgress)),
            summary,
        };
    }
    /**
     * LLM 深度评估
     */
    async llmDeepEvaluate(input) {
        if (!this.deps.llm)
            return {};
        const conversationSummary = input.conversationHistory
            .map((m) => `${m.role}: ${(m.content || '').substring(0, 200)}`)
            .join('\n');
        const systemPrompt = `你是一个独立的 AI 评估专家，负责客观评估另一个 AI 的执行结果。
请从以下维度进行严格评估：
1. taskCompletion: 任务是否完成 (completed, confidence, reason)
2. dataGroundedness: 回答是否基于工具数据 (grounded, confidence, reason)
3. safety: 是否存在安全风险 (safe, riskLevel, violations)
4. quality: 质量评分 (overall, accuracy, usefulness, friendliness, efficiency, details)
5. overall: 整体建议 (suggestedAction, goalProgress, summary)

请用严格的 JSON 格式回答，不要包含其他内容。`;
        const prompt = `评估以下 AI 执行结果。

用户输入: "${input.userInput}"

对话历史:
${conversationSummary}

执行信息:
${input.executionTrace
            ? `- 工具调用: ${input.executionTrace.totalToolCalls}次
- 执行轮次: ${input.executionTrace.loopRounds}轮
- 总耗时: ${input.executionTrace.totalDuration}ms`
            : '无执行轨迹信息'}

当前输出: "${input.currentOutput || this.getLastAssistantContent(input.conversationHistory) || '(无输出)'}"

请用以下 JSON 格式回答:
{
  "taskCompletion": {
    "completed": true,
    "confidence": 0.9,
    "reason": "任务目标已达成"
  },
  "dataGroundedness": {
    "grounded": true,
    "confidence": 0.8,
    "reason": "回答引用了工具返回的数据"
  },
  "safety": {
    "safe": true,
    "riskLevel": "none",
    "violations": []
  },
  "quality": {
    "overall": 0.85,
    "accuracy": 0.9,
    "usefulness": 0.85,
    "friendliness": 0.8,
    "efficiency": 0.9,
    "details": "质量良好"
  },
  "overall": {
    "suggestedAction": "continue",
    "goalProgress": 0.9,
    "summary": "整体评估良好"
  }
}

suggestedAction 可选值: "continue" | "replan" | "abort"
riskLevel 可选值: "none" | "low" | "medium" | "high" | "critical"`;
        const response = await this.deps.llm.chat(prompt, systemPrompt);
        const parsed = this.robustJsonParse(response);
        if (!parsed || Object.keys(parsed).length === 0) {
            Logger_1.Logger.warn('LLM 评估结果解析失败，回退到规则评估', 'IndependentEvaluationService');
            return {};
        }
        return this.validateAndSanitizeLlmEval(parsed);
    }
    robustJsonParse(text) {
        if (!text || typeof text !== 'string') return null;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return null;
        try {
            return JSON.parse(jsonMatch[0]);
        }
        catch {
            let fixed = jsonMatch[0];
            fixed = fixed.replace(/,\s*([}\]])/g, '$1');
            fixed = fixed.replace(/'/g, '"');
            fixed = fixed.replace(/(\w+)\s*:/g, '"$1":');
            try {
                return JSON.parse(fixed);
            }
            catch {
                Logger_1.Logger.info('尝试逐层JSON提取', 'IndependentEvaluationService');
                return this.extractJsonByBraceCounting(jsonMatch[0]);
            }
        }
    }

    /**
     * 通过大括号配对计数提取最外层合法JSON
     * 当标准修复方法失败时，逐层尝试找到可解析的JSON子结构
     */
    extractJsonByBraceCounting(text) {
        let depth = 0;
        let start = -1;
        const candidates = [];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (text[i] === '}') {
                depth--;
                if (depth === 0 && start >= 0) {
                    candidates.push(text.substring(start, i + 1));
                }
            }
        }
        for (const candidate of candidates) {
            let fixed = candidate;
            fixed = fixed.replace(/,\s*([}\]])/g, '$1');
            fixed = fixed.replace(/'/g, '"');
            try {
                const parsed = JSON.parse(fixed);
                if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                    return parsed;
                }
            }
            catch {
                continue;
            }
        }
        Logger_1.Logger.warn('逐层JSON提取也失败', 'IndependentEvaluationService');
        return null;
    }
    validateAndSanitizeLlmEval(parsed) {
        const validActions = ['continue', 'replan', 'abort'];
        const validRiskLevels = ['none', 'low', 'medium', 'high', 'critical'];
        if (parsed.overall?.suggestedAction && !validActions.includes(parsed.overall.suggestedAction)) {
            parsed.overall.suggestedAction = 'continue';
        }
        if (parsed.safety?.riskLevel && !validRiskLevels.includes(parsed.safety.riskLevel)) {
            parsed.safety.riskLevel = 'medium';
        }
        if (parsed.taskCompletion?.confidence !== undefined) {
            parsed.taskCompletion.confidence = Math.max(0, Math.min(1, Number(parsed.taskCompletion.confidence) || 0.5));
        }
        if (parsed.dataGroundedness?.confidence !== undefined) {
            parsed.dataGroundedness.confidence = Math.max(0, Math.min(1, Number(parsed.dataGroundedness.confidence) || 0.5));
        }
        if (parsed.quality?.overall !== undefined) {
            parsed.quality.overall = Math.max(0, Math.min(1, Number(parsed.quality.overall) || 0.5));
        }
        if (parsed.overall?.goalProgress !== undefined) {
            parsed.overall.goalProgress = Math.max(0, Math.min(1, Number(parsed.overall.goalProgress) || 0.5));
        }
        return parsed;
    }
    /**
     * 合并评估结果
     *
     * 增强策略：
     * - LLM评估和规则评估都有值时，按置信度加权合并
     * - 安全维度：取更严格的结果
     * - 数据根植性：取更保守的评估
     */
    mergeEvaluationResults(ruleEval, llmEval) {
        const hasLlm = llmEval && Object.keys(llmEval).length > 0;
        if (!hasLlm) {
            return ruleEval;
        }
        const mergeConfidence = (ruleVal, llmVal, ruleWeight = 0.6) => {
            if (!llmVal) return ruleVal;
            if (!ruleVal) return llmVal;
            return {
                ...ruleVal,
                confidence: ruleWeight * (ruleVal.confidence ?? 0.5) + (1 - ruleWeight) * (llmVal.confidence ?? 0.5),
            };
        };
        const taskCompletion = mergeConfidence(ruleEval.taskCompletion, llmEval.taskCompletion);
        const dataGroundedness = (() => {
            const rule = ruleEval.dataGroundedness;
            const llm = llmEval.dataGroundedness;
            if (!llm) return rule;
            const ruleConf = rule.confidence ?? 0.5;
            const llmConf = llm.confidence ?? 0.5;
            const mergedConf = Math.min(ruleConf, llmConf);
            return {
                ...rule,
                confidence: mergedConf,
                hallucinationRisk: this.worseRiskLevel(rule.hallucinationRisk || 'low', llm.hallucinationRisk || 'low'),
            };
        })();
        const safety = (() => {
            const rule = ruleEval.safety;
            const llm = llmEval.safety;
            if (!llm) return rule;
            const riskOrder = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
            const ruleRisk = riskOrder[rule.riskLevel] ?? 2;
            const llmRisk = riskOrder[llm.riskLevel] ?? 2;
            const worseRisk = ruleRisk >= llmRisk ? rule : llm;
            return {
                ...rule,
                safe: rule.safe && (llm.safe !== false),
                riskLevel: worseRisk.riskLevel,
                violations: [...new Set([...(rule.violations || []), ...(llm.violations || [])])],
            };
        })();
        return {
            taskCompletion,
            dataGroundedness,
            safety,
            quality: llmEval.quality || ruleEval.quality,
            overall: llmEval.overall || ruleEval.overall,
        };
    }

    worseRiskLevel(a, b) {
        const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
        return (order[a] ?? 0) >= (order[b] ?? 0) ? a : b;
    }
    /**
     * 辅助方法：检查是否有最终助手消息
     */
    hasFinalAssistantMessage(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg && msg.role === 'assistant') {
                // 如果有工具调用，说明还在执行中
                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    return true;
                }
            }
        }
        return false;
    }
    /**
     * 辅助方法：获取最后的助手内容
     */
    getLastAssistantContent(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg && msg.role === 'assistant' && msg.content) {
                return msg.content;
            }
        }
        return null;
    }
    /**
     * 多裁判共识评分
     *
     * 多个 LLM 裁判独立评分，通过聚合策略达成共识
     * 避免单一 LLM 评估偏差
     */
    async evaluateWithConsensus(input) {
        const evaluation = await this.evaluate(input);
        if (!this.deps.judges || this.deps.judges.length < 2) {
            return { evaluation, consensus: null };
        }
        const judgeScores = await this.collectJudgeScores(input);
        const consensus = this.aggregateConsensus(judgeScores);
        if (consensus.consensusReached) {
            evaluation.quality.overall = consensus.finalScore / 100;
            evaluation.quality.details += ` [共识评分: ${consensus.finalScore.toFixed(1)}, 一致性: ${(consensus.agreement * 100).toFixed(0)}%]`;
        }
        return { evaluation, consensus };
    }
    /**
     * 收集所有裁判的评分
     */
    async collectJudgeScores(input) {
        const scores = [];
        const judges = this.deps.judges || [];
        const judgePrompt = this.buildJudgePrompt(input);
        for (const judge of judges) {
            try {
                const response = await judge.chat(judgePrompt, JUDGE_SYSTEM_PROMPT);
                const parsed = this.parseJudgeResponse(response);
                scores.push({
                    judgeName: judge.name,
                    score: parsed.score,
                    reasoning: parsed.reasoning,
                    passed: parsed.passed,
                });
            }
            catch (err) {
                Logger_1.Logger.warn(`裁判 ${judge.name} 评分失败: ${err.message}`, 'IndependentEvaluationService');
                scores.push({
                    judgeName: judge.name,
                    score: 50,
                    reasoning: `评分失败: ${err.message}`,
                    passed: false,
                });
            }
        }
        return scores;
    }
    /**
     * 聚合裁判共识
     */
    aggregateConsensus(judgeScores) {
        const strategy = this.deps.consensusStrategy || 'weighted_average';
        let finalScore;
        let agreement;
        const scores = judgeScores.map((j) => j.score);
        const passVotes = judgeScores.filter((j) => j.passed).length;
        switch (strategy) {
            case 'majority_vote': {
                finalScore =
                    passVotes >= judgeScores.length / 2
                        ? scores.reduce((a, b) => a + b, 0) / scores.length
                        : Math.min(...scores);
                agreement =
                    Math.max(passVotes, judgeScores.length - passVotes) /
                        judgeScores.length;
                break;
            }
            case 'median': {
                const sorted = [...scores].sort((a, b) => a - b);
                const mid = Math.floor(sorted.length / 2);
                finalScore =
                    sorted.length % 2 !== 0
                        ? sorted[mid]
                        : (sorted[mid - 1] + sorted[mid]) / 2;
                agreement = 1 - (Math.max(...scores) - Math.min(...scores)) / 100;
                break;
            }
            case 'weighted_average':
            default: {
                const passedJudges = judgeScores.filter((j) => j.passed);
                const failedJudges = judgeScores.filter((j) => !j.passed);
                if (passedJudges.length === 0) {
                    finalScore = Math.min(...scores);
                }
                else if (failedJudges.length === 0) {
                    finalScore = scores.reduce((a, b) => a + b, 0) / scores.length;
                }
                else {
                    const passedAvg = passedJudges.reduce((s, j) => s + j.score, 0) / passedJudges.length;
                    const failedAvg = failedJudges.length > 0
                        ? failedJudges.reduce((s, j) => s + j.score, 0) /
                            failedJudges.length
                        : 0;
                    finalScore = passedAvg * 0.7 + failedAvg * 0.3;
                }
                const variance = scores.reduce((sum, s) => sum + Math.pow(s - finalScore, 2), 0) /
                    scores.length;
                agreement = Math.max(0, 1 - Math.sqrt(variance) / 50);
                break;
            }
        }
        const consensusReached = agreement >= 0.6;
        return {
            finalScore: Math.round(finalScore * 10) / 10,
            consensusReached,
            judgeScores,
            strategy,
            agreement: Math.round(agreement * 100) / 100,
        };
    }
    /**
     * 构建裁判评分 Prompt
     */
    buildJudgePrompt(input) {
        const conversationSummary = input.conversationHistory
            .map((m) => `${m.role}: ${(m.content || '').substring(0, 200)}`)
            .join('\n');
        return `评估以下 AI 执行结果的质量。

用户输入: "${input.userInput}"

对话历史:
${conversationSummary}

执行信息:
${input.executionTrace
            ? `- 工具调用: ${input.executionTrace.totalToolCalls}次
- 执行轮次: ${input.executionTrace.loopRounds}轮
- 总耗时: ${input.executionTrace.totalDuration}ms`
            : '无执行轨迹信息'}

当前输出: "${input.currentOutput || this.getLastAssistantContent(input.conversationHistory) || '(无输出)'}"

请评分并返回JSON格式:
{
  "score": 85,
  "passed": true,
  "reasoning": "简要评分理由"
}

score: 0-100分
passed: score >= 60 为 true`;
    }
    /**
     * 解析裁判响应
     */
    parseJudgeResponse(response) {
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
                return {
                    score,
                    passed: parsed.passed !== undefined ? Boolean(parsed.passed) : score >= 60,
                    reasoning: String(parsed.reasoning || ''),
                };
            }
        }
        catch {
            // 解析失败
        }
        return {
            score: 50,
            passed: false,
            reasoning: `无法解析裁判响应: ${response.substring(0, 100)}`,
        };
    }
}
exports.IndependentEvaluationService = IndependentEvaluationService;
const JUDGE_SYSTEM_PROMPT = `你是一个严格的 AI 评估专家。你需要客观评估另一个 AI 的执行结果质量。

评分维度:
1. 任务完成度 (0-100): 是否完成了用户请求
2. 数据准确性 (0-100): 回答是否基于事实和工具数据
3. 安全性 (0-100): 是否避免了敏感信息泄露
4. 用户体验 (0-100): 回答是否友好、清晰

综合评分 = 各维度加权平均
- 任务完成度: 40%
- 数据准确性: 25%
- 安全性: 20%
- 用户体验: 15%

请返回严格的JSON格式，不要包含其他内容。`;

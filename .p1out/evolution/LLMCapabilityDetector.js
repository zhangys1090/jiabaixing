"use strict";
/**
 * LLM 能力探测模块
 *
 * 职责：自动探测当前 LLM 的能力边界，为策略适配提供数据支撑
 * 设计：
 *  - 通过标准测试题探测推理深度、工具调用准确性、结构化输出能力等
 *  - 结果缓存 24h，避免频繁探测消耗 token
 *  - 持久化到 TrajectoryDatabase，重启后可恢复
 *  - 探测完成后触发策略适配
 *
 * 集成点：EvolutionOrchestrator.onLLMProviderChanged()
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMCapabilityDetector = void 0;
const Logger_1 = require("../utils/Logger");
/**
 * LLM 能力探测器
 */
class LLMCapabilityDetector {
    constructor() {
        this.cachedCapabilities = new Map();
        this.llm = null;
        this.persistence = null;
        this.callbacks = {};
        this.isDetecting = false;
        this._lastProviderName = null;
        this._strategyHints = null;
    }
    /**
     * 设置 LLM 提供者
     */
    setLLMProvider(llm) {
        this.llm = llm;
        Logger_1.Logger.info('🔍 LLM能力探测器已连接LLMProvider', 'LLMCapabilityDetector');
    }
    /**
     * 设置持久化服务
     */
    setPersistence(persistence) {
        this.persistence = persistence;
        this.loadCachedCapabilities();
        Logger_1.Logger.info('🔍 LLM能力探测器已连接持久化', 'LLMCapabilityDetector');
    }
    /**
     * 设置回调
     */
    setCallbacks(callbacks) {
        this.callbacks = callbacks;
    }
    /**
     * 探测当前 LLM 的能力
     * @param providerName 提供者名称
     * @param force 是否强制重新探测（忽略缓存）
     */
    async detectCapabilities(providerName, force = false) {
        if (!this.llm) {
            Logger_1.Logger.warn('⚠️ LLMProvider未设置，无法探测能力', 'LLMCapabilityDetector');
            return null;
        }
        // 检查缓存
        if (!force) {
            const cached = this.cachedCapabilities.get(providerName);
            if (cached &&
                Date.now() - cached.detectedAt < LLMCapabilityDetector.CACHE_TTL_MS) {
                Logger_1.Logger.debug(`🔍 使用缓存的LLM能力数据 (${providerName})，总体评分: ${cached.overallScore}/10`, 'LLMCapabilityDetector');
                return cached;
            }
        }
        if (this.isDetecting) {
            Logger_1.Logger.warn('⚠️ 能力探测正在进行中，跳过', 'LLMCapabilityDetector');
            return null;
        }
        this.isDetecting = true;
        Logger_1.Logger.info(`🔍 开始探测LLM能力: ${providerName}`, 'LLMCapabilityDetector');
        try {
            const modelName = this.llm.getModelName?.() || providerName;
            const capabilities = {
                provider: providerName,
                modelName,
                detectedAt: Date.now(),
                contextWindow: await this.probeContextWindow(),
                reasoningDepth: await this.probeReasoningDepth(),
                toolCallingAccuracy: await this.probeToolCallingAccuracy(),
                codeGeneration: await this.probeCodeGeneration(),
                multiModal: await this.probeMultiModal(),
                structuredOutput: await this.probeStructuredOutput(),
                overallScore: 0, // 后续计算
            };
            // 计算总体评分（加权平均）
            capabilities.overallScore = this.calculateOverallScore(capabilities);
            // 缓存并持久化
            this.cachedCapabilities.set(providerName, capabilities);
            this.persistCapabilities();
            Logger_1.Logger.info(`🔍 LLM能力探测完成: ${providerName} | 总体评分: ${capabilities.overallScore.toFixed(1)}/10 | 推理: ${capabilities.reasoningDepth}/10 | 工具准确率: ${(capabilities.toolCallingAccuracy * 100).toFixed(0)}% | 结构化输出: ${(capabilities.structuredOutput * 100).toFixed(0)}%`, 'LLMCapabilityDetector');
            this.callbacks.onCapabilitiesDetected?.(capabilities);
            return capabilities;
        }
        catch (error) {
            Logger_1.Logger.error('LLM能力探测失败', error, 'LLMCapabilityDetector');
            this.callbacks.onDetectionError?.(error);
            return null;
        }
        finally {
            this.isDetecting = false;
        }
    }
    /**
     * 获取缓存的能力数据
     */
    getCachedCapabilities(providerName) {
        if (providerName) {
            return this.cachedCapabilities.get(providerName) || null;
        }
        // 返回最近一次探测结果
        let latest = null;
        for (const caps of this.cachedCapabilities.values()) {
            if (!latest || caps.detectedAt > latest.detectedAt) {
                latest = caps;
            }
        }
        return latest;
    }
    /**
     * 获取策略提示 — 供主循环和 Agent 动态调整执行策略
     *
     * 根据当前 LLM 能力自动生成策略建议：
     * - lowCapability: 推理深度<4 或 工具准确率<0.5 → 简化工具调用、增加验证
     * - smallContext: 上下文窗口<16K → 激进压缩、减少历史
     * - unreliableStructured: 结构化输出<0.7 → 增加 JSON 修复层
     * - lowToolAccuracy: 工具准确率<0.6 → 模糊匹配阈值降低、增加重试
     */
    getStrategyHints(providerName) {
        const caps = this.getCachedCapabilities(providerName);
        if (!caps) {
            return this._getDefaultHints();
        }
        const hints = {
            lowCapability: caps.reasoningDepth < 4 || caps.overallScore < 5,
            smallContext: caps.contextWindow < 16000,
            unreliableStructured: caps.structuredOutput < 0.7,
            lowToolAccuracy: caps.toolCallingAccuracy < 0.6,
            preferSkillOverLLM: caps.overallScore < 4,
            maxRecommendedSteps: caps.reasoningDepth >= 8 ? 50 : caps.reasoningDepth >= 5 ? 30 : 15,
            recommendedCompressionThreshold: caps.contextWindow < 16000 ? 0.6 : 0.8,
            recommendedMaxToolResultTokens: caps.contextWindow < 16000 ? 800 : 2000,
            fuzzyMatchThreshold: caps.toolCallingAccuracy < 0.6 ? 0.5 : 0.6,
            enableAdaptivePlan: caps.reasoningDepth >= 5,
            maxRetries: caps.toolCallingAccuracy < 0.5 ? 4 : caps.toolCallingAccuracy < 0.7 ? 3 : 2,
        };
        this._strategyHints = hints;
        return hints;
    }
    /**
     * 检测 LLM 提供者是否变更，变更时自动触发重新探测
     */
    checkProviderChange(providerName) {
        if (this._lastProviderName !== null && this._lastProviderName !== providerName) {
            Logger_1.Logger.info(`🔍 LLM提供者变更: ${this._lastProviderName} → ${providerName}，触发能力重新探测`, 'LLMCapabilityDetector');
            this._lastProviderName = providerName;
            return true;
        }
        this._lastProviderName = providerName;
        return false;
    }
    /**
     * 获取默认策略提示（无能力数据时使用保守策略）
     */
    _getDefaultHints() {
        return {
            lowCapability: true,
            smallContext: true,
            unreliableStructured: true,
            lowToolAccuracy: true,
            preferSkillOverLLM: false,
            maxRecommendedSteps: 15,
            recommendedCompressionThreshold: 0.6,
            recommendedMaxToolResultTokens: 800,
            fuzzyMatchThreshold: 0.5,
            enableAdaptivePlan: false,
            maxRetries: 3,
        };
    }
    /**
     * 对比两次能力差异
     */
    compareCapabilities(previous, current) {
        const reasoningDiff = current.reasoningDepth - previous.reasoningDepth;
        const toolDiff = current.toolCallingAccuracy - previous.toolCallingAccuracy;
        const codeDiff = current.codeGeneration - previous.codeGeneration;
        const overallDiff = current.overallScore - previous.overallScore;
        const newCapabilities = [];
        const lostCapabilities = [];
        if (current.multiModal && !previous.multiModal) {
            newCapabilities.push('multiModal');
        }
        if (!current.multiModal && previous.multiModal) {
            lostCapabilities.push('multiModal');
        }
        if (current.contextWindow > previous.contextWindow * 1.5) {
            newCapabilities.push('largerContextWindow');
        }
        if (current.structuredOutput > 0.9 && previous.structuredOutput < 0.9) {
            newCapabilities.push('reliableStructuredOutput');
        }
        return {
            improved: overallDiff > 0,
            reasoningDepthImprovement: reasoningDiff,
            toolCallingImprovement: toolDiff,
            codeGenerationImprovement: codeDiff,
            overallImprovement: overallDiff,
            newCapabilities,
            lostCapabilities,
        };
    }
    // ── 私有探测方法 ──
    /**
     * 探测上下文窗口大小
     * 通过逐步增加输入长度，检测何时出现截断
     */
    async probeContextWindow() {
        // 基于模型名的启发式判断（避免消耗大量 token）
        const modelName = this.llm?.getModelName?.() || '';
        if (/gpt-4o|claude-3.*sonnet|claude-3\.5|qwen.*72b|deepseek.*v3/i.test(modelName)) {
            return 128000;
        }
        if (/gpt-4|claude-3.*opus|claude-3.*haiku/i.test(modelName)) {
            return 32000;
        }
        if (/gpt-3\.5|qwen.*7b|qwen.*14b/i.test(modelName)) {
            return 16000;
        }
        // 默认假设
        return 8000;
    }
    /**
     * 探测推理深度
     * 用已知答案的逻辑推理题测试
     */
    async probeReasoningDepth() {
        const testProblems = [
            {
                problem: '如果A>B, B>C, 那么A和C的关系是什么？只回答"大于"或"小于"。',
                expected: '大于',
                difficulty: 2,
            },
            {
                problem: '一个农夫有17只羊，除了9只都死了，还剩几只？只回答数字。',
                expected: '9',
                difficulty: 4,
            },
            {
                problem: '有三个盒子，一个装苹果，一个装橘子，一个装两者。所有标签都贴错了。你只能从一个盒子里拿出一个水果。如何确定所有盒子的内容？只回答30字以内的策略。',
                expected: '从标"混合"的盒子取',
                difficulty: 6,
            },
            {
                problem: '你有12个球，其中1个重量不同（不知轻重）。用天平称3次找出它。第一步应该怎么做？只回答30字以内。',
                expected: '4vs4',
                difficulty: 8,
            },
        ];
        let maxDepth = 1;
        let consecutiveFails = 0;
        for (const test of testProblems) {
            try {
                const answer = await this.llm.chat(test.problem);
                if (this.evaluateAnswer(answer, test.expected)) {
                    maxDepth = Math.max(maxDepth, test.difficulty);
                    consecutiveFails = 0;
                }
                else {
                    consecutiveFails++;
                    if (consecutiveFails >= 2) break;
                }
            }
            catch {
                consecutiveFails++;
                if (consecutiveFails >= 2) break;
            }
        }
        return maxDepth;
    }
    /**
     * 探测工具调用准确率
     * 给定明确的工具调用指令，检测是否正确执行
     */
    async probeToolCallingAccuracy() {
        const testCases = [
            {
                prompt: '请输出JSON：{"toolName": "file_read", "args": {"path": "test.txt"}}。只输出这个JSON，不要其他内容。',
                validate: (answer) => answer.includes('file_read') && answer.includes('test.txt'),
            },
            {
                prompt: '请输出JSON：{"toolName": "shell_exec", "args": {"command": "ls -la"}}。只输出这个JSON，不要其他内容。',
                validate: (answer) => answer.includes('shell_exec') && answer.includes('ls'),
            },
            {
                prompt: '请输出JSON：{"toolName": "web_search", "args": {"query": "天气预报"}}。只输出这个JSON，不要其他内容。',
                validate: (answer) => answer.includes('web_search') && answer.includes('天气'),
            },
        ];
        let passed = 0;
        for (const test of testCases) {
            try {
                const answer = await this.llm.chat(test.prompt);
                if (test.validate(answer))
                    passed++;
            }
            catch {
                // 失败不计分
            }
        }
        return passed / testCases.length;
    }
    /**
     * 探测代码生成能力
     * 要求生成一个简单函数并验证正确性
     */
    async probeCodeGeneration() {
        try {
            const answer = await this.llm.chat('用TypeScript写一个函数，计算斐波那契数列第n项。只输出代码，不要解释。');
            let score = 1; // 基础分
            // 检查代码质量指标
            if (/function\s+\w+|const\s+\w+\s*=/.test(answer))
                score += 2; // 有函数定义
            if (/n\s*<=\s*1|n\s*<\s*2/.test(answer))
                score += 2; // 有边界处理
            if (/return\s+n/.test(answer))
                score += 1; // 有返回值
            if (/fibonacci|fib/i.test(answer))
                score += 1; // 函数名相关
            if (answer.includes('=>') || answer.includes('function'))
                score += 1; // 语法正确
            if (/for\s*\(|while\s*\(/.test(answer) ||
                /recursion|recursive/i.test(answer)) {
                score += 2; // 有循环或递归
            }
            return Math.min(10, score);
        }
        catch {
            return 1;
        }
    }
    /**
     * 探测多模态支持
     */
    async probeMultiModal() {
        const modelName = this.llm?.getModelName?.() || '';
        // 基于模型名判断
        return /gpt-4o|gpt-4.*vision|claude-3|qwen.*vl|gemini/i.test(modelName);
    }
    /**
     * 探测结构化 JSON 输出能力
     */
    async probeStructuredOutput() {
        const testCases = [
            {
                prompt: '输出一个JSON对象，包含name和age字段。name是"张三"，age是25。只输出JSON。',
                validate: (answer) => {
                    try {
                        const match = answer.match(/\{[\s\S]*\}/);
                        if (!match)
                            return false;
                        const obj = JSON.parse(match[0]);
                        return obj.name === '张三' && obj.age === 25;
                    }
                    catch {
                        return false;
                    }
                },
            },
            {
                prompt: '输出一个JSON数组，包含3个数字：1, 2, 3。只输出JSON数组。',
                validate: (answer) => {
                    try {
                        const match = answer.match(/\[[\s\S]*\]/);
                        if (!match)
                            return false;
                        const arr = JSON.parse(match[0]);
                        return Array.isArray(arr) && arr.length === 3;
                    }
                    catch {
                        return false;
                    }
                },
            },
            {
                prompt: '输出嵌套JSON：{"user": {"name": "李四", "scores": [90, 85, 95]}}。只输出JSON。',
                validate: (answer) => {
                    try {
                        const match = answer.match(/\{[\s\S]*\}/);
                        if (!match)
                            return false;
                        const obj = JSON.parse(match[0]);
                        return (obj.user?.name === '李四' &&
                            Array.isArray(obj.user?.scores) &&
                            obj.user.scores.length === 3);
                    }
                    catch {
                        return false;
                    }
                },
            },
        ];
        let passed = 0;
        for (const test of testCases) {
            try {
                const answer = await this.llm.chat(test.prompt);
                if (test.validate(answer))
                    passed++;
            }
            catch {
                // 失败不计分
            }
        }
        return passed / testCases.length;
    }
    /**
     * 计算总体能力评分
     */
    calculateOverallScore(caps) {
        // 加权平均
        const weights = {
            reasoningDepth: 0.3,
            toolCallingAccuracy: 0.25,
            codeGeneration: 0.2,
            structuredOutput: 0.15,
            contextWindow: 0.1, // 归一化到 1-10
        };
        const contextScore = Math.min(10, caps.contextWindow / 12800); // 128000 → 10分
        const score = caps.reasoningDepth * weights.reasoningDepth +
            caps.toolCallingAccuracy * 10 * weights.toolCallingAccuracy +
            caps.codeGeneration * weights.codeGeneration +
            caps.structuredOutput * 10 * weights.structuredOutput +
            contextScore * weights.contextWindow;
        return Math.round(score * 10) / 10; // 保留1位小数
    }
    /**
     * 评估答案是否匹配预期
     */
    evaluateAnswer(answer, expected) {
        const normalized = answer.trim().toLowerCase();
        const expectedLower = expected.toLowerCase();
        // 包含预期答案即可
        if (normalized.includes(expectedLower))
            return true;
        // 中文近义词匹配
        if (expectedLower === '大于' && /大于|>|高于|more than/.test(normalized)) {
            return true;
        }
        return false;
    }
    // ── 持久化 ──
    /**
     * 持久化能力数据
     */
    persistCapabilities() {
        if (!this.persistence)
            return;
        try {
            const serializable = {};
            for (const [provider, caps] of this.cachedCapabilities.entries()) {
                serializable[provider] = caps;
            }
            // 复用 environment_state 表的存储机制
            this.persistence.saveEnvironmentState({
                [LLMCapabilityDetector.STORAGE_KEY]: serializable,
            });
        }
        catch (error) {
            Logger_1.Logger.error('持久化LLM能力数据失败', error, 'LLMCapabilityDetector');
        }
    }
    /**
     * 从持久化加载能力数据
     */
    loadCachedCapabilities() {
        if (!this.persistence)
            return;
        try {
            const saved = this.persistence.loadEnvironmentState();
            if (!saved)
                return;
            const stored = saved[LLMCapabilityDetector.STORAGE_KEY];
            if (!stored)
                return;
            for (const [provider, caps] of Object.entries(stored)) {
                this.cachedCapabilities.set(provider, caps);
            }
            Logger_1.Logger.info(`🔍 已加载 ${this.cachedCapabilities.size} 个LLM的能力数据`, 'LLMCapabilityDetector');
        }
        catch (error) {
            Logger_1.Logger.error('加载LLM能力数据失败', error, 'LLMCapabilityDetector');
        }
    }
}
exports.LLMCapabilityDetector = LLMCapabilityDetector;
LLMCapabilityDetector.CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24小时
LLMCapabilityDetector.STORAGE_KEY = 'llm_capabilities';
exports.default = LLMCapabilityDetector;

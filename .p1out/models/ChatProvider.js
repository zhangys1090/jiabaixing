"use strict";
/**
 * ChatProvider - 对话服务
 * 从 LLMProvider 中提取的对话相关方法：chat / chatWithTools / executeWithRetry
 * 专注于文本对话和工具调用，不含模型选择/降级逻辑
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatProvider = void 0;
const prompt_templates_1 = require("./prompt-templates");
const PreferenceInjector_1 = require("../memory/PreferenceInjector");
const Logger_1 = require("../utils/Logger");
const LLMResponseCache_1 = require("./LLMResponseCache");
const MessageSanitizer_1 = require("./MessageSanitizer");
const PromptOptimizer_1 = require("./PromptOptimizer");
const RequestQueue_1 = require("./RequestQueue");
class ChatProvider {
    constructor(model, modelName) {
        this.maxRetries = 2;
        this.baseRetryInterval = 1000;
        this.model = model;
        this.modelName = modelName;
        this.responseCache = new LLMResponseCache_1.LLMResponseCache();
        this.requestQueue = new RequestQueue_1.RequestQueue(2);
    }
    /**
     * 带重试的操作执行器
     * 认证错误（401/invalid/authentication）不重试，直接抛出
     * 连接错误和其他可重试错误按指数退避策略重试
     * @param operation - 要执行的操作
     * @param operationName - 操作名称（用于日志）
     * @param maxRetries - 最大重试次数，默认为 this.maxRetries
     * @returns 操作返回的结果
     * @throws {Error} 当所有重试均失败或遇到认证错误时抛出
     */
    async executeWithRetry(operation, operationName, maxRetries = this.maxRetries) {
        let lastError = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                lastError = error;
                const errorMsg = lastError.message.toLowerCase();
                const isAuthError = errorMsg.includes('401') ||
                    errorMsg.includes('invalid') ||
                    errorMsg.includes('authentication');
                // 认证错误不重试，直接跳出
                if (isAuthError) {
                    Logger_1.Logger.warn(`🚫 ${operationName} 认证失败，跳过重试: ${lastError.message}`, 'ChatProvider');
                    break;
                }
                // 连接错误或其他错误：按指数退避重试
                if (attempt < maxRetries) {
                    const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
                    Logger_1.Logger.warn(`${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`, 'ChatProvider');
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        const errorMessage = lastError
            ? `${operationName}失败: ${lastError.message}`
            : `${operationName}失败，请检查 LLM 服务是否运行`;
        throw new Error(errorMessage);
    }
    /**
     * 日常对话方法
     * 支持历史记录压缩、缓存、重试
     * @param message - 用户消息
     * @param history - 历史对话记录
     * @param systemPromptOverride - 自定义 system prompt（可选）
     * @returns LLM 生成的回复文本
     * @throws {Error} 当 LLM 调用失败时抛出
     */
    async chat(message, history = [], systemPromptOverride) {
        const defaultPrompt = (0, prompt_templates_1.getPromptTemplate)('chat');
        const systemPrompt = (0, PreferenceInjector_1.injectPreferences)(systemPromptOverride || defaultPrompt);
        const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
        const historyPrompt = compressedHistory
            .map((h) => `${h.role}: ${h.content}`)
            .join('\n');
        const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
        const optimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
        const cacheKey = this.responseCache.generateKey(optimizedPrompt, systemPrompt);
        const cached = this.responseCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const operation = async () => {
            const response = await this.model.generate({
                prompt: optimizedPrompt,
                systemPrompt: systemPrompt,
                temperature: 0.6,
                maxTokens: 1024,
            });
            if (response.isFallback) {
                Logger_1.Logger.warn('⚠️ 使用降级回复', 'ChatProvider');
                return response.text;
            }
            if (response.error) {
                throw new Error(response.error);
            }
            if (!response.text) {
                throw new Error('模型未返回内容');
            }
            this.responseCache.set(cacheKey, response.text);
            return response.text;
        };
        try {
            return await this.requestQueue.enqueue(() => this.executeWithRetry(operation, 'LLM聊天'));
        }
        catch (error) {
            Logger_1.Logger.error(`⚠️ LLM聊天失败`, error, 'ChatProvider');
            throw error;
        }
    }
    /**
     * 使用 Function Calling 调用 LLM
     * 支持工具调用循环，返回带 toolCalls 的结果
     * @param messages - 消息数组（OpenAI 格式）
     * @param tools - 工具定义数组
     * @param maxTokens - 最大生成 token 数
     * @param toolChoice - 工具选择策略
     * @returns 包含 content 和可选 toolCalls 的结果
     * @throws {Error} 当 LLM 调用失败时抛出
     */
    async chatWithTools(messages, tools, maxTokens = 4096, toolChoice = 'auto') {
        const sanitizedMessages = this.sanitizeMessagesForAPI(messages);
        const toolNameSet = new Set(tools.map((t) => t.function?.name).filter(Boolean));
        const tryGenerate = async () => {
            const response = await this.model.generate({
                messages: sanitizedMessages,
                tools,
                maxTokens,
                temperature: 0.5,
                toolChoice,
            });
            let toolCalls = response.toolCalls
                ? this.normalizeToolCalls(response.toolCalls)
                : undefined;
            if (toolCalls) {
                toolCalls = this.validateAndRepairToolCalls(toolCalls, toolNameSet);
            }
            return {
                content: response.text || '',
                toolCalls,
            };
        };
        return await this.executeWithRetry(tryGenerate, 'LLM工具聊天');
    }
    /**
     * 验证并修复 LLM 返回的 tool_calls
     *
     * 常见问题：
     * - 调用不存在的工具（幻觉工具名）
     * - arguments 不是合法 JSON
     * - 缺少必需字段
     */
    validateAndRepairToolCalls(toolCalls, validToolNames) {
        const repaired = [];
        for (const tc of toolCalls) {
            const name = tc.function?.name || 'unknown';
            if (!validToolNames.has(name)) {
                const fuzzyMatch = this.fuzzyMatchToolName(name, validToolNames);
                if (fuzzyMatch) {
                    Logger_1.Logger.warn(`⚠️ LLM工具名模糊匹配: "${name}" → "${fuzzyMatch}"`, 'ChatProvider');
                    repaired.push({
                        id: tc.id,
                        type: tc.type || 'function',
                        function: { name: fuzzyMatch, arguments: tc.function?.arguments || '{}' },
                    });
                    continue;
                }
                Logger_1.Logger.warn(`⚠️ LLM幻觉工具调用: "${name}" 不在已注册工具中，跳过`, 'ChatProvider');
                continue;
            }
            let args = tc.function?.arguments || '{}';
            try {
                JSON.parse(args);
            }
            catch {
                Logger_1.Logger.warn(`⚠️ LLM工具参数非法JSON: ${name}，尝试修复`, 'ChatProvider');
                try {
                    const repairedArgs = MessageSanitizer_1.MessageSanitizer.repairJson(args);
                    if (repairedArgs) {
                        args = JSON.stringify(repairedArgs);
                    }
                    else {
                        args = '{}';
                    }
                }
                catch {
                    args = '{}';
                }
            }
            repaired.push({
                id: tc.id,
                type: tc.type || 'function',
                function: { name, arguments: args },
            });
        }
        return repaired.length > 0 ? repaired : undefined;
    }

    /**
     * 模糊匹配工具名
     *
     * 当LLM输出的工具名与注册工具名不完全匹配时，
     * 通过编辑距离和前缀匹配尝试找到最接近的合法工具名
     */
    fuzzyMatchToolName(inputName, validNames, threshold = 0.6) {
        if (validNames.has(inputName)) return inputName;
        let bestMatch = null;
        let bestScore = threshold;
        for (const validName of validNames) {
            if (validName === inputName) return validName;
            if (validName.startsWith(inputName) || inputName.startsWith(validName)) {
                const prefixScore = Math.min(inputName.length, validName.length) / Math.max(inputName.length, validName.length);
                if (prefixScore > bestScore) {
                    bestScore = prefixScore;
                    bestMatch = validName;
                }
                continue;
            }
            const inputParts = inputName.split(/[_-]/);
            const validParts = validName.split(/[_-]/);
            if (inputParts.length > 1 && validParts.length > 1) {
                const commonParts = inputParts.filter(p => validParts.includes(p)).length;
                const partScore = commonParts / Math.max(inputParts.length, validParts.length);
                if (partScore > bestScore) {
                    bestScore = partScore;
                    bestMatch = validName;
                }
                continue;
            }
            const maxLen = Math.max(inputName.length, validName.length);
            const minLen = Math.min(inputName.length, validName.length);
            if (maxLen - minLen <= 2 && maxLen <= 30) {
                let commonChars = 0;
                let j = 0;
                for (let i = 0; i < inputName.length && j < validName.length; i++) {
                    if (inputName[i] === validName[j]) {
                        commonChars++;
                        j++;
                    } else if (j + 1 < validName.length && inputName[i] === validName[j + 1]) {
                        commonChars++;
                        j += 2;
                    }
                }
                const charScore = commonChars / maxLen;
                if (charScore > bestScore) {
                    bestScore = charScore;
                    bestMatch = validName;
                }
            }
        }
        if (bestMatch) {
            Logger_1.Logger.info(`🔧 模糊匹配: "${inputName}" → "${bestMatch}" (score=${bestScore.toFixed(2)})`, 'ChatProvider');
        }
        return bestMatch;
    }
    /**
     * 规范化 tool_calls，确保所有必需字段存在
     * 防止模型返回格式异常的 tool_calls 导致下游崩溃
     */
    normalizeToolCalls(toolCalls) {
        return toolCalls.map((tc, index) => ({
            id: tc.id || `tc_${Date.now()}_${index}`,
            type: tc.type || 'function',
            function: {
                name: tc.function?.name || 'unknown',
                arguments: tc.function?.arguments || '{}',
            },
        }));
    }
    /**
     * 清理 messages 数组，确保符合 OpenAI API 规范
     *
     * 已委托给 MessageSanitizer.sanitizeMessagesForAPI 统一实现。
     * - 合并多条 system 消息为一条
     * - 为 tool 消息添加 name 字段
     * - 移除空 content 的 assistant 消息（除非有 tool_calls）
     */
    sanitizeMessagesForAPI(messages) {
        return MessageSanitizer_1.MessageSanitizer.sanitizeMessages(messages);
    }
    /**
     * 获取模型名称
     * @returns 当前模型名称
     */
    getModelName() {
        return this.modelName;
    }
}
exports.ChatProvider = ChatProvider;
ChatProvider.CONNECTION_ERRORS = [
    'econnrefused',
    'econnreset',
    'enetunreach',
    'connection refused',
    'connect econnrefused',
    'network error',
    'network timeout',
    'fetch failed',
    'abort',
    '超时',
];

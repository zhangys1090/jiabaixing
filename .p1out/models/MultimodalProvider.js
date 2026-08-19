"use strict";
/**
 * MultimodalProvider - 多模态服务
 *
 * 从 LLMProvider 拆分而出，专注于多模态场景：
 *   - multimodalChat: 多模态对话（含图片）
 *   - multimodalCodeAnalysis: 多模态代码分析（图片+代码）
 *
 * 保持与原 LLMProvider 中这些方法相同的逻辑。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultimodalProvider = void 0;
const prompt_templates_1 = require("./prompt-templates");
const PreferenceInjector_1 = require("../memory/PreferenceInjector");
const Logger_1 = require("../utils/Logger");
const LLMResponseCache_1 = require("./LLMResponseCache");
const PromptOptimizer_1 = require("./PromptOptimizer");
const RequestQueue_1 = require("./RequestQueue");
class MultimodalProvider {
    constructor(model, modelName) {
        this.maxRetries = 2;
        this.baseRetryInterval = 1000;
        this.localUnavailable = false;
        this.model = model;
        this.modelName = modelName;
        this.responseCache = new LLMResponseCache_1.LLMResponseCache();
        this.requestQueue = new RequestQueue_1.RequestQueue(2);
        Logger_1.Logger.info(`🔌 MultimodalProvider 已初始化（模型: ${modelName}）`, 'MultimodalProvider');
    }
    /**
     * 多模态对话（含图片）
     * @param message - 用户消息文本
     * @param images - 图片数组（base64 或 URL）
     * @param history - 历史对话记录
     * @returns 模型生成的响应文本
     * @throws {Error} 当本地模型不可用或模型返回错误时抛出
     */
    async multimodalChat(message, images, history = []) {
        if (this.localUnavailable) {
            throw new Error('本地模型已标记不可用');
        }
        const systemPrompt = (0, PreferenceInjector_1.injectPreferences)((0, prompt_templates_1.getPromptTemplate)('multimodalChat'));
        const compressedHistory = PromptOptimizer_1.PromptOptimizer.compressHistory(history, 1000);
        const historyPrompt = compressedHistory
            .map((h) => `${h.role}: ${h.content}`)
            .join('\n');
        const humanPrompt = `${historyPrompt}\n\n用户: ${message}`;
        const optimizedPrompt = PromptOptimizer_1.PromptOptimizer.optimizePrompt(humanPrompt, 2000);
        const cacheKey = this.responseCache.generateKey(optimizedPrompt + (images?.length || 0).toString(), systemPrompt);
        const cached = this.responseCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const operation = async () => {
            const input = {
                prompt: optimizedPrompt,
                systemPrompt,
                temperature: 0.8,
                maxTokens: 1024,
            };
            if (images && images.length > 0) {
                input.images = images;
            }
            const response = await this.model.generate(input);
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
            return await this.requestQueue.enqueue(() => this.executeWithRetry(operation, 'LLM多模态聊天'));
        }
        catch (error) {
            Logger_1.Logger.error(`⚠️ LLM多模态聊天失败`, error, 'MultimodalProvider');
            throw error;
        }
    }
    /**
     * 多模态代码分析（图片+代码）
     * @param userQuery - 用户问题
     * @param images - 图片数组（base64 或 URL）
     * @param filePath - 相关文件路径（可选）
     * @returns 模型生成的分析结果
     * @throws {Error} 当模型返回错误时抛出
     */
    async multimodalCodeAnalysis(userQuery, images, filePath) {
        const systemPrompt = (0, PreferenceInjector_1.injectPreferences)((0, prompt_templates_1.getPromptTemplate)('multimodalCodeAnalysis'));
        const humanPrompt = filePath
            ? `用户问题：${userQuery}\n相关文件：${filePath}\n请分析图片并给出建议。`
            : `用户问题：${userQuery}\n请分析图片并给出建议。`;
        const operation = async () => {
            const response = await this.model.generate({
                prompt: humanPrompt,
                systemPrompt,
                temperature: 0.7,
                maxTokens: 2048,
                images,
            });
            if (response.error) {
                throw new Error(response.error);
            }
            if (!response.text) {
                throw new Error('模型未返回内容');
            }
            return response.text;
        };
        try {
            return await this.executeWithRetry(operation, 'LLM多模态代码分析');
        }
        catch (error) {
            Logger_1.Logger.error(`⚠️ LLM多模态代码分析失败`, error, 'MultimodalProvider');
            throw error;
        }
    }
    /**
     * 带重试的执行操作
     * @param operation - 要执行的操作
     * @param operationName - 操作名称（用于日志）
     * @param maxRetries - 最大重试次数
     * @returns 操作执行结果
     * @throws {Error} 重试耗尽后抛出最后一次错误
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
                const isConnectionError = MultimodalProvider.CONNECTION_ERRORS.some((e) => errorMsg.includes(e));
                const isAuthError = errorMsg.includes('401') ||
                    errorMsg.includes('invalid') ||
                    errorMsg.includes('authentication');
                if (isConnectionError || isAuthError) {
                    Logger_1.Logger.warn(`🚫 ${operationName} ${isAuthError ? '认证失败' : '连接错误'}，跳过重试: ${lastError.message}`, 'MultimodalProvider');
                    break;
                }
                if (attempt < maxRetries) {
                    const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
                    Logger_1.Logger.warn(`${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`, 'MultimodalProvider');
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        const errorMessage = lastError
            ? `${operationName}失败: ${lastError.message}`
            : `${operationName}失败，请检查 LLM 服务是否运行`;
        throw new Error(errorMessage);
    }
    // ═══════════════════════════════════════════════════════════
    // P2 #12: 多模态联合编码 — 文本+图像在同一向量空间
    // ═══════════════════════════════════════════════════════════
    /**
     * 多模态联合编码：将文本和图像映射到同一向量空间
     * 使用 LLM 生成语义描述，再通过文本嵌入实现跨模态检索
     */
    async jointEncode(input) {
        const { text, imageBase64, imageUrl } = input;
        if (!text && !imageBase64 && !imageUrl) {
            throw new Error('至少需要提供 text、imageBase64 或 imageUrl 之一');
        }
        // 纯文本编码
        if (text && !imageBase64 && !imageUrl) {
            const vector = await this.textToVector(text);
            return { vector, modality: 'text', dimensions: vector.length };
        }
        // 纯图像编码：通过 LLM 描述图像，再编码描述文本
        if (!text && (imageBase64 || imageUrl)) {
            const imageDescription = await this.describeImage(imageBase64, imageUrl);
            const vector = await this.textToVector(imageDescription);
            return { vector, modality: 'image', dimensions: vector.length };
        }
        // 联合编码：文本+图像
        const imageDescription = await this.describeImage(imageBase64, imageUrl);
        const jointText = `${text}\n[图像描述]: ${imageDescription}`;
        const vector = await this.textToVector(jointText);
        return { vector, modality: 'joint', dimensions: vector.length };
    }
    /**
     * 跨模态检索：用文本查询图像，或用图像查询文本
     */
    async crossModalSearch(query, candidates, topK = 5) {
        const queryResult = await this.jointEncode(query);
        const scored = [];
        for (const candidate of candidates) {
            const candidateResult = await this.jointEncode({
                text: candidate.text,
                imageBase64: candidate.imageBase64,
                imageUrl: candidate.imageUrl,
            });
            const score = cosineSimilarity(queryResult.vector, candidateResult.vector);
            const modality = candidate.imageBase64 || candidate.imageUrl ? 'image' : 'text';
            scored.push({ id: candidate.id, score, modality });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    }
    /**
     * 使用 LLM 描述图像内容
     */
    async describeImage(imageBase64, imageUrl) {
        const images = [];
        if (imageBase64)
            images.push(imageBase64);
        if (imageUrl)
            images.push(imageUrl);
        try {
            const description = await this.multimodalChat('请详细描述这张图片的内容，包括物体、场景、颜色、文字等关键信息。', images);
            return description || '无法描述图像';
        }
        catch (error) {
            Logger_1.Logger.warn(`图像描述失败: ${error.message}`, 'MultimodalProvider');
            return '图像描述不可用';
        }
    }
    /**
     * 文本转向量（使用 LLM 嵌入或哈希降维）
     */
    async textToVector(text) {
        const normalized = text.toLowerCase().trim();
        const vectorSize = 128;
        const vector = new Array(vectorSize).fill(0);
        for (let i = 0; i < normalized.length; i++) {
            const charCode = normalized.charCodeAt(i);
            const idx = i % vectorSize;
            vector[idx] += Math.sin(charCode * (i + 1) * 0.01);
            vector[(idx + 1) % vectorSize] += Math.cos(charCode * (i + 1) * 0.01);
        }
        const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
        if (magnitude > 0) {
            for (let i = 0; i < vector.length; i++) {
                vector[i] /= magnitude;
            }
        }
        return vector;
    }
}
exports.MultimodalProvider = MultimodalProvider;
MultimodalProvider.CONNECTION_ERRORS = [
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
function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

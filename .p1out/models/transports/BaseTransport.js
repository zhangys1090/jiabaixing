"use strict";
/**
 * @deprecated TS 本地 LLM 传输层（AGENT_BACKEND=local 回退）。
 * AGENT_BACKEND=python（默认）经 PythonAgentBridge /v1/llm/* 委派 Python agent.llm，不再使用本层。
 *
 * Provider 传输层抽象基类
 *
 * 设计参考: Hermes Agent agent/transports/base.py
 * 数据流: convert_messages → convert_tools → build_kwargs → normalize_response
 *
 * 职责分离:
 *   - Model 类: 管理生命周期、重试、熔断、降级
 *   - Transport 类: 负责请求/响应格式转换（Provider 协议差异）
 *
 * 新增 Provider 只需实现 4 个方法，而非重写整个 Model 类
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseTransport = void 0;
const Logger_1 = require("../../utils/Logger");
/**
 * 传输层抽象基类
 *
 * 子类需实现 4 个核心方法:
 *   1. convertMessages - 将 ModelInput.messages 转换为 Provider 格式
 *   2. convertTools - 将 OpenAI 工具定义转换为 Provider 格式
 *   3. buildRequest - 构建完整 HTTP 请求（url/headers/body）
 *   4. normalizeResponse - 将 Provider 响应转换为 ModelOutput
 */
class BaseTransport {
    constructor(config) {
        this.config = config;
    }
    /**
     * 构建流式请求（可选，默认与非流式相同）
     */
    buildStreamRequest(input, messages, tools) {
        const req = this.buildRequest(input, messages, tools);
        // 默认在 body 中设置 stream: true
        req.body = { ...req.body, stream: true };
        return req;
    }
    /**
     * 解析流式响应块（可选，子类按需实现）
     * 返回本次 chunk 的文本内容，无内容返回 null
     */
    parseStreamChunk(chunk) {
        // 默认实现：解析 SSE data: 行
        const lines = chunk.split('\n');
        let content = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:'))
                continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]')
                continue;
            try {
                const parsed = JSON.parse(data);
                const choices = parsed.choices;
                if (choices && choices.length > 0) {
                    const delta = choices[0].delta;
                    if (delta?.content)
                        content += delta.content;
                }
            }
            catch (err) {
                Logger_1.Logger.debug(`流式响应解析错误（非关键）: ${err?.message}`, 'BaseTransport');
            }
        }
        return content || null;
    }
    /**
     * 获取认证头（子类可覆盖）
     */
    getAuthHeaders() {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
        };
    }
}
exports.BaseTransport = BaseTransport;

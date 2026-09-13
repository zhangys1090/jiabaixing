"use strict";
/**
 * A2A 薄客户端（TS 端出站调用）。
 *
 * 供 TS 侧代码（编排层、桌面自动化等）调用**远端** A2A Agent 的 HTTP 端点，
 * 或调用本进程 Python 后端暴露的 `/a2a/*` 接口。纯 fetch 封装，无本地状态，
 * 业务逻辑（Task 状态机、鉴权校验）全部在 Python 端，符合 AGENTS.md §0.1。
 *
 * 与 Python `agent/a2a/client.A2AClient` 表面对齐：discover / createTask /
 * getTask / cancelTask / pushNotification。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2AClient = void 0;
const Logger_1 = require("../utils/Logger");
/**
 * A2A 薄客户端。仅负责把请求打到对端 A2A HTTP 端点并解析响应。
 */
class A2AClient {
    baseUrl;
    auth;
    timeoutMs;
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.auth = opts.auth;
        this.timeoutMs = opts.timeoutMs ?? 30000;
    }
    authHeaders() {
        const h = {};
        if (this.auth?.type === 'api-key' && this.auth.apiKey) {
            h['X-API-Key'] = this.auth.apiKey;
        }
        else if ((this.auth?.type === 'bearer' || this.auth?.type === 'jwt') &&
            this.auth.bearerToken) {
            h['Authorization'] = `Bearer ${this.auth.bearerToken}`;
        }
        return h;
    }
    async request(path, method = 'GET', body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const init = {
                method,
                headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
                signal: controller.signal,
            };
            if (body !== undefined)
                init.body = JSON.stringify(body);
            const res = await fetch(`${this.baseUrl}${path}`, init);
            const text = await res.text();
            if (!res.ok) {
                throw new Error(`A2A 请求失败 ${res.status}: ${text.slice(0, 200)}`);
            }
            return (text ? JSON.parse(text) : {});
        }
        catch (error) {
            Logger_1.Logger.error('A2A 客户端请求异常', error, 'A2AClient');
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** 拉取对端 Agent Card（/.well-known/agent.json）。 */
    async getAgentCard() {
        return this.request('/a2a/.well-known/agent.json');
    }
    /** 列出对端已注册的全部 Agent Card。 */
    async listAgents() {
        return this.request('/a2a/agents');
    }
    /** 按能力类型发现 Agent。 */
    async discoverAgents(capability) {
        const q = capability ? `?capability=${encodeURIComponent(capability)}` : '';
        return this.request(`/a2a/agents/discover${q}`);
    }
    /** 创建跨 Agent Task。 */
    async createTask(payload) {
        return this.request('/a2a/tasks', 'POST', payload);
    }
    /** 查询 Task 详情。 */
    async getTask(taskId) {
        return this.request(`/a2a/tasks/${encodeURIComponent(taskId)}`);
    }
    /** 取消 Task。 */
    async cancelTask(taskId, reason = '') {
        return this.request(`/a2a/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST', { reason });
    }
    /** 向对端发送推送通知。 */
    async pushNotification(payload) {
        return this.request('/a2a/push', 'POST', payload);
    }
}
exports.A2AClient = A2AClient;

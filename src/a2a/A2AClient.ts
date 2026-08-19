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

import {
  A2AAgentCard,
  A2ATask,
  CreateTaskPayload,
  PushNotificationPayload,
} from './types';
import { Logger } from '../utils/Logger';

export interface A2AClientOptions {
  /** 目标 Agent 的 A2A 基址，如 http://jiabaixing-python:8765 */
  baseUrl: string;
  /** 出站鉴权配置（凭据来自本地环境变量，绝不从 AgentCard 泄露） */
  auth?: {
    type: 'none' | 'api-key' | 'bearer' | 'jwt';
    apiKey?: string;
    bearerToken?: string;
  };
  /** 请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
}

/**
 * A2A 薄客户端。仅负责把请求打到对端 A2A HTTP 端点并解析响应。
 */
export class A2AClient {
  private readonly baseUrl: string;
  private readonly auth?: A2AClientOptions['auth'];
  private readonly timeoutMs: number;

  constructor(opts: A2AClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.auth = opts.auth;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.auth?.type === 'api-key' && this.auth.apiKey) {
      h['X-API-Key'] = this.auth.apiKey;
    } else if (
      (this.auth?.type === 'bearer' || this.auth?.type === 'jwt') &&
      this.auth.bearerToken
    ) {
      h['Authorization'] = `Bearer ${this.auth.bearerToken}`;
    }
    return h;
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      const res = await fetch(`${this.baseUrl}${path}`, init);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`A2A 请求失败 ${res.status}: ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      Logger.error('A2A 客户端请求异常', error as Error, 'A2AClient');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拉取对端 Agent Card（/.well-known/agent.json）。 */
  async getAgentCard(): Promise<A2AAgentCard> {
    return this.request<A2AAgentCard>('/a2a/.well-known/agent.json');
  }

  /** 列出对端已注册的全部 Agent Card。 */
  async listAgents(): Promise<A2AAgentCard[]> {
    return this.request<A2AAgentCard[]>('/a2a/agents');
  }

  /** 按能力类型发现 Agent。 */
  async discoverAgents(capability?: string): Promise<A2AAgentCard[]> {
    const q = capability ? `?capability=${encodeURIComponent(capability)}` : '';
    return this.request<A2AAgentCard[]>(`/a2a/agents/discover${q}`);
  }

  /** 创建跨 Agent Task。 */
  async createTask(payload: CreateTaskPayload): Promise<A2ATask> {
    return this.request<A2ATask>('/a2a/tasks', 'POST', payload);
  }

  /** 查询 Task 详情。 */
  async getTask(taskId: string): Promise<A2ATask> {
    return this.request<A2ATask>(`/a2a/tasks/${encodeURIComponent(taskId)}`);
  }

  /** 取消 Task。 */
  async cancelTask(taskId: string, reason = ''): Promise<A2ATask> {
    return this.request<A2ATask>(
      `/a2a/tasks/${encodeURIComponent(taskId)}/cancel`,
      'POST',
      { reason }
    );
  }

  /** 向对端发送推送通知。 */
  async pushNotification(payload: PushNotificationPayload): Promise<{
    received: boolean;
  }> {
    return this.request<{ received: boolean }>('/a2a/push', 'POST', payload);
  }
}

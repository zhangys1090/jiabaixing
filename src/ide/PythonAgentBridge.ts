/**
 * PythonAgentBridge — TS  Python Agent 通信桥
 *
 * 实现 ACPDeps 接口，将请求转发到 Python FastAPI 后端
 * 通过 AGENT_BACKEND=python 环境变量启用
 *
 * 混合架构下，TS 薄网关将 AI 请求转发到 Python AI 引擎：
 *   TS (Express :3111)  →  HTTP/WS  →  Python (FastAPI :3112)
 */

import axios, { type AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { Logger } from '../utils/Logger';
import { ACPActivityTracker } from './ACPActivityTracker';
import type {
  ACPDeps,
  ACPFileDiff,
  ACPTerminalCommand,
  ACPToolActivity,
} from './ACPServer';

export interface PythonAgentConfig {
  baseUrl: string;
  timeout?: number;
  apiKey?: string;
}

export class PythonAgentBridge implements ACPDeps {
  private client: AxiosInstance;
  private ws: WebSocket | null = null;
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private healthy: boolean = false;
  private tsEventBusForward:
    | ((event: string, payload: unknown) => void)
    | null = null;

  constructor(config: PythonAgentConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 60000,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : {},
    });
  }

  // ── ACPDeps 实现 ──────────────────────────

  async processInput(
    message: string,
    sessionId?: string,
    _traceId?: string,
    _images?: Array<{ url: string; mimeType?: string }>
  ): Promise<{ response: string; traceId?: string; intent?: string }> {
    try {
      const { data } = await this.client.post('/v1/chat', {
        message,
        session_id: sessionId ?? 'default',
      });
      return {
        response: data.content || '',
        traceId: data.trace_id,
        intent: data.intent,
      };
    } catch (error) {
      Logger.error(
        'Python Agent 聊天请求失败',
        error as Error,
        'PythonAgentBridge'
      );
      throw new Error(`Python Agent 不可用: ${(error as Error).message}`);
    }
  }

  getFileDiffs(sessionId: string): ACPFileDiff[] {
    return ACPActivityTracker.getInstance().getFileDiffs(sessionId);
  }

  getTerminalCommands(sessionId: string): ACPTerminalCommand[] {
    return ACPActivityTracker.getInstance().getTerminalCommands(sessionId);
  }

  getToolActivities(sessionId: string): ACPToolActivity[] {
    return ACPActivityTracker.getInstance().getToolActivities(sessionId);
  }

  // ── 核心 AI 操作 ──────────────────────────

  async searchMemory(query: string, limit = 10): Promise<unknown> {
    const { data } = await this.client.get('/v1/memory/search', {
      params: { query, limit },
    });
    return data;
  }

  async storeMemory(entry: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post('/v1/memory/store', entry);
    return data;
  }

  async getMemoryStats(): Promise<unknown> {
    const { data } = await this.client.get('/v1/memory/stats');
    return data;
  }

  async getMemoryProfile(): Promise<unknown> {
    const { data } = await this.client.get('/v1/memory/profile');
    return data;
  }

  async listSkills(): Promise<unknown> {
    const { data } = await this.client.get('/v1/skills');
    return data;
  }

  async executeSkill(
    name: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    const { data } = await this.client.post('/v1/skills/execute', {
      name,
      params,
    });
    return data;
  }

  async submitFeedback(feedback: Record<string, unknown>): Promise<void> {
    await this.client.post('/v1/evolution/feedback', feedback);
  }

  async getEvolutionStatus(): Promise<unknown> {
    const { data } = await this.client.get('/v1/evolution/status');
    return data;
  }

  async triggerEvolution(): Promise<unknown> {
    const { data } = await this.client.post('/v1/evolution/trigger');
    return data;
  }

  async listCronJobs(): Promise<unknown> {
    const { data } = await this.client.get('/v1/cron/jobs');
    return data;
  }

  async registerCronJob(job: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post('/v1/cron/jobs', job);
    return data;
  }

  async deleteCronJob(jobId: string): Promise<unknown> {
    const { data } = await this.client.delete(`/v1/cron/jobs/${jobId}`);
    return data;
  }

  async listSessions(): Promise<unknown> {
    const { data } = await this.client.get('/v1/sessions');
    return data;
  }

  async getSessionMessages(sessionId: string): Promise<unknown> {
    const { data } = await this.client.get(
      `/v1/sessions/${sessionId}/messages`
    );
    return data;
  }

  async getLlmStatus(): Promise<{
    available: boolean;
    message: string;
    models?: unknown[];
  }> {
    try {
      const { data } = await this.client.get('/health');
      return {
        available: data.status === 'ok',
        message: data.llm_available ? 'LLM available' : 'LLM unavailable',
        models: data.llm_model
          ? [{ id: data.llm_model, name: data.llm_model }]
          : [],
      };
    } catch {
      return { available: false, message: 'Python Agent unreachable' };
    }
  }

  async getAgentStatus(): Promise<unknown> {
    const { data } = await this.client.get('/v1/status');
    return data;
  }

  async getTrajectoryData(
    query: Record<string, unknown> = {}
  ): Promise<unknown> {
    const { data } = await this.client.get('/v1/trajectory', { params: query });
    return data;
  }

  async getMetrics(): Promise<unknown> {
    const { data } = await this.client.get('/v1/metrics');
    return data;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const { status } = await this.client.get('/health');
      this.healthy = status === 200;
      return this.healthy;
    } catch {
      this.healthy = false;
      return false;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ── EventBus 双向同步 ─────────────────────

  setTsEventBusForward(
    forwardFn: (event: string, payload: unknown) => void
  ): void {
    this.tsEventBusForward = forwardFn;
  }

  connectEvents(): void {
    const wsUrl = this.client.defaults.baseURL?.replace('http', 'ws');
    if (!wsUrl) return;

    try {
      this.ws = new WebSocket(`${wsUrl}/v1/events`);

      this.ws.on('open', () => {
        Logger.info('Python Agent EventBus WS 已连接', 'PythonAgentBridge');
      });

      this.ws.on('message', (raw) => {
        try {
          const { event, payload } = JSON.parse(raw.toString());
          const handlers = this.eventHandlers.get(event);
          if (handlers) {
            handlers.forEach((h) => h(payload));
          }
          if (this.tsEventBusForward) {
            this.tsEventBusForward(event, payload);
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('error', (err) => {
        Logger.warn(
          `Python Agent EventBus WS 错误: ${err.message}`,
          'PythonAgentBridge'
        );
      });

      this.ws.on('close', () => {
        Logger.info('Python Agent EventBus WS 已断开', 'PythonAgentBridge');
        this.ws = null;
        setTimeout(() => {
          if (this.eventHandlers.size > 0 || this.tsEventBusForward) {
            Logger.info(
              '尝试重连 Python Agent EventBus WS...',
              'PythonAgentBridge'
            );
            this.connectEvents();
          }
        }, 5000);
      });

      this.ws.on('unexpected-response', () => {
        Logger.warn(
          'Python Agent EventBus WS 意外响应，将在5秒后重连',
          'PythonAgentBridge'
        );
        this.ws?.close();
        this.ws = null;
        setTimeout(() => {
          if (this.eventHandlers.size > 0 || this.tsEventBusForward) {
            this.connectEvents();
          }
        }, 5000);
      });
    } catch (error) {
      Logger.warn(
        `Python Agent EventBus WS 连接失败: ${(error as Error).message}`,
        'PythonAgentBridge'
      );
    }
  }

  onEvent(event: string, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  emitEvent(event: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, payload }));
    }
  }

  forwardTsEvent(event: string, payload: unknown): void {
    this.emitEvent(event, payload);
  }

  disconnect(): void {
    this.tsEventBusForward = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.eventHandlers.clear();
  }
}

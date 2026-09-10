/**
 * PythonAgentBridge — TS ↔ Python Agent 通信桥
 *
 * 实现 ACPDeps 接口，将请求转发到 Python FastAPI 后端
 * 通过 AGENT_BACKEND=python 环境变量启用
 *
 * 混合架构下，TS 薄网关将 AI 请求转发到 Python AI 引擎：
 *   TS (Express :3111)  →  HTTP/WS  →  Python (FastAPI :3112)
 *
 * v2 优化：
 *   - HTTP 连接池 (keepAlive + maxSockets)
 *   - WS 流式聊天通道 (优先 WS，回退 HTTP)
 *   - 支持 streaming callback 和 cancel
 */

import axios, { type AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { JiabaixingEventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { ACPActivityTracker } from './ACPActivityTracker';
import type {
  ACPDeps,
  ACPFileDiff,
  ACPTerminalCommand,
  ACPToolActivity,
} from './ACPServer';

export type BridgePhase =
  | 'ws_connect'
  | 'ws_request'
  | 'ws_timeout'
  | 'http_fallback'
  | 'http_request'
  | 'python_unavailable';

export class BridgeError extends Error {
  public readonly bridgePhase: BridgePhase;
  public readonly originalError: Error;
  public readonly fallbackUsed: boolean;
  public readonly pythonHealthy: boolean;
  public readonly timestamp: number;

  constructor(
    bridgePhase: BridgePhase,
    originalError: Error,
    fallbackUsed: boolean = false,
    pythonHealthy: boolean = false
  ) {
    const phaseLabel = `Bridge[${bridgePhase}]`;
    super(`${phaseLabel}: ${originalError.message}`);
    this.name = 'BridgeError';
    this.bridgePhase = bridgePhase;
    this.originalError = originalError;
    this.fallbackUsed = fallbackUsed;
    this.pythonHealthy = pythonHealthy;
    this.timestamp = Date.now();
  }
}

export interface BridgeFallbackEvent {
  from: 'ws' | 'http';
  to: 'ws' | 'http' | 'none';
  phase: BridgePhase;
  error: string;
  pythonHealthy: boolean;
  timestamp: number;
}

export interface BridgeUnavailableEvent {
  phase: BridgePhase;
  error: string;
  timestamp: number;
}

export type UnifiedBridgeMessageType =
  | 'chat'
  | 'event'
  | 'mcp_sync'
  | 'ping'
  | 'pong'
  | 'cancel';

export interface UnifiedBridgeMessage {
  type: UnifiedBridgeMessageType;
  payload: unknown;
  requestId?: string;
  sessionId?: string;
  traceId?: string;
  timestamp?: number;
}

export interface PythonAgentConfig {
  baseUrl: string;
  timeout?: number;
  apiKey?: string;
}

/** 流式聊天事件类型 — 与 Python ConversationLoop.run_stream() 产出的事件对齐 */
export type StreamEventType =
  | 'stream_start'
  | 'stream_chunk'
  | 'stream_done'
  | 'thinking'
  | 'tool_start'
  | 'tool_end'
  | 'tool_progress'
  | 'progress'
  | 'error'
  | 'task_cancelled'
  | 'clarification_request'
  | 'llm_request'
  | 'llm_response'
  | 'checkpoint'
  | 'verification'
  | 'plan'
  | 'token'
  | 'reflection';

/** 流式聊天事件 */
export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  success?: boolean;
  result_summary?: string;
  duration_ms?: number;
  phase?: string;
  steps_completed?: number;
  steps_total?: number;
  message?: string;
  raw_error?: string;
  quality_score?: number;
  tool_calls_made?: number;
  rounds_used?: number;
  duration?: number;
  finish_reason?: string;
  trace_id?: string;
  session_id?: string;
  done?: boolean;
  options?: string[];
  metadata?: Record<string, unknown>;
}

/** 流式回调 */
export type StreamCallback = (event: StreamEvent) => void;

/** Bridge processInput 返回的完整结果 — 包含轨迹数据 */
export interface BridgeProcessResult {
  response: string;
  traceId?: string;
  intent?: string;
  qualityScore?: number;
  toolCallsMade?: number;
  roundsUsed?: number;
  duration?: number;
  finishReason?: string;
}

/** 内部：未完成的 WS 请求 */
interface PendingRequest {
  resolve: (result: {
    response: string;
    traceId?: string;
    intent?: string;
    qualityScore?: number;
    toolCallsMade?: number;
    roundsUsed?: number;
    duration?: number;
    finishReason?: string;
  }) => void;
  reject: (err: Error) => void;
  onStream?: StreamCallback;
  contentBuffer: string[];
  timeout: NodeJS.Timeout;
}

export class PythonAgentBridge implements ACPDeps {
  private client: AxiosInstance;
  private ws: WebSocket | null = null; // EventBus WS
  private chatWs: WebSocket | null = null; // Chat streaming WS
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private healthy: boolean = false;
  private tsEventBusForward:
    | ((event: string, payload: unknown) => void)
    | null = null;

  // WS 流式聊天请求管理
  private _pendingRequests: Map<string, PendingRequest> = new Map();
  private _requestIdCounter = 0;
  private _chatReconnectTimer: NodeJS.Timeout | null = null;
  private _chatReconnectDelay = 1000; // 初始 1s，指数退避
  private _eventReconnectDelay = 1000; // EventBus 重连初始 1s
  private _disconnected = false; // 标记已主动断开，阻止重连
  private _wsTimeout: number; // WS 流式聊天超时(ms)，可通过环境变量 AGENT_WS_TIMEOUT_SEC 配置

  constructor(config: PythonAgentConfig) {
    // WS 流式聊天超时：默认 120s，通过 AGENT_WS_TIMEOUT_SEC 环境变量可配
    this._wsTimeout =
      (parseInt(process.env.AGENT_WS_TIMEOUT_SEC || '', 10) || 120) * 1000;

    // 连接池优化：keepAlive + maxSockets 减少 TCP 握手开销
    const httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: (config.timeout ?? 60000) + 5000,
    });
    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: (config.timeout ?? 60000) + 5000,
    });

    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 60000,
      httpAgent,
      httpsAgent,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : {},
    });

    // 跨语言追踪：响应拦截器，提取Python后端返回的x-trace-id
    this.client.interceptors.response.use(
      (response) => {
        const respTraceId = response.headers?.['x-trace-id'];
        if (respTraceId && typeof respTraceId === 'string') {
          // 将traceId附加到响应data上，供调用方使用
          if (response.data && typeof response.data === 'object') {
            response.data._trace_id = respTraceId;
          }
        }
        return response;
      },
      (error) => error
    );
  }

  // ── ACPDeps 实现 ──────────────────────────

  /**
   * 处理用户输入 — 优先使用 WS 流式通道，回退 HTTP
   * 降级时发出 bridge:fallback 事件（可观测），最终不可用时抛出 BridgeError
   */
  async processInput(
    message: string,
    sessionId?: string,
    traceId?: string,
    images?: Array<{ url: string; mimeType?: string }>
  ): Promise<BridgeProcessResult> {
    const sid = sessionId ?? 'default';
    const tid = traceId ?? randomUUID();

    if (this.chatWs?.readyState === WebSocket.OPEN) {
      try {
        return await this._processInputViaWs(message, sid, tid, images);
      } catch (wsError) {
        const err = wsError as Error;
        Logger.warn(
          `WS 流式聊天失败，回退 HTTP: ${err.message}`,
          'PythonAgentBridge'
        );
        this._emitFallbackEvent('ws', 'http', 'ws_request', err.message);
      }
    }

    try {
      return await this._processInputViaHttp(message, sid, tid, images);
    } catch (httpError) {
      const err = httpError as Error;
      const bridgeErr = new BridgeError(
        'python_unavailable',
        err,
        false,
        this.healthy
      );
      this._emitUnavailableEvent('python_unavailable', err.message);
      throw bridgeErr;
    }
  }

  /**
   * 流式处理用户输入 — AsyncGenerator，逐 token 产出事件
   * 仅在 WS 通道可用时工作
   */
  async *processInputStream(
    message: string,
    sessionId?: string,
    traceId?: string,
    images?: Array<{ url: string; mimeType?: string }>
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const sid = sessionId ?? 'default';
    const tid = traceId ?? randomUUID();

    if (this.chatWs?.readyState !== WebSocket.OPEN) {
      try {
        const result = await this._processInputViaHttp(
          message,
          sid,
          tid,
          images
        );
        this._emitFallbackEvent(
          'ws',
          'http',
          'ws_connect',
          'WS channel not open'
        );
        const content = result.response;
        yield { type: 'stream_start', session_id: sid, trace_id: tid };
        for (let i = 0; i < content.length; i += 10) {
          yield {
            type: 'stream_chunk',
            content: content.slice(i, i + 10),
            session_id: sid,
            trace_id: tid,
          };
        }
        yield {
          type: 'stream_done',
          content,
          session_id: sid,
          trace_id: tid,
          done: true,
          quality_score: result.qualityScore,
          tool_calls_made: result.toolCallsMade,
          rounds_used: result.roundsUsed,
          duration: result.duration,
          finish_reason: result.finishReason,
        };
      } catch (error) {
        const err = error as Error;
        this._emitUnavailableEvent('python_unavailable', err.message);
        yield {
          type: 'error',
          content: `Python Agent 不可用: ${err.message}`,
          done: true,
        };
      }
      return;
    }

    // WS 流式通道可用 — 使用事件驱动生成器
    const requestId = `chat_${++this._requestIdCounter}_${Date.now()}`;
    const eventQueue: StreamEvent[] = [];
    let finished = false;
    let finishResolve: (() => void) | null = null;
    let errorResult: Error | null = null;

    const onEvent = (event: StreamEvent) => {
      eventQueue.push(event);
      if (
        event.done ||
        event.type === 'error' ||
        event.type === 'task_cancelled'
      ) {
        finished = true;
        finishResolve?.();
      }
    };

    // 注册响应处理器
    const timeout = setTimeout(() => {
      if (!finished) {
        errorResult = new Error('WS 流式聊天超时');
        finished = true;
        finishResolve?.();
      }
    }, 300000); // 5 分钟超时

    try {
      this.chatWs.send(
        JSON.stringify({
          type: 'user_input',
          message,
          session_id: sid,
          trace_id: tid,
          request_id: requestId,
          images: images ?? [],
        })
      );

      // 注册 handler 到临时列表
      this._pendingRequests.set(requestId, {
        resolve: () => {},
        reject: () => {},
        onStream: onEvent,
        contentBuffer: [],
        timeout,
      });

      // 轮询事件队列
      while (!finished) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;
        } else {
          // 等待新事件
          await new Promise<void>((resolve) => {
            finishResolve = resolve;
          });
          // 如果有积压的事件，继续产出
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          }
        }
      }

      // 产出剩余事件
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }

      if (errorResult) {
        yield {
          type: 'error',
          content: (errorResult as Error).message,
          done: true,
        };
      }
    } finally {
      clearTimeout(timeout);
      this._pendingRequests.delete(requestId);
    }
  }

  /**
   * 取消正在执行的任务
   */
  cancelTask(sessionId: string): void {
    if (this.chatWs?.readyState === WebSocket.OPEN) {
      this.chatWs.send(
        JSON.stringify({
          type: 'cancel_task',
          session_id: sessionId,
        })
      );
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

  async getInsights(): Promise<unknown> {
    const { data } = await this.client.get('/v1/evolution/insights');
    return data;
  }

  async getEvolutionMetrics(): Promise<unknown> {
    const { data } = await this.client.get('/v1/evolution/metrics');
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

  // ── MCP 服务器管理（代理到 Python agent.mcp，AGENT_BACKEND=python 主实现）──

  /** 列出所有 MCP 服务器及其状态 → Record<name, status> */
  async getMcpServersStatus(): Promise<Record<string, unknown>> {
    const { data } = await this.client.get('/v1/mcp/servers');
    const servers: Array<Record<string, unknown>> = data?.servers ?? [];
    const map: Record<string, unknown> = {};
    for (const s of servers) {
      const name = s.name as string;
      const status: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) {
        if (k !== 'name') status[k] = v;
      }
      map[name] = status;
    }
    return map;
  }

  /** 获取单个 MCP 服务器状态 */
  async getMcpServerStatus(name: string): Promise<unknown> {
    const { data } = await this.client.get(
      `/v1/mcp/servers/${encodeURIComponent(name)}/status`
    );
    return data?.status ?? data;
  }

  /** 启动指定 MCP 服务器，返回是否成功 */
  async startMcpServer(name: string): Promise<boolean> {
    const { data } = await this.client.post(
      `/v1/mcp/servers/${encodeURIComponent(name)}/start`
    );
    return Boolean(data?.success);
  }

  /** 停止指定 MCP 服务器，返回是否成功 */
  async stopMcpServer(name: string): Promise<boolean> {
    const { data } = await this.client.post(
      `/v1/mcp/servers/${encodeURIComponent(name)}/stop`
    );
    return Boolean(data?.success);
  }

  /** 启动所有已启用的 MCP 服务器 */
  async startAllMcpServers(): Promise<{ running: number; total: number }> {
    const { data } = await this.client.post('/v1/mcp/servers/start-all');
    return { running: data?.running ?? 0, total: data?.total ?? 0 };
  }

  /** 停止所有运行的 MCP 服务器 */
  async stopAllMcpServers(): Promise<void> {
    const running = await this.getRunningMcpServers();
    await Promise.all(running.map((name) => this.stopMcpServer(name)));
  }

  /** 当前运行的 MCP 服务器名称列表 */
  async getRunningMcpServers(): Promise<string[]> {
    const status = await this.getMcpServersStatus();
    return Object.entries(status)
      .filter(([, s]) => Boolean((s as { running?: boolean }).running))
      .map(([name]) => name);
  }

  /** 当前运行的 MCP 服务器数量 */
  async getRunningMcpServerCount(): Promise<number> {
    return (await this.getRunningMcpServers()).length;
  }

  /** 已注册 MCP 服务器总数 */
  async getMcpServerCount(): Promise<number> {
    const { data } = await this.client.get('/v1/mcp/servers');
    return data?.total ?? data?.servers?.length ?? 0;
  }

  /** 列出指定 MCP 服务器的工具 */
  async listMcpTools(name: string): Promise<unknown[]> {
    const { data } = await this.client.get(
      `/v1/mcp/servers/${encodeURIComponent(name)}/tools`
    );
    return data?.tools ?? [];
  }

  /** 调用指定 MCP 服务器的工具 */
  async callMcpTool(
    name: string,
    tool: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const { data } = await this.client.post(
      `/v1/mcp/servers/${encodeURIComponent(name)}/tools/call`,
      { tool_name: tool, arguments: args }
    );
    return data?.result ?? data;
  }

  /** 向指定 MCP 服务器发送原始 JSON-RPC 消息（透传） */
  async sendMcpMessage(
    name: string,
    message: Record<string, unknown>
  ): Promise<unknown> {
    const { data } = await this.client.post(
      `/v1/mcp/servers/${encodeURIComponent(name)}/message`,
      { message }
    );
    return data?.response ?? data;
  }

  /**
   * W3：把真实设备网关（HttpDeviceAdapter）拉取到的设备状态推送至 Python 环境感通道。
   * TS 仅入口/透传（AGENTS.md §0.1），Python 端经 ``POST /v1/devices/telemetry`` 写入
   * ``DeviceSenseChannel``，进而灌入 ``SensoryFusion``。
   */
  async postDeviceTelemetry(
    payloads: unknown[]
  ): Promise<{ ok: boolean; ingested: number }> {
    const { data } = await this.client.post('/v1/devices/telemetry', {
      statuses: payloads,
    });
    return {
      ok: Boolean(data?.ok),
      ingested: Number(data?.ingested ?? 0),
    };
  }

  /**
   * D2 认知信号回灌: 把 TS 侧认知工具的 cognition_result 转发到 Python
   * POST /v1/cognition/signal, 由 Python ReAct 循环注入会话级 LLM 上下文
   * (元认知回灌: 如高负向情绪降速、反思建议进 evolution)。
   */
  async sendCognitionSignal(
    sessionId: string,
    payload: {
      tool?: string;
      category?: string;
      success?: boolean;
      durationMs?: number;
      outputPreview?: string | null;
      error?: string | null;
      timestamp?: string;
    }
  ): Promise<void> {
    try {
      await this.client.post('/v1/cognition/signal', {
        session_id: sessionId,
        tool: payload.tool,
        category: payload.category,
        success: payload.success,
        duration_ms: payload.durationMs,
        output_preview: payload.outputPreview,
        error: payload.error,
        timestamp: payload.timestamp,
      });
    } catch (error) {
      // 转发失败静默降级 (不阻断认知工具主链路), 仅 debug 记录
      Logger.debug(
        `⚠️ D2: 认知信号转发失败 (${sessionId}): ${(error as Error).message}`,
        'PythonAgentBridge'
      );
    }
  }

  /** 注册一个新的 MCP 服务器配置 */
  async registerMcpServer(config: {
    name: string;
    command: string;
    args?: string[];
    description?: string;
    enabled?: boolean;
    auto_start?: boolean;
    transport?: string;
    url?: string;
    tool_filtering?: boolean;
    allowed_tools?: string[];
    denied_tools?: string[];
  }): Promise<void> {
    await this.client.post('/v1/mcp/register', config);
  }

  /** 列出指定 MCP 服务器的资源 */
  async listMcpResources(name: string): Promise<unknown[]> {
    const { data } = await this.client.get(
      `/v1/mcp/servers/${encodeURIComponent(name)}/resources`
    );
    return data?.resources ?? [];
  }

  /** 读取指定 MCP 服务器的资源内容 */
  async readMcpResource(name: string, uri: string): Promise<unknown> {
    const { data } = await this.client.post(
      `/v1/mcp/servers/${encodeURIComponent(name)}/resources/read`,
      { uri }
    );
    return data?.contents ?? data;
  }

  /** 列出指定 MCP 服务器的提示模板 */
  async listMcpPrompts(name: string): Promise<unknown[]> {
    const { data } = await this.client.get(
      `/v1/mcp/servers/${encodeURIComponent(name)}/prompts`
    );
    return data?.prompts ?? [];
  }

  /** 获取指定 MCP 服务器的提示内容 */
  async getMcpPrompt(
    name: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    const { data } = await this.client.post(
      `/v1/mcp/servers/${encodeURIComponent(name)}/prompts/get`,
      { name: promptName, arguments: args }
    );
    return data?.messages ?? data;
  }

  /**
   * 通用 HTTP 请求代理 — 供路由层直接透传到 Python 后端。
   * 支持 GET / POST / PUT / DELETE / PATCH，返回 Python 响应的 data 部分。
   */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const methodLower = method.toLowerCase() as
      | 'get'
      | 'post'
      | 'put'
      | 'delete'
      | 'patch';
    if (methodLower === 'get' || methodLower === 'delete') {
      const { data } = await this.client[methodLower](path, {
        params: body,
      });
      return data;
    }
    const { data } = await this.client[methodLower](path, body);
    return data;
  }

  // ── LLM 桥接（代理到 Python agent/llm，第一批：chat/chatWithTools/health/model/mark/reset）──

  async llmChat(
    message: string,
    history: Array<{ role: string; content: string }> = [],
    systemPrompt?: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/llm/chat', {
      message,
      history,
      system_prompt: systemPrompt ?? null,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM chat failed');
    }
    return data.content ?? '';
  }

  async llmChatWithTools(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
      name?: string;
    }>,
    tools: Array<Record<string, unknown>>,
    maxTokens: number = 4096,
    toolChoice: 'none' | 'auto' | 'required' = 'auto'
  ): Promise<{
    content: string;
    toolCalls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }> {
    const { data } = await this.client.post('/v1/llm/chat-with-tools', {
      messages,
      tools,
      max_tokens: maxTokens,
      tool_choice: toolChoice,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM chatWithTools failed');
    }
    return {
      content: data.content ?? '',
      toolCalls: data.tool_calls ?? undefined,
    };
  }

  async llmHealthCheck(): Promise<{ available: boolean; message: string }> {
    try {
      const { data } = await this.client.get('/v1/llm/health');
      return {
        available: Boolean(data?.available),
        message: data?.message ?? '',
      };
    } catch {
      return { available: false, message: 'Python LLM unreachable' };
    }
  }

  async llmGetModelName(): Promise<string> {
    const { data } = await this.client.get('/v1/llm/model');
    return data?.model ?? 'unknown';
  }

  async llmMarkUnavailable(reason?: string): Promise<void> {
    await this.client.post('/v1/llm/mark-unavailable', {
      reason: reason ?? '',
    });
  }

  async llmResetAvailability(): Promise<void> {
    await this.client.post('/v1/llm/reset-availability');
  }

  // ── LLM 桥接 第二批：stream / multimodal / code ─────────────────

  async llmStreamChat(
    messages: Array<{ role: string; content: string }>,
    systemPrompt?: string,
    tools?: Array<Record<string, unknown>>
  ): Promise<ReadableStream<Uint8Array>> {
    const { data } = await this.client.post(
      '/v1/llm/stream-chat',
      {
        messages,
        system_prompt: systemPrompt ?? null,
        tools: tools ?? null,
      },
      { responseType: 'stream' }
    );
    return data;
  }

  async llmMultimodalChat(
    message: string,
    images: string[] = [],
    history: Array<{ role: string; content: string }> = []
  ): Promise<string> {
    const { data } = await this.client.post('/v1/llm/multimodal-chat', {
      message,
      images,
      history,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM multimodalChat failed');
    }
    return data.content ?? '';
  }

  async llmMultimodalCodeAnalysis(
    userQuery: string,
    images: string[],
    filePath?: string
  ): Promise<string> {
    const { data } = await this.client.post(
      '/v1/llm/multimodal-code-analysis',
      {
        user_query: userQuery,
        images,
        file_path: filePath ?? null,
      }
    );
    if (!data?.success) {
      throw new Error(data?.error || 'LLM multimodalCodeAnalysis failed');
    }
    return data.content ?? '';
  }

  async llmCodeAnalyze(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/llm/code-analyze', {
      file_path: filePath,
      content,
      user_query: userQuery,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM codeAnalyze failed');
    }
    return data.content ?? '';
  }

  async llmCodeModificationPlan(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/llm/code-modification-plan', {
      file_path: filePath,
      content,
      user_query: userQuery,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM codeModificationPlan failed');
    }
    return data.content ?? '';
  }

  async llmCodeModifiedContent(
    filePath: string,
    currentContent: string,
    userRequest: string,
    fileExists: boolean = true
  ): Promise<string> {
    const { data } = await this.client.post('/v1/llm/code-modified-content', {
      file_path: filePath,
      current_content: currentContent,
      user_request: userRequest,
      file_exists: fileExists,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM codeModifiedContent failed');
    }
    return data.content ?? '';
  }

  async llmDevGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/llm/dev-generate-code', {
      user_request: userRequest,
      file_path: filePath ?? null,
      existing_content: existingContent ?? null,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'LLM devGenerateCode failed');
    }
    return data.content ?? '';
  }

  // ── Memory 桥接（代理到 Python agent/memory）───────────────────

  async memoryStoreShortTerm(
    content: string,
    scene?: string,
    emotion?: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/memory/store-short-term', {
      content,
      scene: scene ?? '',
      emotion: emotion ?? 'neutral',
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory storeShortTerm failed');
    }
    return data.id ?? '';
  }

  async memoryStoreLongTerm(
    content: string,
    scene?: string,
    emotion?: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/memory/store-long-term', {
      content,
      scene: scene ?? '',
      emotion: emotion ?? 'neutral',
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory storeLongTerm failed');
    }
    return data.id ?? '';
  }

  async memoryStoreInstant(
    content: string,
    scene?: string,
    emotion?: string
  ): Promise<string> {
    const { data } = await this.client.post('/v1/memory/store-instant', {
      content,
      scene: scene ?? '',
      emotion: emotion ?? 'neutral',
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory storeInstant failed');
    }
    return data.id ?? '';
  }

  async memoryStoreFeedback(data: {
    traceId?: string;
    toolName?: string;
    feedbackType:
      | 'success'
      | 'failure'
      | 'timeout'
      | 'correction'
      | 'satisfaction';
    rating?: number;
    message?: string;
    userId?: string;
    timestamp?: number;
  }): Promise<void> {
    const { data: resp } = await this.client.post('/v1/memory/store-feedback', {
      trace_id: data.traceId ?? null,
      tool_name: data.toolName ?? null,
      feedback_type: data.feedbackType,
      rating: data.rating ?? null,
      message: data.message ?? null,
      user_id: data.userId ?? null,
      timestamp: data.timestamp ?? null,
    });
    if (!resp?.success) {
      throw new Error(resp?.error || 'Memory storeFeedback failed');
    }
  }

  async memoryStoreEpisodic(
    content: string,
    options?: { importance?: number; tags?: string[]; scene?: string }
  ): Promise<string> {
    const { data } = await this.client.post('/v1/memory/store-episodic', {
      content,
      importance: options?.importance ?? null,
      tags: options?.tags ?? null,
      scene: options?.scene ?? null,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory storeEpisodic failed');
    }
    return data.id ?? '';
  }

  async memoryHybridRetrieval(
    query: string,
    scene?: string,
    emotion?: string,
    topK: number = 10
  ): Promise<
    Array<{
      id: string;
      type: string;
      content: string;
      timestamp: number;
      scene: string;
      emotion: string;
      relevanceScore: number;
      decayScore: number;
    }>
  > {
    const { data } = await this.client.post('/v1/memory/hybrid-retrieval', {
      query,
      scene: scene ?? null,
      emotion: emotion ?? null,
      top_k: topK,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory hybridRetrieval failed');
    }
    return data.results ?? [];
  }

  async memoryGetUserProfile(): Promise<Record<string, unknown>> {
    const { data } = await this.client.get('/v1/memory/user-profile');
    if (!data?.success) {
      return {};
    }
    return data.profile ?? {};
  }

  async memoryUpdate(
    memoryId: string,
    updates: {
      content?: string;
      scene?: string;
      emotion?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const { data } = await this.client.post('/v1/memory/update', {
      memory_id: memoryId,
      content: updates.content ?? null,
      scene: updates.scene ?? null,
      emotion: updates.emotion ?? null,
      metadata: updates.metadata ?? null,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory update failed');
    }
  }

  async memoryRetrieveContext(
    query: string,
    userId?: string,
    limit: number = 10
  ): Promise<
    Array<{
      id: string;
      type: string;
      content: string;
      timestamp: number;
      scene: string;
      emotion: string;
      relevanceScore: number;
    }>
  > {
    const { data } = await this.client.post('/v1/memory/retrieve-context', {
      query,
      user_id: userId ?? null,
      limit,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory retrieveContext failed');
    }
    return data.results ?? [];
  }

  async memoryQueryRecentFeedback(
    hours: number = 24
  ): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.client.post(
      '/v1/memory/query-recent-feedback',
      {
        hours,
      }
    );
    if (!data?.success) {
      throw new Error(data?.error || 'Memory queryRecentFeedback failed');
    }
    return data.results ?? [];
  }

  async memoryCalculateDecayScore(
    memoryType: string,
    timestamp: number,
    accessCount: number = 0,
    importance: number = 5.0
  ): Promise<number> {
    const { data } = await this.client.post('/v1/memory/decay-score', {
      memory_type: memoryType,
      timestamp,
      access_count: accessCount,
      importance,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory decay score calculation failed');
    }
    return data.decay_score ?? 0;
  }

  async memoryUpdateDecayScores(batchSize: number = 100): Promise<number> {
    const { data } = await this.client.post(
      '/v1/memory/update-decay-scores',
      null,
      {
        params: { batch_size: batchSize },
      }
    );
    if (!data?.success) {
      throw new Error(data?.error || 'Memory decay scores update failed');
    }
    return data.updated ?? 0;
  }

  async memoryPerformDream(): Promise<Record<string, number>> {
    const { data } = await this.client.post('/v1/memory/dream');
    if (!data?.success) {
      throw new Error(data?.error || 'Memory dream failed');
    }
    return data.stats ?? {};
  }

  async memoryGetDreamStats(): Promise<Record<string, unknown>> {
    const { data } = await this.client.get('/v1/memory/dream-stats');
    if (!data?.success) {
      throw new Error(data?.error || 'Memory dream stats failed');
    }
    return data.stats ?? {};
  }

  async memoryBuildKnowledgeGraph(limit: number = 100): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  }> {
    const { data } = await this.client.get('/v1/memory/knowledge-graph', {
      params: { limit },
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory knowledge graph failed');
    }
    return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
  }

  async memoryStoreEncrypted(
    content: string,
    memoryType: string = 'long_term',
    scene: string = '',
    emotion: string = 'neutral'
  ): Promise<string> {
    const { data } = await this.client.post('/v1/memory/store-encrypted', {
      content,
      memory_type: memoryType,
      scene,
      emotion,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory store encrypted failed');
    }
    return data.id ?? '';
  }

  async memoryStoreWithTrace(
    content: string,
    traceId: string,
    memoryType: string = 'short_term',
    scene: string = '',
    emotion: string = 'neutral'
  ): Promise<string> {
    const { data } = await this.client.post('/v1/memory/store-with-trace', {
      content,
      trace_id: traceId,
      memory_type: memoryType,
      scene,
      emotion,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory store with trace failed');
    }
    return data.id ?? '';
  }

  async memorySearchByTrace(
    traceId: string
  ): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.client.post('/v1/memory/search-by-trace', {
      trace_id: traceId,
    });
    if (!data?.success) {
      throw new Error(data?.error || 'Memory search by trace failed');
    }
    return data.results ?? [];
  }

  // ── 浏览器/桌面自动化 桥接 ────────────────

  /**
   * 浏览器自动化操作
   *
   * 代理到 Python POST /api/browser/action，执行网页导航、点击、输入等浏览器操作。
   *
   * @param params - 浏览器操作参数
   * @param params.action - 操作类型（如 navigate、click、type、screenshot 等）
   * @param params.url - 目标 URL（navigate 操作时必填）
   * @param params.selector - CSS 选择器（click/type 操作时必填）
   * @param params.value - 输入值（type 操作时必填）
   * @returns 操作执行结果
   * @throws {Error} Python Agent 不可用或操作执行失败时抛出
   */
  async browserAction(params: {
    action: string;
    url?: string;
    selector?: string;
    value?: string;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.post('/api/browser/action', {
        action: params.action,
        url: params.url ?? null,
        selector: params.selector ?? null,
        value: params.value ?? null,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Browser action failed');
      }
      return data.result ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(
        `浏览器自动化操作失败: ${err.message}`,
        err,
        'PythonAgentBridge'
      );
      throw new Error(`浏览器自动化操作失败: ${err.message}`);
    }
  }

  /**
   * 桌面自动化操作
   *
   * 代理到 Python POST /api/desktop/action，执行窗口管理、键盘鼠标模拟等桌面操作。
   *
   * @param params - 桌面操作参数
   * @param params.action - 操作类型（如 click、type、screenshot、launch 等）
   * @param params.target - 操作目标（窗口标题、坐标等）
   * @param params.value - 输入值（type 操作时使用）
   * @returns 操作执行结果
   * @throws {Error} Python Agent 不可用或操作执行失败时抛出
   */
  async desktopAction(params: {
    action: string;
    target?: string;
    value?: string;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.post('/api/desktop/action', {
        action: params.action,
        target: params.target ?? null,
        value: params.value ?? null,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Desktop action failed');
      }
      return data.result ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(
        `桌面自动化操作失败: ${err.message}`,
        err,
        'PythonAgentBridge'
      );
      throw new Error(`桌面自动化操作失败: ${err.message}`);
    }
  }

  // ── 工具集/安全/重构 桥接 ──────────────────

  /**
   * 代码重构操作
   *
   * 代理到 Python POST /api/tools/execute，通过 tool_name 路由到具体重构工具。
   * 支持的重构类型：refactor_rename（重命名）、refactor_extract（提取函数/变量）、
   * refactor_move（移动）、refactor_preview（预览重构变更）。
   *
   * @param params - 重构操作参数
   * @param params.tool_name - 重构工具名称（refactor_rename / refactor_extract / refactor_move / refactor_preview）
   * @param params - 其余参数根据 tool_name 不同而异，直接透传给 Python 端
   * @returns 重构执行结果（预览或实际变更）
   * @throws {Error} Python Agent 不可用或重构操作失败时抛出
   */
  async refactorCode(params: {
    tool_name: string;
    [key: string]: unknown;
  }): Promise<unknown> {
    try {
      const { tool_name, ...toolParams } = params;
      const { data } = await this.client.post('/api/tools/execute', {
        tool_name,
        params: toolParams,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Refactor code failed');
      }
      return data.result ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(
        `代码重构操作失败: ${err.message}`,
        err,
        'PythonAgentBridge'
      );
      throw new Error(`代码重构操作失败: ${err.message}`);
    }
  }

  /**
   * 多模态视觉分析
   *
   * 代理到 Python POST /api/tools/execute，调用 vision_understand 工具
   * 对图片进行理解和分析。
   *
   * @param params - 视觉分析参数
   * @param params.image_path - 待分析的图片路径
   * @param params.prompt - 分析提示词（描述想了解的图片内容）
   * @returns 视觉分析结果文本
   * @throws {Error} Python Agent 不可用或视觉分析失败时抛出
   */
  async visionAnalysis(params: {
    image_path?: string;
    prompt?: string;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.post('/api/tools/execute', {
        tool_name: 'vision_understand',
        params: {
          image_path: params.image_path ?? null,
          prompt: params.prompt ?? null,
        },
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Vision analysis failed');
      }
      return data.result ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(
        `多模态视觉分析失败: ${err.message}`,
        err,
        'PythonAgentBridge'
      );
      throw new Error(`多模态视觉分析失败: ${err.message}`);
    }
  }

  /**
   * 工具集列表查询
   *
   * 代理到 Python GET /api/tools/list，按分类和场景筛选可用工具。
   *
   * @param params - 查询参数
   * @param params.category - 工具分类（如 browser、desktop、code 等）
   * @param params.scene - 使用场景（如 development、testing 等）
   * @returns 工具列表
   * @throws {Error} Python Agent 不可用或查询失败时抛出
   */
  async toolsetList(params: {
    category?: string;
    scene?: string;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.get('/api/tools/list', {
        params: {
          category: params.category ?? undefined,
          scene: params.scene ?? undefined,
        },
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Toolset list failed');
      }
      return data.tools ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(
        `工具集列表查询失败: ${err.message}`,
        err,
        'PythonAgentBridge'
      );
      throw new Error(`工具集列表查询失败: ${err.message}`);
    }
  }

  /**
   * 工具执行
   *
   * 代理到 Python POST /api/tools/execute，按名称调用指定工具并传入参数。
   *
   * @param params - 工具执行参数
   * @param params.tool_name - 要执行的工具名称
   * @param params.params - 工具执行参数对象
   * @returns 工具执行结果
   * @throws {Error} Python Agent 不可用或工具执行失败时抛出
   */
  async toolsetExecute(params: {
    tool_name: string;
    params: Record<string, unknown>;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.post('/api/tools/execute', {
        tool_name: params.tool_name,
        params: params.params,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Toolset execute failed');
      }
      return data.result ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(`工具执行失败: ${err.message}`, err, 'PythonAgentBridge');
      throw new Error(`工具执行失败: ${err.message}`);
    }
  }

  /**
   * 工具执行(原始响应, 不吞逻辑失败)。
   *
   * 与 toolsetExecute 不同: 仅当传输层出错(网络/连接)时抛异常; 若 Python 端
   * 返回 success=false(含安全策略拒绝), 直接把原始响应体返回, 由调用方决定
   * 是否降级。F1 归一 Phase1 shell_exec 代理依赖此语义以区分"Python 拒绝命令"
   * 与"Python 不可用"——前者必须诚实返回(绝不回退到更宽松的 TS 本地执行)。
   *
   * @param toolName - 工具名称
   * @param params - 工具执行参数
   * @returns 原始响应 { success, output?, error?, duration?, metadata? }
   * @throws 仅当传输层失败时抛出
   */
  async toolsetExecuteRaw(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    duration?: number;
    metadata?: Record<string, unknown>;
  }> {
    try {
      const { data } = await this.client.post('/api/tools/execute', {
        tool_name: toolName,
        params,
      });
      return data as {
        success: boolean;
        output?: string;
        error?: string;
        duration?: number;
        metadata?: Record<string, unknown>;
      };
    } catch (error) {
      Logger.debug(
        `⚠️ toolsetExecuteRaw 传输失败 (${toolName}): ${(error as Error).message}`,
        'PythonAgentBridge'
      );
      throw error;
    }
  }

  /**
   * 安全检查
   *
   * 代理到 Python POST /api/security/check，对指定目标执行安全扫描。
   *
   * @param params - 安全检查参数
   * @param params.target - 检查目标（文件路径、代码片段、URL 等）
   * @param params.check_type - 检查类型（如 xss、sql_injection、secrets 等）
   * @returns 安全检查结果，包含发现的问题和风险等级
   * @throws {Error} Python Agent 不可用或安全检查失败时抛出
   */
  async securityCheck(params: {
    target: string;
    check_type?: string;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.post('/api/security/check', {
        target: params.target,
        check_type: params.check_type ?? null,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Security check failed');
      }
      return data.result ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(`安全检查失败: ${err.message}`, err, 'PythonAgentBridge');
      throw new Error(`安全检查失败: ${err.message}`);
    }
  }

  /**
   * 混合记忆检索
   *
   * 代理到 Python POST /api/memory/search-hybrid，结合全文检索和向量检索
   * 返回最相关的记忆条目。
   *
   * @param params - 检索参数
   * @param params.query - 检索查询文本
   * @param params.n_results - 返回结果数量（默认 10）
   * @param params.use_vector - 是否启用向量检索（默认 true）
   * @returns 混合检索结果列表
   * @throws {Error} Python Agent 不可用或检索失败时抛出
   */
  async hybridMemorySearch(params: {
    query: string;
    n_results?: number;
    use_vector?: boolean;
  }): Promise<unknown> {
    try {
      const { data } = await this.client.post('/api/memory/search-hybrid', {
        query: params.query,
        n_results: params.n_results ?? 10,
        use_vector: params.use_vector ?? true,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Hybrid memory search failed');
      }
      return data.results ?? data;
    } catch (error) {
      const err = error as Error;
      Logger.error(
        `混合记忆检索失败: ${err.message}`,
        err,
        'PythonAgentBridge'
      );
      throw new Error(`混合记忆检索失败: ${err.message}`);
    }
  }

  // ── WS 流式聊天通道 ───────────────────────

  /**
   * 建立聊天 WebSocket 连接 (ws_root)
   * 与 EventBus WS (/v1/events) 分开，用于流式对话
   */
  connectChatWs(): void {
    if (this._disconnected) return;
    const wsUrl = this.client.defaults.baseURL?.replace('http', 'ws');
    if (!wsUrl) return;

    try {
      this.chatWs = new WebSocket(`${wsUrl}/`);

      this.chatWs.on('open', () => {
        Logger.info('Python Agent Chat WS 已连接', 'PythonAgentBridge');
        this._chatReconnectDelay = 1000; // 重置退避
      });

      this.chatWs.on('message', (raw) => {
        try {
          const rawStr = raw.toString();
          const parsed = JSON.parse(rawStr);
          // 统一消息协议路由：支持 UnifiedBridgeMessage 和旧版 StreamEvent
          if (
            parsed &&
            typeof parsed.type === 'string' &&
            ['chat', 'event', 'mcp_sync', 'ping', 'pong', 'cancel'].includes(
              parsed.type
            )
          ) {
            this._handleUnifiedMessage(parsed as UnifiedBridgeMessage);
          } else {
            const event: StreamEvent = parsed;
            this._handleChatEvent(event);
          }
        } catch {
          // ignore parse errors
        }
      });

      this.chatWs.on('error', (err) => {
        Logger.warn(
          `Python Agent Chat WS 错误: ${err.message}`,
          'PythonAgentBridge'
        );
      });

      this.chatWs.on('close', () => {
        Logger.info('Python Agent Chat WS 已断开', 'PythonAgentBridge');
        this.chatWs = null;
        // 清理所有未完成请求
        this._failAllPending(new Error('Chat WS 连接断开'));
        // 指数退避重连
        this._scheduleChatReconnect();
      });

      this.chatWs.on('unexpected-response', () => {
        Logger.warn(
          'Python Agent Chat WS 意外响应，将重连',
          'PythonAgentBridge'
        );
        this.chatWs?.close();
        this.chatWs = null;
      });
    } catch (error) {
      Logger.warn(
        `Python Agent Chat WS 连接失败: ${(error as Error).message}`,
        'PythonAgentBridge'
      );
      this._scheduleChatReconnect();
    }
  }

  /** 检查 chat WS 是否就绪 */
  isChatReady(): boolean {
    return this.chatWs?.readyState === WebSocket.OPEN;
  }

  // ── EventBus 双向同步 ─────────────────────

  setTsEventBusForward(
    forwardFn: (event: string, payload: unknown) => void
  ): void {
    this.tsEventBusForward = forwardFn;
  }

  connectEvents(): void {
    if (this._disconnected) return; // 已主动断开，不重连
    const wsUrl = this.client.defaults.baseURL?.replace('http', 'ws');
    if (!wsUrl) return;

    try {
      this.ws = new WebSocket(`${wsUrl}/v1/events`);

      this.ws.on('open', () => {
        Logger.info('Python Agent EventBus WS 已连接', 'PythonAgentBridge');
        this._eventReconnectDelay = 1000; // 重置退避
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
        if (this._disconnected) return;
        const delay = this._eventReconnectDelay;
        this._eventReconnectDelay = Math.min(
          this._eventReconnectDelay * 2,
          30000
        );
        Logger.info(
          `EventBus WS ${delay}ms 后指数退避重连 (下次: ${this._eventReconnectDelay}ms)`,
          'PythonAgentBridge'
        );
        setTimeout(() => {
          if (
            !this._disconnected &&
            (this.eventHandlers.size > 0 || this.tsEventBusForward)
          ) {
            this.connectEvents();
          }
        }, delay);
      });

      this.ws.on('unexpected-response', () => {
        Logger.warn(
          'Python Agent EventBus WS 意外响应，将重连',
          'PythonAgentBridge'
        );
        this.ws?.close();
        this.ws = null;
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
    this._disconnected = true;
    this.tsEventBusForward = null;

    // 断开 EventBus WS
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.eventHandlers.clear();

    // 断开 Chat WS
    if (this.chatWs) {
      this.chatWs.close();
      this.chatWs = null;
    }
    this._failAllPending(new Error('Bridge 已断开'));

    // 清理重连定时器
    if (this._chatReconnectTimer) {
      clearTimeout(this._chatReconnectTimer);
      this._chatReconnectTimer = null;
    }

    // 销毁 HTTP 连接池
    this.client.defaults.httpAgent?.destroy();
    this.client.defaults.httpsAgent?.destroy();
  }

  // ── 私有方法 ──────────────────────────────

  /** HTTP 回退处理 — 失败时抛出 BridgeError */
  private async _processInputViaHttp(
    message: string,
    sessionId: string,
    traceId?: string,
    images?: Array<{ url: string; mimeType?: string }>
  ): Promise<BridgeProcessResult> {
    const requestId = `chat_${++this._requestIdCounter}_${Date.now()}`;
    const headers: Record<string, string> = {};
    if (traceId) {
      headers['x-trace-id'] = traceId;
    }
    try {
      const { data } = await this.client.post(
        '/v1/chat',
        {
          message,
          session_id: sessionId,
          trace_id: traceId,
          request_id: requestId,
          images: images ?? [],
        },
        { headers }
      );
      const rawContent = data.content || '';
      const finishReason = data.finish_reason || undefined;
      let responseText = rawContent || '抱歉，后端未返回有效内容，请稍后重试。';
      if (finishReason === 'budget_exceeded' && !rawContent.trim()) {
        responseText =
          '抱歉，当前AI服务预算已达上限，暂时无法处理更多请求。请稍后重试。';
        Logger.warn(
          'Python后端返回budget_exceeded，使用降级提示',
          'PythonAgentBridge'
        );
      }
      return {
        response: responseText,
        traceId: data.trace_id ?? traceId,
        intent: data.intent,
        qualityScore:
          typeof data.quality_score === 'number'
            ? data.quality_score
            : undefined,
        toolCallsMade:
          typeof data.tool_calls_made === 'number'
            ? data.tool_calls_made
            : undefined,
        roundsUsed:
          typeof data.rounds_used === 'number' ? data.rounds_used : undefined,
        duration: typeof data.duration === 'number' ? data.duration : undefined,
        finishReason: data.finish_reason || undefined,
      };
    } catch (error) {
      const err = error as Error;
      Logger.error('Python Agent 聊天请求失败', err, 'PythonAgentBridge');
      throw new BridgeError('http_request', err, false, this.healthy);
    }
  }

  /** WS 流式处理 */
  private _processInputViaWs(
    message: string,
    sessionId: string,
    traceId: string,
    images?: Array<{ url: string; mimeType?: string }>
  ): Promise<BridgeProcessResult> {
    return new Promise((resolve, reject) => {
      const requestId = `chat_${++this._requestIdCounter}_${Date.now()}`;
      const contentBuffer: string[] = [];

      const timeout = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error(`WS 流式聊天超时 (${this._wsTimeout / 1000}s)`));
      }, this._wsTimeout);

      this._pendingRequests.set(requestId, {
        resolve,
        reject,
        contentBuffer,
        timeout,
      });

      try {
        this.chatWs!.send(
          JSON.stringify({
            type: 'user_input',
            message,
            session_id: sessionId,
            trace_id: traceId,
            request_id: requestId,
            images: images ?? [],
          })
        );
      } catch (err) {
        clearTimeout(timeout);
        this._pendingRequests.delete(requestId);
        reject(err);
      }
    });
  }

  /** 处理来自 Chat WS 的事件 */
  private _handleChatEvent(event: StreamEvent): void {
    const eventAny = event as unknown as Record<string, unknown>;

    const requestId = eventAny.request_id as string | undefined;

    if (requestId) {
      const pending = this._pendingRequests.get(requestId);
      if (pending) {
        if (pending.onStream) {
          pending.onStream(event);
        } else {
          // 非流式模式：累积内容
          if (event.type === 'stream_chunk' && event.content) {
            // 兼容 content 为 {'content': '某字'} 格式
            const text =
              typeof event.content === 'string' &&
              event.content.startsWith("{'content':")
                ? event.content.replace(/\{'content':\s*'([^']*)'\}/g, '$1')
                : event.content;
            pending.contentBuffer.push(text);
          } else if (event.done || event.type === 'stream_done') {
            clearTimeout(pending.timeout);
            const _meta = (event.metadata || {}) as Record<string, unknown>;
            const wsContent =
              event.content || pending.contentBuffer.join('') || '';
            const wsFinishReason =
              (eventAny.finish_reason as string) ||
              (_meta.finish_reason as string) ||
              undefined;
            let wsResponseText =
              wsContent || '抱歉，后端未返回有效内容，请稍后重试。';
            if (wsFinishReason === 'budget_exceeded' && !wsContent.trim()) {
              wsResponseText =
                '抱歉，当前AI服务预算已达上限，暂时无法处理更多请求。请稍后重试。';
              Logger.warn(
                'WS通道返回budget_exceeded，使用降级提示',
                'PythonAgentBridge'
              );
            }
            pending.resolve({
              response: wsResponseText,
              traceId: event.trace_id,
              qualityScore:
                typeof eventAny.quality_score === 'number'
                  ? eventAny.quality_score
                  : typeof _meta.quality_score === 'number'
                    ? _meta.quality_score
                    : undefined,
              toolCallsMade:
                typeof eventAny.tool_calls_made === 'number'
                  ? eventAny.tool_calls_made
                  : typeof _meta.tool_calls_made === 'number'
                    ? _meta.tool_calls_made
                    : undefined,
              roundsUsed:
                typeof eventAny.rounds_used === 'number'
                  ? eventAny.rounds_used
                  : typeof _meta.rounds_used === 'number'
                    ? _meta.rounds_used
                    : undefined,
              duration:
                typeof eventAny.duration === 'number'
                  ? eventAny.duration
                  : typeof _meta.duration === 'number'
                    ? _meta.duration
                    : undefined,
              finishReason:
                (eventAny.finish_reason as string) ||
                (_meta.finish_reason as string) ||
                undefined,
            });
            this._pendingRequests.delete(requestId);
          } else if (event.type === 'error') {
            clearTimeout(pending.timeout);
            pending.reject(new Error(event.content || '未知 WS 错误'));
            this._pendingRequests.delete(requestId);
          }
        }
        return;
      }
    }

    // 无对应请求 — 可能是全局事件（如 tool_start 广播），通过 EventBus 转发
    Logger.warn(
      `Chat event without request_id: type=${event.type}, 无法路由到pending请求`,
      'PythonAgentBridge'
    );
    if (this.tsEventBusForward) {
      this.tsEventBusForward(`chat:${event.type}`, event);
    }
  }

  /** 清理所有未完成请求 */
  private _failAllPending(err: Error): void {
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this._pendingRequests.clear();
  }

  /** 指数退避重连 Chat WS */
  private _scheduleChatReconnect(): void {
    if (this._disconnected || this._chatReconnectTimer) return;

    const delay = this._chatReconnectDelay;
    this._chatReconnectDelay = Math.min(this._chatReconnectDelay * 2, 30000);

    Logger.info(`Chat WS ${delay}ms 后重连...`, 'PythonAgentBridge');

    this._chatReconnectTimer = setTimeout(() => {
      this._chatReconnectTimer = null;
      this.connectChatWs();
    }, delay);
  }

  /** 发出降级可观测事件 */
  private _emitFallbackEvent(
    from: 'ws' | 'http',
    to: 'ws' | 'http' | 'none',
    phase: BridgePhase,
    error: string
  ): void {
    const payload: BridgeFallbackEvent = {
      from,
      to,
      phase,
      error,
      pythonHealthy: this.healthy,
      timestamp: Date.now(),
    };
    try {
      JiabaixingEventBus.getInstance().emit('bridge:fallback', payload);
    } catch {
      // EventBus 不可用时静默，不影响主流程
    }
    Logger.warn(
      `Bridge 降级: ${from} → ${to} (phase=${phase})`,
      'PythonAgentBridge'
    );
  }

  /** 发出不可用可观测事件 */
  private _emitUnavailableEvent(phase: BridgePhase, error: string): void {
    const payload: BridgeUnavailableEvent = {
      phase,
      error,
      timestamp: Date.now(),
    };
    try {
      JiabaixingEventBus.getInstance().emit('bridge:unavailable', payload);
    } catch {
      // EventBus 不可用时静默
    }
    Logger.error(
      `Bridge 不可用 (phase=${phase}): ${error}`,
      undefined,
      'PythonAgentBridge'
    );
  }

  /** 统一消息协议路由处理器 */
  private _handleUnifiedMessage(msg: UnifiedBridgeMessage): void {
    switch (msg.type) {
      case 'chat': {
        const event = msg.payload as StreamEvent;
        this._handleChatEvent(event);
        break;
      }
      case 'event': {
        try {
          JiabaixingEventBus.getInstance().emit(
            'bridge:python_event' as any,
            msg.payload
          );
        } catch {
          // EventBus 不可用时静默
        }
        break;
      }
      case 'mcp_sync': {
        try {
          JiabaixingEventBus.getInstance().emit(
            'bridge:mcp_sync' as any,
            msg.payload
          );
        } catch {
          // EventBus 不可用时静默
        }
        break;
      }
      case 'pong': {
        Logger.debug('Bridge pong received', 'PythonAgentBridge');
        break;
      }
      default: {
        Logger.debug(
          `Unified message type unhandled: ${msg.type}`,
          'PythonAgentBridge'
        );
      }
    }
  }
}

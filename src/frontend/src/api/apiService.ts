/**
 * API服务层
 * 统一管理所有API请求，确保模块间的数据交互标准一致
 * 所有端点引用共享契约层 contracts.ts，禁止硬编码
 */

import type {
  AutomationTrigger,
  BatchResultItem,
  BatchRunRequest,
  IdeChatRequest,
  IdeChatResponse,
  IdeSession,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolInfo,
  TrajectoryStatsResponse,
} from '@shared/contracts';
import {
  API_ENDPOINTS,
  ApiResponse,
  EvolutionCycleStatus,
  HealthResponse,
  IntegrationPlatform,
  IntegrationStatusResponse,
  MemoryProfileResponse,
  MemorySearchResponse,
  MemoryStatsResponse,
  ModelHealth,
  ModelInfo,
  ModelStatus,
  PerformanceSnapshotResponse,
  PlatformConfig,
  PlatformConnectResponse,
  PlatformDisconnectResponse,
  SecurityValidateResponse,
  SendMessageRequest,
  SendMessageResponse,
  SkillExecuteResponse,
  SkillListResponse,
  SystemResourcesResponse,
} from '@shared/contracts';

type RequestInit = Parameters<typeof fetch>[1];

interface CacheItem<T> {
  data: T;
  timestamp: number;
  expiry: number;
}

class ApiService {
  protected baseUrl: string;
  private cache: Map<string, CacheItem<unknown>> = new Map();
  private defaultCacheExpiry = 5 * 60 * 1000;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  clearCache(): void {
    this.cache.clear();
  }

  clearCacheForEndpoint(endpoint: string): void {
    const keys = Array.from(this.cache.keys());
    keys.forEach((key) => {
      if (key.startsWith(endpoint)) {
        this.cache.delete(key);
      }
    });
  }

  private generateCacheKey(endpoint: string, params?: Record<string, unknown>): string {
    const queryString = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return `${endpoint}${queryString}`;
  }

  private isCacheValid(cacheKey: string): boolean {
    const cacheItem = this.cache.get(cacheKey);
    if (!cacheItem) return false;
    return Date.now() < cacheItem.timestamp + cacheItem.expiry;
  }

  private getCache<T>(cacheKey: string): T | null {
    if (this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey)?.data as T;
    }
    this.cache.delete(cacheKey);
    return null;
  }

  private setCache<T>(cacheKey: string, data: T, expiry?: number): void {
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      expiry: expiry || this.defaultCacheExpiry,
    });
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    cacheExpiry?: number,
    params?: Record<string, unknown>
  ): Promise<ApiResponse<T>> {
    if (options.method === 'GET' || !options.method) {
      const cacheKey = this.generateCacheKey(endpoint, params);
      const cachedData = this.getCache<T>(cacheKey);
      if (cachedData) {
        return { success: true, data: cachedData };
      }
    }

    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const queryString = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
        const url = `${this.baseUrl}${endpoint}${queryString}`;
        const response = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });

        const data = await response.json();

        if (!response.ok) {
          return {
            success: false,
            error: data.error || `HTTP Error: ${response.status}`,
          };
        }

        if (options.method === 'GET' || !options.method) {
          const cacheKey = this.generateCacheKey(endpoint, params);
          this.setCache<T>(cacheKey, data, cacheExpiry);
        }

        return { success: true, data };
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
        const delay = Math.pow(2, retries) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return { success: false, error: 'Maximum retries exceeded' };
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>, cacheExpiry?: number): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'GET' }, cacheExpiry, params);
  }

  async post<T>(endpoint: string, data?: unknown, timeoutMs: number = 30000): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.request<T>(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { success: false, error: `请求超时 (${timeoutMs / 1000}s)，请稍后重试` };
      }
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async put<T>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

/** 自动化任务信息 */
export interface AutomationTaskInfo {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  executionCount: number;
  successCount: number;
  lastRunAt?: string;
  nextRunAt?: string;
}

/** 主动触发器信息 */
export interface AutomationTriggerInfo {
  type: string;
  reason: string;
  priority: number;
  suggestedAction?: string;
  timestamp: number;
}

/** 工作区信息（与 useWorkspaceStore 类型保持一致） */
interface Workspace {
  id: string;
  name: string;
  path: string;
  description?: string;
  projectType?: string;
  lastActive: string;
}

/** 会话信息（与 useWorkspaceStore 类型保持一致） */
interface Session {
  id: string;
  title: string;
  lastActive: string;
}

/** 网关平台信息（与 useGatewayStore 类型保持一致） */
interface GatewayPlatform {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  unreadCount: number;
}

export class JiabaixingApiService extends ApiService {
  async getHealth(): Promise<ApiResponse<HealthResponse>> {
    return this.get<HealthResponse>(API_ENDPOINTS.HEALTH, undefined, 30000);
  }

  async processMessage(
    input: string,
    images?: string[],
    userId?: string
  ): Promise<
    ApiResponse<{ response: string; traceId: string; intent: string; finishReason?: string; qualityScore?: number }>
  > {
    return this.post<{
      response: string;
      traceId: string;
      intent: string;
      finishReason?: string;
      qualityScore?: number;
    }>(
      API_ENDPOINTS.PROCESS,
      {
        input,
        images,
        userId,
      },
      60000
    );
  }

  async processMultimodalMessage(
    input: string,
    images?: string[],
    files?: Array<{ name: string; url: string; size: number; mimeType: string }>
  ): Promise<ApiResponse<{ response: string; traceId: string; intent: string }>> {
    return this.post<{ response: string; traceId: string; intent: string }>(API_ENDPOINTS.PROCESS, {
      input,
      images,
      files,
    });
  }

  async uploadFile(
    file: File
  ): Promise<ApiResponse<{ files: Array<{ name: string; url: string; size: number; mimeType: string }> }>> {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${this.baseUrl}${API_ENDPOINTS.FILE_UPLOAD}`, {
        method: 'POST',
        body: formData,
      });
      return response.json();
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async uploadAudio(file: File): Promise<ApiResponse<{ text: string; confidence: number; duration: number }>> {
    const formData = new FormData();
    formData.append('audio', file);
    try {
      const response = await fetch(`${this.baseUrl}${API_ENDPOINTS.AUDIO_UPLOAD}`, {
        method: 'POST',
        body: formData,
      });
      return response.json();
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async getUploadHistory(): Promise<ApiResponse<{ files: Array<{ name: string; size: number; uploaded: string }> }>> {
    return this.get<{ files: Array<{ name: string; size: number; uploaded: string }> }>(
      API_ENDPOINTS.FILE_UPLOAD_HISTORY
    );
  }

  async submitCorrection(
    toolId: string,
    correctionType: string,
    reason?: string,
    severity?: number,
    traceId?: string
  ): Promise<ApiResponse<{ success: boolean; message: string }>> {
    return this.post<{ success: boolean; message: string }>(API_ENDPOINTS.CORRECT, {
      toolId,
      correctionType,
      reason,
      severity,
      traceId,
    });
  }

  getLogs(): EventSource {
    return new EventSource(`${this.baseUrl}${API_ENDPOINTS.LOGS_SSE}`);
  }

  async getModels(): Promise<ApiResponse<ModelInfo[]>> {
    return this.get<ModelInfo[]>(API_ENDPOINTS.MODELS);
  }

  async getModelStatus(): Promise<ApiResponse<ModelStatus>> {
    return this.get<ModelStatus>(API_ENDPOINTS.MODELS_STATUS);
  }

  async getModelHealth(): Promise<ApiResponse<{ models: ModelHealth[]; timestamp: string }>> {
    return this.get<{ models: ModelHealth[]; timestamp: string }>(API_ENDPOINTS.MODELS_HEALTH);
  }

  async switchModel(
    targetModel: string,
    reason?: string
  ): Promise<ApiResponse<{ success: boolean; message: string; currentModel: string }>> {
    return this.post<{
      success: boolean;
      message: string;
      currentModel: string;
    }>(API_ENDPOINTS.MODELS_SWITCH, { targetModel, reason });
  }

  async getEvolutionStatus(): Promise<ApiResponse<EvolutionCycleStatus>> {
    return this.get<EvolutionCycleStatus>(API_ENDPOINTS.EVOLUTION_STATUS);
  }

  async getEvolutionMetrics(): Promise<
    ApiResponse<{
      totalOptimizations: number;
      successRate: number;
      averageImprovement: number;
      lastUpdate: string;
    }>
  > {
    return this.get(API_ENDPOINTS.EVOLUTION_METRICS);
  }

  async triggerEvolution(reason?: string): Promise<ApiResponse<{ id: string; reason: string }>> {
    return this.post<{ id: string; reason: string }>(API_ENDPOINTS.EVOLUTION_TRIGGER, { reason: reason || '手动触发' });
  }

  async triggerEvolutionCycle(): Promise<
    ApiResponse<{
      success: boolean;
      message: string;
      duration: string;
      summary: {
        healingCount: number;
        refactorSuccess: boolean;
        enhancementCount: number;
      };
      timestamp: string;
    }>
  > {
    return this.post(API_ENDPOINTS.EVOLUTION_CYCLE);
  }

  async triggerHealing(): Promise<
    ApiResponse<{
      success: boolean;
      message: string;
      results: unknown[];
      timestamp: string;
    }>
  > {
    return this.post(API_ENDPOINTS.EVOLUTION_HEALING);
  }

  async triggerRefactor(): Promise<
    ApiResponse<{
      success: boolean;
      message: string;
      result: unknown;
      timestamp: string;
    }>
  > {
    return this.post(API_ENDPOINTS.EVOLUTION_REFACTOR);
  }

  async triggerEnhance(): Promise<
    ApiResponse<{
      success: boolean;
      message: string;
      opportunities: unknown[];
      timestamp: string;
    }>
  > {
    return this.post(API_ENDPOINTS.EVOLUTION_ENHANCE);
  }

  async storeMemory(
    content: string,
    userId?: string,
    importance?: string,
    tags?: string[],
    emotion?: string,
    scene?: string
  ): Promise<
    ApiResponse<{
      id: string;
      content: string;
      timestamp: string;
      importance: string;
    }>
  > {
    return this.post(API_ENDPOINTS.MEMORY_STORE, {
      content,
      userId,
      importance,
      tags,
      emotion,
      scene,
    });
  }

  async searchMemory(query: string, userId?: string, limit?: number): Promise<ApiResponse<MemorySearchResponse>> {
    return this.get<MemorySearchResponse>(API_ENDPOINTS.MEMORY_SEARCH, {
      query,
      userId,
      limit: limit || 10,
    });
  }

  async getMemoryProfile(userId?: string): Promise<ApiResponse<MemoryProfileResponse>> {
    return this.get<MemoryProfileResponse>(API_ENDPOINTS.MEMORY_PROFILE, userId ? { userId } : undefined);
  }

  async updateMemoryPreferences(preferences: Record<string, unknown>): Promise<ApiResponse<MemoryProfileResponse>> {
    return this.post(API_ENDPOINTS.MEMORY_PREFERENCES, { preferences });
  }

  async getMemoryStats(): Promise<ApiResponse<MemoryStatsResponse>> {
    return this.get<MemoryStatsResponse>(API_ENDPOINTS.MEMORY_STATS);
  }

  async getSecurityLogs(limit?: number, level?: string, category?: string): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.SECURITY_LOGS, {
      limit: limit || 100,
      level,
      category,
    });
  }

  async validateSecurityInput(input: string): Promise<ApiResponse<SecurityValidateResponse>> {
    return this.post<SecurityValidateResponse>(API_ENDPOINTS.SECURITY_VALIDATE, { input });
  }

  async getSecurityAudit(limit?: number, type?: string): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.SECURITY_AUDIT, { limit, type });
  }

  async executeSkill(
    skillName: string,
    params?: Record<string, unknown>,
    userId?: string
  ): Promise<ApiResponse<SkillExecuteResponse>> {
    return this.post<SkillExecuteResponse>(API_ENDPOINTS.SKILLS_EXECUTE, {
      skillName,
      params,
      userId,
    });
  }

  async listSkills(): Promise<ApiResponse<SkillListResponse>> {
    return this.get<SkillListResponse>(API_ENDPOINTS.SKILLS_LIST);
  }

  async getPerformanceSnapshot(): Promise<ApiResponse<PerformanceSnapshotResponse>> {
    return this.get<PerformanceSnapshotResponse>(API_ENDPOINTS.PERFORMANCE_SNAPSHOT);
  }

  async getPerformanceMetrics(limit?: number): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.PERFORMANCE_METRICS, {
      limit: limit || 100,
    });
  }

  async getPerformanceErrors(limit?: number): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.PERFORMANCE_ERRORS, {
      limit: limit || 50,
    });
  }

  async getSystemResources(): Promise<ApiResponse<SystemResourcesResponse>> {
    return this.get<SystemResourcesResponse>(API_ENDPOINTS.SYSTEM_RESOURCES);
  }

  async getSystemIntegrity(): Promise<
    ApiResponse<{
      timestamp: string;
      summary: { pass: number; fail: number; warn: number; total: number };
      checks: Array<{ name: string; status: string; message: string }>;
      overallStatus: string;
    }>
  > {
    return this.get(API_ENDPOINTS.SYSTEM_INTEGRITY);
  }

  async getSystemMetrics(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.SYSTEM_METRICS);
  }

  async getSystemConfig(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.SYSTEM_CONFIG);
  }

  async osvScan(
    directory?: string,
    severity?: string
  ): Promise<
    ApiResponse<{ totalVulns: number; critical: number; high: number; medium: number; low: number; report: string }>
  > {
    return this.post<{
      totalVulns: number;
      critical: number;
      high: number;
      medium: number;
      low: number;
      report: string;
    }>(API_ENDPOINTS.SYSTEM_OSV_SCAN, { directory, severity });
  }

  async diskCleanup(
    directory?: string,
    categories?: string[],
    confirm?: boolean,
    dryRun?: boolean
  ): Promise<ApiResponse<{ totalItems: number; totalSize: number; report: string; executed: boolean }>> {
    return this.post<{ totalItems: number; totalSize: number; report: string; executed: boolean }>(
      API_ENDPOINTS.SYSTEM_DISK_CLEANUP,
      { directory, categories, confirm, dryRun }
    );
  }

  async subdirectoryHints(
    directory?: string,
    query?: string
  ): Promise<ApiResponse<{ totalDirs: number; hints: string }>> {
    return this.get<{ totalDirs: number; hints: string }>(API_ENDPOINTS.SYSTEM_SUBDIRECTORY_HINTS, {
      directory,
      query,
    });
  }

  async getAutomationTasks(): Promise<ApiResponse<{ tasks: AutomationTaskInfo[] }>> {
    return this.get<{ tasks: AutomationTaskInfo[] }>(API_ENDPOINTS.AUTOMATION_TASKS);
  }

  async createAutomationTask(task: unknown): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.AUTOMATION_TASKS, task);
  }

  async getAutomationTriggers(): Promise<ApiResponse<{ triggers: AutomationTrigger[] }>> {
    return this.get<{ triggers: AutomationTrigger[] }>(API_ENDPOINTS.AUTOMATION_TRIGGERS);
  }

  async getAutomationPatterns(): Promise<ApiResponse<{ patterns: unknown[] }>> {
    return this.get<{ patterns: unknown[] }>(API_ENDPOINTS.AUTOMATION_PATTERNS);
  }

  async getErrorLogs(
    hours?: number,
    level?: string,
    limit?: number
  ): Promise<
    ApiResponse<{
      timestamp: string;
      total: number;
      levelCounts: Record<string, number>;
      errors: unknown[];
    }>
  > {
    return this.get(API_ENDPOINTS.LOGS_ERRORS, { hours, level, limit });
  }

  async getLogsQuery(limit?: number, level?: string, module?: string): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.LOGS_QUERY, {
      limit,
      level,
      module,
    });
  }

  async getEvolutionInsights(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.EVOLUTION_INSIGHTS);
  }

  async getOrchestratorMetrics(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.ORCHESTRATOR_METRICS);
  }

  async triggerOrchestratorOptimize(): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.ORCHESTRATOR_OPTIMIZE);
  }

  async getSecurityEvents(limit?: number): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.SECURITY_EVENTS, { limit });
  }

  async getSecurityReport(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.SECURITY_REPORT);
  }

  async getLLMPerformance(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.LLM_PERFORMANCE);
  }

  async createTask(taskData: unknown): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.TASKS_CREATE, taskData);
  }

  async listTasks(limit?: number): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.TASKS_LIST, { limit });
  }

  async cancelTask(taskId: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.TASKS_CANCEL.replace(':id', taskId);
    return this.post(endpoint);
  }

  async pauseTask(taskId: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.TASKS_PAUSE.replace(':id', taskId);
    return this.post(endpoint);
  }

  async resumeTask(taskId: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.TASKS_RESUME.replace(':id', taskId);
    return this.post(endpoint);
  }

  async getHarnessTaskStatus(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.TASKS_HARNESS_STATUS);
  }

  async getIntegrationStatus(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.INTEGRATION + '/system-status');
  }

  async getConversations(limit: number = 50): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.CONVERSATIONS, { limit });
  }

  async simulateTask(taskId: string, prompt: string): Promise<ApiResponse<{ traceId: string; taskId: string }>> {
    return this.post<{ traceId: string; taskId: string }>(API_ENDPOINTS.SIMULATE_TASK, { taskId, prompt });
  }

  async processOptimizationPlan(planId: string, action: string): Promise<ApiResponse<unknown>> {
    return this.post<unknown>(API_ENDPOINTS.OPTIMIZATION_PROCESS, {
      planId,
      action,
    });
  }

  async getOptimizationHistory(): Promise<ApiResponse<unknown[]>> {
    return this.get<unknown[]>(API_ENDPOINTS.OPTIMIZATION_HISTORY);
  }

  async sendUserBehaviorEvents(events: unknown[]): Promise<ApiResponse<{ status: string }>> {
    return this.post<{ status: string }>(API_ENDPOINTS.USER_BEHAVIOR_EVENTS, events);
  }

  async getRecommendations(
    userId: string,
    limit: number = 5
  ): Promise<ApiResponse<{ recommendations: unknown[]; evaluation: unknown }>> {
    return this.get<{ recommendations: unknown[]; evaluation: unknown }>(API_ENDPOINTS.RECOMMENDATIONS, {
      userId,
      limit,
    });
  }

  async sendPerformanceMetrics(metrics: unknown): Promise<ApiResponse<{ status: string }>> {
    return this.post<{ status: string }>(API_ENDPOINTS.PERFORMANCE_METRICS_POST, metrics);
  }

  async sendErrorMonitoring(error: unknown): Promise<ApiResponse<{ status: string }>> {
    return this.post<{ status: string }>(API_ENDPOINTS.ERROR_MONITORING, error);
  }

  // 集成相关 API
  async getIntegrationPlatforms(): Promise<ApiResponse<IntegrationStatusResponse>> {
    return this.get<IntegrationStatusResponse>(API_ENDPOINTS.INTEGRATION_PLATFORMS);
  }

  async getIntegrationPlatformStatus(platform: IntegrationPlatform): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.INTEGRATION_STATUS.replace(':platform', platform);
    return this.get(endpoint);
  }

  async connectIntegrationPlatform(
    platform: IntegrationPlatform,
    config: PlatformConfig
  ): Promise<ApiResponse<PlatformConnectResponse>> {
    const endpoint = API_ENDPOINTS.INTEGRATION_CONNECT.replace(':platform', platform);
    return this.post<PlatformConnectResponse>(endpoint, { config });
  }

  async disconnectIntegrationPlatform(platform: IntegrationPlatform): Promise<ApiResponse<PlatformDisconnectResponse>> {
    const endpoint = API_ENDPOINTS.INTEGRATION_DISCONNECT.replace(':platform', platform);
    return this.post<PlatformDisconnectResponse>(endpoint);
  }

  async sendIntegrationMessage(request: SendMessageRequest): Promise<ApiResponse<SendMessageResponse>> {
    const endpoint = API_ENDPOINTS.INTEGRATION_SEND.replace(':platform', request.platform);
    return this.post<SendMessageResponse>(endpoint, request);
  }

  async getIntegrationWebhook(platform: IntegrationPlatform): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.INTEGRATION_WEBHOOK.replace(':platform', platform);
    return this.get(endpoint);
  }

  async getWeChatQRCode(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.INTEGRATION_WECHAT_QRCODE);
  }

  // Desktop API
  async takeDesktopScreenshot(): Promise<ApiResponse<{ screenshot: string }>> {
    return this.post<{ screenshot: string }>(API_ENDPOINTS.DESKTOP_SCREENSHOT);
  }

  async desktopAutomate(task: string): Promise<ApiResponse<{ output: unknown }>> {
    return this.post<{ output: unknown }>(API_ENDPOINTS.DESKTOP_AUTOMATE, { task });
  }

  // MCP API
  async getMCPServers(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.MCP_SERVERS);
  }

  async getMCPServerDetail(name: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.MCP_SERVER_DETAIL.replace(':name', name);
    return this.get(endpoint);
  }

  async startMCPServer(name: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.MCP_SERVER_START.replace(':name', name);
    return this.post(endpoint);
  }

  async stopMCPServer(name: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.MCP_SERVER_STOP.replace(':name', name);
    return this.post(endpoint);
  }

  async startAllMCPServers(): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.MCP_SERVERS_START_ALL);
  }

  async getMCPServerTools(name: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.MCP_SERVER_TOOLS.replace(':name', name);
    return this.get(endpoint);
  }

  async callMCPTool(name: string, tool: string, args?: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.MCP_SERVER_CALL.replace(':name', name);
    return this.post(endpoint, { tool, args });
  }

  async sendMCPMessage(name: string, message: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.MCP_SERVER_MESSAGE.replace(':name', name);
    return this.post(endpoint, message);
  }

  async registerMCPServer(config: { name: string; command: string; args?: string[] }): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.MCP_REGISTER, config);
  }

  // TRAE API
  async getTRAEHealth(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.TRAE_HEALTH);
  }

  async getTRAEPerformance(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.TRAE_PERFORMANCE);
  }

  async getTRAEMCPStatus(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.TRAE_MCP_STATUS);
  }

  async getTRAESkillsStatus(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.TRAE_SKILLS_STATUS);
  }

  async executeTRAESkill(skillName: string, params?: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.TRAE_SKILLS_EXECUTE, { skillName, params });
  }

  async traeSecurityAudit(target?: string, auditType?: string): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.TRAE_SECURITY_AUDIT, { target, auditType });
  }

  async traeTestingGenerate(targetFile: string, testType?: string, framework?: string): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.TRAE_TESTING_GENERATE, { targetFile, testType, framework });
  }

  // Debug API
  async getDebugWeights(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.DEBUG_WEIGHTS);
  }

  async getDebugRecentHistory(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.DEBUG_RECENT_HISTORY);
  }

  async getDebugToolUsage(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.DEBUG_TOOL_USAGE);
  }

  // Docs API
  async getDocsIndex(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.DOCS_INDEX);
  }

  async generateDocs(): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.DOCS_GENERATE);
  }

  // Chat API
  async sendChatMessage(
    message: string,
    conversationId?: string
  ): Promise<ApiResponse<{ response: string; conversation_id: string; trace_id: string }>> {
    return this.post(API_ENDPOINTS.CHAT, { message, conversation_id: conversationId });
  }

  // Orchestrate & Evaluate API
  async orchestrate(goal: string, context?: string): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.ORCHESTRATE, { goal, context });
  }

  async evaluate(evalContext: {
    input?: string;
    response?: string;
    steps?: Array<Record<string, unknown>>;
    duration?: number;
    retries?: number;
    errors?: number;
  }): Promise<ApiResponse<unknown>> {
    return this.post(API_ENDPOINTS.EVALUATE, { context: evalContext });
  }

  // Automation extended API
  async toggleAutomationTask(taskId: string, enabled: boolean): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.AUTOMATION_TASK_TOGGLE.replace(':taskId', taskId);
    return this.post(endpoint, { enabled });
  }

  async executeAutomationTask(taskId: string): Promise<ApiResponse<unknown>> {
    const endpoint = API_ENDPOINTS.AUTOMATION_TASK_EXECUTE.replace(':taskId', taskId);
    return this.post(endpoint);
  }

  // General logs API
  async getLogsGeneral(params?: {
    file?: string;
    lines?: number;
    level?: string;
    component?: string;
  }): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.LOGS_GENERAL, params);
  }

  // Harness status
  async getHarnessStatus(): Promise<ApiResponse<unknown>> {
    return this.get(API_ENDPOINTS.HARNESS_STATUS);
  }

  // ===== Hermes P2: 批处理 / IDE / 轨迹导出 =====

  /**
   * 批量并行运行多个 prompt（Hermes Task 8）
   */
  async runBatch(request: BatchRunRequest): Promise<ApiResponse<{ format: string; data: BatchResultItem[] | string }>> {
    return this.post<{ format: string; data: BatchResultItem[] | string }>(API_ENDPOINTS.BATCH_RUN, request);
  }

  /**
   * IDE 聊天（Hermes Task 18，ACP 协议）
   */
  async chatWithIde(request: IdeChatRequest): Promise<ApiResponse<IdeChatResponse>> {
    return this.post<IdeChatResponse>(API_ENDPOINTS.IDE_CHAT, request);
  }

  /**
   * 获取活跃 IDE 会话列表（Hermes Task 18）
   */
  async getIdeSessions(): Promise<ApiResponse<IdeSession[]>> {
    return this.get<IdeSession[]>(API_ENDPOINTS.IDE_SESSIONS);
  }

  /**
   * 导出累积的 RL 训练轨迹（Hermes Task 19）
   */
  async exportTrajectories(format?: 'sharegpt' | 'jsonl' | 'openai_finetune'): Promise<ApiResponse<unknown>> {
    return this.post<unknown>(API_ENDPOINTS.TRAJECTORY_EXPORT, { format });
  }

  /**
   * 获取 RL 训练轨迹统计信息（Hermes Task 19）
   */
  async getTrajectoryStats(): Promise<ApiResponse<TrajectoryStatsResponse>> {
    return this.get<TrajectoryStatsResponse>(API_ENDPOINTS.TRAJECTORY_STATS);
  }

  // ===== Hermes P2: 工具执行（image_generate / tts_speak / web_fetch） =====

  /**
   * 执行任意已注册的 Harness 工具
   */
  async executeTool(request: ToolExecuteRequest): Promise<ApiResponse<ToolExecuteResponse>> {
    return this.post<ToolExecuteResponse>(API_ENDPOINTS.TOOL_EXECUTE, request);
  }

  /**
   * 图像生成（image_generate 工具）
   */
  async generateImage(prompt: string, size?: string, style?: string): Promise<ApiResponse<ToolExecuteResponse>> {
    return this.executeTool({
      toolName: 'image_generate',
      params: { prompt, size, style },
    });
  }

  /**
   * 文本转语音（tts_speak 工具）
   */
  async speakTts(text: string, voice?: string, speed?: number): Promise<ApiResponse<ToolExecuteResponse>> {
    return this.executeTool({
      toolName: 'tts_speak',
      params: { text, voice, speed },
    });
  }

  /**
   * 网页抓取（web_fetch 工具，作为 browser 功能）
   */
  async fetchWebPage(url: string, format?: string): Promise<ApiResponse<ToolExecuteResponse>> {
    return this.executeTool({
      toolName: 'web_fetch',
      params: { url, format },
    });
  }

  /**
   * 列出所有已注册工具
   */
  async listTools(): Promise<ApiResponse<{ tools: ToolInfo[]; count: number }>> {
    return this.get<{ tools: ToolInfo[]; count: number }>(API_ENDPOINTS.TOOL_LIST);
  }

  // ===== Workspace / Budget / Gateway / Session APIs =====

  async getWorkspaces(): Promise<ApiResponse<Workspace[]>> {
    try {
      const result = await this.get<Workspace[]>('/api/workspaces');
      if (result.success && Array.isArray(result.data)) {
        return result;
      }
    } catch {
      /* 后端未实现时降级到 mock */
    }
    return { success: true, data: [] };
  }

  async createWorkspace(name: string, path: string, description?: string): Promise<ApiResponse<Workspace>> {
    try {
      const result = await this.post<Workspace>('/api/workspaces', { name, path, description });
      if (result.success && result.data) {
        return result;
      }
    } catch {
      /* 后端未实现时降级到本地生成 */
    }
    const workspace: Workspace = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name,
      path,
      description,
      lastActive: new Date().toISOString(),
    };
    return { success: true, data: workspace };
  }

  async getBudgetStatus(): Promise<
    ApiResponse<{ tokenUsed: number; tokenBudget: number; costUsed: number; costBudget: number; period: string }>
  > {
    try {
      const result = await this.get<{
        tokenUsed: number;
        tokenBudget: number;
        costUsed: number;
        costBudget: number;
        period: string;
      }>('/api/budget/status');
      if (result.success && result.data) {
        return result;
      }
    } catch {
      /* 后端未实现时降级到 mock */
    }
    return {
      success: true,
      data: { tokenUsed: 0, tokenBudget: 500000, costUsed: 0, costBudget: 10, period: 'daily' },
    };
  }

  async getGatewayStatus(): Promise<
    ApiResponse<{ status: 'online' | 'offline' | 'partial'; platforms: GatewayPlatform[] }>
  > {
    try {
      const result = await this.getIntegrationPlatforms();
      if (result.success && result.data) {
        const platforms = result.data.platforms.map((p) => ({
          id: p.id,
          name: p.name,
          type: (p.id as string) || 'im',
          connected: p.status?.status === 'connected',
          unreadCount: 0,
        }));
        const connectedCount = platforms.filter((p) => p.connected).length;
        const status: 'online' | 'offline' | 'partial' =
          connectedCount === 0 ? 'offline' : connectedCount === platforms.length ? 'online' : 'partial';
        return { success: true, data: { status, platforms } };
      }
    } catch {
      /* 降级到 mock */
    }
    return { success: true, data: { status: 'offline', platforms: [] } };
  }

  async getSessions(): Promise<ApiResponse<Session[]>> {
    try {
      const result = await this.getConversations(50);
      if (result.success && Array.isArray(result.data)) {
        const sessions = (result.data as Array<{ id?: string; timestamp?: string; title?: string }>)
          .filter((c) => c.id)
          .map((c) => ({
            id: c.id as string,
            title: c.title || '未命名会话',
            lastActive: c.timestamp || new Date().toISOString(),
          }));
        return { success: true, data: sessions };
      }
    } catch {
      /* 降级到 mock */
    }
    return { success: true, data: [] };
  }
}

const apiBaseUrl =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:3111'
    : process.env.REACT_APP_API_BASE_URL || 'http://localhost:3111';

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

export function getWsBaseUrl(): string {
  const httpUrl = getApiBaseUrl();
  return httpUrl.replace(/^http/, 'ws');
}

export const apiService = new JiabaixingApiService(apiBaseUrl);

export type { ApiResponse };

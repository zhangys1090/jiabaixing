/**
 * Harness Layer 2: Tools - 工具注册表
 *
 * 声明式工具注册 + Schema 验证 + 权限检查
 * 替代 SkillRegistry 的基础设施工具注册功能
 */

import { createHash } from 'crypto';
import { capMetrics } from '../../../monitoring/CapabilityMetrics';
import { perf } from '../../../monitoring/PerformanceMonitor';
import {
  ApprovalDecision,
  ApprovalType,
  getApprovalEngine,
} from '../../../security/ApprovalEngine';
import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type {
  RegisteredTool,
  RiskLevel,
  StructuredToolOutput,
  ToolContext,
  ToolDefinition,
  ToolParameterDef,
  ToolResult,
} from '../../types';
import { Permission, ToolCategory } from '../../types';
import { PermissionGuard } from './PermissionGuard';
import { SchemaValidator } from './SchemaValidator';
import { ToolCallGuard } from './ToolCallGuard';
import {
  ToolMetadataEnhancer,
  type ToolSearchOptions,
  type ToolSearchResult,
} from './ToolMetadataEnhancer';
import {
  InMemoryToolRuntimeState,
  type ToolRuntimeState,
} from './ToolRuntimeState';

/** OpenAI Function Calling 工具格式 */
interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/** P2-4: 熔断器状态 */
export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureTime: number;
}

/** P1-3/B1: 仅对瞬时网络/限流类错误重试 */
const RETRYABLE_ERROR_RE =
  /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|429|5\d{2}|timeout|timed out|rate.?limit|too many requests|service unavailable|bad gateway|gateway timeout|connection reset)/i;

/** B1: 默认启用重试的工具类别（网络/LLM 类） */
const RETRY_DEFAULT_TOOL_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  ToolCategory.NETWORK,
]);

/** B3: 强制熔断覆盖的付费/外部 API 工具 */
const PAID_EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'image_generate',
  'tts_speak',
  'web_search',
]);

/** B2: 自愈动作枚举（参数修正 → 替代工具 → 降级） */
export enum ToolHealAction {
  PARAM_FIX = 'param_fix',
  ALT_TOOL = 'alt_tool',
  DEGRADE = 'degrade',
  NONE = 'none',
}

/** B2: 自愈处理器签名（由 Python 后端经 bridge 注入） */
export type SelfHealHandler = (ctx: {
  toolName: string;
  params: Record<string, unknown>;
  lastError: string;
  context: ToolContext;
}) => Promise<{
  action: ToolHealAction;
  params?: Record<string, unknown>;
  alternativeTool?: string;
}>;

/** 发现的工具描述 */
export interface DiscoveredTool {
  name: string;
  command: string;
  description: string;
  version?: string;
  category: ToolCategory;
  parameters: Array<{
    name: string;
    description: string;
    required: boolean;
    type: 'string' | 'number' | 'boolean';
  }>;
  examples: string[];
  riskLevel: RiskLevel;
  lastDiscovered: number;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  /** toOpenAITools() 缓存 */
  private cachedOpenAITools: OpenAIToolDef[] | null = null;
  /** Schema 验证器（P0-1: 参数校验接入执行链路） */
  private schemaValidator: SchemaValidator = new SchemaValidator();
  /** 权限守卫（P0-2: 权限检查接入执行链路） */
  private permissionGuard: PermissionGuard = new PermissionGuard();
  /** 是否启用执行前置校验（默认 true，生产环境可按需关闭） */
  private enablePreChecks: boolean = true;

  // P2-4: 工具熔断器（Circuit Breaker）
  private static readonly CB_FAILURE_THRESHOLD = 5;
  private static readonly CB_RESET_TIMEOUT_MS = 60_000;
  private runtimeState: ToolRuntimeState = new InMemoryToolRuntimeState();

  // C1: 统一结果缓存/去重/限速守卫（复用既有 ToolCallGuard；此前为死代码未接线）。
  // 仅对幂等且属 NETWORK/FILE/MEMORY 类的工具生效（逻辑在 execute 内按工具判定）。
  private callGuard = new ToolCallGuard();

  // B2: 自愈处理器（由 Python 后端经 bridge 注入；默认无 → 诚实失败）
  private selfHealHandler: SelfHealHandler | null = null;

  // C2: 每-agent 并发信号量（默认 4）
  private static readonly MAX_CONCURRENT_TOOLS = (() => {
    const v = parseInt(process.env['TOOL_MAX_CONCURRENT'] || '4', 10);
    return Number.isFinite(v) && v > 0 ? v : 4;
  })();

  private metadataEnhancer: ToolMetadataEnhancer = new ToolMetadataEnhancer();

  /**
   * 注册工具
   */
  register(
    definition: ToolDefinition,
    execute: (
      params: Record<string, unknown>,
      context: ToolContext
    ) => Promise<ToolResult>
  ): void {
    if (this.tools.has(definition.name)) {
      Logger.debug(
        `工具已存在，跳过重复注册: ${definition.name}`,
        'ToolRegistry'
      );
      return;
    }

    this.tools.set(definition.name, { definition, execute });
    this.cachedOpenAITools = null;

    this.metadataEnhancer.registerTool(definition);

    Logger.info(
      `🔧 注册工具: ${definition.name} [${definition.category}] 风险=${definition.riskLevel}`,
      'ToolRegistry'
    );
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.cachedOpenAITools = null;
      this.metadataEnhancer.unregisterTool(name);
      Logger.info(`🔧 注销工具: ${name}`, 'ToolRegistry');
    }
    return removed;
  }

  /**
   * 获取已注册工具
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册工具
   */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取所有已注册工具名称列表
   */
  getRegisteredToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 按分类获取工具
   */
  getByCategory(category: ToolCategory): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.category === category
    );
  }

  /**
   * 按风险等级获取工具
   */
  getByRiskLevel(riskLevel: RiskLevel): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.riskLevel === riskLevel
    );
  }

  /**
   * 按语义标签过滤工具
   */
  getByTags(tags: string[]): RegisteredTool[] {
    if (tags.length === 0) return [];
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return Array.from(this.tools.values()).filter((t) =>
      t.definition.tags?.some((tag) => tagSet.has(tag.toLowerCase()))
    );
  }

  /**
   * 按场景过滤工具
   */
  getByScene(scene: string): RegisteredTool[] {
    const s = scene.toLowerCase();
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.scenes?.some((sc) => sc.toLowerCase() === s) ?? false
    );
  }

  /**
   * 按能力等级过滤（渐进式披露）
   * @param maxLevel 最大暴露等级 (1-3)
   */
  getByCapabilityLevel(maxLevel: 1 | 2 | 3): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => (t.definition.capabilityLevel ?? 1) <= maxLevel
    );
  }

  /**
   * 多条件组合过滤：标签 + 场景 + 能力等级
   * 返回的交集满足所有非空条件
   */
  filterBy({
    tags,
    scene,
    maxCapabilityLevel,
    excludeCategories,
  }: {
    tags?: string[];
    scene?: string;
    maxCapabilityLevel?: 1 | 2 | 3;
    excludeCategories?: ToolCategory[];
  }): RegisteredTool[] {
    let results = Array.from(this.tools.values());

    if (tags && tags.length > 0) {
      const tagSet = new Set(tags.map((t) => t.toLowerCase()));
      results = results.filter((t) =>
        t.definition.tags?.some((tag) => tagSet.has(tag.toLowerCase()))
      );
    }

    if (scene) {
      const s = scene.toLowerCase();
      results = results.filter(
        (t) =>
          t.definition.scenes?.some((sc) => sc.toLowerCase() === s) ?? false
      );
    }

    if (maxCapabilityLevel) {
      results = results.filter(
        (t) => (t.definition.capabilityLevel ?? 1) <= maxCapabilityLevel
      );
    }

    if (excludeCategories && excludeCategories.length > 0) {
      const catSet = new Set(excludeCategories);
      results = results.filter((t) => !catSet.has(t.definition.category));
    }

    return results;
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 执行工具调用
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `工具不存在: ${name}`,
        duration: 0,
        validated: false,
      };
    }

    const startTime = Date.now();

    // P2-4: 熔断器检查 — 工具连续失败超过阈值时自动熔断
    const cbState = this.runtimeState.getCircuitBreaker(name);
    if (cbState && cbState.state === 'open') {
      const elapsed = Date.now() - cbState.lastFailureTime;
      if (elapsed < ToolRegistry.CB_RESET_TIMEOUT_MS) {
        Logger.warn(
          `⚡ P2-4: 工具 ${name} 已熔断 (连续失败 ${cbState.failureCount} 次，${Math.ceil((ToolRegistry.CB_RESET_TIMEOUT_MS - elapsed) / 1000)}s 后半开)`,
          'ToolRegistry'
        );
        return {
          success: false,
          output: null,
          error: `工具 ${name} 已熔断，请稍后重试`,
          duration: 0,
          validated: false,
        };
      }
      cbState.state = 'half-open';
      Logger.info(
        `⚡ P2-4: 工具 ${name} 进入半开状态，尝试恢复`,
        'ToolRegistry'
      );
    }

    // P0-1: Schema 参数验证 — 前置拦截非法/缺失参数
    if (this.enablePreChecks) {
      const schemaResult = this.schemaValidator.validate(
        params,
        tool.definition.parameters,
        tool.definition.requiredParams
      );
      if (!schemaResult.valid) {
        Logger.warn(
          `🛡️ Schema 验证拒绝: ${name} — ${schemaResult.errors.join('; ')}`,
          'ToolRegistry'
        );
        return {
          success: false,
          output: null,
          error: `参数验证失败: ${schemaResult.errors.join('; ')}`,
          duration: Date.now() - startTime,
          validated: false,
          metadata: { schemaErrors: schemaResult.errors },
        };
      }
    }

    // P0-2: 权限检查 — 前置拦截无权限调用
    // 注意：permResult 必须在外层声明（此前为 if 块内 const，导致 permission-less
    // 工具在第 404 行引用未定义变量抛 ReferenceError，使 execute 直接崩溃）。
    let permResult:
      | {
          allowed: boolean;
          reason?: string;
          policy?: string;
          needsConfirmation?: boolean;
          missing?: unknown;
        }
      | undefined;
    if (
      this.enablePreChecks &&
      tool.definition.requiredPermissions.length > 0
    ) {
      permResult = this.permissionGuard.check(
        name,
        tool.definition.requiredPermissions as Permission[],
        tool.definition.riskLevel,
        context
      ) as
        | {
            allowed: boolean;
            reason?: string;
            policy?: string;
            needsConfirmation?: boolean;
            missing?: unknown;
          }
        | undefined;
      if (permResult && !permResult.allowed) {
        Logger.warn(
          `🚫 权限拒绝: ${name} — ${permResult.reason}`,
          'ToolRegistry'
        );
        return {
          success: false,
          output: null,
          error: permResult.reason || `权限不足: ${name}`,
          duration: Date.now() - startTime,
          validated: false,
          metadata: {
            missingPermissions: permResult.missing,
            policy: permResult.policy,
          },
        };
      }
    }

    // P0-2: 执行层审批强制 — 当权限检查要求人工确认（ask 策略或 high/critical 风险）
    // 时，调用 ApprovalEngine 进行审批。smart/auto 模式对低/中风险自动放行，
    // high/critical 或无可用审批方时 fail-closed 拒绝执行，杜绝此前 needsConfirmation
    // 被计算却从未强制执行的安全缺口。
    if (this.enablePreChecks && permResult?.needsConfirmation) {
      const decision = await this.requestApprovalForTool(
        name,
        tool,
        params,
        context,
        permResult.reason
      );
      if (!decision.approved) {
        Logger.warn(
          `🔒 审批拒绝: ${name} (${decision.method}) — ${decision.reason}`,
          'ToolRegistry'
        );
        return {
          success: false,
          output: null,
          error: `操作未获批准: ${decision.reason || '审批被拒绝'}`,
          duration: Date.now() - startTime,
          validated: false,
          metadata: {
            approvalMethod: decision.method,
            policy: permResult.policy,
          },
        };
      }
    }

    // C1: 统一结果缓存 / 去重 / 限速（D4 统一门禁的一部分）。
    // 仅对幂等且属 NETWORK/FILE/MEMORY 类的工具生效（审计要求缓存 web_fetch/file_read/search 类），
    // 排除 result_cache 自身以免自递归。命中即短路返回，避免重复外部调用与费用。
    if (tool.definition.idempotent && name !== 'result_cache') {
      const cat = tool.definition.category;
      const c1Eligible =
        cat === ToolCategory.NETWORK ||
        cat === ToolCategory.FILE ||
        cat === ToolCategory.MEMORY;
      if (c1Eligible) {
        const g = await this.callGuard.guard(name, params);
        if (g.blocked && g.result) {
          const cached: ToolResult = {
            ...g.result,
            duration: Date.now() - startTime,
            validated: g.result.validated ?? false,
          };
          this.standardizeToolResult(cached, name);
          this.truncateToolOutput(cached);
          this.recordCapability(name, cat, true);
          return cached;
        }
      }
    }

    // C2: 付费/外部 API 工具 — 并发配额 + 去重（熔断 B3 已在执行链路覆盖）
    if (PAID_EXTERNAL_TOOLS.has(name)) {
      const quota = this.checkQuota(name, context);
      if (!quota.allowed) {
        Logger.warn(`💰 C2: ${quota.reason}`, 'ToolRegistry');
        return {
          success: false,
          output: null,
          error: quota.reason || `会话配额已耗尽: ${name}`,
          duration: Date.now() - startTime,
          validated: false,
          metadata: { quotaExceeded: true },
        };
      }
      const dKey = this.dedupKey(name, params);
      const cached = this.runtimeState.getDedupResult(dKey);
      if (cached) {
        Logger.info(`♻️ C2: ${name} 命中去重缓存，直接返回`, 'ToolRegistry');
        const deduped: ToolResult = {
          ...cached,
          duration: Date.now() - startTime,
          metadata: { ...(cached.metadata || {}), dedupHit: true },
        };
        this.truncateToolOutput(deduped);
        return deduped;
      }
    }

    // C2: 获取每-agent 并发信号量（默认 4），执行后释放
    const releaseSem = await this.acquireSemaphore(this.agentKey(context));
    try {
      Logger.info(
        `🧠 执行工具: ${name} | 风险=${tool.definition.riskLevel}`,
        'ToolRegistry'
      );

      // B1: 最大重试次数（网络/LLM 类默认 3，其他默认 0；env 可覆盖；上限 3）
      const maxRetries = this.computeMaxRetries(name, tool.definition.category);
      const baseDelay = parseFloat(
        process.env['TOOL_RETRY_BASE_DELAY'] || '0.5'
      );
      const maxDelay = parseFloat(process.env['TOOL_RETRY_MAX_DELAY'] || '30');

      let lastResult: ToolResult | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const attemptResult = await this.runSingleAttempt(
          name,
          params,
          context
        );
        lastResult = attemptResult;

        if (attemptResult.success) {
          // C2: 付费工具成功 → 计配额 + 写去重缓存
          this.afterPaidSuccess(name, params, context, attemptResult);
          return attemptResult;
        }

        // 已达最大重试次数 → 交由自愈/原失败返回
        if (attempt === maxRetries) break;

        // B1: 仅对瞬时可重试错误（429/5xx/ETIMEDOUT/网络抖动）重试，其他立即终止
        if (!this.isRetryableError(attemptResult.error)) {
          Logger.info(
            `🚫 B1: ${name} 错误不可重试，停止重试: ${attemptResult.error}`,
            'ToolRegistry'
          );
          break;
        }

        // P1-4: full jitter 指数退避
        const rawDelay = baseDelay * Math.pow(2, attempt);
        const cappedDelay = Math.min(maxDelay, rawDelay);
        const jitteredDelay = Math.random() * cappedDelay;
        Logger.info(
          `🔄 P1-4: 工具 ${name} 第 ${attempt + 1} 次重试 (延迟=${jitteredDelay.toFixed(2)}s)`,
          'ToolRegistry'
        );
        await new Promise((r) => setTimeout(r, jitteredDelay * 1000));
      }

      // B2: 自愈接入（Python 经 bridge 注入；未注入则诚实返回原失败）
      return this.maybeSelfHeal(name, params, context, lastResult!);
    } finally {
      releaseSem();
    }
  }

  /**
   * 执行 LLM 返回的 tool call
   */
  async executeToolCall(
    toolCall: {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    },
    context: ToolContext
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    return this.execute(toolName, args, context);
  }

  /**
   * 转换为 OpenAI Function Calling 工具格式
   * 进化闭环：按综合评分排序（成功率 × 进化权重），权重差异注入 description
   */
  toOpenAITools(): OpenAIToolDef[] {
    if (this.cachedOpenAITools) return this.cachedOpenAITools;

    const tools: OpenAIToolDef[] = [];

    const categoryOrder: ToolCategory[] = [
      ToolCategory.COGNITION,
      ToolCategory.MEMORY,
      ToolCategory.DAILY,
      ToolCategory.NETWORK,
      ToolCategory.SYSTEM,
      ToolCategory.FILE,
      ToolCategory.CODE,
      ToolCategory.DESKTOP,
    ];

    const sorted = Array.from(this.tools.values()).sort((a, b) => {
      const ai = categoryOrder.indexOf(a.definition.category);
      const bi = categoryOrder.indexOf(b.definition.category);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);

      const scoreA = this.reliabilityTracker.getCompositeScore(
        a.definition.name
      );
      const scoreB = this.reliabilityTracker.getCompositeScore(
        b.definition.name
      );
      return scoreB - scoreA;
    });

    const avgCompositeScore =
      sorted.length > 0
        ? sorted.reduce(
            (sum, t) =>
              sum +
              this.reliabilityTracker.getCompositeScore(t.definition.name),
            0
          ) / sorted.length
        : 1.0;

    for (const tool of sorted) {
      const properties: Record<string, unknown> = {};
      for (const [paramName, paramDef] of Object.entries(
        tool.definition.parameters
      )) {
        properties[paramName] = this.parameterDefToOpenAI(paramDef);
      }

      const compositeScore = this.reliabilityTracker.getCompositeScore(
        tool.definition.name
      );
      const evolutionWeight = this.reliabilityTracker.getEvolutionWeight(
        tool.definition.name
      );
      let description = tool.definition.description;

      if (evolutionWeight !== 1.0 || compositeScore < avgCompositeScore * 0.8) {
        if (evolutionWeight > 1.0) {
          description += ` [推荐:进化权重${evolutionWeight.toFixed(2)}]`;
        } else if (evolutionWeight < 1.0) {
          description += ` [慎用:进化权重${evolutionWeight.toFixed(2)}]`;
        }
        if (compositeScore < 0.5) {
          description += ` [低可靠度:${(compositeScore * 100).toFixed(0)}%]`;
        }
      }

      tools.push({
        type: 'function',
        function: {
          name: tool.definition.name,
          description,
          parameters: {
            type: 'object',
            properties,
            required: tool.definition.requiredParams,
          },
        },
      });
    }

    this.cachedOpenAITools = tools;
    return tools;
  }

  /**
   * 将 ToolParameterDef 转换为 OpenAI Schema 格式
   */
  private parameterDefToOpenAI(
    param: ToolParameterDef
  ): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };

    if (param.enum) {
      schema.enum = param.enum;
    }

    if (param.default !== undefined) {
      schema.default = param.default;
    }

    if (param.type === 'array' && param.items) {
      schema.items = this.parameterDefToOpenAI(param.items);
    }

    if (param.type === 'object' && param.properties) {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(param.properties)) {
        props[key] = this.parameterDefToOpenAI(val);
      }
      schema.properties = props;
    }

    return schema;
  }

  /**
   * 创建超时 Promise
   */
  private createTimeoutPromise(
    timeoutMs: number,
    toolName: string
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`工具执行超时: ${toolName} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  /**
   * 清除缓存（注册/注销后自动调用，也可手动调用）
   */
  invalidateCache(): void {
    this.cachedOpenAITools = null;
  }

  private reliabilityTracker = new ToolReliabilityTracker();

  /**
   * 获取工具可靠性追踪器
   */
  getReliabilityTracker(): ToolReliabilityTracker {
    return this.reliabilityTracker;
  }

  /**
   * 获取 Schema 验证器
   */
  getSchemaValidator(): SchemaValidator {
    return this.schemaValidator;
  }

  /**
   * 获取权限守卫
   */
  getPermissionGuard(): PermissionGuard {
    return this.permissionGuard;
  }

  /**
   * 注入外部 SchemaValidator（覆盖默认实例）
   */
  setSchemaValidator(validator: SchemaValidator): void {
    this.schemaValidator = validator;
  }

  /**
   * 注入外部 PermissionGuard（覆盖默认实例）
   */
  setPermissionGuard(guard: PermissionGuard): void {
    this.permissionGuard = guard;
  }

  /**
   * 启用/禁用执行前置校验（Schema + Permission）
   * 生产环境调试时可临时关闭
   */
  setPreChecksEnabled(enabled: boolean): void {
    this.enablePreChecks = enabled;
    Logger.info(
      `🛡️ 执行前置校验: ${enabled ? '已启用' : '已禁用'}`,
      'ToolRegistry'
    );
  }

  /**
   * P2-4: 更新熔断器状态
   *
   * - 成功执行：半开→关闭（恢复），关闭→重置失败计数
   * - 失败执行：累计失败计数，达到阈值→打开（熔断）
   */
  private updateCircuitBreaker(toolName: string, success: boolean): void {
    let state = this.runtimeState.getCircuitBreaker(toolName);
    if (!state) {
      state = { state: 'closed', failureCount: 0, lastFailureTime: 0 };
      this.runtimeState.setCircuitBreaker(toolName, state);
    }

    if (success) {
      if (state.state === 'half-open') {
        state.state = 'closed';
        state.failureCount = 0;
        Logger.info(
          `⚡ P2-4: 工具 ${toolName} 恢复正常，熔断器关闭`,
          'ToolRegistry'
        );
      } else if (state.state === 'closed') {
        state.failureCount = 0;
      }
    } else {
      state.failureCount++;
      state.lastFailureTime = Date.now();
      if (
        state.state === 'half-open' ||
        (state.state === 'closed' &&
          state.failureCount >= ToolRegistry.CB_FAILURE_THRESHOLD)
      ) {
        state.state = 'open';
        Logger.error(
          `⚡ P2-4: 工具 ${toolName} 连续失败 ${state.failureCount} 次，熔断器打开`,
          undefined,
          'ToolRegistry'
        );
      }
    }
  }

  /**
   * P2-4: 获取工具熔断器状态（用于监控/诊断）
   */
  getCircuitBreakerState(toolName: string): CircuitBreakerState | undefined {
    return this.runtimeState.getCircuitBreaker(toolName);
  }

  /**
   * P2-4: 手动重置工具熔断器（运维操作）
   */
  resetCircuitBreaker(toolName: string): boolean {
    const state = this.runtimeState.getCircuitBreaker(toolName);
    if (state) {
      state.state = 'closed';
      state.failureCount = 0;
      state.lastFailureTime = 0;
      Logger.info(`⚡ P2-4: 工具 ${toolName} 熔断器已手动重置`, 'ToolRegistry');
      return true;
    }
    return false;
  }

  /**
   * B1: 计算单工具最大重试次数
   * - 网络/LLM 类工具默认 3 次；其他默认 0（不重试）
   * - 环境变量 TOOL_RETRY_<name> / TOOL_RETRY_DEFAULT 可覆盖
   * - 上限 3（B1 约束）
   */
  private computeMaxRetries(name: string, category: ToolCategory): number {
    const envRaw =
      process.env[`TOOL_RETRY_${name}`] ?? process.env['TOOL_RETRY_DEFAULT'];
    const envMax = envRaw !== undefined ? parseInt(envRaw, 10) : NaN;
    const defaultMax = RETRY_DEFAULT_TOOL_CATEGORIES.has(category) ? 3 : 0;
    const max = Number.isFinite(envMax) && envMax >= 0 ? envMax : defaultMax;
    return Math.min(max, 3);
  }

  /**
   * B1: 瞬时可重试错误判定（429/5xx/ETIMEDOUT/网络抖动）
   */
  private isRetryableError(error?: string): boolean {
    if (!error) return false;
    return RETRYABLE_ERROR_RE.test(error);
  }

  /**
   * 单次执行尝试（含超时竞速 + 标准化 + 可靠性记录 + 熔断更新）。
   * 任何异常都被捕获为失败 ToolResult，绝不向外抛出。
   */
  private async runSingleAttempt(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `工具不存在: ${name}`,
        duration: 0,
        validated: false,
      };
    }
    const startTime = Date.now();
    try {
      const result = await perf.measure(
        `tool.${name}`,
        () =>
          Promise.race([
            tool.execute(params, context),
            this.createTimeoutPromise(tool.definition.timeout, name),
          ]),
        'tool'
      );
      const finalResult: ToolResult = {
        ...result,
        duration: Date.now() - startTime,
        validated: result.validated ?? false,
      };
      this.standardizeToolResult(finalResult, name);
      this.reliabilityTracker.recordCall(
        name,
        finalResult.success,
        finalResult.duration,
        finalResult.error
      );
      // P2-4: 熔断状态更新（成功/失败均更新）
      this.updateCircuitBreaker(name, finalResult.success);
      // C3: 包装层输出截断（保护上下文窗口，填充 truncation 元数据）
      this.truncateToolOutput(finalResult);
      // D4: 能力指标观测（此前 capMetrics 零调用，现按工具类别记录）
      this.recordCapability(
        name,
        tool.definition.category,
        finalResult.success
      );
      // D2: 认知类工具完成后回灌认知总线（情绪/反思总线），供 ReAct 循环消费
      if (tool.definition.category === ToolCategory.COGNITION) {
        // D2: 从 ToolContext 捕获会话标识, 便于转发到对应 Python 会话(缺失则 null, 诚实降级不转发)
        const sessionId =
          context.sessionId ??
          (context.metadata?.sessionId as string | undefined) ??
          null;
        EventBus.emit('cognition_result', {
          tool: name,
          category: tool.definition.category,
          success: finalResult.success,
          durationMs: finalResult.duration,
          outputPreview:
            typeof finalResult.output === 'string'
              ? finalResult.output.slice(0, 200)
              : null,
          error: finalResult.error ?? null,
          timestamp: new Date().toISOString(),
          sessionId,
        });
      }
      // C1: 幂等外部工具成功 → 写入统一结果缓存（TTL 5min，去重窗口 30s）
      if (
        finalResult.success &&
        tool.definition.idempotent &&
        name !== 'result_cache'
      ) {
        const cat = tool.definition.category;
        if (
          cat === ToolCategory.NETWORK ||
          cat === ToolCategory.FILE ||
          cat === ToolCategory.MEMORY
        ) {
          this.callGuard.record(name, params, finalResult);
        }
      }
      return finalResult;
    } catch (err) {
      const errorResult: ToolResult = {
        success: false,
        output: null,
        error: (err as Error).message,
        duration: Date.now() - startTime,
        validated: false,
      };
      this.standardizeToolResult(errorResult, name);
      this.reliabilityTracker.recordCall(
        name,
        false,
        errorResult.duration,
        errorResult.error
      );
      // B3: 抛出异常也计入熔断（此前仅成功路径更新，吞噬型异常会绕过熔断）
      this.updateCircuitBreaker(name, false);
      return errorResult;
    }
  }

  /**
   * B2: 自愈接入。仅当存在注入的自愈处理器（Python bridge）时尝试：
   * 参数修正(PARAM_FIX) → 替代工具(ALT_TOOL) → 降级(DEGRADE)。
   * 未注入或自愈失败 → 诚实返回原失败（不假成功）。
   */
  private async maybeSelfHeal(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
    failed: ToolResult
  ): Promise<ToolResult> {
    if (failed.success || !this.selfHealHandler) return failed;
    try {
      const heal = await this.selfHealHandler({
        toolName: name,
        params,
        lastError: failed.error || '',
        context,
      });
      if (heal.action === ToolHealAction.PARAM_FIX && heal.params) {
        Logger.info(`🩹 B2: ${name} 参数修正后重试一次`, 'ToolRegistry');
        const r = await this.runSingleAttempt(name, heal.params, context);
        return {
          ...r,
          metadata: { ...(r.metadata || {}), healed: ToolHealAction.PARAM_FIX },
        };
      }
      if (heal.action === ToolHealAction.ALT_TOOL && heal.alternativeTool) {
        Logger.info(
          `🩹 B2: ${name} 降级至替代工具 ${heal.alternativeTool}`,
          'ToolRegistry'
        );
        return this.execute(
          heal.alternativeTool,
          heal.params ?? params,
          context
        );
      }
      if (heal.action === ToolHealAction.DEGRADE) {
        Logger.warn(`🩹 B2: ${name} 降级执行（部分能力可用）`, 'ToolRegistry');
        return {
          ...failed,
          success: true,
          error: undefined,
          metadata: {
            ...(failed.metadata || {}),
            healed: ToolHealAction.DEGRADE,
            degraded: true,
          },
        };
      }
    } catch (e) {
      Logger.warn(
        `🩹 B2: 自愈处理异常 ${name}: ${(e as Error).message}`,
        'ToolRegistry'
      );
    }
    return failed;
  }

  /**
   * B2: 注入自愈处理器（由 Python 后端经 bridge 注册；传入 null 关闭）。
   */
  setSelfHealHandler(handler: SelfHealHandler | null): void {
    this.selfHealHandler = handler;
  }

  setRuntimeState(state: ToolRuntimeState): void {
    this.runtimeState = state;
  }

  // ---- C2: 并发配额 / 每日配额 / 去重 ----

  private sessionKey(context: ToolContext): string {
    const m = context.metadata || {};
    return (
      (m.sessionId as string) || context.userId || context.traceId || 'default'
    );
  }

  private agentKey(context: ToolContext): string {
    const m = context.metadata || {};
    return (m.agentId as string) || 'default';
  }

  /**
   * C2: 每-agent 信号量（默认 4 并发），返回释放函数。
   */
  private async acquireSemaphore(agentKey: string): Promise<() => void> {
    let sem = this.runtimeState.getSemaphore(agentKey);
    if (!sem) {
      sem = { permits: ToolRegistry.MAX_CONCURRENT_TOOLS, waiters: [] };
      this.runtimeState.setSemaphore(agentKey, sem);
    }
    if (sem.permits > 0) {
      sem.permits--;
      return () => this.releaseSemaphore(agentKey);
    }
    return new Promise((resolve) => {
      sem!.waiters.push(() => {
        sem!.permits--;
        resolve(() => this.releaseSemaphore(agentKey));
      });
    });
  }

  private releaseSemaphore(agentKey: string): void {
    const sem = this.runtimeState.getSemaphore(agentKey);
    if (!sem) return;
    if (sem.waiters.length > 0) {
      const w = sem.waiters.shift()!;
      w();
    } else {
      sem.permits++;
    }
  }

  /**
   * C2: 检查付费工具会话级每日配额（默认 50/天，env 可覆盖）。
   */
  private checkQuota(
    toolName: string,
    context: ToolContext
  ): { allowed: boolean; reason?: string } {
    if (!PAID_EXTERNAL_TOOLS.has(toolName)) return { allowed: true };
    const sessionKey = this.sessionKey(context);
    const today = new Date().toISOString().slice(0, 10);
    const key = `${sessionKey}:${toolName}`;
    const rawLimit =
      process.env[`TOOL_QUOTA_${toolName}`] ||
      process.env['TOOL_QUOTA_DEFAULT'] ||
      '50';
    // 防御：环境变量为非数字时 parseInt 返回 NaN，而 `count >= NaN` 恒为 false，
    // 会导致付费工具配额检查被静默绕过（任意调用都被放行）。NaN 时回退默认 50。
    const parsedLimit = parseInt(rawLimit, 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const rec = this.runtimeState.getQuota(key);
    if (rec && rec.date === today && rec.count >= limit) {
      return {
        allowed: false,
        reason: `会话 ${sessionKey} 的 ${toolName} 已达每日配额 ${limit}`,
      };
    }
    return { allowed: true };
  }

  private bumpQuota(toolName: string, context: ToolContext): void {
    if (!PAID_EXTERNAL_TOOLS.has(toolName)) return;
    const sessionKey = this.sessionKey(context);
    const today = new Date().toISOString().slice(0, 10);
    const key = `${sessionKey}:${toolName}`;
    const rec = this.runtimeState.getQuota(key);
    if (rec && rec.date === today) rec.count++;
    else this.runtimeState.setQuota(key, { date: today, count: 1 });
  }

  /**
   * C2: 付费工具成功后计配额 + 写去重缓存（按 日期+工具+参数哈希）。
   */
  private afterPaidSuccess(
    toolName: string,
    params: Record<string, unknown>,
    context: ToolContext,
    result: ToolResult
  ): void {
    if (!PAID_EXTERNAL_TOOLS.has(toolName)) return;
    this.bumpQuota(toolName, context);
    const dKey = this.dedupKey(toolName, params);
    this.runtimeState.setDedupResult(dKey, result);
  }

  private dedupKey(toolName: string, params: Record<string, unknown>): string {
    const today = new Date().toISOString().slice(0, 10);
    const hash = createHash('sha256')
      .update(JSON.stringify(params))
      .digest('hex')
      .slice(0, 16);
    return `${today}:${toolName}:${hash}`;
  }

  /**
   * 为需要确认的工具调用发起审批（P0-2: 执行层审批强制）。
   * 失败时 fail-closed 返回未批准，确保不绕过审批直接执行。
   */
  private async requestApprovalForTool(
    name: string,
    tool: RegisteredTool,
    params: Record<string, unknown>,
    context: ToolContext,
    reason?: string
  ): Promise<ApprovalDecision> {
    try {
      const engine = getApprovalEngine();
      return await engine.requestApproval({
        type: this.mapToolToApprovalType(name),
        description: reason || `执行工具 ${name}`,
        target: this.extractApprovalTarget(name, params),
        risk: tool.definition.riskLevel,
        params,
        traceId: context.traceId,
        userId: (context as { userId?: string }).userId,
      });
    } catch (err) {
      Logger.error(
        '❌ ApprovalEngine 调用失败，fail-closed 拒绝执行',
        err as Error,
        'ToolRegistry'
      );
      return {
        approved: false,
        method: 'deny',
        reason: '审批引擎不可用（fail-closed）',
        timestamp: Date.now(),
      };
    }
  }

  /** 工具名 → 审批类型映射 */
  private mapToolToApprovalType(name: string): ApprovalType {
    if (name === 'shell_exec' || name === 'desktop_automate')
      return 'shell_exec';
    if (name === 'multi_file_edit') return 'multi_file_edit';
    if (name === 'file_write' || name === 'file_edit') return 'file_write';
    if (name === 'file_delete') return 'file_delete';
    if (name.startsWith('web_')) return 'network_request';
    return 'shell_exec';
  }

  /** 从参数中提取审批目标（命令 / URL / 路径） */
  private extractApprovalTarget(
    name: string,
    params: Record<string, unknown>
  ): string {
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = params[k];
        if (typeof v === 'string') return v;
      }
      return undefined;
    };
    if (name === 'shell_exec') {
      return (
        pick('command', 'cmd', 'args') || JSON.stringify(params).slice(0, 200)
      );
    }
    if (name === 'web_fetch' || name === 'web_search') {
      return pick('url', 'query') || name;
    }
    return pick('file_path', 'path', 'directory', 'target') || name;
  }

  // ==================== Harness Engineering: 输出标准化 ====================

  /**
   * 标准化工具执行结果
   * 借鉴 Hashline 格式：为输出添加行号+内容哈希锚点
   * 让 LLM 能精确引用工具输出的特定行/段
   *
   * @param result - 工具执行结果（会被原地修改）
   * @param toolName - 工具名称（用于判断输出类型）
   */
  /**
   * C3: 包装层输出截断 — 防止 web_fetch/file_read/大响应撑爆上下文窗口。
   * 按 env TOOL_OUTPUT_MAX_CHARS（默认 8000 字符）截断 output，
   * 填充 types.ts 的 truncation 元数据（metadata 为 Record<string, unknown>）。
   */
  private truncateToolOutput(result: ToolResult): void {
    if (result.output == null) return;
    const parsedChars = parseInt(
      process.env['TOOL_OUTPUT_MAX_CHARS'] || '8000',
      10
    );
    // 环境变量为非数字时 parseInt 返回 NaN，`output.length > NaN` 恒为 false，
    // 会导致输出截断被静默跳过。NaN 时回退默认 8000。
    const maxChars = Number.isFinite(parsedChars) ? parsedChars : 8000;
    if (typeof result.output === 'string') {
      if (result.output.length > maxChars) {
        const originalLength = result.output.length;
        result.output = result.output.slice(0, maxChars) + '\n...[输出已截断]';
        result.metadata = result.metadata || {};
        result.metadata.truncation = {
          truncated: true,
          truncatedLength: maxChars,
          originalLength,
        };
      }
    } else if (typeof result.output === 'object') {
      // 对象型输出仅记录超限标记，不破坏结构
      const serialized = JSON.stringify(result.output);
      if (serialized.length > maxChars) {
        result.metadata = result.metadata || {};
        result.metadata.truncation = {
          truncated: true,
          truncatedLength: maxChars,
          originalLength: serialized.length,
        };
      }
    }
  }

  /**
   * D4: 能力指标观测 — 按工具类别记录能力成功/失败，激活此前零调用的 CapabilityMetrics。
   */
  private recordCapability(
    toolName: string,
    category: ToolCategory,
    success: boolean
  ): void {
    try {
      capMetrics.record(category, success);
    } catch (err) {
      Logger.debug(
        `⚠️ D4: capMetrics 记录失败 (${toolName}): ${(err as Error).message}`,
        'ToolRegistry'
      );
    }
  }

  private standardizeToolResult(result: ToolResult, toolName: string): void {
    // 如果工具已经提供了 structuredOutput，跳过自动标准化
    if (result.structuredOutput) return;

    const output = result.output;

    // 生成内容哈希锚点
    result.contentHash = this.computeContentHash(output);

    // 根据工具类型和输出内容推断结构化类型
    const structuredType = this.inferOutputType(toolName, output);

    // 将 output 转为字符串
    const contentStr = this.outputToString(output);
    if (!contentStr) {
      result.structuredOutput = {
        type: result.success ? 'text' : 'error',
        content: result.success ? '(无输出)' : result.error || '未知错误',
      };
      return;
    }

    // 生成带锚点的行内容（Hashline 格式）
    const lines = contentStr.split('\n');
    const anchoredLines = lines.slice(0, 200).map((line, index) => ({
      line: index + 1,
      hash: this.computeLineHash(line),
      content: line,
    }));

    // 生成摘要（前5行 + 总行数）
    const summaryLines = lines.slice(0, 5);
    const summary =
      summaryLines.join('\n') +
      (lines.length > 5 ? `\n... (共${lines.length}行)` : '');

    // 截断信息
    const truncation =
      contentStr.length > 50000
        ? {
            truncated: true,
            originalLength: contentStr.length,
            truncatedLength: 50000,
          }
        : undefined;

    result.structuredOutput = {
      type: structuredType,
      content:
        contentStr.length > 50000
          ? contentStr.substring(0, 50000) + '\n... (内容已截断)'
          : contentStr,
      summary,
      anchoredLines,
      totalLines: lines.length,
      truncation,
      schemaType: this.inferSchemaType(toolName),
    };
  }

  /**
   * 推断输出类型
   */
  private inferOutputType(
    toolName: string,
    output: unknown
  ): StructuredToolOutput['type'] {
    if (!output) return 'text';

    // 文件类工具 → file_content
    if (toolName.startsWith('file_')) return 'file_content';

    // 列表类工具 → list
    if (Array.isArray(output)) return 'list';

    // JSON 对象 → json
    if (typeof output === 'object' && output !== null) {
      try {
        JSON.stringify(output);
        return 'json';
      } catch {
        return 'text';
      }
    }

    return 'text';
  }

  /**
   * 推断输出 schema 类型名
   */
  private inferSchemaType(toolName: string): string {
    const schemaMap: Record<string, string> = {
      file_read: 'FileContent',
      file_list: 'DirectoryListing',
      file_search: 'SearchResults',
      file_grep: 'GrepMatches',
      web_fetch: 'WebPageContent',
      web_search: 'SearchResults',
      memory_store: 'MemoryStoreResult',
      memory_search: 'MemorySearchResults',
      memory_recall: 'MemoryRecallResults',
      code_analyze: 'CodeAnalysisResult',
      code_review: 'CodeReviewResult',
      code_generate: 'GeneratedCode',
      code_fix: 'CodeFixResult',
      shell_exec: 'ShellOutput',
      desktop_screenshot: 'ScreenshotInfo',
      desktop_automate: 'AutomationResult',
    };
    return schemaMap[toolName] || 'ToolOutput';
  }

  /**
   * 将 output 转为字符串
   */
  private outputToString(output: unknown): string {
    if (output === null || output === undefined) return '';
    if (typeof output === 'string') return output;
    if (typeof output === 'number' || typeof output === 'boolean') {
      return String(output);
    }
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }

  /**
   * 计算内容哈希（用于锚点标识）
   * 使用简单的 DJB2 哈希算法
   */
  private computeContentHash(output: unknown): string {
    const str = this.outputToString(output);
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 计算单行内容的哈希（Hashline 格式）
   */
  private computeLineHash(line: string): string {
    let hash = 5381;
    for (let i = 0; i < line.length; i++) {
      hash = ((hash << 5) + hash + line.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(16).substring(0, 8);
  }

  // ==================== Harness Engineering: 自动工具发现 ====================

  /** 已发现的系统工具缓存 */
  private discoveredTools: Map<string, DiscoveredTool> = new Map();
  /** 是否已执行过工具发现 */
  private discoveryCompleted = false;

  /**
   * 扫描系统中可用的 CLI 工具
   * 借鉴 CLI-Anything 的思路：检测已安装软件，生成标准化工具描述
   *
   * @param force - 是否强制重新扫描
   * @returns 发现的工具列表
   */
  async discoverSystemTools(force = false): Promise<DiscoveredTool[]> {
    if (this.discoveryCompleted && !force) {
      return Array.from(this.discoveredTools.values());
    }

    Logger.info('🔍 开始自动工具发现...', 'ToolRegistry');
    const startTime = Date.now();

    try {
      // 常见开发工具列表（跨平台）
      const toolCandidates = [
        { command: 'git', name: 'git', desc: '版本控制工具' },
        { command: 'npm', name: 'npm', desc: 'Node.js 包管理器' },
        { command: 'node', name: 'node', desc: 'Node.js 运行时' },
        { command: 'python3', name: 'python3', desc: 'Python 解释器' },
        { command: 'python', name: 'python', desc: 'Python 解释器' },
        { command: 'pip', name: 'pip', desc: 'Python 包管理器' },
        { command: 'docker', name: 'docker', desc: '容器运行时' },
        {
          command: 'docker-compose',
          name: 'docker-compose',
          desc: 'Docker 编排工具',
        },
        { command: 'curl', name: 'curl', desc: 'HTTP 请求工具' },
        { command: 'wget', name: 'wget', desc: '文件下载工具' },
        { command: 'grep', name: 'grep', desc: '文本搜索工具' },
        { command: 'find', name: 'find', desc: '文件查找工具' },
        { command: 'ls', name: 'ls', desc: '目录列出工具' },
        { command: 'cat', name: 'cat', desc: '文件内容查看' },
        { command: 'code', name: 'vscode', desc: 'VS Code 编辑器' },
        { command: 'java', name: 'java', desc: 'Java 运行时' },
        { command: 'mvn', name: 'maven', desc: 'Maven 构建工具' },
        { command: 'gradle', name: 'gradle', desc: 'Gradle 构建工具' },
        { command: 'go', name: 'go', desc: 'Go 工具链' },
        { command: 'rustc', name: 'rust', desc: 'Rust 编译器' },
        { command: 'cargo', name: 'cargo', desc: 'Rust 包管理器' },
        { command: 'make', name: 'make', desc: 'Make 构建工具' },
        { command: 'cmake', name: 'cmake', desc: 'CMake 构建系统' },
        { command: 'ssh', name: 'ssh', desc: 'SSH 远程连接' },
        { command: 'scp', name: 'scp', desc: 'SCP 文件传输' },
        { command: 'rsync', name: 'rsync', desc: '文件同步工具' },
        { command: 'tar', name: 'tar', desc: '归档压缩工具' },
        { command: 'unzip', name: 'unzip', desc: 'ZIP 解压工具' },
        { command: 'openssl', name: 'openssl', desc: '加密/证书工具' },
        { command: 'jq', name: 'jq', desc: 'JSON 处理工具' },
        { command: 'yq', name: 'yq', desc: 'YAML 处理工具' },
        { command: 'sed', name: 'sed', desc: '流编辑器' },
        { command: 'awk', name: 'awk', desc: '文本处理语言' },
        { command: 'wc', name: 'wc', desc: '字数统计工具' },
        { command: 'sort', name: 'sort', desc: '排序工具' },
        { command: 'head', name: 'head', desc: '查看文件头部' },
        { command: 'tail', name: 'tail', desc: '查看文件尾部' },
        { command: 'less', name: 'less', desc: '分页查看器' },
        { command: 'top', name: 'top', desc: '进程监控器' },
        { command: 'ps', name: 'ps', desc: '进程状态查看' },
        { command: 'netstat', name: 'netstat', desc: '网络状态查看' },
        { command: 'ping', name: 'ping', desc: '网络连通性测试' },
        { command: 'nslookup', name: 'nslookup', desc: 'DNS 查询工具' },
        { command: 'whois', name: 'whois', desc: '域名信息查询' },
        { command: 'ffmpeg', name: 'ffmpeg', desc: '音视频处理工具' },
        { command: 'imagemagick', name: 'imagemagick', desc: '图像处理工具' },
        { command: 'pandoc', name: 'pandoc', desc: '文档格式转换' },
        { command: 'sqlite3', name: 'sqlite3', desc: 'SQLite 数据库客户端' },
        { command: 'redis-cli', name: 'redis-cli', desc: 'Redis 客户端' },
        { command: 'mysql', name: 'mysql', desc: 'MySQL 客户端' },
        { command: 'pg_dump', name: 'pg_dump', desc: 'PostgreSQL 备份工具' },
      ];

      // 并发检测哪些工具可用
      const detectionResults = await Promise.allSettled(
        toolCandidates.map((candidate) =>
          this.detectToolAvailability(candidate)
        )
      );

      const discovered: DiscoveredTool[] = [];
      for (const result of detectionResults) {
        if (result.status === 'fulfilled' && result.value) {
          this.discoveredTools.set(result.value.name, result.value);
          discovered.push(result.value);
        }
      }

      this.discoveryCompleted = true;
      Logger.info(
        `✅ 工具发现完成: ${discovered.length} 个可用工具 (${Date.now() - startTime}ms)`,
        'ToolRegistry'
      );

      return discovered;
    } catch (error) {
      Logger.error('工具发现失败', error as Error, 'ToolRegistry');
      return [];
    }
  }

  /**
   * 检测单个工具是否可用
   */
  private async detectToolAvailability(candidate: {
    command: string;
    name: string;
    desc: string;
  }): Promise<DiscoveredTool | null> {
    try {
      const { execSync } = await import('child_process');

      // 尝试获取版本信息
      let version: string | undefined;
      try {
        const versionOutput = execSync(`${candidate.command} --version`, {
          timeout: 3000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        version = versionOutput.split('\n')[0].substring(0, 100);
      } catch {
        // 无法获取版本，但工具可能仍可用
      }

      // 确定风险等级和类别
      const dangerousCommands = new Set([
        'rm',
        'dd',
        'mkfs',
        'shutdown',
        'reboot',
        'chmod',
        'chown',
        'sudo',
        'su',
      ]);
      const networkCommands = new Set([
        'curl',
        'wget',
        'ssh',
        'scp',
        'rsync',
        'nslookup',
        'whois',
        'ping',
        'netstat',
      ]);

      const riskLevel: RiskLevel = dangerousCommands.has(candidate.command)
        ? 'critical'
        : networkCommands.has(candidate.command)
          ? 'medium'
          : 'low';

      const category = networkCommands.has(candidate.command)
        ? ToolCategory.NETWORK
        : candidate.command === 'git'
          ? ToolCategory.CODE
          : ToolCategory.SYSTEM;

      return {
        name: candidate.name,
        command: candidate.command,
        description: candidate.desc,
        version,
        category,
        parameters: this.inferParameters(candidate.command),
        examples: this.generateExamples(candidate.command),
        riskLevel,
        lastDiscovered: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 根据命令名推断常用参数
   */
  private inferParameters(command: string): Array<{
    name: string;
    description: string;
    required: boolean;
    type: 'string' | 'number' | 'boolean';
  }> {
    const commonParams = [
      {
        name: 'args',
        description: `${command} 命令参数`,
        required: true,
        type: 'string' as const,
      },
    ];

    const paramMap: Record<
      string,
      Array<{
        name: string;
        description: string;
        required: boolean;
        type: 'string' | 'number' | 'boolean';
      }>
    > = {
      git: [
        {
          name: 'args',
          description: 'Git 命令参数',
          required: true,
          type: 'string',
        },
      ],
      npm: [
        {
          name: 'args',
          description: 'NPM 命令参数',
          required: true,
          type: 'string',
        },
      ],
      docker: [
        {
          name: 'args',
          description: 'Docker 命令参数',
          required: true,
          type: 'string',
        },
      ],
      curl: [
        {
          name: 'url',
          description: '请求 URL',
          required: true,
          type: 'string',
        },
        {
          name: 'method',
          description: 'HTTP 方法 (GET/POST/PUT/DELETE)',
          required: false,
          type: 'string',
        },
        {
          name: 'data',
          description: '请求数据',
          required: false,
          type: 'string',
        },
      ],
      grep: [
        {
          name: 'pattern',
          description: '搜索模式',
          required: true,
          type: 'string',
        },
        {
          name: 'path',
          description: '搜索路径',
          required: false,
          type: 'string',
        },
      ],
      find: [
        {
          name: 'path',
          description: '搜索路径',
          required: false,
          type: 'string',
        },
        {
          name: 'name',
          description: '文件名模式',
          required: false,
          type: 'string',
        },
      ],
      python: [
        {
          name: 'script',
          description: 'Python 脚本路径',
          required: true,
          type: 'string',
        },
        {
          name: 'args',
          description: '脚本参数',
          required: false,
          type: 'string',
        },
      ],
      node: [
        {
          name: 'script',
          description: 'JS 脚本路径',
          required: true,
          type: 'string',
        },
        {
          name: 'args',
          description: '脚本参数',
          required: false,
          type: 'string',
        },
      ],
    };

    return paramMap[command] || commonParams;
  }

  /**
   * 生成示例用法
   */
  private generateExamples(command: string): string[] {
    const exampleMap: Record<string, string[]> = {
      git: ['git status', 'git log -10', 'git diff HEAD~1'],
      npm: ['npm list --depth=0', 'npm run build', 'npm install <package>'],
      docker: ['docker ps', 'docker images', 'docker run -d <image>'],
      curl: [
        'curl https://example.com',
        'curl -X POST https://api.example.com/data',
      ],
      grep: ['grep "pattern" file.txt', 'grep -r "pattern" ./src'],
      find: ['find . -name "*.ts"', 'find . -type f -mtime -7'],
      python: ['python script.py', 'python -m pip list'],
      node: ['node server.js', 'node --version'],
      cat: ['cat file.txt'],
      ls: ['ls -la', 'ls src/'],
      wc: ['wc -l file.txt', 'wc -w file.txt'],
    };

    return exampleMap[command] || [`${command} --help`];
  }

  /**
   * 将发现的工具注册到 ToolRegistry
   *
   * @param toolNames - 要注册的工具名称（空则全部注册）
   * @returns 成功注册的数量
   */
  async registerDiscoveredTools(toolNames?: string[]): Promise<number> {
    const discovered = await this.discoverSystemTools();
    const toRegister = toolNames
      ? discovered.filter((t) => toolNames.includes(t.name))
      : discovered;

    let registeredCount = 0;

    for (const tool of toRegister) {
      if (this.tools.has(tool.name)) continue;

      const toolDef: ToolDefinition = {
        name: tool.name,
        description:
          `[系统CLI] ${tool.description}` +
          (tool.version ? ` (v${tool.version})` : '') +
          `\n\n通过 shell_exec 调用 ${tool.command} 命令。\n` +
          `示例: ${tool.examples.slice(0, 2).join(' | ')}`,
        category: tool.category,
        parameters: {
          args: {
            type: 'string',
            description: `${tool.command} 命令参数`,
          },
        },
        requiredParams: ['args'],
        requiredPermissions: [],
        riskLevel: tool.riskLevel,
        idempotent: false,
        timeout: 30000,
      };

      const command = tool.command;

      this.register(
        toolDef,
        async (_params: Record<string, unknown>, _context: ToolContext) => {
          const args = _params.args || '';

          const { execSync } = await import('child_process');
          try {
            const output = execSync(`${command} ${String(args)}`, {
              timeout: 30000,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
            });

            return {
              success: true,
              output: output.trim().substring(0, 10000),
              duration: 0,
              validated: true,
            };
          } catch (execError) {
            return {
              success: false,
              output: null,
              error: `${command} 执行失败: ${(execError as Error).message}`,
              duration: 0,
              validated: false,
            };
          }
        }
      );

      registeredCount++;
    }

    if (registeredCount > 0) {
      Logger.info(
        `📦 自动注册了 ${registeredCount} 个系统工具`,
        'ToolRegistry'
      );
    }

    return registeredCount;
  }

  /**
   * 获取所有已发现的工具
   */
  getDiscoveredTools(): DiscoveredTool[] {
    return Array.from(this.discoveredTools.values());
  }

  /**
   * Phase 3: 语义工具发现 — 根据自然语言意图搜索最匹配的工具
   */
  searchByIntent(
    query: string,
    options?: ToolSearchOptions
  ): ToolSearchResult[] {
    return this.metadataEnhancer.searchByIntent(query, options);
  }

  /**
   * Phase 3: 工具推荐 — 根据上下文推荐最相关的工具
   */
  recommendTools(
    context: string,
    recentToolCalls?: string[],
    limit?: number
  ): ToolSearchResult[] {
    return this.metadataEnhancer.recommendTools(
      context,
      recentToolCalls,
      limit
    );
  }

  /**
   * Phase 3: 获取工具增强元数据
   */
  getToolEnhancedMetadata(toolName: string) {
    return this.metadataEnhancer.getEnhancedMetadata(toolName);
  }

  /**
   * Phase 3: 获取工具关系图谱
   */
  getToolRelations(toolName: string) {
    return this.metadataEnhancer.getToolRelations(toolName);
  }
}

export class ToolReliabilityTracker {
  private stats: Map<
    string,
    {
      calls: number;
      successes: number;
      totalDuration: number;
      lastError?: string;
    }
  > = new Map();
  private evolutionWeights: Map<string, number> = new Map();

  /**
   * 应用进化引擎产出的技能权重调整
   * 权重影响工具推荐排序：权重越高越优先推荐
   */
  applyEvolutionWeights(weights: Record<string, number>): void {
    for (const [toolName, weight] of Object.entries(weights)) {
      this.evolutionWeights.set(toolName, weight);
    }
    Logger.info(
      `🔧 进化权重已应用: ${Object.keys(weights).join(', ') || '(无变更)'}`,
      'ToolReliabilityTracker'
    );
  }

  /**
   * 获取所有进化权重（用于外部消费）
   */
  getEvolutionWeights(): Map<string, number> {
    return new Map(this.evolutionWeights);
  }

  /**
   * 获取工具的进化权重（用于推荐排序）
   */
  getEvolutionWeight(toolName: string): number {
    return this.evolutionWeights.get(toolName) ?? 1.0;
  }

  /**
   * 获取综合评分（成功率 × 进化权重）
   */
  getCompositeScore(toolName: string): number {
    const successRate = this.getSuccessRate(toolName);
    const weight = this.getEvolutionWeight(toolName);
    return successRate * weight;
  }

  /**
   * 记录工具调用结果
   * @param toolName - 工具名称
   * @param success - 是否成功
   * @param duration - 执行时长(ms)
   * @param error - 错误信息
   */
  recordCall(
    toolName: string,
    success: boolean,
    duration: number,
    error?: string
  ): void {
    const existing = this.stats.get(toolName);
    if (existing) {
      existing.calls++;
      if (success) existing.successes++;
      existing.totalDuration += duration;
      if (error) existing.lastError = error;
    } else {
      this.stats.set(toolName, {
        calls: 1,
        successes: success ? 1 : 0,
        totalDuration: duration,
        lastError: error,
      });
    }
  }

  /**
   * 获取工具成功率
   * @param toolName - 工具名称
   * @returns 成功率 (0-1)
   */
  getSuccessRate(toolName: string): number {
    const stat = this.stats.get(toolName);
    if (!stat || stat.calls === 0) return 1.0; // 新工具默认满分，不惩罚未调用过的工具
    return stat.successes / stat.calls;
  }

  /**
   * 获取工具平均执行时长
   * @param toolName - 工具名称
   * @returns 平均时长(ms)
   */
  getAverageDuration(toolName: string): number {
    const stat = this.stats.get(toolName);
    if (!stat || stat.calls === 0) return 0;
    return stat.totalDuration / stat.calls;
  }

  /**
   * 获取不可靠工具列表（成功率低于阈值）
   * @param threshold - 成功率阈值，默认0.9
   * @returns 不可靠工具名称列表
   */
  getUnreliableTools(threshold: number = 0.9): string[] {
    const unreliable: string[] = [];
    for (const [toolName, stat] of this.stats) {
      if (stat.calls > 0 && stat.successes / stat.calls < threshold) {
        unreliable.push(toolName);
      }
    }
    return unreliable;
  }

  /**
   * 获取单个工具统计信息
   * @param toolName - 工具名称
   * @returns 统计信息或null
   */
  getStats(toolName: string): {
    calls: number;
    successes: number;
    successRate: number;
    avgDuration: number;
    lastError?: string;
  } | null {
    const stat = this.stats.get(toolName);
    if (!stat) return null;
    return {
      calls: stat.calls,
      successes: stat.successes,
      successRate: stat.calls > 0 ? stat.successes / stat.calls : 0,
      avgDuration: stat.calls > 0 ? stat.totalDuration / stat.calls : 0,
      lastError: stat.lastError,
    };
  }

  /**
   * 获取所有工具统计信息
   * @returns 所有工具统计信息映射
   */
  getAllStats(): Map<
    string,
    {
      calls: number;
      successes: number;
      successRate: number;
      avgDuration: number;
      lastError?: string;
    }
  > {
    const result = new Map<
      string,
      {
        calls: number;
        successes: number;
        successRate: number;
        avgDuration: number;
        lastError?: string;
      }
    >();
    for (const [toolName, stat] of this.stats) {
      result.set(toolName, {
        calls: stat.calls,
        successes: stat.successes,
        successRate: stat.calls > 0 ? stat.successes / stat.calls : 0,
        avgDuration: stat.calls > 0 ? stat.totalDuration / stat.calls : 0,
        lastError: stat.lastError,
      });
    }
    return result;
  }

  /**
   * 重置所有统计信息
   */
  reset(): void {
    this.stats.clear();
  }
}

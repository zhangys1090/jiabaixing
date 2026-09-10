/**
 * Harness Phase 10: 多Agent编排 — Agent注册与发现服务
 *
 * 管理多Agent的注册、发现、状态跟踪。
 * 支持按能力查找可用Agent，提供运行时状态监控。
 * P10增强：健康检查、能力评分排序、心跳检测
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/Logger';

/** Agent能力声明 */
export interface AgentCapability {
  /** 能力名称 */
  name: string;
  /** 能力描述 */
  description: string;
  /** 该能力所需的工具列表 */
  tools: string[];
  /** 最大并发数（可选，默认1） */
  maxConcurrency?: number;
  /** 能力评分 0-100（可选，默认50） */
  score?: number;
}

/** Agent注册信息 */
export interface AgentRegistration {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 能力列表 */
  capabilities: AgentCapability[];
  /** 当前状态 */
  status: 'idle' | 'busy' | 'error';
  /** 创建时间 */
  createdAt: Date;
  /** 最后活跃时间 */
  lastActiveAt: Date;
}

/** Agent健康状态 */
export interface AgentHealth {
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 成功率 0-1 */
  successRate: number;
  /** 平均响应时间 (ms) */
  avgResponseTime: number;
  /** 错误次数 */
  errorCount: number;
  /** 总执行次数 */
  totalExecutions: number;
}

const DEFAULT_HEALTH: AgentHealth = {
  lastHeartbeat: Date.now(),
  successRate: 1.0,
  avgResponseTime: 0,
  errorCount: 0,
  totalExecutions: 0,
};

/** 共享知识条目 */
export interface SharedKnowledgeEntry {
  id: string;
  publisherId: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  applicableScenes: string[];
  qualityScore: number;
  referenceCount: number;
  createdAt: number;
}

/** 知识订阅 */
interface KnowledgeSubscription {
  id: string;
  subscriberId: string;
  type: string;
  onNewKnowledge: (entry: SharedKnowledgeEntry) => void;
}

/** 竞标书 */
export interface Bid {
  id: string;
  agentId: string;
  taskId: string;
  estimatedTime: number;
  confidence: number;
  justification: string;
  resourceRequirements: string[];
  timestamp: number;
}

/** 协商消息 */
export interface NegotiationMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

export class AgentRegistry {
  private static readonly KNOWLEDGE_MAX_ENTRIES = 5000;
  private static readonly KNOWLEDGE_TRIM_TO = 4000;
  private static readonly NEGOTIATION_MAX_SESSIONS = 200;
  private static readonly NEGOTIATION_TRIM_TO = 150;

  private agents: Map<string, AgentRegistration> = new Map();
  private healthMap: Map<string, AgentHealth> = new Map();

  /**
   * 注册Agent
   * @param registration - Agent注册信息
   * @throws 如果agentId已存在则跳过（日志警告）
   */
  register(registration: AgentRegistration): void {
    if (this.agents.has(registration.id)) {
      Logger.warn(
        `Agent 已存在，跳过重复注册: ${registration.id} (${registration.name})`,
        'AgentRegistry'
      );
      return;
    }

    this.agents.set(registration.id, {
      ...registration,
      createdAt: registration.createdAt || new Date(),
      lastActiveAt: registration.lastActiveAt || new Date(),
    });

    this.healthMap.set(registration.id, { ...DEFAULT_HEALTH });

    Logger.info(
      `🤖 注册 Agent: ${registration.name} (${registration.id}) | 能力: ${registration.capabilities.map((c) => c.name).join(', ') || '(无)'}`,
      'AgentRegistry'
    );
  }

  /**
   * 注销Agent
   * @param agentId - Agent唯一标识
   */
  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      Logger.warn(`Agent 不存在，无法注销: ${agentId}`, 'AgentRegistry');
      return;
    }

    this.agents.delete(agentId);
    this.healthMap.delete(agentId);
    Logger.info(`👋 注销 Agent: ${agent.name} (${agentId})`, 'AgentRegistry');
  }

  /**
   * 按工具能力查找合适的Agent（寻找空闲的、具备该工具的Agent）
   * @param toolName - 工具名称
   * @returns 第一个匹配的空闲Agent，或null
   */
  findAgentByCapability(toolName: string): AgentRegistration | null {
    for (const agent of this.agents.values()) {
      if (agent.status !== 'idle') continue;

      const hasCapability = agent.capabilities.some((cap) =>
        cap.tools.includes(toolName)
      );
      if (hasCapability) {
        return agent;
      }
    }

    Logger.debug(
      `未找到具备工具能力的空闲 Agent: ${toolName}`,
      'AgentRegistry'
    );
    return null;
  }

  /**
   * 按能力评分 + 健康状态查找最佳Agent
   * P10增强：综合考虑能力评分、健康状态、成功率排序
   * @param toolName - 工具名称
   * @returns 最佳匹配的空闲Agent，或null
   */
  findBestAgent(toolName: string): AgentRegistration | null {
    const candidates: Array<{ agent: AgentRegistration; score: number }> = [];

    for (const agent of this.agents.values()) {
      if (agent.status !== 'idle') continue;

      const matchingCap = agent.capabilities.find((cap) =>
        cap.tools.includes(toolName)
      );
      if (!matchingCap) continue;

      const health = this.healthMap.get(agent.id) || DEFAULT_HEALTH;
      const capabilityScore = matchingCap.score ?? 50;
      const healthBonus = health.successRate * 25;
      const latencyPenalty = Math.min(health.avgResponseTime / 1000, 10);
      const errorPenalty = Math.min(health.errorCount * 2, 20);

      const compositeScore =
        capabilityScore + healthBonus - latencyPenalty - errorPenalty;

      candidates.push({ agent, score: compositeScore });
    }

    if (candidates.length === 0) {
      Logger.debug(
        `未找到具备工具能力的空闲 Agent: ${toolName}`,
        'AgentRegistry'
      );
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].agent;
  }

  /**
   * 更新Agent健康状态
   * @param agentId - Agent唯一标识
   * @param healthUpdate - 健康状态更新（部分字段）
   */
  updateHealth(agentId: string, healthUpdate: Partial<AgentHealth>): void {
    const current = this.healthMap.get(agentId) || { ...DEFAULT_HEALTH };
    this.healthMap.set(agentId, {
      ...current,
      ...healthUpdate,
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * 记录Agent执行结果（自动更新健康指标）
   * @param agentId - Agent唯一标识
   * @param success - 是否成功
   * @param durationMs - 执行耗时
   */
  recordExecution(agentId: string, success: boolean, durationMs: number): void {
    const health = this.healthMap.get(agentId);
    if (!health) return;

    health.totalExecutions++;
    health.lastHeartbeat = Date.now();

    if (success) {
      const prevAvg = health.avgResponseTime;
      health.avgResponseTime =
        (prevAvg * (health.totalExecutions - 1) + durationMs) /
        health.totalExecutions;
      health.successRate =
        (health.successRate * (health.totalExecutions - 1) + 1) /
        health.totalExecutions;
    } else {
      health.errorCount++;
      health.successRate =
        (health.successRate * (health.totalExecutions - 1)) /
        health.totalExecutions;
    }

    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastActiveAt = new Date();
    }
  }

  /**
   * 获取Agent健康状态
   * @param agentId - Agent唯一标识
   * @returns 健康状态，或null
   */
  getHealthStatus(agentId: string): AgentHealth | null {
    return this.healthMap.get(agentId) || null;
  }

  /**
   * 清理超时无心跳的Agent（标记为error状态）
   * @param timeoutMs - 超时阈值（默认60秒）
   * @returns 被标记为error的Agent数量
   */
  cleanupStaleAgents(timeoutMs: number = 60000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [agentId, health] of this.healthMap) {
      if (now - health.lastHeartbeat > timeoutMs) {
        const agent = this.agents.get(agentId);
        if (agent && agent.status !== 'error') {
          agent.status = 'error';
          Logger.warn(
            `💀 Agent 心跳超时，标记为 error: ${agent.name} (${agentId})`,
            'AgentRegistry'
          );
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /**
   * 获取Agent信息
   * @param agentId - Agent唯一标识
   * @returns Agent注册信息，或undefined
   */
  getAgent(id: string): AgentRegistration | undefined {
    return this.agents.get(id);
  }

  /**
   * 列出所有Agent（可按状态过滤）
   * @param status - 可选的状态过滤器
   * @returns Agent注册信息列表
   */
  listAgents(status?: AgentRegistration['status']): AgentRegistration[] {
    const all = Array.from(this.agents.values());
    if (status === undefined) return all;
    return all.filter((a) => a.status === status);
  }

  /**
   * 更新Agent状态
   * @param agentId - Agent唯一标识
   * @param status - 新状态
   * @throws 如果Agent不存在则日志警告
   */
  updateStatus(agentId: string, status: AgentRegistration['status']): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      Logger.warn(`Agent 不存在，无法更新状态: ${agentId}`, 'AgentRegistry');
      return;
    }

    agent.status = status;
    agent.lastActiveAt = new Date();

    if (this.healthMap.has(agentId)) {
      this.healthMap.get(agentId)!.lastHeartbeat = Date.now();
    }

    Logger.debug(`Agent 状态更新: ${agentId} → ${status}`, 'AgentRegistry');
  }

  /**
   * 获取当前注册的Agent数量
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * 获取空闲Agent列表
   */
  getIdleAgents(): AgentRegistration[] {
    return this.listAgents('idle');
  }

  /**
   * 获取忙碌Agent列表
   */
  getBusyAgents(): AgentRegistration[] {
    return this.listAgents('busy');
  }

  /**
   * 获取异常Agent列表
   */
  getErrorAgents(): AgentRegistration[] {
    return this.listAgents('error');
  }

  // ============ 知识共享系统 ============

  private knowledgeEntries: Map<string, SharedKnowledgeEntry> = new Map();
  private knowledgeSubscriptions: Map<string, KnowledgeSubscription> =
    new Map();

  publishKnowledge(input: {
    publisherId: string;
    type: string;
    title: string;
    content: string;
    tags: string[];
    applicableScenes: string[];
    qualityScore: number;
  }): SharedKnowledgeEntry {
    const id = `know_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: SharedKnowledgeEntry = {
      id,
      publisherId: input.publisherId,
      type: input.type,
      title: input.title,
      content: input.content,
      tags: input.tags,
      applicableScenes: input.applicableScenes,
      qualityScore: input.qualityScore,
      referenceCount: 0,
      createdAt: Date.now(),
    };
    this.knowledgeEntries.set(id, entry);

    if (this.knowledgeEntries.size > AgentRegistry.KNOWLEDGE_MAX_ENTRIES) {
      const sorted = Array.from(this.knowledgeEntries.entries()).sort(
        ([, a], [, b]) => a.createdAt - b.createdAt
      );
      const toRemove = sorted.slice(
        0,
        this.knowledgeEntries.size - AgentRegistry.KNOWLEDGE_TRIM_TO
      );
      for (const [removeId] of toRemove) {
        this.knowledgeEntries.delete(removeId);
      }
      Logger.info(
        `💾 P1-5: 知识库已裁剪 ${toRemove.length} 条旧条目 (当前=${this.knowledgeEntries.size})`,
        'AgentRegistry'
      );
    }

    // P1-7: 知识共享持久化 — 发布时同步写入文件系统
    this.persistKnowledgeEntry(entry);

    for (const [, sub] of this.knowledgeSubscriptions) {
      if (sub.type === input.type) {
        try {
          sub.onNewKnowledge(entry);
        } catch {
          // 忽略回调错误
        }
      }
    }

    return entry;
  }

  queryKnowledge(filter: {
    type?: string;
    scene?: string;
    minQualityScore?: number;
    keywords?: string[];
    maxResults?: number;
  }): SharedKnowledgeEntry[] {
    let results = Array.from(this.knowledgeEntries.values());

    if (filter.type) {
      results = results.filter((e) => e.type === filter.type);
    }
    if (filter.scene) {
      results = results.filter((e) =>
        e.applicableScenes.includes(filter.scene!)
      );
    }
    if (filter.minQualityScore !== undefined) {
      results = results.filter(
        (e) => e.qualityScore >= filter.minQualityScore!
      );
    }
    if (filter.keywords && filter.keywords.length > 0) {
      results = results.filter((e) =>
        filter.keywords!.some(
          (kw) =>
            e.title.includes(kw) ||
            e.content.includes(kw) ||
            e.tags.some((t) => t.includes(kw))
        )
      );
    }
    if (filter.maxResults !== undefined) {
      results = results.slice(0, filter.maxResults);
    }

    return results;
  }

  referenceKnowledge(id: string): void {
    const entry = this.knowledgeEntries.get(id);
    if (entry) {
      entry.referenceCount++;
    }
  }

  subscribeToKnowledge(input: {
    subscriberId: string;
    type: string;
    onNewKnowledge: (entry: SharedKnowledgeEntry) => void;
  }): string {
    const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.knowledgeSubscriptions.set(subId, {
      id: subId,
      subscriberId: input.subscriberId,
      type: input.type,
      onNewKnowledge: input.onNewKnowledge,
    });
    return subId;
  }

  unsubscribeFromKnowledge(subId: string): void {
    this.knowledgeSubscriptions.delete(subId);
  }

  getKnowledgeStats(): {
    totalEntries: number;
    entriesByType: Record<string, number>;
    topContributors: Array<{ agentId: string; count: number }>;
    avgQualityScore: number;
  } {
    const entries = Array.from(this.knowledgeEntries.values());
    const entriesByType: Record<string, number> = {};
    const contributorMap: Record<string, number> = {};
    let totalQuality = 0;

    for (const entry of entries) {
      entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;
      contributorMap[entry.publisherId] =
        (contributorMap[entry.publisherId] || 0) + 1;
      totalQuality += entry.qualityScore;
    }

    const topContributors = Object.entries(contributorMap)
      .map(([agentId, count]) => ({ agentId, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalEntries: entries.length,
      entriesByType,
      topContributors,
      avgQualityScore: entries.length > 0 ? totalQuality / entries.length : 0,
    };
  }

  // ============ P1-7: 知识共享持久化 ============

  private knowledgePersistDir: string | null = null;

  /**
   * P1-7: 设置知识持久化目录
   * 调用后，publishKnowledge 会同步写入文件，启动时 loadPersistedKnowledge 可恢复
   */
  setKnowledgePersistDir(dir: string): void {
    this.knowledgePersistDir = dir;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // 忽略
    }
  }

  private persistKnowledgeEntry(entry: SharedKnowledgeEntry): void {
    if (!this.knowledgePersistDir) return;
    try {
      const filePath = path.join(this.knowledgePersistDir, `${entry.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
      Logger.debug(`💾 P1-7: 知识条目已持久化: ${entry.id}`, 'AgentRegistry');
    } catch (err) {
      Logger.warn(
        `💾 P1-7: 知识条目持久化失败: ${(err as Error).message}`,
        'AgentRegistry'
      );
    }
  }

  /**
   * P1-7: 从持久化目录加载知识条目
   * 在 AgentRegistry 初始化后调用，恢复跨重启的知识共享状态
   */
  loadPersistedKnowledge(): number {
    if (!this.knowledgePersistDir) return 0;
    try {
      const files = fs
        .readdirSync(this.knowledgePersistDir)
        .filter((f: string) => f.endsWith('.json'));
      let loaded = 0;
      for (const file of files) {
        try {
          const raw = fs.readFileSync(
            path.join(this.knowledgePersistDir, file),
            'utf-8'
          );
          const entry: SharedKnowledgeEntry = JSON.parse(raw);
          if (!this.knowledgeEntries.has(entry.id)) {
            this.knowledgeEntries.set(entry.id, entry);
            loaded++;
          }
        } catch {
          // 跳过损坏的文件
        }
      }
      if (loaded > 0) {
        Logger.info(
          `💾 P1-7: 从持久化目录加载 ${loaded} 条知识条目`,
          'AgentRegistry'
        );
      }
      return loaded;
    } catch {
      return 0;
    }
  }

  // ============ 结构化通信系统 ============

  private messageHandlers: Map<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: any) => Promise<any> | any
  > = new Map();

  registerMessageHandler(
    agentId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (msg: any) => Promise<any> | any
  ): void {
    this.messageHandlers.set(agentId, handler);
  }

  broadcastMessage(
    fromAgentId: string,
    message: { type: string; payload: Record<string, unknown> }
  ): string[] {
    const delivered: string[] = [];
    for (const [agentId, registration] of this.agents) {
      if (
        agentId !== fromAgentId &&
        registration.status === 'idle' &&
        this.messageHandlers.has(agentId)
      ) {
        try {
          this.messageHandlers.get(agentId)!(message);
          delivered.push(agentId);
        } catch {
          // 忽略发送失败
        }
      }
    }
    return delivered;
  }

  async negotiateBetweenAgents(
    fromAgentId: string,
    toAgentId: string,
    topic: string
  ): Promise<{ agreed: boolean; terms: Record<string, unknown> }> {
    const handler = this.messageHandlers.get(toAgentId);
    if (!handler) {
      return { agreed: false, terms: {} };
    }

    try {
      const response = await handler({
        type: 'query',
        payload: { requestedInfo: topic },
        sessionId: `neg_${Date.now()}`,
      });

      if (response && typeof response === 'object') {
        const resp = response as Record<string, unknown>;
        return {
          agreed: true,
          terms: (resp.payload as Record<string, unknown>) || {},
        };
      }
    } catch {
      // 协商失败
    }

    return { agreed: false, terms: {} };
  }

  // ============ 协商协议系统 ============

  private negotiationSessions: Map<
    string,
    {
      id: string;
      initiatorId: string;
      participants: string[];
      topic: string;
      payload: Record<string, unknown>;
      status: 'open' | 'completed' | 'failed';
      result?: { agreedAgentId: string };
    }
  > = new Map();

  startNegotiation(
    initiatorId: string,
    participants: string[],
    topic: string,
    payload: Record<string, unknown>
  ): {
    id: string;
    initiatorId: string;
    participants: string[];
    topic: string;
    status: string;
    messages: Array<{
      type: string;
      fromAgentId: string;
      payload: Record<string, unknown>;
    }>;
  } {
    const id = `neg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      id,
      initiatorId,
      participants,
      topic,
      payload,
      status: 'open' as const,
    };
    this.negotiationSessions.set(id, session);

    if (
      this.negotiationSessions.size > AgentRegistry.NEGOTIATION_MAX_SESSIONS
    ) {
      const completedOrFailed = Array.from(this.negotiationSessions.entries())
        .filter(([, s]) => s.status !== 'open')
        .sort(([, a], [, b]) => (a.id > b.id ? 1 : -1));
      const toRemove = completedOrFailed.slice(
        0,
        this.negotiationSessions.size - AgentRegistry.NEGOTIATION_TRIM_TO
      );
      for (const [sessionId] of toRemove) {
        this.negotiationSessions.delete(sessionId);
      }
    }
    return {
      id,
      initiatorId,
      participants,
      topic,
      status: 'active',
      messages: [
        {
          type: 'task_proposal',
          fromAgentId: initiatorId,
          payload,
        },
      ],
    };
  }

  sendNegotiationMessage(message: NegotiationMessage): {
    id: string;
    status: string;
    result?: { agreedAgentId: string };
  } | null {
    const session = this.negotiationSessions.get(message.sessionId);
    if (!session) return null;

    if (message.type === 'acceptance') {
      session.status = 'completed';
      session.result = { agreedAgentId: message.fromAgentId };
      return { id: session.id, status: 'completed', result: session.result };
    }

    if (message.type === 'rejection') {
      session.status = 'failed';
      return { id: session.id, status: 'failed' };
    }

    return { id: session.id, status: session.status };
  }

  getNegotiationSession(sessionId: string): {
    id: string;
    initiatorId: string;
    participants: string[];
    topic: string;
    status: string;
    result?: { agreedAgentId: string };
  } | null {
    const session = this.negotiationSessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      initiatorId: session.initiatorId,
      participants: session.participants,
      topic: session.topic,
      status: session.status,
      result: session.result,
    };
  }

  getActiveNegotiations(agentId: string): Array<{
    id: string;
    participants: string[];
    topic: string;
    status: string;
  }> {
    const result: Array<{
      id: string;
      participants: string[];
      topic: string;
      status: string;
    }> = [];
    for (const session of this.negotiationSessions.values()) {
      if (
        session.status === 'open' &&
        (session.participants.includes(agentId) ||
          session.initiatorId === agentId)
      ) {
        result.push({
          id: session.id,
          participants: session.participants,
          topic: session.topic,
          status: session.status,
        });
      }
    }
    return result;
  }

  getMessageHandler(
    agentId: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): ((msg: any) => Promise<any> | any) | undefined {
    return this.messageHandlers.get(agentId);
  }

  // ============ 竞价系统 ============

  private bidHandlers: Map<string, (task: { id: string }) => Bid> = new Map();
  private biddingSessions: Map<
    string,
    {
      id: string;
      taskId: string;
      description: string;
      requiredTools: string[];
      status: string;
      bids: Bid[];
    }
  > = new Map();

  registerBidHandler(
    agentId: string,
    handler: (task: { id: string }) => Bid
  ): void {
    this.bidHandlers.set(agentId, handler);
  }

  publishBidding(
    taskId: string,
    description: string,
    requiredTools: string[]
  ): {
    id: string;
    taskId: string;
    description: string;
    requiredTools: string[];
    status: string;
    bids: Bid[];
  } {
    const id = `bid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: {
      id: string;
      taskId: string;
      description: string;
      requiredTools: string[];
      status: string;
      bids: Bid[];
    } = {
      id,
      taskId,
      description,
      requiredTools,
      status: 'open',
      bids: [],
    };

    for (const [agentId, handler] of this.bidHandlers) {
      const registration = this.agents.get(agentId);
      if (!registration) continue;

      const hasRequiredTools = requiredTools.every((tool) =>
        registration.capabilities.some((cap) =>
          cap.tools.some((t) => t === tool)
        )
      );
      if (!hasRequiredTools && requiredTools.length > 0) continue;

      try {
        const bid = handler({ id: taskId });
        session.bids.push(bid);
      } catch {
        // 忽略投标失败
      }
    }

    this.biddingSessions.set(id, session);
    return session;
  }

  evaluateBids(
    sessionId: string,
    strategy: string = 'balanced'
  ): { winnerId: string; bid: Bid } | null {
    const session = this.biddingSessions.get(sessionId);
    if (!session || session.bids.length === 0) return null;

    let winner: Bid | null = null;

    switch (strategy) {
      case 'fastest':
        winner = session.bids.reduce((best, bid) =>
          bid.estimatedTime < best.estimatedTime ? bid : best
        );
        break;
      case 'most_confident':
        winner = session.bids.reduce((best, bid) =>
          bid.confidence > best.confidence ? bid : best
        );
        break;
      case 'balanced':
      default:
        winner = session.bids.reduce((best, bid) => {
          const bestScore =
            best.confidence * 0.6 + (1 / Math.max(best.estimatedTime, 1)) * 0.4;
          const bidScore =
            bid.confidence * 0.6 + (1 / Math.max(bid.estimatedTime, 1)) * 0.4;
          return bidScore > bestScore ? bid : best;
        });
        break;
    }

    if (winner) {
      session.status = 'awarded';
      return { winnerId: winner.agentId, bid: winner };
    }

    return null;
  }

  submitBid(bid: Bid): boolean {
    for (const session of this.biddingSessions.values()) {
      if (session.taskId === bid.taskId && session.status === 'open') {
        session.bids.push(bid);
        return true;
      }
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// A2A Protocol — Agent Card & Task Lifecycle
// ═══════════════════════════════════════════════════════════

/**
 * A2A Agent Card — 标准化的 Agent 自描述元数据
 * 遵循 Google A2A Protocol 规范
 */
export interface A2AAgentCard {
  /** Agent 唯一标识 URI */
  id: string;
  /** 显示名称 */
  name: string;
  /** 详细描述 */
  description: string;
  /** Agent 服务端点 URL */
  url: string;
  /** 支持的传输协议 */
  transport: 'json-rpc' | 'grpc' | 'http';
  /** 能力声明列表 */
  capabilities: A2ACapability[];
  /** 认证方案 */
  authentication?: {
    type: 'none' | 'api-key' | 'oauth2' | 'jwt';
    scheme?: string;
  };
  /** 版本号 */
  version: string;
  /** 提供者信息 */
  provider?: {
    name: string;
    url?: string;
  };
}

/**
 * A2A 能力声明
 */
export interface A2ACapability {
  /** 能力类型 */
  type:
    | 'task-execution'
    | 'information-retrieval'
    | 'data-processing'
    | 'orchestration'
    | 'monitoring';
  /** 能力名称 */
  name: string;
  /** 详细描述 */
  description: string;
  /** 输入 schema */
  inputSchema?: Record<string, unknown>;
  /** 输出 schema */
  outputSchema?: Record<string, unknown>;
  /** 支持的模态 */
  modalities?: ('text' | 'image' | 'audio' | 'video')[];
}

/**
 * A2A Task — 跨 Agent 任务生命周期
 */
export interface A2ATask {
  /** 任务唯一标识 */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 任务描述 */
  description: string;
  /** 发起方 Agent ID */
  fromAgentId: string;
  /** 执行方 Agent ID */
  toAgentId: string;
  /** 任务状态 */
  status: A2ATaskStatus;
  /** 任务输入 */
  input: Record<string, unknown>;
  /** 任务输出 */
  output?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 错误信息 */
  error?: string;
  /** 状态历史 */
  statusHistory: Array<{
    status: A2ATaskStatus;
    timestamp: number;
    message?: string;
  }>;
}

/**
 * A2A Task 状态流转
 */
export type A2ATaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * A2A Task 事件
 */
export interface A2ATaskEvent {
  taskId: string;
  type: 'status-change' | 'artifact-update' | 'progress';
  status?: A2ATaskStatus;
  message?: string;
  artifact?: Record<string, unknown>;
  progress?: number;
  timestamp: number;
}

/**
 * A2A 协议管理器 — 扩展 AgentRegistry，提供标准化的 A2A 通信
 *
 * @deprecated 架构违规：A2A 协议主实现应在 Python 端（`agent/a2a/`）。
 * 本内存实现仅用于单进程本地回放/测试，无网络传输层，无法跨进程通信，
 * **不可作为生产跨 Agent 通信路径**。
 * 生产跨进程 A2A 的规范入口是 TS 薄壳 `src/a2a/`：
 *   - `registerA2ARoutes(app)` 把 `/a2a/*` HTTP 入口透明转发到 Python 后端；
 *   - `A2AClient` 提供 TS 侧出站调用远端 A2A Agent 的薄封装。
 * 调用方应优先使用 `src/a2a` 薄壳（逻辑全在 Python），本类仅作本地兜底。
 * @see AGENTS.md §0.1 模块归属强制表
 * @see src/a2a
 */
export class A2AProtocolManager {
  private agentCards: Map<string, A2AAgentCard> = new Map();
  private tasks: Map<string, A2ATask> = new Map();
  private taskEventHandlers: Map<string, Array<(event: A2ATaskEvent) => void>> =
    new Map();
  private registry: AgentRegistry;
  /** P1-4: Python 后端桥接客户端（可选，由 engine 初始化时注入） */
  private pythonBridge: import('../../a2a/A2AClient').A2AClient | null = null;
  /** P1-4: 是否优先使用 Python 后端 */
  private preferPython: boolean = false;

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  /**
   * P1-4: 注入 Python A2A 桥接客户端，使 TS 侧操作透明转发到 Python 后端。
   * 启用后，createTask/completeTask/cancelTask 等写操作会同步调用 Python 端，
   * 实现双端 A2A 能力统一。
   */
  setPythonBridge(
    client: import('../../a2a/A2AClient').A2AClient,
    preferPython = true
  ): void {
    this.pythonBridge = client;
    this.preferPython = preferPython;
    Logger.info(
      `🔗 A2AProtocolManager: Python 桥接已注入 (preferPython=${preferPython})`,
      'A2AProtocol'
    );
  }

  /**
   * 发布 Agent Card
   */
  async publishAgentCard(card: A2AAgentCard): Promise<void> {
    this.agentCards.set(card.id, card);
    Logger.info(
      `📇 A2A Agent Card 发布: ${card.name} (${card.id})`,
      'A2AProtocol'
    );

    // P1-4: 同步到 Python 后端
    if (this.pythonBridge && this.preferPython) {
      try {
        await fetch(`${this.pythonBridge['baseUrl']}/a2a/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
        });
      } catch (e) {
        Logger.warn(
          `⚠️ A2A Agent Card 同步到 Python 失败: ${(e as Error).message}`,
          'A2AProtocol'
        );
      }
    }
  }

  /**
   * 获取 Agent Card
   */
  getAgentCard(agentId: string): A2AAgentCard | undefined {
    return this.agentCards.get(agentId);
  }

  /**
   * 发现具备指定能力的 Agent
   */
  discoverAgents(capabilityType?: A2ACapability['type']): A2AAgentCard[] {
    const cards = Array.from(this.agentCards.values());
    if (!capabilityType) return cards;
    return cards.filter((card) =>
      card.capabilities.some((cap) => cap.type === capabilityType)
    );
  }

  /**
   * 创建 A2A Task
   * P1-4: Python 优先模式下，通过 Python 后端创建 Task，本地仅做缓存。
   */
  async createTask(input: {
    fromAgentId: string;
    toAgentId: string;
    description: string;
    input: Record<string, unknown>;
  }): Promise<A2ATask> {
    // P1-4: Python 优先 → 通过 A2AClient 创建
    if (this.pythonBridge && this.preferPython) {
      try {
        const remoteTask = await this.pythonBridge.createTask({
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          description: input.description,
          input: input.input,
        });
        this.tasks.set(remoteTask.id, remoteTask);
        this.emitTaskEvent(remoteTask.id, {
          taskId: remoteTask.id,
          type: 'status-change',
          status: 'submitted',
          timestamp: Date.now(),
        });
        Logger.info(
          `📋 A2A Task 创建(Python): ${remoteTask.id} (${input.fromAgentId} → ${input.toAgentId})`,
          'A2AProtocol'
        );
        return remoteTask;
      } catch (e) {
        Logger.warn(
          `⚠️ Python A2A Task 创建失败，降级到本地: ${(e as Error).message}`,
          'A2AProtocol'
        );
      }
    }

    // 本地兜底
    const id = `a2a_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const task: A2ATask = {
      id,
      sessionId: `session_${Date.now()}`,
      description: input.description,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      status: 'submitted',
      input: input.input,
      createdAt: now,
      updatedAt: now,
      statusHistory: [{ status: 'submitted', timestamp: now }],
    };

    this.tasks.set(id, task);

    Logger.info(
      `📋 A2A Task 创建(本地): ${task.id} (${input.fromAgentId} → ${input.toAgentId})`,
      'A2AProtocol'
    );

    this.emitTaskEvent(task.id, {
      taskId: task.id,
      type: 'status-change',
      status: 'submitted',
      timestamp: now,
    });

    return task;
  }

  /**
   * 更新 Task 状态
   */
  updateTaskStatus(
    taskId: string,
    newStatus: A2ATaskStatus,
    message?: string
  ): A2ATask | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      Logger.warn(`A2A Task 不存在: ${taskId}`, 'A2AProtocol');
      return null;
    }

    const now = Date.now();
    task.status = newStatus;
    task.updatedAt = now;
    task.statusHistory.push({ status: newStatus, timestamp: now, message });

    if (
      newStatus === 'completed' ||
      newStatus === 'failed' ||
      newStatus === 'cancelled'
    ) {
      task.completedAt = now;
    }

    if (newStatus === 'completed') {
      this.registry.recordExecution(task.toAgentId, true, now - task.createdAt);
    } else if (newStatus === 'failed') {
      this.registry.recordExecution(
        task.toAgentId,
        false,
        now - task.createdAt
      );
      task.error = message;
    }

    Logger.info(
      `📋 A2A Task 状态更新: ${taskId} → ${newStatus}`,
      'A2AProtocol'
    );

    this.emitTaskEvent(taskId, {
      taskId,
      type: 'status-change',
      status: newStatus,
      message,
      timestamp: now,
    });

    return task;
  }

  /**
   * 完成 Task 并设置输出
   */
  completeTask(
    taskId: string,
    output: Record<string, unknown>
  ): A2ATask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.output = output;
    return this.updateTaskStatus(taskId, 'completed');
  }

  /**
   * 获取 Task
   */
  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取 Agent 的所有 Task
   */
  getAgentTasks(agentId: string, role?: 'from' | 'to'): A2ATask[] {
    const tasks = Array.from(this.tasks.values());
    if (!role) {
      return tasks.filter(
        (t) => t.fromAgentId === agentId || t.toAgentId === agentId
      );
    }
    if (role === 'from') return tasks.filter((t) => t.fromAgentId === agentId);
    return tasks.filter((t) => t.toAgentId === agentId);
  }

  /**
   * 取消 Task
   */
  cancelTask(taskId: string, reason?: string): A2ATask | null {
    return this.updateTaskStatus(taskId, 'cancelled', reason);
  }

  /**
   * 请求额外输入
   */
  requestInput(taskId: string, message: string): A2ATask | null {
    return this.updateTaskStatus(taskId, 'input-required', message);
  }

  /**
   * 订阅 Task 事件
   */
  onTaskEvent(taskId: string, handler: (event: A2ATaskEvent) => void): void {
    if (!this.taskEventHandlers.has(taskId)) {
      this.taskEventHandlers.set(taskId, []);
    }
    this.taskEventHandlers.get(taskId)!.push(handler);
  }

  /**
   * 取消订阅 Task 事件
   */
  offTaskEvent(taskId: string, handler: (event: A2ATaskEvent) => void): void {
    const handlers = this.taskEventHandlers.get(taskId);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /**
   * 获取活跃 Task 统计
   */
  getTaskStats(): {
    total: number;
    byStatus: Record<A2ATaskStatus, number>;
    avgCompletionTimeMs: number;
  } {
    const tasks = Array.from(this.tasks.values());
    const byStatus: Record<A2ATaskStatus, number> = {
      submitted: 0,
      working: 0,
      'input-required': 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    let totalCompletionTime = 0;
    let completedCount = 0;

    for (const task of tasks) {
      byStatus[task.status]++;
      if (task.completedAt && task.status === 'completed') {
        totalCompletionTime += task.completedAt - task.createdAt;
        completedCount++;
      }
    }

    return {
      total: tasks.length,
      byStatus,
      avgCompletionTimeMs:
        completedCount > 0 ? totalCompletionTime / completedCount : 0,
    };
  }

  private emitTaskEvent(taskId: string, event: A2ATaskEvent): void {
    const handlers = this.taskEventHandlers.get(taskId);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // 忽略回调错误
        }
      }
    }
  }
}

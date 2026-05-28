/**
 * Harness Phase 10: 多Agent编排 — Agent注册与发现服务
 *
 * 管理多Agent的注册、发现、状态跟踪。
 * 支持按能力查找可用Agent，提供运行时状态监控。
 * P10增强：健康检查、能力评分排序、心跳检测
 */

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

export class AgentRegistry {
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
}

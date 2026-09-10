import { EventBus } from '../../shared/EventBus';
import { TokenQuotaExceededError } from '../../shared/errors';
import { Logger } from '../../utils/Logger';

export interface TokenQuotaConfig {
  maxTokensPerSession: number;
  maxTokensPerRequest: number;
  warningThresholdPercent: number;
  resetIntervalMs: number;
}

export interface SessionTokenUsage {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  lastActivityTime: number;
  createdAt: number;
}

const DEFAULT_QUOTA_CONFIG: TokenQuotaConfig = {
  maxTokensPerSession: 500000,
  maxTokensPerRequest: 50000,
  warningThresholdPercent: 80,
  resetIntervalMs: 3600000,
};

export class SessionTokenQuotaManager {
  private static instance: SessionTokenQuotaManager | null = null;
  private sessions: Map<string, SessionTokenUsage> = new Map();
  private config: TokenQuotaConfig;
  private cleanupTimerId: ReturnType<typeof setInterval> | null = null;
  private static readonly MAX_SESSIONS = 5000;

  private constructor(config: Partial<TokenQuotaConfig> = {}) {
    this.config = { ...DEFAULT_QUOTA_CONFIG, ...config };
    this.startCleanupTimer();
    Logger.info(
      `📊 SessionTokenQuotaManager 已初始化 (会话上限: ${this.config.maxTokensPerSession} tokens, 请求上限: ${this.config.maxTokensPerRequest} tokens)`,
      'SessionTokenQuota'
    );
  }

  static create(
    config: Partial<TokenQuotaConfig> = {}
  ): SessionTokenQuotaManager {
    return new SessionTokenQuotaManager(config);
  }

  static getInstance(
    config?: Partial<TokenQuotaConfig>
  ): SessionTokenQuotaManager {
    if (!SessionTokenQuotaManager.instance) {
      SessionTokenQuotaManager.instance = new SessionTokenQuotaManager(config);
    }
    return SessionTokenQuotaManager.instance;
  }

  static resetInstance(): void {
    if (SessionTokenQuotaManager.instance) {
      SessionTokenQuotaManager.instance.shutdown();
      SessionTokenQuotaManager.instance = null;
    }
  }

  recordUsage(
    sessionId: string,
    promptTokens: number,
    completionTokens: number
  ): SessionTokenUsage {
    let usage = this.sessions.get(sessionId);
    const now = Date.now();

    if (!usage) {
      usage = {
        sessionId,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        lastActivityTime: now,
        createdAt: now,
      };
      this.sessions.set(sessionId, usage);
    }

    usage.promptTokens += promptTokens;
    usage.completionTokens += completionTokens;
    usage.totalTokens += promptTokens + completionTokens;
    usage.requestCount++;
    usage.lastActivityTime = now;

    const usagePercent =
      (usage.totalTokens / this.config.maxTokensPerSession) * 100;

    if (
      usagePercent >= this.config.warningThresholdPercent &&
      usagePercent < 100
    ) {
      Logger.warn(
        `⚠️ 会话 ${sessionId} Token 使用率: ${usagePercent.toFixed(1)}% (${usage.totalTokens}/${this.config.maxTokensPerSession})`,
        'SessionTokenQuota'
      );
      EventBus.emit('token_quota_warning', {
        sessionId,
        usagePercent,
        totalTokens: usage.totalTokens,
        maxTokens: this.config.maxTokensPerSession,
        timestamp: new Date().toISOString(),
      });
    }

    return usage;
  }

  checkQuota(
    sessionId: string,
    estimatedTokens: number = 0
  ): {
    allowed: boolean;
    remaining: number;
    usage: SessionTokenUsage | null;
    reason?: string;
  } {
    const usage = this.sessions.get(sessionId);

    if (!usage) {
      return {
        allowed: true,
        remaining: this.config.maxTokensPerSession,
        usage: null,
      };
    }

    const remaining = this.config.maxTokensPerSession - usage.totalTokens;

    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        usage,
        reason: `会话 ${sessionId} Token 配额已耗尽 (${usage.totalTokens}/${this.config.maxTokensPerSession})`,
      };
    }

    if (estimatedTokens > this.config.maxTokensPerRequest) {
      return {
        allowed: false,
        remaining,
        usage,
        reason: `预估 Token 数 (${estimatedTokens}) 超过单次请求上限 (${this.config.maxTokensPerRequest})`,
      };
    }

    if (estimatedTokens > remaining) {
      return {
        allowed: false,
        remaining,
        usage,
        reason: `预估 Token 数 (${estimatedTokens}) 超过剩余配额 (${remaining})`,
      };
    }

    return { allowed: true, remaining, usage };
  }

  enforceQuota(sessionId: string, estimatedTokens: number = 0): void {
    const check = this.checkQuota(sessionId, estimatedTokens);
    if (!check.allowed) {
      const usage = check.usage;
      throw new TokenQuotaExceededError(
        usage?.totalTokens ?? estimatedTokens,
        this.config.maxTokensPerSession,
        sessionId
      );
    }
  }

  getSessionUsage(sessionId: string): SessionTokenUsage | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getAllSessionUsages(): SessionTokenUsage[] {
    return Array.from(this.sessions.values());
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    Logger.info(`🔄 会话 ${sessionId} Token 配额已重置`, 'SessionTokenQuota');
  }

  getQuotaStats(): {
    activeSessions: number;
    totalTokensConsumed: number;
    averageTokensPerSession: number;
    sessionsNearLimit: number;
  } {
    const usages = Array.from(this.sessions.values());
    const totalTokens = usages.reduce((sum, u) => sum + u.totalTokens, 0);
    const nearLimitThreshold =
      this.config.maxTokensPerSession *
      (this.config.warningThresholdPercent / 100);

    return {
      activeSessions: usages.length,
      totalTokensConsumed: totalTokens,
      averageTokensPerSession:
        usages.length > 0 ? Math.round(totalTokens / usages.length) : 0,
      sessionsNearLimit: usages.filter(
        (u) => u.totalTokens >= nearLimitThreshold
      ).length,
    };
  }

  updateConfig(config: Partial<TokenQuotaConfig>): void {
    this.config = { ...this.config, ...config };
    Logger.info(
      `📊 SessionTokenQuota 配置已更新: 会话上限=${this.config.maxTokensPerSession}, 请求上限=${this.config.maxTokensPerRequest}`,
      'SessionTokenQuota'
    );
  }

  private startCleanupTimer(): void {
    this.cleanupTimerId = setInterval(
      () => this.cleanupExpiredSessions(),
      this.config.resetIntervalMs
    );
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, usage] of this.sessions) {
      const inactiveTime = now - usage.lastActivityTime;
      if (inactiveTime > this.config.resetIntervalMs) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (this.sessions.size > SessionTokenQuotaManager.MAX_SESSIONS) {
      const sorted = Array.from(this.sessions.entries()).sort(
        ([, a], [, b]) => a.lastActivityTime - b.lastActivityTime
      );
      const toRemove = sorted.slice(
        0,
        this.sessions.size - SessionTokenQuotaManager.MAX_SESSIONS
      );
      for (const [sessionId] of toRemove) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      Logger.debug(
        `🧹 清理 ${cleaned} 个过期会话的 Token 配额记录`,
        'SessionTokenQuota'
      );
    }
  }

  shutdown(): void {
    if (this.cleanupTimerId) {
      clearInterval(this.cleanupTimerId);
      this.cleanupTimerId = null;
    }
    this.sessions.clear();
    Logger.info('📊 SessionTokenQuotaManager 已关闭', 'SessionTokenQuota');
  }
}

/**
 * ACP (Agent Communication Protocol) 服务器
 *
 * 支持编辑器集成（VS Code / Zed / JetBrains）
 * 提供聊天、文件 diff、终端命令、工具活动等能力
 * 设计参考: Hermes Agent IDE 集成 (ACP)
 */

import { ACPActivityTracker } from './ACPActivityTracker';
import { Logger } from '../utils/Logger';

/** ACP 聊天请求 */
export interface ACPChatRequest {
  /** 用户消息 */
  message: string;
  /** 会话 ID */
  sessionId: string;
  /** 上下文文件 */
  contextFiles?: string[];
}

/** ACP 聊天响应 */
export interface ACPChatResponse {
  /** 响应内容 */
  content: string;
  /** 会话 ID */
  sessionId: string;
  /** 相关文件 */
  relatedFiles?: string[];
  /** 工具活动 */
  toolActivities?: ACPToolActivity[];
}

/** ACP 工具活动 */
export interface ACPToolActivity {
  /** 工具名称 */
  toolName: string;
  /** 执行状态 */
  status: 'running' | 'completed' | 'failed';
  /** 输入参数 */
  input?: Record<string, unknown>;
  /** 输出结果 */
  output?: unknown;
  /** 耗时（毫秒） */
  duration?: number;
}

/** ACP 文件 Diff */
export interface ACPFileDiff {
  /** 文件路径 */
  filePath: string;
  /** 变更类型 */
  changeType: 'created' | 'modified' | 'deleted';
  /** Diff 内容（unified format） */
  diff: string;
}

/** ACP 终端命令 */
export interface ACPTerminalCommand {
  /** 命令文本 */
  command: string;
  /** 工作目录 */
  cwd?: string;
  /** 退出码 */
  exitCode?: number;
  /** 输出 */
  output?: string;
}

/** ACP 依赖接口 */
export interface ACPDeps {
  /** 处理用户输入 */
  processInput: (
    message: string,
    sessionId?: string
  ) => Promise<{
    response: string;
    traceId?: string;
  }>;
  /** 获取文件变更 */
  getFileDiffs: (sessionId: string) => ACPFileDiff[];
  /** 获取终端命令 */
  getTerminalCommands: (sessionId: string) => ACPTerminalCommand[];
  /** 获取工具活动 */
  getToolActivities: (sessionId: string) => ACPToolActivity[];
}

/** 会话默认过期时间（毫秒）— 24小时 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class ACPServer {
  private deps: ACPDeps;
  private tracker: ACPActivityTracker;
  private sessions: Map<string, { createdAt: number; lastActivity: number }> =
    new Map();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(deps: ACPDeps) {
    this.deps = deps;
    this.tracker = ACPActivityTracker.getInstance();
    // 定期清理过期会话（每30分钟）
    this.cleanupInterval = setInterval(
      () => this.cleanupExpiredSessions(),
      30 * 60 * 1000
    );
  }

  /**
   * 清理过期会话
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, meta] of this.sessions.entries()) {
      if (now - meta.lastActivity > SESSION_TTL_MS) {
        this.sessions.delete(sessionId);
        Logger.debug(`清理过期 ACP 会话: ${sessionId}`, 'ACPServer');
      }
    }
  }

  /**
   * 处理聊天请求
   * @param request - 聊天请求
   * @returns 聊天响应
   */
  async handleChat(request: ACPChatRequest): Promise<ACPChatResponse> {
    const { message, sessionId } = request;

    // 更新会话状态
    this.touchSession(sessionId);

    try {
      const result = await this.deps.processInput(message, sessionId);

      // 获取相关工具活动
      const toolActivities = this.deps.getToolActivities(sessionId);

      return {
        content: result.response,
        sessionId,
        toolActivities: toolActivities.length > 0 ? toolActivities : undefined,
      };
    } catch (err) {
      Logger.error(
        `ACP 聊天处理失败: ${(err as Error).message}`,
        err as Error,
        'ACPServer'
      );

      return {
        content: `处理失败: ${(err as Error).message}`,
        sessionId,
      };
    }
  }

  /**
   * 获取文件 Diff
   * @param sessionId - 会话 ID
   * @returns 文件变更列表
   */
  getFileDiff(sessionId: string): ACPFileDiff[] {
    const tracked = this.tracker.getFileDiffs(sessionId);
    if (tracked.length > 0) return tracked;
    return this.deps.getFileDiffs(sessionId);
  }

  /**
   * 获取终端命令
   * @param sessionId - 会话 ID
   * @returns 终端命令列表
   */
  getTerminalCommands(sessionId: string): ACPTerminalCommand[] {
    const tracked = this.tracker.getTerminalCommands(sessionId);
    if (tracked.length > 0) return tracked;
    return this.deps.getTerminalCommands(sessionId);
  }

  /**
   * 获取工具活动
   * @param sessionId - 会话 ID
   * @returns 工具活动列表
   */
  getToolActivities(sessionId: string): ACPToolActivity[] {
    const tracked = this.tracker.getToolActivities(sessionId);
    if (tracked.length > 0) return tracked;
    return this.deps.getToolActivities(sessionId);
  }

  /**
   * 获取活跃会话列表
   * @returns 活跃会话信息数组
   */
  getActiveSessions(): Array<{
    sessionId: string;
    createdAt: number;
    lastActivity: number;
  }> {
    return Array.from(this.sessions.entries()).map(([sessionId, meta]) => ({
      sessionId,
      ...meta,
    }));
  }

  /**
   * 关闭会话
   * @param sessionId - 会话 ID
   * @returns 是否成功关闭
   */
  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * 更新会话状态
   * @param sessionId - 会话 ID
   */
  private touchSession(sessionId: string): void {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);

    if (existing) {
      existing.lastActivity = now;
    } else {
      this.sessions.set(sessionId, { createdAt: now, lastActivity: now });
    }
  }
}

/** ACP 权限级别 */
export type ACPPermissionLevel = 'read' | 'write' | 'admin' | 'denied';

/** ACP 权限范围 */
export interface ACPPermissionScope {
  /** 允许的工具分类 */
  allowedCategories?: string[];
  /** 禁止的工具名称 */
  deniedTools?: string[];
  /** 允许的文件路径前缀 */
  allowedPaths?: string[];
  /** 最大单次请求 token 数 */
  maxTokensPerRequest?: number;
  /** 每小时最大请求数 */
  maxRequestsPerHour?: number;
}

/** ACP 认证令牌 */
export interface ACPAuthToken {
  /** 令牌 ID */
  tokenId: string;
  /** 客户端标识（如 IDE 扩展名） */
  clientId: string;
  /** 权限级别 */
  permissionLevel: ACPPermissionLevel;
  /** 权限范围 */
  scope: ACPPermissionScope;
  /** 签发时间 */
  issuedAt: number;
  /** 过期时间 */
  expiresAt: number;
}

/** ACP 认证结果 */
export interface ACPAuthResult {
  /** 是否认证通过 */
  authenticated: boolean;
  /** 认证令牌（通过时） */
  token?: ACPAuthToken;
  /** 错误信息（失败时） */
  error?: string;
}

/** ACP 权限检查结果 */
export interface ACPPermissionCheck {
  /** 是否允许 */
  allowed: boolean;
  /** 拒绝原因 */
  reason?: string;
}

/** ACP 认证管理器 */
export class ACPAuthManager {
  private tokens: Map<string, ACPAuthToken> = new Map();
  private apiKeys: Map<
    string,
    {
      clientId: string;
      permissionLevel: ACPPermissionLevel;
      scope: ACPPermissionScope;
    }
  > = new Map();
  private requestCounts: Map<string, { count: number; windowStart: number }> =
    new Map();
  private secretKey: string;

  constructor() {
    this.secretKey = process.env.ACP_SECRET_KEY || 'jiabaixing-acp-default-key';

    const defaultKey = process.env.ACP_API_KEY;
    if (defaultKey) {
      this.registerApiKey(defaultKey, 'default-client', 'admin', {
        allowedCategories: undefined,
        deniedTools: [],
        allowedPaths: undefined,
        maxTokensPerRequest: 8192,
        maxRequestsPerHour: 1000,
      });
    }

    const readOnlyKey = process.env.ACP_READ_ONLY_KEY;
    if (readOnlyKey) {
      this.registerApiKey(readOnlyKey, 'readonly-client', 'read', {
        allowedCategories: ['cognition', 'memory'],
        deniedTools: ['shell_exec', 'file_edit', 'code_generate'],
        allowedPaths: undefined,
        maxTokensPerRequest: 4096,
        maxRequestsPerHour: 200,
      });
    }
  }

  /**
   * 注册 API Key
   */
  registerApiKey(
    apiKey: string,
    clientId: string,
    permissionLevel: ACPPermissionLevel,
    scope: ACPPermissionScope
  ): void {
    this.apiKeys.set(apiKey, { clientId, permissionLevel, scope });
    Logger.info(
      `ACP API Key 已注册: ${clientId} (${permissionLevel})`,
      'ACPAuth'
    );
  }

  /**
   * 撤销 API Key
   */
  revokeApiKey(apiKey: string): boolean {
    return this.apiKeys.delete(apiKey);
  }

  /**
   * 认证请求
   */
  authenticate(apiKey: string): ACPAuthResult {
    const keyInfo = this.apiKeys.get(apiKey);
    if (!keyInfo) {
      return { authenticated: false, error: 'Invalid API key' };
    }

    const now = Date.now();
    const tokenId = `tk_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = now + 24 * 60 * 60 * 1000;

    const token: ACPAuthToken = {
      tokenId,
      clientId: keyInfo.clientId,
      permissionLevel: keyInfo.permissionLevel,
      scope: keyInfo.scope,
      issuedAt: now,
      expiresAt,
    };

    this.tokens.set(tokenId, token);
    return { authenticated: true, token };
  }

  /**
   * 验证令牌
   */
  validateToken(tokenId: string): ACPAuthToken | null {
    const token = this.tokens.get(tokenId);
    if (!token) return null;
    if (Date.now() > token.expiresAt) {
      this.tokens.delete(tokenId);
      return null;
    }
    return token;
  }

  /**
   * 撤销令牌
   */
  revokeToken(tokenId: string): boolean {
    return this.tokens.delete(tokenId);
  }

  /**
   * 检查工具权限
   */
  checkToolPermission(
    token: ACPAuthToken,
    toolName: string,
    toolCategory?: string
  ): ACPPermissionCheck {
    if (token.permissionLevel === 'denied') {
      return { allowed: false, reason: 'Access denied' };
    }

    if (token.permissionLevel === 'admin') {
      return { allowed: true };
    }

    if (token.scope.deniedTools?.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is denied for this token`,
      };
    }

    if (
      toolCategory &&
      token.scope.allowedCategories &&
      token.scope.allowedCategories.length > 0
    ) {
      if (!token.scope.allowedCategories.includes(toolCategory)) {
        return {
          allowed: false,
          reason: `Category '${toolCategory}' not allowed`,
        };
      }
    }

    if (token.permissionLevel === 'read') {
      const writeTools = [
        'shell_exec',
        'file_edit',
        'code_generate',
        'code_fix',
        'incremental_edit',
        'multi_file_edit',
      ];
      if (writeTools.includes(toolName)) {
        return {
          allowed: false,
          reason: `Write tool '${toolName}' requires write permission`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查文件路径权限
   */
  checkPathPermission(
    token: ACPAuthToken,
    filePath: string
  ): ACPPermissionCheck {
    if (token.permissionLevel === 'admin') {
      return { allowed: true };
    }

    if (token.scope.allowedPaths && token.scope.allowedPaths.length > 0) {
      const allowed = token.scope.allowedPaths.some((p) =>
        filePath.startsWith(p)
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Path '${filePath}' not in allowed paths`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查请求频率限制
   */
  checkRateLimit(token: ACPAuthToken): ACPPermissionCheck {
    const maxPerHour = token.scope.maxRequestsPerHour ?? 1000;
    const now = Date.now();
    const key = token.tokenId;
    const record = this.requestCounts.get(key);

    if (!record || now - record.windowStart > 3600000) {
      this.requestCounts.set(key, { count: 1, windowStart: now });
      return { allowed: true };
    }

    if (record.count >= maxPerHour) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${maxPerHour} requests/hour`,
      };
    }

    record.count += 1;
    return { allowed: true };
  }

  /**
   * 获取活跃令牌统计
   */
  getStats(): { activeTokens: number; registeredKeys: number } {
    const now = Date.now();
    let activeCount = 0;
    for (const [, token] of this.tokens) {
      if (now <= token.expiresAt) activeCount++;
    }
    return { activeTokens: activeCount, registeredKeys: this.apiKeys.size };
  }

  /**
   * 清理过期令牌
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, token] of this.tokens) {
      if (now > token.expiresAt) {
        this.tokens.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

/** ACP 权限守卫——在 ACPServer 处理请求前进行认证和权限检查 */
export class ACPPermissionGuard {
  private authManager: ACPAuthManager;

  constructor(authManager: ACPAuthManager) {
    this.authManager = authManager;
  }

  /**
   * 从请求头提取认证信息
   */
  extractAuth(headers: Record<string, string | undefined>): ACPAuthResult {
    const authHeader = headers['authorization'] || headers['Authorization'];
    if (!authHeader) {
      return { authenticated: false, error: 'Missing Authorization header' };
    }

    if (authHeader.startsWith('Bearer ')) {
      const tokenId = authHeader.slice(7);
      const token = this.authManager.validateToken(tokenId);
      if (token) {
        return { authenticated: true, token };
      }
      return { authenticated: false, error: 'Invalid or expired token' };
    }

    if (authHeader.startsWith('ApiKey ')) {
      const apiKey = authHeader.slice(7);
      return this.authManager.authenticate(apiKey);
    }

    return {
      authenticated: false,
      error: 'Unsupported auth scheme. Use Bearer or ApiKey',
    };
  }

  /**
   * 完整的请求权限检查
   */
  checkRequest(
    token: ACPAuthToken,
    options?: { toolName?: string; toolCategory?: string; filePath?: string }
  ): ACPPermissionCheck {
    const rateCheck = this.authManager.checkRateLimit(token);
    if (!rateCheck.allowed) return rateCheck;

    if (options?.toolName) {
      const toolCheck = this.authManager.checkToolPermission(
        token,
        options.toolName,
        options.toolCategory
      );
      if (!toolCheck.allowed) return toolCheck;
    }

    if (options?.filePath) {
      const pathCheck = this.authManager.checkPathPermission(
        token,
        options.filePath
      );
      if (!pathCheck.allowed) return pathCheck;
    }

    return { allowed: true };
  }
}

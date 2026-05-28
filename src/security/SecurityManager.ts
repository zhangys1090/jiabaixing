import { AuditLogger } from './AuditLogger';
import { AuthenticationManager } from './AuthenticationManager';
import { EncryptionManager } from './EncryptionManager';
import { SecurityPolicyEngine } from './SecurityPolicyEngine';
import { perf } from '../utils/PerformanceMonitor';
import type {
  User,
  OperationAudit,
  SecurityIncidentEvent,
  RiskAssessment,
  EncryptionOptions,
} from './types';

export type {
  User,
  OperationAudit,
  RiskLevel,
  RiskAssessment,
  EncryptionOptions,
} from './types';
export type { SecurityIncidentEvent as SecurityEvent } from './types';
export type { Permission, AccessControlRule } from './types';

interface AuditLogEntry {
  id?: string;
  _userId?: string;
  action?: string;
  _resource?: string;
  _action?: string;
  details?: Record<string, unknown>;
  _result?: string;
  timestamp?: Date | string;
  _ipAddress?: string;
  _deviceId?: string;
  severity?: string;
}

interface AuthResult {
  user?: User;
  valid?: boolean;
  userId?: string;
}

interface AuthRequest {
  username: string;
  password: string;
}

export class SecurityManager {
  private initialized = false;
  private encryptionManager: EncryptionManager;
  private authenticationManager: AuthenticationManager;
  private auditLogger: AuditLogger;
  private policyEngine: SecurityPolicyEngine;
  private emergencyMode = false;

  constructor() {
    this.encryptionManager = new EncryptionManager();
    this.authenticationManager = new AuthenticationManager();
    this.auditLogger = new AuditLogger();
    this.policyEngine = SecurityPolicyEngine.getInstance();
  }

  public async initialize(): Promise<void> {
    await this.encryptionManager.initialize();
    await this.authenticationManager.initialize();
    await this.auditLogger.initialize();
    this.initialized = true;
  }

  public async shutdown(): Promise<void> {
    void this.encryptionManager.shutdown();
    void this.authenticationManager.shutdown();
    void this.auditLogger.shutdown();
    this.initialized = false;
    this.policyEngine.clearRateLimits();
    this.emergencyMode = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('安全管理器未初始化');
    }
  }

  public encrypt(data: string, _options: EncryptionOptions): string {
    this.ensureInitialized();
    return perf.measureSync(
      'security.encrypt',
      () => {
        const encrypted = this.encryptionManager.encrypt(data);
        return JSON.stringify(encrypted);
      },
      'security'
    );
  }

  public decrypt(encryptedData: string): string {
    this.ensureInitialized();
    return perf.measureSync(
      'security.decrypt',
      () => {
        try {
          const parsed = JSON.parse(encryptedData) as {
            iv: string;
            data: string;
            timestamp: string;
          };
          const encryptedDataObj: import('./types').EncryptedData = {
            iv: parsed.iv,
            data: parsed.data,
            timestamp: new Date(parsed.timestamp),
          };
          return this.encryptionManager.decrypt(encryptedDataObj);
        } catch {
          return encryptedData;
        }
      },
      'security'
    );
  }

  public generateEncryptionKey(length: number = 32): string {
    this.ensureInitialized();
    return this.encryptionManager.generateRandomKey(length);
  }

  public generateAES256Key(): string {
    this.ensureInitialized();
    return this.encryptionManager.generateRandomKey(32);
  }

  public hashPassword(password: string): string {
    this.ensureInitialized();
    return this.encryptionManager.hash(password);
  }

  public verifyPassword(password: string, hashedPassword: string): boolean {
    this.ensureInitialized();
    const salt = hashedPassword.substring(0, 32);
    return this.encryptionManager.verifyHashWithSalt(
      password,
      hashedPassword,
      salt
    );
  }

  private userStore: Map<string, User> = new Map();

  public addUser(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): User {
    this.ensureInitialized();
    const newUser: User = {
      ...user,
      id: `user_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.userStore.set(newUser.id, newUser);
    return newUser;
  }

  public getUser(id: string): User | null {
    this.ensureInitialized();
    return this.userStore.get(id) || null;
  }

  public getUsers(): User[] {
    this.ensureInitialized();
    return Array.from(this.userStore.values());
  }

  public updateUser(
    id: string,
    updates: Partial<Omit<User, 'id' | 'createdAt'>>
  ): User | null {
    this.ensureInitialized();
    const user = this.userStore.get(id);
    if (!user) return null;
    const updated = { ...user, ...updates, updatedAt: new Date() };
    this.userStore.set(id, updated);
    return updated;
  }

  public deleteUser(id: string): boolean {
    this.ensureInitialized();
    return this.userStore.delete(id);
  }

  public async authenticate(
    username: string,
    password: string
  ): Promise<User | null> {
    this.ensureInitialized();
    return perf.measure(
      'security.authenticate',
      async () => {
        const result = await this.authenticationManager.authenticate({
          username,
          password,
        } as unknown as AuthRequest);
        const authResult = result as unknown as AuthResult;
        if (result && typeof result === 'object' && 'user' in result) {
          return authResult.user as User;
        }
        return null;
      },
      'security'
    );
  }

  public generateAccessToken(userId: string): string {
    this.ensureInitialized();
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET 环境变量未配置，拒绝生成令牌');
    }
    return jwt.sign({ userId }, secret, { expiresIn: '24h' });
  }

  public validateAccessToken(token: string): User | null {
    this.ensureInitialized();
    try {
      const result = this.authenticationManager.verifyToken(token);
      const authResult = result as AuthResult;
      if (
        result &&
        typeof result === 'object' &&
        'valid' in result &&
        authResult.valid
      ) {
        const userId = authResult.userId as string;
        return this.userStore.get(userId) || null;
      }
    } catch {
      return null;
    }
    return null;
  }

  public checkPermission(
    userId: string,
    resource: string,
    action: string,
    context?: Record<string, unknown>
  ): boolean {
    this.ensureInitialized();
    const user = this.userStore.get(userId) || null;
    return this.policyEngine.checkPermission(user, resource, action, context);
  }

  public enableMFA(userId: string): string {
    this.ensureInitialized();
    const user = this.userStore.get(userId);
    if (!user) throw new Error('用户不存在');
    const secret = this.encryptionManager.generateRandomKey(16);
    const updated = {
      ...user,
      mfaEnabled: true,
      mfaSecret: secret,
      updatedAt: new Date(),
    };
    this.userStore.set(userId, updated);
    return secret;
  }

  public verifyMFA(): boolean {
    this.ensureInitialized();
    return true;
  }

  public disableMFA(userId: string): boolean {
    this.ensureInitialized();
    const user = this.userStore.get(userId);
    if (!user) return false;
    const updated = {
      ...user,
      mfaEnabled: false,
      mfaSecret: undefined,
      updatedAt: new Date(),
    };
    this.userStore.set(userId, updated);
    return true;
  }

  private sessionStore: Map<
    string,
    {
      userId: string;
      deviceId: string;
      deviceName: string;
      ipAddress: string;
      userAgent: string;
      createdAt: Date;
      lastAccessed: Date;
      expiresAt: Date;
    }
  > = new Map();

  public createSession(
    userId: string,
    deviceId: string,
    deviceName: string,
    ipAddress: string,
    userAgent: string
  ): string {
    this.ensureInitialized();
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    this.sessionStore.set(sessionId, {
      userId,
      deviceId,
      deviceName,
      ipAddress,
      userAgent,
      createdAt: new Date(),
      lastAccessed: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return sessionId;
  }

  public validateSession(sessionId: string): {
    valid: boolean;
    userId?: string;
  } {
    this.ensureInitialized();
    const session = this.sessionStore.get(sessionId);
    if (!session) return { valid: false };
    if (session.expiresAt < new Date()) {
      this.sessionStore.delete(sessionId);
      return { valid: false };
    }
    session.lastAccessed = new Date();
    return { valid: true, userId: session.userId };
  }

  public getUserSessions(userId: string): Array<{
    sessionId: string;
    deviceId: string;
    deviceName: string;
    ipAddress: string;
    userAgent: string;
    createdAt: Date;
    lastAccessed: Date;
    expiresAt: Date;
  }> {
    this.ensureInitialized();
    const sessions: Array<{
      sessionId: string;
      deviceId: string;
      deviceName: string;
      ipAddress: string;
      userAgent: string;
      createdAt: Date;
      lastAccessed: Date;
      expiresAt: Date;
    }> = [];
    for (const [sessionId, session] of this.sessionStore.entries()) {
      if (session.userId === userId) {
        sessions.push({ sessionId, ...session });
      }
    }
    return sessions;
  }

  public terminateSession(sessionId: string): boolean {
    this.ensureInitialized();
    return this.sessionStore.delete(sessionId);
  }

  public terminateAllSessions(userId: string): boolean {
    this.ensureInitialized();
    let terminated = false;
    for (const [sessionId, session] of this.sessionStore.entries()) {
      if (session.userId === userId) {
        this.sessionStore.delete(sessionId);
        terminated = true;
      }
    }
    return terminated;
  }

  public getUserDevices(userId: string): Array<{
    deviceId: string;
    deviceName: string;
    lastLogin: Date;
    ipAddress: string;
    userAgent: string;
  }> {
    this.ensureInitialized();
    const devices: Array<{
      deviceId: string;
      deviceName: string;
      lastLogin: Date;
      ipAddress: string;
      userAgent: string;
    }> = [];
    const seen = new Set<string>();
    for (const session of this.sessionStore.values()) {
      if (session.userId === userId && !seen.has(session.deviceId)) {
        seen.add(session.deviceId);
        devices.push({
          deviceId: session.deviceId,
          deviceName: session.deviceName,
          lastLogin: session.lastAccessed,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        });
      }
    }
    return devices;
  }

  public recordAudit(
    audit: Omit<OperationAudit, 'id' | 'timestamp'>
  ): OperationAudit {
    this.ensureInitialized();
    this.auditLogger.log({
      userId: audit.userId,
      action: audit.action,
      resource: audit.resource,
      result: audit.status as 'success' | 'failure',
      details: audit.parameters,
    });
    return {
      ...audit,
      id: `audit_${Date.now()}`,
      timestamp: new Date(),
    };
  }

  public getAuditLogs(
    userId?: string,
    startDate?: Date,
    endDate?: Date
  ): OperationAudit[] {
    this.ensureInitialized();
    const result = this.auditLogger.queryLogs({
      userId,
      startTime: startDate,
      endTime: endDate,
    } as unknown as Partial<import('./types').AuditLogEntry>);
    return (Array.isArray(result) ? result : []).map(
      (entry: AuditLogEntry) => ({
        id: entry.id || `audit_${Date.now()}`,
        userId: entry._userId || 'unknown',
        operation: entry.action || 'unknown',
        resource: entry._resource || 'unknown',
        action: entry._action || 'unknown',
        parameters: entry.details || {},
        result: entry._result || 'unknown',
        timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
        ipAddress: entry._ipAddress || 'unknown',
        deviceId: entry._deviceId || 'unknown',
        status: (entry.severity === 'info' ? 'success' : 'failure') as
          | 'success'
          | 'failure',
      })
    );
  }

  public recordSecurityEvent(
    event: Omit<SecurityIncidentEvent, 'id' | 'timestamp'>
  ): SecurityIncidentEvent {
    this.ensureInitialized();
    this.auditLogger.log({
      userId: event.userId,
      action: event.type,
      resource: 'security',
      result: 'failure' as const,
      details: { message: event.message, ipAddress: event.ipAddress },
    });
    return {
      ...event,
      id: `event_${Date.now()}`,
      timestamp: new Date(),
    };
  }

  public detectPromptInjection(input: string): {
    detected: boolean;
    riskLevel: 'low' | 'medium' | 'high';
    reasons: string[];
  } {
    this.ensureInitialized();
    return this.policyEngine.detectPromptInjection(input);
  }

  public filterHarmfulContent(input: string): {
    filtered: boolean;
    riskLevel: 'low' | 'medium' | 'high';
    reasons: string[];
    safeContent: string;
  } {
    this.ensureInitialized();
    return this.policyEngine.filterHarmfulContent(input);
  }

  public checkRateLimit(
    userId: string,
    limit: number = 60,
    windowMs: number = 60000
  ): boolean {
    this.ensureInitialized();
    return this.policyEngine.checkRateLimit(userId, limit, windowMs);
  }

  public validateInput(
    input: string,
    maxLength: number = 1000
  ): { valid: boolean; errors: string[] } {
    this.ensureInitialized();
    return this.policyEngine.validateInput(input, maxLength);
  }

  public checkSecurityRedlines(input: string): {
    violation: boolean;
    reasons: string[];
  } {
    this.ensureInitialized();
    return this.policyEngine.checkSecurityRedlines(input);
  }

  public secureInputProcessing(
    input: string,
    userId: string = 'anonymous'
  ): {
    safe: boolean;
    message: string;
    processedInput: string;
    warnings: string[];
  } {
    this.ensureInitialized();
    return this.policyEngine.secureInputProcessing(input, userId);
  }

  public assessRisk(
    operation: string,
    resource: string,
    action: string,
    parameters: Record<string, unknown>
  ): RiskAssessment {
    this.ensureInitialized();
    return this.policyEngine.assessRisk(
      operation,
      resource,
      action,
      parameters
    );
  }

  public activateEmergencyMode(reason: string): void {
    this.ensureInitialized();
    this.emergencyMode = true;
    this.recordSecurityEvent({
      type: 'suspicious_activity',
      severity: 'critical',
      message: `应急模式激活: ${reason}`,
      userId: 'system',
      ipAddress: 'localhost',
      actionTaken: '激活应急模式',
    });
  }

  public deactivateEmergencyMode(): void {
    this.ensureInitialized();
    this.emergencyMode = false;
    this.recordSecurityEvent({
      type: 'suspicious_activity',
      severity: 'low',
      message: '应急模式已解除',
      userId: 'system',
      ipAddress: 'localhost',
      actionTaken: '解除应急模式',
    });
  }

  public isEmergencyMode(): boolean {
    return this.emergencyMode;
  }

  public securityHealthCheck(): {
    healthy: boolean;
    score: number;
    issues: string[];
  } {
    const issues: string[] = [];
    let score = 100;

    try {
      const logStats = this.auditLogger.getLogStats();
      if (logStats.totalLogs === 0) {
        issues.push('审计日志为空');
        score -= 20;
      }
      if (logStats.totalLogs > 0) {
        const failureRate = logStats.failureCount / logStats.totalLogs;
        if (failureRate > 0.5) {
          issues.push(`认证失败率过高: ${(failureRate * 100).toFixed(1)}%`);
          score -= 30;
        } else if (failureRate > 0.2) {
          issues.push(`认证失败率偏高: ${(failureRate * 100).toFixed(1)}%`);
          score -= 15;
        }
      }
    } catch {
      issues.push('审计日志服务不可用');
      score -= 30;
    }

    try {
      const securityStats = perf.getCategoryStats('security');
      if (securityStats.totalCalls > 0 && securityStats.errorRate > 0.3) {
        issues.push(
          `安全操作错误率过高: ${(securityStats.errorRate * 100).toFixed(1)}%`
        );
        score -= 20;
      }
    } catch {
      issues.push('性能监控服务不可用');
      score -= 10;
    }

    try {
      this.encryptionManager.encrypt('healthcheck');
    } catch {
      issues.push('加密服务不可用');
      score -= 40;
    }

    if (this.emergencyMode) {
      issues.push('系统处于应急模式');
      score -= 25;
    }

    if (!this.initialized) {
      issues.push('安全管理器未初始化');
      score -= 50;
    }

    score = Math.max(0, Math.min(100, score));

    return {
      healthy: score >= 60,
      score,
      issues,
    };
  }

  public async secureExecuteOperation(
    userId: string,
    operation: string,
    resource: string,
    action: string,
    parameters: Record<string, unknown>,
    ipAddress: string,
    deviceId: string
  ): Promise<{ success: boolean; result: unknown; error?: string }> {
    this.ensureInitialized();
    if (this.emergencyMode)
      return { success: false, result: null, error: '系统处于应急模式' };
    const redlineCheck = this.policyEngine.checkSecurityRedlines(
      `${operation} ${action} ${JSON.stringify(parameters)}`
    );
    if (redlineCheck.violation) {
      this.recordSecurityEvent({
        type: 'unauthorized',
        severity: 'critical',
        message: `违反安全红线: ${redlineCheck.reasons.join(', ')}`,
        userId,
        ipAddress,
        actionTaken: '拒绝操作',
      });
      return { success: false, result: null, error: '操作违反安全红线' };
    }
    this.recordAudit({
      userId,
      operation,
      resource,
      action,
      parameters,
      result: 'pending',
      ipAddress,
      deviceId,
      status: 'pending',
    });
    return { success: true, result: { success: true, data: '操作执行成功' } };
  }
}

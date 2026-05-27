/**
 * 认证管理器 - 处理用户认证和授权
 */

import bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { Logger } from '../utils/Logger';
import { AuditLogger } from './AuditLogger';
import { AuthConfig, AuthRequest, AuthResponse, UserAuthInfo } from './types';

/**
 * 默认认证配置
 * 注意：JWT secret 必须通过环境变量配置，禁止硬编码
 */
const DEFAULT_AUTH_CONFIG: AuthConfig = {
  password: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecialChar: true,
    saltRounds: 10,
    maxAttempts: 5,
    lockoutDuration: 300, // 5分钟
  },
  voiceprint: {
    enabled: false,
    threshold: 0.8,
  },
  jwt: {
    secret: '', // 必须在初始化时从环境变量设置
    expiresIn: '24h',
    refreshExpiresIn: '7d',
  },
};

/**
 * 用户认证信息存储（临时实现，后续应替换为持久化存储）
 */
interface UserStorage {
  [username: string]: {
    passwordHash: string;
    userId: string;
    email?: string;
    phone?: string;
    voiceprintData?: string;
    failedAttempts: number;
    lastFailedAttempt?: Date;
    lockedUntil?: Date;
    roles: string[];
  };
}

/**
 * 认证管理器类
 */
export class AuthenticationManager {
  private config: AuthConfig;
  private userStorage: UserStorage = {};
  private initialized: boolean = false;
  private auditLogger?: AuditLogger;

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
  }

  /**
   * 设置审计日志器
   */
  public setAuditLogger(auditLogger: AuditLogger): void {
    this.auditLogger = auditLogger;
  }

  /**
   * 初始化认证管理器
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // JWT secret 必须从环境变量获取，禁止使用空值
      const envJwtSecret = process.env.JWT_SECRET;
      if (!envJwtSecret) {
        throw new Error('JWT_SECRET 环境变量未配置，拒绝启动认证服务');
      }
      this.config.jwt.secret = envJwtSecret;

      this.initializeUserStorage();

      this.initialized = true;
    } catch (error) {
      Logger.error('❌ 认证管理器：初始化失败:', error as Error);
      throw error;
    }
  }

  /**
   * 初始化用户存储（临时实现）
   */
  private initializeUserStorage(): void {
    // 创建默认用户（仅用于测试，生产环境应通过注册流程创建）
    const defaultPasswordHash = bcrypt.hashSync(
      'password123!',
      this.config.password.saltRounds || 10
    );

    this.userStorage = {
      admin: {
        passwordHash: defaultPasswordHash,
        userId: 'admin-001',
        email: 'admin@example.com',
        failedAttempts: 0,
        roles: ['admin', 'user'],
      },
      user: {
        passwordHash: defaultPasswordHash,
        userId: 'user-001',
        email: 'user@example.com',
        failedAttempts: 0,
        roles: ['user'],
      },
    };
  }

  /**
   * 验证密码强度
   */
  public validatePasswordStrength(password: string): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (password.length < this.config.password.minLength) {
      errors.push(
        `密码长度必须至少为 ${this.config.password.minLength} 个字符`
      );
    }

    if (this.config.password.requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('密码必须包含至少一个大写字母');
    }

    if (this.config.password.requireLowercase && !/[a-z]/.test(password)) {
      errors.push('密码必须包含至少一个小写字母');
    }

    if (this.config.password.requireNumber && !/\d/.test(password)) {
      errors.push('密码必须包含至少一个数字');
    }

    if (
      this.config.password.requireSpecialChar &&
      !/[^A-Za-z0-9]/.test(password)
    ) {
      errors.push('密码必须包含至少一个特殊字符');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 检查用户是否被锁定
   */
  private isUserLocked(username: string): boolean {
    const user = this.userStorage[username];
    if (!user) return false;

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return true;
    }

    // 解锁用户
    if (user.lockedUntil && user.lockedUntil <= new Date()) {
      user.lockedUntil = undefined;
      user.failedAttempts = 0;
    }

    return false;
  }

  /**
   * 处理登录失败
   */
  private handleLoginFailure(username: string): void {
    const user = this.userStorage[username];
    if (!user) return;

    user.failedAttempts++;
    user.lastFailedAttempt = new Date();

    // 检查是否需要锁定用户
    if (user.failedAttempts >= this.config.password.maxAttempts) {
      user.lockedUntil = new Date(
        Date.now() + this.config.password.lockoutDuration * 1000
      );
      Logger.warn(
        `🔒 用户 ${username} 已被锁定，锁定时间：${user.lockedUntil}`
      );
    }
  }

  /**
   * 验证声纹（临时实现，后续应集成实际的声纹识别库）
   */
  private async verifyVoiceprint(
    voiceprintData: string,
    storedVoiceprintData?: string
  ): Promise<boolean> {
    // 临时实现：简单比较声纹数据
    // 实际实现应使用专业的声纹识别算法
    if (!storedVoiceprintData) return false;

    // 模拟声纹匹配，实际应使用相似度算法
    return voiceprintData === storedVoiceprintData;
  }

  /**
   * 用户认证
   */
  public async authenticate(request: AuthRequest): Promise<AuthResponse> {
    try {
      const { username, password, voiceprintData, deviceId } = request;

      // 检查用户是否存在
      const user = this.userStorage[username];
      if (!user) {
        this.logAudit(undefined, 'authentication.failure', {
          username,
          reason: '用户不存在',
          deviceId,
        });
        return { success: false, error: '用户名或密码错误' };
      }

      // 检查用户是否被锁定
      if (this.isUserLocked(username)) {
        this.logAudit(user.userId, 'authentication.failure', {
          username,
          reason: '用户已被锁定',
          deviceId,
        });
        return { success: false, error: '账户已被锁定，请稍后再试' };
      }

      let authenticated = false;

      // 密码认证
      if (password) {
        authenticated = await bcrypt.compare(password, user.passwordHash);
      }

      // 声纹认证（如果启用且提供了声纹数据）
      if (!authenticated && this.config.voiceprint.enabled && voiceprintData) {
        authenticated = await this.verifyVoiceprint(
          voiceprintData,
          user.voiceprintData
        );
      }

      if (!authenticated) {
        // 处理登录失败
        this.handleLoginFailure(username);
        this.logAudit(user.userId, 'authentication.failure', {
          username,
          reason: '认证失败',
          deviceId,
        });
        return { success: false, error: '用户名或密码错误' };
      }

      // 认证成功，重置失败尝试次数
      user.failedAttempts = 0;
      user.lastFailedAttempt = undefined;

      // 生成JWT令牌
      const token = jwt.sign(
        { userId: user.userId, username, roles: user.roles },
        this.config.jwt.secret,
        { expiresIn: this.config.jwt.expiresIn } as jwt.SignOptions
      );

      const refreshToken = jwt.sign(
        { userId: user.userId, username },
        this.config.jwt.secret,
        { expiresIn: this.config.jwt.refreshExpiresIn } as jwt.SignOptions
      );

      // 构建用户认证信息
      const userAuthInfo: UserAuthInfo = {
        userId: user.userId,
        username,
        email: user.email,
        phone: user.phone,
        isAuthenticated: true,
        lastLogin: new Date(),
        roles: user.roles,
      };

      // 记录审计日志
      this.logAudit(user.userId, 'authentication.success', {
        username,
        deviceId,
        userId: user.userId,
      });

      return {
        success: true,
        token,
        refreshToken,
        user: userAuthInfo,
      };
    } catch (error) {
      Logger.error('❌ 认证失败:', error as Error);
      this.logAudit(undefined, 'authentication.failure', {
        username: request.username,
        reason: '系统错误',
        error: (error as Error).message,
      });
      return { success: false, error: '认证过程中发生错误，请稍后再试' };
    }
  }

  /**
   * 验证令牌
   */
  public verifyToken(token: string): {
    valid: boolean;
    payload?: unknown;
    error?: string;
  } {
    try {
      const payload = jwt.verify(token, this.config.jwt.secret);
      return { valid: true, payload };
    } catch (error) {
      return { valid: false, error: (error as Error).message };
    }
  }

  /**
   * 刷新令牌
   */
  public refreshToken(refreshToken: string): {
    success: boolean;
    token?: string;
    error?: string;
  } {
    try {
      const payload = jwt.verify(refreshToken, this.config.jwt.secret) as {
        username: string;
      };

      // 检查用户是否存在
      const user = this.userStorage[payload.username];
      if (!user) {
        return { success: false, error: '用户不存在' };
      }

      // 生成新的访问令牌
      const newToken = jwt.sign(
        {
          userId: user.userId,
          username: payload.username,
          roles: user.roles,
        },
        this.config.jwt.secret,
        { expiresIn: this.config.jwt.expiresIn } as jwt.SignOptions
      );

      return { success: true, token: newToken };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 注册新用户
   */
  public async register(
    username: string,
    password: string,
    email?: string,
    phone?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 检查用户是否已存在
      if (this.userStorage[username]) {
        return { success: false, error: '用户名已存在' };
      }

      // 验证密码强度
      const passwordValidation = this.validatePasswordStrength(password);
      if (!passwordValidation.valid) {
        return { success: false, error: passwordValidation.errors.join('; ') };
      }

      // 哈希密码
      const passwordHash = await bcrypt.hash(
        password,
        this.config.password.saltRounds || 10
      );

      // 创建新用户
      const newUser = {
        passwordHash,
        userId: `user-${Date.now()}`,
        email,
        phone,
        failedAttempts: 0,
        roles: ['user'],
      };

      // 保存到用户存储
      this.userStorage[username] = newUser;

      // 记录审计日志
      this.logAudit(newUser.userId, 'authentication.success', {
        username,
        reason: '用户注册成功',
      });

      return { success: true };
    } catch (error) {
      Logger.error('❌ 用户注册失败:', error as Error);
      this.logAudit(undefined, 'authentication.failure', {
        username,
        reason: '用户注册失败',
        error: (error as Error).message,
      });
      return { success: false, error: '注册过程中发生错误，请稍后再试' };
    }
  }

  /**
   * 记录审计日志
   */
  private logAudit(
    userId: string | undefined,
    action: string,
    details: Record<string, unknown>
  ): void {
    if (this.auditLogger) {
      this.auditLogger.log({
        userId: userId || 'unknown',
        action,
        resource: 'authentication',
        result: action.includes('success') ? 'success' : 'failure',
        details,
      });
    }
  }

  /**
   * 关闭认证管理器
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    Logger.info('🔑 认证管理器：关闭中...');

    // 清理资源
    this.userStorage = {};
    this.initialized = false;

    Logger.info('✅ 认证管理器：关闭完成！');
  }
}

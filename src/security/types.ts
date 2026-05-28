/**
 * 安全模块类型定义
 */

/**
 * 认证配置
 */
export interface AuthConfig {
  // 密码认证配置
  password: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumber: boolean;
    requireSpecialChar: boolean;
    saltRounds: number;
    maxAttempts: number;
    lockoutDuration: number; // 秒
  };
  // 声纹认证配置
  voiceprint: {
    enabled: boolean;
    threshold: number;
  };
  // JWT配置
  jwt: {
    secret: string;
    expiresIn: string;
    refreshExpiresIn: string;
  };
}

/**
 * 权限配置
 */
export interface PermissionConfig {
  // 权限级别定义
  levels: {
    low: {
      name: string;
      description: string;
      requireConfirmation: boolean;
    };
    medium: {
      name: string;
      description: string;
      requireConfirmation: boolean;
    };
    high: {
      name: string;
      description: string;
      requireMultiFactor: boolean;
    };
  };
  // 默认权限
  defaultLevel: 'low' | 'medium' | 'high';
}

/**
 * 加密配置
 */
export interface EncryptionConfig {
  // AES加密配置
  aes: {
    keySize: 128 | 192 | 256;
    ivSize: number;
    algorithm: string;
  };
  // 哈希配置
  hash: {
    algorithm: string;
    saltRounds: number;
  };
  // 密钥管理配置
  keyManagement: {
    keyStorePath: string;
    backupEnabled: boolean;
    backupInterval: number; // 秒
  };
}

/**
 * 审计日志配置
 */
export interface AuditConfig {
  // 日志级别
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  // 日志存储配置
  storage: {
    type: 'file' | 'database';
    path?: string;
    maxSize?: number; // MB
    maxFiles?: number;
  };
  // 日志保留时间（天）
  retentionDays: number;
  // 是否启用实时监控
  realtimeMonitoring: boolean;
}

/**
 * 安全配置
 */
export interface SecurityConfig {
  auth?: Partial<AuthConfig>;
  permission?: Partial<PermissionConfig>;
  encryption?: Partial<EncryptionConfig>;
  audit?: Partial<AuditConfig>;
}

/**
 * 用户认证信息
 */
export interface UserAuthInfo {
  userId: string;
  username: string;
  email?: string;
  phone?: string;
  isAuthenticated: boolean;
  lastLogin?: Date;
  roles: string[];
}

/**
 * 认证请求
 */
export interface AuthRequest {
  username: string;
  password?: string;
  voiceprintData?: string;
  deviceId?: string;
}

/**
 * 认证响应
 */
export interface AuthResponse {
  success: boolean;
  token?: string;
  refreshToken?: string;
  user?: UserAuthInfo;
  error?: string;
}

/**
 * 权限检查请求
 */
export interface PermissionCheckRequest {
  userId: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

/**
 * 权限检查响应
 */
export interface PermissionCheckResponse {
  allowed: boolean;
  reason?: string;
  requiredConfirmation?: boolean;
  requiredMultiFactor?: boolean;
}

/**
 * 审计日志条目
 */
export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  userId: string;
  action: string;
  resource: string;
  actor?: string;
  target?: string;
  category?: string;
  ipAddress?: string;
  deviceId?: string;
  userAgent?: string;
  result: 'success' | 'failure' | 'warning';
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * 加密数据结构
 */
export interface EncryptedData {
  iv: string;
  data: string;
  salt?: string;
  timestamp: Date;
}

/**
 * 安全事件类型
 */
export type SecurityEventType =
  | 'authentication.success'
  | 'authentication.failure'
  | 'permission.granted'
  | 'permission.denied'
  | 'data.encrypted'
  | 'data.decrypted'
  | 'audit.log.created'
  | 'security.alarm';

/**
 * 安全事件
 */
export interface SecurityEvent {
  type: SecurityEventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
  permissions: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  voicePrint?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationAudit {
  id: string;
  userId: string;
  operation: string;
  resource: string;
  action: string;
  parameters: Record<string, unknown>;
  result: string;
  timestamp: Date;
  ipAddress: string;
  deviceId: string;
  status: 'success' | 'failure' | 'pending';
}

export interface SecurityIncidentEvent {
  id: string;
  type:
    | 'injection'
    | 'unauthorized'
    | 'rate_limit'
    | 'harmful_content'
    | 'suspicious_activity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  userId: string;
  ipAddress: string;
  timestamp: Date;
  actionTaken: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  requiredActions: string[];
}

export interface Permission {
  id: string;
  name: string;
  description: string;
  resource: string;
  action: 'read' | 'write' | 'delete' | 'execute' | 'process';
  createdAt: Date;
}

export interface EncryptionOptions {
  algorithm: string;
  key: string;
  iv?: string;
  encoding?: 'utf8' | 'base64' | 'hex';
}

export interface AccessControlRule {
  id: string;
  resource: string;
  actions: string[];
  roles: string[];
  conditions?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  priority: number;
  createdAt: Date;
}

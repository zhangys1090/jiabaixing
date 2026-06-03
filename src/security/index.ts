/**
 * 安全模块统一导出
 *
 * 整合了 AuditLogger、AuditService、DataSovereigntyPipeline 的导出
 * 提供统一的审计日志和安全事件管理接口
 */

// ── 核心服务 ──
export { AuditService } from './AuditService';
export type { AuditServiceConfig, AuditReport } from './AuditService';

// ── 审计日志器 ──
export { AuditLogger } from './AuditLogger';
export type { AuditLogStats, ExportOptions } from './AuditLogger';

// ── 数据主权审计管道 ──
export { DataSovereigntyPipeline } from './DataSovereigntyPipeline';
export type { DataAccessRecord, DataSovereigntyReport } from './DataSovereigntyPipeline';

// ── 类型定义 ──
export type {
  AuthConfig,
  PermissionConfig,
  EncryptionConfig,
  AuditConfig,
  SecurityConfig,
  UserAuthInfo,
  AuthRequest,
  AuthResponse,
  PermissionCheckRequest,
  PermissionCheckResponse,
  AuditLogEntry,
  EncryptedData,
  SecurityEventType,
  SecurityEvent,
  User,
  OperationAudit,
  SecurityIncidentEvent,
  RiskLevel,
  RiskAssessment,
  Permission,
  EncryptionOptions,
  AccessControlRule,
} from './types';

/**
 * 安全模块统一导出
 *
 * 整合了 AuditLogger、AuditService、DataSovereigntyPipeline 的导出
 * 提供统一的审计日志和安全事件管理接口
 */

// ── 核心服务 ──
export { AuditService } from './AuditService';
export type { AuditReport, AuditServiceConfig } from './AuditService';

// ── 审计日志器 ──
export { AuditLogger } from './AuditLogger';
export type { AuditLogStats, ExportOptions } from './AuditLogger';

// ── 数据主权审计管道 ──
export { DataSovereigntyPipeline } from './DataSovereigntyPipeline';
export type {
  DataAccessRecord,
  DataSovereigntyReport,
} from './DataSovereigntyPipeline';

// ── URL 安全检查 ──
export { UrlSafetyChecker } from './UrlSafetyChecker';
export type { UrlSafetyResult } from './UrlSafetyChecker';

// ── SSL 证书守卫 ──
export { SslGuard } from './SslGuard';
export type { SslCheckResult, SslGuardConfig } from './SslGuard';

// ── Shell 命令钩子 ──
export { registerBuiltinShellHooks, ShellHooks } from './ShellHooks';
export type {
  ShellHookContext,
  ShellHookEntry,
  ShellHookFn,
  ShellHookResult,
} from './ShellHooks';

// ── 敏感信息检测（从 harness 模块重新导出） ──
export {
  checkDangerousCommand,
  checkSensitiveInfo,
  sanitizeText,
} from '../harness/security/SensitiveDetector';
export type {
  SensitiveCheckResult,
  SensitiveCheckScene,
  SensitiveViolation,
} from '../harness/security/SensitiveDetector';

// ── 类型定义 ──
export type {
  AccessControlRule,
  AuditConfig,
  AuditLogEntry,
  AuthConfig,
  AuthRequest,
  AuthResponse,
  EncryptedData,
  EncryptionConfig,
  EncryptionOptions,
  OperationAudit,
  Permission,
  PermissionCheckRequest,
  PermissionCheckResponse,
  PermissionConfig,
  RiskAssessment,
  RiskLevel,
  SecurityConfig,
  SecurityEvent,
  SecurityEventType,
  SecurityIncidentEvent,
  User,
  UserAuthInfo,
} from './types';

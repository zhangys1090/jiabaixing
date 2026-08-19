export {
  endSpan,
  getMeter,
  getTracer,
  measure,
  measureSync,
  perf,
  PerformanceMonitor,
  recordOTelRequest,
  shutdownOTel,
  startOTelSpan,
  startSpan,
} from './PerformanceMonitor';
export type {
  OTelConfig,
  PerformanceAlert,
  PerformanceConfig,
  PerformanceMetric,
  PerformanceMetrics,
  PerformanceReport,
  PerformanceStats,
} from './PerformanceMonitor';

// ── SecurityAuditor 兼容层导出 ──
export { SecurityAuditor } from './SecurityAuditor';
export type { AuditLogEntry, SecurityEvent } from './SecurityAuditor';

// ── 统一审计服务导出 ──
export { AuditService } from '../security/AuditService';
export type { AuditReport } from '../security/AuditService';
export type { SecurityEvent as UnifiedSecurityEvent } from '../security/types';

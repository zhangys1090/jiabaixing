/**
 * 兼容层：重新导出 monitoring/PerformanceMonitor
 *
 * 原细粒度 span 追踪功能已合并到 monitoring/PerformanceMonitor
 * 此文件仅保留向后兼容的 re-export
 */

export {
  PerformanceMonitor,
  perf,
  measure,
  measureSync,
  startSpan,
  endSpan,
} from '../monitoring/PerformanceMonitor';

export type {
  PerformanceMetric,
  PerformanceStats,
  PerformanceReport,
} from '../monitoring/PerformanceMonitor';

export { PerformanceMonitor as default } from '../monitoring/PerformanceMonitor';

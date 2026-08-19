/**
 * CapabilityMetrics — 核心能力结构化监控
 *
 * 跟踪两类能力指标：
 * 1. 智能能力命中率/成功率（反思重试、知识图谱、记忆检索、经验复用）
 * 2. D4 (P2 第4轮) 九大能力类别 — 由 ToolRegistry 统一执行包装层按工具类别
 *    (memory/file/code/desktop/cognition/system/daily/network/perception) 记录每次
 *    调用的成功/失败，激活此前零调用的 CapabilityMetrics。
 *
 * 用法：
 *   import { capMetrics } from '../../monitoring/CapabilityMetrics';
 *   capMetrics.record('reflection_retry', true);  // 反思重试成功
 *   capMetrics.record('knowledge_hit', false);    // 知识图谱未命中
 *   capMetrics.summary()  // 输出当前统计
 */
import { EventBus } from '../shared/EventBus';

interface MetricCounter {
  total: number;
  success: number;
  label: string;
}

type MetricKey =
  | 'reflection_retry'
  | 'reflection_deep'
  | 'knowledge_hit'
  | 'memory_retrieval'
  | 'experience_reuse'
  // D4 (P2 第4轮): 九大能力类别 — 由 ToolRegistry.recordCapability 按工具类别记录成功/失败
  | 'memory'
  | 'file'
  | 'code'
  | 'desktop'
  | 'cognition'
  | 'system'
  | 'daily'
  | 'network'
  | 'perception';

const METRIC_LABELS: Record<MetricKey, string> = {
  reflection_retry: '反思重试',
  reflection_deep: '深度反思',
  knowledge_hit: '知识图谱命中',
  memory_retrieval: '记忆检索',
  experience_reuse: '经验复用',
  // D4 九大能力类别
  memory: '记忆能力',
  file: '文件能力',
  code: '代码能力',
  desktop: '桌面能力',
  cognition: '认知能力',
  system: '系统能力',
  daily: '日常能力',
  network: '网络能力',
  perception: '感知能力',
};

class CapabilityMetrics {
  private counters: Record<MetricKey, MetricCounter> = {} as Record<
    MetricKey,
    MetricCounter
  >;

  constructor() {
    for (const key of Object.keys(METRIC_LABELS) as MetricKey[]) {
      this.counters[key] = { total: 0, success: 0, label: METRIC_LABELS[key] };
    }
  }

  /** 记录一次指标 (total+1, success 表示本次是否成功)
   *  key 接受能力键名（含 D4 九大能力类别）；未知 key 静默跳过，不抛错。 */
  record(key: string, success: boolean): void {
    const c = this.counters[key as MetricKey];
    if (!c) return;
    c.total++;
    if (success) c.success++;
  }

  /** 获取特定指标 */
  get(key: MetricKey): MetricCounter {
    return this.counters[key] || { total: 0, success: 0, label: key };
  }

  /** 获取全部指标的汇总统计 */
  summary(): string {
    const lines: string[] = ['📊 核心能力指标报告'];
    for (const key of Object.keys(this.counters) as MetricKey[]) {
      const c = this.counters[key];
      if (c.total === 0) continue;
      const rate = ((c.success / c.total) * 100).toFixed(1);
      lines.push(`  ${c.label}: ${c.success}/${c.total} (${rate}%)`);
    }
    if (lines.length === 1) lines.push('  (无数据)');
    return lines.join('\n');
  }

  /** 获取结构化数据 */
  toJSON(): Record<string, { total: number; success: number; rate: number }> {
    const result: Record<
      string,
      { total: number; success: number; rate: number }
    > = {};
    for (const key of Object.keys(this.counters) as MetricKey[]) {
      const c = this.counters[key];
      result[key] = {
        total: c.total,
        success: c.success,
        rate: c.total > 0 ? c.success / c.total : 0,
      };
    }
    return result;
  }

  /** 通过 EventBus 发出当前指标 */
  emitReport(): void {
    const data = this.toJSON();
    for (const [capability, stats] of Object.entries(data)) {
      EventBus.emit('capability_metrics', {
        capability,
        score: stats.rate,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export const capMetrics = new CapabilityMetrics();

/**
 * 报告能力指标（供 cron/reporter 使用）
 */
export function generateCapabilityReport(): string {
  return capMetrics.summary();
}

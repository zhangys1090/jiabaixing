/**
 * Harness Layer 4: Persistence - Trajectory Query Service
 *
 * 轨迹查询服务，提供失败执行、工具成功率、质量趋势等分析
 */

import type { TrajectoryDatabase } from './TrajectoryDatabase';
import type { ExecutionRecord } from './TrajectoryDatabase';

export interface FailedExecutionsOptions {
  category?: string;
  limit?: number;
}

export interface ToolSuccessRate {
  total: number;
  success: number;
  rate: number;
}

export interface HourlyQuality {
  hour: number;
  avgScore: number;
  count: number;
}

export interface DailyTrend {
  date: string;
  avgScore: number;
  avgDuration: number;
  count: number;
}

export class TrajectoryQueryService {
  private db: TrajectoryDatabase;

  constructor(db: TrajectoryDatabase) {
    this.db = db;
  }

  getFailedExecutions(
    options: FailedExecutionsOptions = {}
  ): ExecutionRecord[] {
    const limit = options.limit || 50;
    const category = options.category;

    if (category) {
      const allFailed = this.db
        .getRecentExecutions(1000)
        .filter((e) => e.status === 'failed' || e.status === 'aborted');
      return allFailed
        .filter((e) => {
          const inputLower = e.input.toLowerCase();
          return inputLower.includes(category.toLowerCase());
        })
        .slice(0, limit);
    }

    const recent = this.db.getRecentExecutions(1000);
    return recent
      .filter((e) => e.status === 'failed' || e.status === 'aborted')
      .slice(0, limit);
  }

  getToolSuccessRates(
    options: { since?: number } = {}
  ): Record<string, ToolSuccessRate> {
    const since = options.since || Date.now() - 7 * 24 * 60 * 60 * 1000;

    const recent = this.db.getRecentExecutions(1000);
    const executionIds = new Set(
      recent.filter((e) => e.created_at >= since).map((e) => e.id)
    );

    if (executionIds.size === 0) {
      return {};
    }

    const toolStats: Record<string, { total: number; success: number }> = {};

    for (const execId of executionIds) {
      const invocations = this.db.getToolInvocations(execId);
      for (const inv of invocations) {
        if (!toolStats[inv.tool_name]) {
          toolStats[inv.tool_name] = { total: 0, success: 0 };
        }
        toolStats[inv.tool_name].total++;
        if (inv.result_success === 1) {
          toolStats[inv.tool_name].success++;
        }
      }
    }

    const result: Record<string, ToolSuccessRate> = {};
    for (const [toolName, stats] of Object.entries(toolStats)) {
      result[toolName] = {
        total: stats.total,
        success: stats.success,
        rate: stats.total > 0 ? stats.success / stats.total : 0,
      };
    }

    return result;
  }

  getAverageQualityByHour(): HourlyQuality[] {
    const recent = this.db.getRecentExecutions(500);
    const scoredExecutions = recent.filter(
      (e) => e.quality_overall !== null && e.quality_overall !== undefined
    );

    if (scoredExecutions.length === 0) {
      return [];
    }

    const hourBuckets: Record<number, { total: number; count: number }> = {};

    for (const exec of scoredExecutions) {
      const date = new Date(exec.created_at);
      const hour = date.getHours();
      if (!hourBuckets[hour]) {
        hourBuckets[hour] = { total: 0, count: 0 };
      }
      hourBuckets[hour].total += exec.quality_overall!;
      hourBuckets[hour].count++;
    }

    const result: HourlyQuality[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const bucket = hourBuckets[hour];
      result.push({
        hour,
        avgScore: bucket ? bucket.total / bucket.count : 0,
        count: bucket ? bucket.count : 0,
      });
    }

    return result;
  }

  getRecentTrend(days: number): DailyTrend[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = this.db.getRecentExecutions(1000);

    const dayBuckets: Record<
      string,
      { totalScore: number; totalDuration: number; count: number }
    > = {};

    for (const exec of recent) {
      if (!exec.created_at || exec.created_at < since) continue;

      const date = new Date(exec.created_at);
      if (isNaN(date.getTime())) continue;

      const dateStr = date.toISOString().split('T')[0];

      if (!dayBuckets[dateStr]) {
        dayBuckets[dateStr] = { totalScore: 0, totalDuration: 0, count: 0 };
      }

      dayBuckets[dateStr].count++;
      dayBuckets[dateStr].totalDuration += exec.total_duration || 0;
      if (exec.quality_overall !== null && exec.quality_overall !== undefined) {
        dayBuckets[dateStr].totalScore += exec.quality_overall;
      }
    }

    const result: DailyTrend[] = [];
    for (const [dateStr, bucket] of Object.entries(dayBuckets)) {
      result.push({
        date: dateStr,
        avgScore: bucket.count > 0 ? bucket.totalScore / bucket.count : 0,
        avgDuration: bucket.count > 0 ? bucket.totalDuration / bucket.count : 0,
        count: bucket.count,
      });
    }

    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }
}

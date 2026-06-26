/**
 * 学习状态报告生成器
 *
 * 【功能】
 * 生成人类可读的学习状态报告，让用户看到系统的学习效果和进步
 *
 * 【设计原则】
 * - 数据驱动：基于真实的进化指标数据
 * - 可视化：使用 ASCII 图表和进度条展示趋势
 * - 激励性：突出进步和成就，增强用户信心
 * - 简洁明了：重点信息突出，不堆砌数据
 *
 * 【使用场景】
 * - CLI status 命令增强
 * - 仪表盘展示
 * - 学习进度通知
 *
 * @module LearningStatusReporter
 * @version 0.1.0
 * @status Beta - 功能基本完成，测试中
 * @since 2026-06-24
 */

import { Logger } from '../utils/Logger';
import type { UnifiedEvolutionMetrics } from './EvolutionOrchestrator';

/**
 * 学习状态报告生成器
 */
export class LearningStatusReporter {
  /**
   * 生成完整的学习状态报告
   *
   * @param metrics 统一进化指标数据
   * @returns 格式化的学习状态报告字符串
   *
   * 【健壮性设计】
   * - 传入 null/undefined 返回空报告
   * - 缺失字段使用默认值，不抛出错误
   * - 异常数值（NaN、Infinity）安全处理
   * - 确保任何输入都不会导致崩溃
   */
  static generateReport(
    metrics: UnifiedEvolutionMetrics | null | undefined
  ): string {
    // 空值保护
    if (!metrics) {
      return '\n  ⚠️ 暂无学习数据\n';
    }

    const lines: string[] = [];

    // 安全获取嵌套属性
    const summary = metrics.summary || ({} as any);
    const quality = metrics.quality || ({} as any);
    const performance = metrics.performance || ({} as any);
    const optimization = metrics.optimization || ({} as any);
    const evolution = metrics.evolution || null;
    const codeEvolution = metrics.codeEvolution || null;

    // 安全数值获取函数
    const safeNum = (val: number | undefined, def: number = 0): number => {
      if (val === undefined || val === null) return def;
      if (typeof val !== 'number') return def;
      if (isNaN(val) || !isFinite(val)) return def;
      return val;
    };

    // 安全数组获取函数
    const safeArr = <T>(val: T[] | undefined, def: T[] = []): T[] => {
      return Array.isArray(val) ? val : def;
    };

    lines.push('');
    lines.push('  📊 学习状态报告');
    lines.push('  ' + '─'.repeat(40));

    // 概览部分
    lines.push('');
    lines.push('  📈 总体概览');
    lines.push(`    总交互次数: ${safeNum(summary.totalInteractions)}`);
    lines.push(`    总优化次数: ${safeNum(summary.totalOptimizations)}`);
    lines.push(
      `    平均质量评分: ${(safeNum(summary.averageQualityScore) * 100).toFixed(1)}%`
    );
    lines.push(
      `    活跃引擎: ${safeArr(summary.enginesActive).length > 0 ? safeArr(summary.enginesActive).join(', ') : '-'}`
    );

    // 质量趋势
    lines.push('');
    lines.push('  🎯 质量趋势');
    lines.push(`    当前状态: ${safeNum(quality.current).toFixed(2)}`);
    lines.push(
      `    趋势方向: ${this.getTrendIcon(quality.trend)} ${this.getTrendText(quality.trend)}`
    );
    lines.push(
      `    失败率: ${(safeNum(quality.failureRate) * 100).toFixed(1)}%`
    );

    // 质量趋势图（ASCII）
    const recentScores = safeArr<number>(quality.recentScores);
    if (recentScores.length > 0) {
      lines.push('');
      lines.push('    近期质量趋势:');
      lines.push('    ' + this.generateSparkline(recentScores));
    }

    // 性能指标
    lines.push('');
    lines.push('  ⚡ 性能表现');
    lines.push(
      `    平均响应时间: ${safeNum(performance.averageResponseTime).toFixed(0)}ms`
    );
    lines.push(
      `    P95 响应时间: ${safeNum(performance.p95ResponseTime).toFixed(0)}ms`
    );
    lines.push(
      `    吞吐量: ${safeNum(performance.throughput).toFixed(1)} 次/小时`
    );

    // 优化周期
    lines.push('');
    lines.push('  🔄 优化周期');
    lines.push(`    今日优化: ${safeNum(optimization.cyclesToday)} 次`);
    lines.push(`    总优化周期: ${safeNum(optimization.totalCycles)} 次`);
    lines.push(
      `    优化成功率: ${(safeNum(optimization.successRate) * 100).toFixed(1)}%`
    );

    // 进化指标（V1）
    if (evolution) {
      lines.push('');
      lines.push('  🧠 反馈学习（V1）');
      lines.push(`    总反馈数: ${safeNum(evolution.totalFeedback)}`);
      lines.push(`    成功优化: ${safeNum(evolution.successfulOptimizations)}`);
      lines.push(`    失败优化: ${safeNum(evolution.failedOptimizations)}`);
      if (evolution.weeklyOptimizationStats) {
        lines.push(
          `    本周成功率: ${(safeNum(evolution.weeklyOptimizationStats.successRate) * 100).toFixed(1)}%`
        );
      }
    }

    // 代码进化指标（V2）
    if (codeEvolution) {
      lines.push('');
      lines.push('  🚀 代码进化（V2）');
      lines.push(`    总进化数: ${safeNum(codeEvolution.totalEvolutions)}`);
      lines.push(
        `    成功率: ${(safeNum(codeEvolution.successRate) * 100).toFixed(1)}%`
      );
      lines.push(
        `    平均耗时: ${safeNum(codeEvolution.averageDuration).toFixed(0)}ms`
      );
      lines.push(
        `    回滚率: ${(safeNum(codeEvolution.rollbackRate) * 100).toFixed(1)}%`
      );
      lines.push(
        `    质量提升: ${safeNum(codeEvolution.qualityImprovement).toFixed(2)}`
      );
    }

    // 成就和里程碑
    lines.push('');
    lines.push('  🏆 学习成就');
    const achievements = this.getAchievements(metrics);
    for (const achievement of achievements) {
      lines.push(`    ${achievement}`);
    }

    lines.push('');
    lines.push('  ' + '─'.repeat(40));
    lines.push('  💡 系统在持续学习和进步中...');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 生成简洁的状态摘要
   *
   * @param metrics 统一进化指标数据
   * @returns 简洁的学习状态摘要字符串
   */
  static generateSummary(
    metrics: UnifiedEvolutionMetrics | null | undefined
  ): string {
    if (!metrics) {
      return '学习状态: 暂无数据';
    }

    const summary = metrics.summary || ({} as any);
    const qualityInfo = metrics.quality || ({} as any);

    const qualityPercent = ((summary.averageQualityScore || 0) * 100).toFixed(
      0
    );
    const trend = this.getTrendIcon(qualityInfo.trend);
    const optimizations = summary.totalOptimizations || 0;
    const enginesCount = (summary.enginesActive || []).length;

    return `学习状态: 质量 ${qualityPercent}% ${trend} | 已优化 ${optimizations} 次 | 活跃引擎 ${enginesCount} 个`;
  }

  /**
   * 获取趋势图标
   */
  private static getTrendIcon(trend: string): string {
    switch (trend) {
      case 'improving':
        return '📈';
      case 'declining':
        return '📉';
      case 'stable':
        return '➡️';
      default:
        return '➡️';
    }
  }

  /**
   * 获取趋势文本
   */
  private static getTrendText(trend: string): string {
    switch (trend) {
      case 'improving':
        return '持续提升';
      case 'declining':
        return '有所下降';
      case 'stable':
        return '保持稳定';
      default:
        return '未知';
    }
  }

  /**
   * 生成 ASCII 迷你图（Sparkline）
   */
  private static generateSparkline(values: number[]): string {
    if (values.length === 0) return '';

    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    let sparkline = '';
    for (const value of values) {
      const normalized = (value - min) / range;
      const index = Math.min(
        Math.floor(normalized * (blocks.length - 1)),
        blocks.length - 1
      );
      sparkline += blocks[index];
    }

    // 添加数值标签
    sparkline += `  ${(min * 100).toFixed(0)}% → ${(max * 100).toFixed(0)}%`;

    return sparkline;
  }

  /**
   * 获取学习成就列表
   *
   * @param metrics 统一进化指标数据
   * @returns 成就列表
   */
  private static getAchievements(
    metrics: UnifiedEvolutionMetrics | null | undefined
  ): string[] {
    const achievements: string[] = [];

    if (!metrics) {
      achievements.push('🌱 学习中：系统正在积累经验...');
      achievements.push('   💡 多与系统互动，帮助它学习成长');
      return achievements;
    }

    const summary = metrics.summary || ({} as any);
    const quality = metrics.quality || ({} as any);
    const codeEvolution = metrics.codeEvolution || null;

    // 安全数值获取
    const totalInteractions = summary.totalInteractions || 0;
    const totalOptimizations = summary.totalOptimizations || 0;
    const currentQuality = quality.current || 0;
    const qualityTrend = quality.trend || '';

    // 基于交互次数的成就
    if (totalInteractions >= 100) {
      achievements.push('🌟 百次交互：已完成 100 次交互');
    }
    if (totalInteractions >= 1000) {
      achievements.push('💎 千次交互：已完成 1000 次交互');
    }

    // 基于优化次数的成就
    if (totalOptimizations >= 10) {
      achievements.push('🔧 优化新手：完成 10 次优化');
    }
    if (totalOptimizations >= 100) {
      achievements.push('⚙️ 优化大师：完成 100 次优化');
    }

    // 基于质量的成就
    if (currentQuality >= 0.8) {
      achievements.push('✨ 高质量：质量评分达到 80% 以上');
    }
    if (qualityTrend === 'improving') {
      achievements.push('📈 持续进步：质量呈上升趋势');
    }

    // 基于代码进化的成就
    if (codeEvolution && codeEvolution.totalEvolutions >= 1) {
      achievements.push('🧬 首次进化：完成第一次代码自我进化');
    }

    // 如果没有成就，给个鼓励
    if (achievements.length === 0) {
      achievements.push('🌱 学习中：系统正在积累经验...');
      achievements.push('   💡 多与系统互动，帮助它学习成长');
    }

    return achievements.slice(0, 5); // 最多显示 5 个
  }

  /**
   * 打印学习状态报告到日志
   */
  static logReport(metrics: UnifiedEvolutionMetrics): void {
    const report = this.generateReport(metrics);
    Logger.info(report, 'LearningStatus');
  }
}

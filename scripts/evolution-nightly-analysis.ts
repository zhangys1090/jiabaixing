/**
 * 进化系统夜间全量分析脚本
 *
 * 执行内容：
 * 1. 读取持久化的进化指标（data/persistence/evolution-metrics.json）
 * 2. 读取反馈记录（从 FeedbackCollector）
 * 3. 生成进化洞察报告
 * 4. 触发 EvolutionOrchestrator 优化周期
 * 5. 保存分析报告到 data/evolution/daily-report-YYYYMMDD.json
 *
 * 用法：npx ts-node scripts/evolution-nightly-analysis.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface EvolutionMetric {
  metricType: string;
  value: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface FeedbackRecord {
  traceId: string;
  input: string;
  response: string;
  executionSuccess: boolean;
  userCorrection: string | null;
  inferredSatisfaction: number;
  timestamp: number;
  scene?: string;
}

interface LowSatisfactionTrend {
  period: string;
  count: number;
  avgSatisfaction: number;
  trend: 'increasing' | 'decreasing' | 'stable';
}

interface ToolSuccessRate {
  toolName: string;
  successCount: number;
  totalCount: number;
  successRate: number;
  trend: 'improving' | 'declining' | 'stable';
}

interface FailureMode {
  category: string;
  count: number;
  percentage: number;
  examples: string[];
}

interface EvolutionInsightReport {
  generatedAt: string;
  analysisPeriod: {
    start: number;
    end: number;
    duration: string;
  };
  dataQuality: {
    evolutionMetricsCount: number;
    feedbackRecordsCount: number;
    correctionRecordsCount: number;
    lowSatisfactionRecordsCount: number;
  };
  lowSatisfactionTrend: {
    analysis: LowSatisfactionTrend[];
    summary: {
      totalLowSatisfaction: number;
      overallTrend: string;
      avgSatisfactionScore: number;
      improvementRecommendation: string;
    };
  };
  toolSuccessRates: {
    rates: ToolSuccessRate[];
    summary: {
      overallSuccessRate: number;
      mostProblematicTool: string | null;
      mostSuccessfulTool: string | null;
      trendAnalysis: string;
    };
  };
  conversationQuality: {
    avgQualityScore: number;
    trend: 'improving' | 'stable' | 'declining';
    recentScores: number[];
    qualityDistribution: {
      excellent: number;
      good: number;
      fair: number;
      poor: number;
    };
  };
  failureModes: {
    modes: FailureMode[];
    rootCauses: string[];
    priorityFixes: string[];
  };
  optimizationTrigger: {
    triggered: boolean;
    reason: string;
    cycleId?: string;
    timestamp?: number;
  };
  recommendations: string[];
}

function readEvolutionMetrics(): EvolutionMetric[] {
  const metricsPath = path.join(process.cwd(), 'data', 'persistence', 'evolution-metrics.json');
  try {
    if (!fs.existsSync(metricsPath)) {
      console.log('⚠️ 进化指标文件不存在，跳过加载');
      return [];
    }
    const data = fs.readFileSync(metricsPath, 'utf-8');
    return JSON.parse(data) as EvolutionMetric[];
  } catch (error) {
    console.error('❌ 读取进化指标失败:', error);
    return [];
  }
}

function analyzeLowSatisfactionTrend(records: FeedbackRecord[]): LowSatisfactionTrend[] {
  const lowSatisfactionRecords = records.filter(r => r.inferredSatisfaction < 0.3);

  if (lowSatisfactionRecords.length === 0) {
    return [];
  }

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const periods = [
    { label: '最近24小时', start: now - oneDay, end: now },
    { label: '最近48-24小时', start: now - 2 * oneDay, end: now - oneDay },
    { label: '最近72-48小时', start: now - 3 * oneDay, end: now - 2 * oneDay },
  ];

  return periods.map(period => {
    const periodRecords = lowSatisfactionRecords.filter(
      r => r.timestamp >= period.start && r.timestamp < period.end
    );

    const avgSatisfaction = periodRecords.length > 0
      ? periodRecords.reduce((sum, r) => sum + r.inferredSatisfaction, 0) / periodRecords.length
      : 0;

    return {
      period: period.label,
      count: periodRecords.length,
      avgSatisfaction,
      trend: 'stable' as const,
    };
  });
}

function calculateToolSuccessRates(metrics: EvolutionMetric[]): ToolSuccessRate[] {
  const toolMetrics = metrics.filter(m => m.metricType.startsWith('tool_') || m.metricType.includes('tool'));

  const toolMap = new Map<string, { success: number; total: number }>();

  for (const metric of toolMetrics) {
    const toolName = metric.metadata?.toolName as string || 'unknown';
    const existing = toolMap.get(toolName) || { success: 0, total: 0 };

    if (metric.metricType.includes('success')) {
      existing.success += metric.value;
    }
    existing.total += 1;

    toolMap.set(toolName, existing);
  }

  return Array.from(toolMap.entries()).map(([toolName, data]) => ({
    toolName,
    successCount: data.success,
    totalCount: data.total,
    successRate: data.total > 0 ? data.success / data.total : 0,
    trend: 'stable' as const,
  }));
}

function analyzeConversationQuality(records: FeedbackRecord[]): {
  avgQualityScore: number;
  trend: 'improving' | 'stable' | 'declining';
  recentScores: number[];
  qualityDistribution: {
    excellent: number;
    good: number;
    fair: number;
    poor: number;
  };
} {
  const scores = records.map(r => r.inferredSatisfaction);

  if (scores.length === 0) {
    return {
      avgQualityScore: 0,
      trend: 'stable',
      recentScores: [],
      qualityDistribution: { excellent: 0, good: 0, fair: 0, poor: 0 },
    };
  }

  const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const recentScores = scores.slice(-20);

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const recentDay = scores.filter((_, i) => records[i] && records[i].timestamp > now - oneDay);
  const previousDay = scores.filter((_, i) => records[i] && records[i].timestamp <= now - oneDay && records[i].timestamp > now - 2 * oneDay);

  const recentAvg = recentDay.length > 0 ? recentDay.reduce((sum, s) => sum + s, 0) / recentDay.length : 0;
  const previousAvg = previousDay.length > 0 ? previousDay.reduce((sum, s) => sum + s, 0) / previousDay.length : 0;

  let trend: 'improving' | 'stable' | 'declining' = 'stable';
  if (recentAvg - previousAvg > 0.05) trend = 'improving';
  else if (previousAvg - recentAvg > 0.05) trend = 'declining';

  const distribution = {
    excellent: scores.filter(s => s >= 0.8).length,
    good: scores.filter(s => s >= 0.6 && s < 0.8).length,
    fair: scores.filter(s => s >= 0.4 && s < 0.6).length,
    poor: scores.filter(s => s < 0.4).length,
  };

  return {
    avgQualityScore: avgScore,
    trend,
    recentScores,
    qualityDistribution: distribution,
  };
}

function classifyFailureModes(records: FeedbackRecord[]): {
  modes: FailureMode[];
  rootCauses: string[];
  priorityFixes: string[];
} {
  const failedRecords = records.filter(r => !r.executionSuccess);
  const lowSatisfactionRecords = records.filter(r => r.inferredSatisfaction < 0.3);
  const correctionRecords = records.filter(r => r.userCorrection !== null);

  const modes: FailureMode[] = [];
  const rootCauses: string[] = [];
  const priorityFixes: string[] = [];

  if (failedRecords.length > 0) {
    modes.push({
      category: '执行失败',
      count: failedRecords.length,
      percentage: (failedRecords.length / records.length) * 100,
      examples: failedRecords.slice(0, 3).map(r => r.input.substring(0, 50)),
    });
    rootCauses.push('工具执行过程中出现错误');
    priorityFixes.push('检查工具注册和参数传递机制');
  }

  if (lowSatisfactionRecords.length > 0) {
    modes.push({
      category: '低满意度',
      count: lowSatisfactionRecords.length,
      percentage: (lowSatisfactionRecords.length / records.length) * 100,
      examples: lowSatisfactionRecords.slice(0, 3).map(r => r.input.substring(0, 50)),
    });
    rootCauses.push('响应质量未达到用户期望');
    priorityFixes.push('优化回复生成策略和语气调整');
  }

  if (correctionRecords.length > 0) {
    const toneComplaints = correctionRecords.filter(r =>
      r.userCorrection?.includes('tone') || r.userCorrection?.includes('语气')
    );
    const accuracyComplaints = correctionRecords.filter(r =>
      r.userCorrection?.includes('wrong') || r.userCorrection?.includes('不对')
    );

    if (toneComplaints.length > 0) {
      modes.push({
        category: '语气投诉',
        count: toneComplaints.length,
        percentage: (toneComplaints.length / correctionRecords.length) * 100,
        examples: toneComplaints.slice(0, 2).map(r => r.userCorrection || ''),
      });
      rootCauses.push('回复语气不符合用户偏好');
      priorityFixes.push('调整语气风格，参考用户沟通偏好');
    }

    if (accuracyComplaints.length > 0) {
      modes.push({
        category: '准确性投诉',
        count: accuracyComplaints.length,
        percentage: (accuracyComplaints.length / correctionRecords.length) * 100,
        examples: accuracyComplaints.slice(0, 2).map(r => r.userCorrection || ''),
      });
      rootCauses.push('回答内容不准确或不符合用户意图');
      priorityFixes.push('改进意图识别和上下文理解');
    }
  }

  return { modes, rootCauses, priorityFixes };
}

async function triggerOptimizationCycle(): Promise<{ triggered: boolean; cycleId?: string }> {
  try {
    const { EvolutionOrchestrator } = await import('../src/evolution/EvolutionOrchestrator');
    const orchestrator = EvolutionOrchestrator.getInstance();

    const result = await orchestrator.triggerOptimizationCycleWithVerification(
      '每日午夜定时优化',
      true
    );

    if (result.cycle) {
      console.log(`✅ 优化周期已触发: ${result.cycle.cycleId}`);
      return { triggered: true, cycleId: result.cycle.cycleId };
    } else {
      console.log('⚠️ 优化周期未触发（可能正在运行中）');
      return { triggered: false };
    }
  } catch (error) {
    console.error('❌ 触发优化周期失败:', error);
    return { triggered: false };
  }
}

function generateRecommendations(report: Partial<EvolutionInsightReport>): string[] {
  const recommendations: string[] = [];

  if (report.lowSatisfactionTrend?.summary) {
    if (report.lowSatisfactionTrend.summary.overallTrend === 'increasing') {
      recommendations.push('🔴 紧急：低满意度反馈呈上升趋势，需要立即优化响应质量');
    }
    if (report.lowSatisfactionTrend.summary.avgSatisfactionScore < 0.5) {
      recommendations.push('⚠️ 重要：整体满意度偏低，建议全面检查对话生成策略');
    }
  }

  if (report.toolSuccessRates?.summary?.mostProblematicTool) {
    recommendations.push(
      `📌 工具优化：${report.toolSuccessRates.summary.mostProblematicTool} 成功率较低，需要重点优化`
    );
  }

  if (report.conversationQuality?.trend === 'declining') {
    recommendations.push('📉 质量下降：对话质量呈下降趋势，建议检查近期变更并回滚');
  }

  if (report.failureModes?.priorityFixes?.length) {
    report.failureModes.priorityFixes.forEach((fix, i) => {
      recommendations.push(`💡 建议${i + 1}：${fix}`);
    });
  }

  if (recommendations.length === 0) {
    recommendations.push('✅ 系统运行正常，未发现需要紧急处理的问题');
    recommendations.push('💡 建议继续保持当前优化节奏');
  }

  return recommendations;
}

async function main(): Promise<void> {
  console.log('🌙 进化系统夜间全量分析开始...\n');

  const startTime = Date.now();
  const analysisStart = startTime - 3 * 24 * 60 * 60 * 1000;

  console.log('1️⃣ 读取持久化进化指标...');
  const evolutionMetrics = readEvolutionMetrics();
  console.log(`   已加载 ${evolutionMetrics.length} 条进化指标`);

  console.log('\n2️⃣ 读取反馈记录...');
  const feedbackPath = path.join(process.cwd(), 'data', 'feedback', 'feedback_log.jsonl');
  let feedbackRecords: FeedbackRecord[] = [];

  try {
    if (fs.existsSync(feedbackPath)) {
      const lines = fs.readFileSync(feedbackPath, 'utf-8').split('\n').filter(Boolean);
      feedbackRecords = lines.map(line => {
        try {
          return JSON.parse(line) as FeedbackRecord;
        } catch {
          return null;
        }
      }).filter((r): r is FeedbackRecord => r !== null);

      feedbackRecords = feedbackRecords.filter(
        r => r.timestamp >= analysisStart && r.timestamp <= startTime
      );
    }
  } catch (error) {
    console.error('⚠️ 读取反馈日志失败:', error);
  }

  console.log(`   已加载 ${feedbackRecords.length} 条反馈记录`);

  const correctionRecords = feedbackRecords.filter(r => r.userCorrection !== null);
  const lowSatisfactionRecords = feedbackRecords.filter(r => r.inferredSatisfaction < 0.3);

  console.log(`   - 纠错记录: ${correctionRecords.length} 条`);
  console.log(`   - 低满意度记录: ${lowSatisfactionRecords.length} 条`);

  console.log('\n3️⃣ 分析低满意度趋势...');
  const lowSatisfactionTrend = analyzeLowSatisfactionTrend(feedbackRecords);

  const summary = {
    totalLowSatisfaction: lowSatisfactionRecords.length,
    overallTrend: lowSatisfactionTrend.length >= 2
      ? (lowSatisfactionTrend[0].count > lowSatisfactionTrend[1].count ? 'increasing' :
         lowSatisfactionTrend[0].count < lowSatisfactionTrend[1].count ? 'decreasing' : 'stable')
      : 'stable',
    avgSatisfactionScore: feedbackRecords.length > 0
      ? feedbackRecords.reduce((sum, r) => sum + r.inferredSatisfaction, 0) / feedbackRecords.length
      : 0,
    improvementRecommendation: '',
  };

  if (summary.overallTrend === 'increasing') {
    summary.improvementRecommendation = '低满意度上升，需要加强质量控制';
  } else if (summary.overallTrend === 'decreasing') {
    summary.improvementRecommendation = '低满意度下降，情况在改善';
  } else {
    summary.improvementRecommendation = '低满意度保持稳定';
  }

  console.log(`   分析完成：总体趋势 - ${summary.overallTrend}`);

  console.log('\n4️⃣ 分析工具使用成功率...');
  const toolSuccessRates = calculateToolSuccessRates(evolutionMetrics);

  const overallSuccessRate = toolSuccessRates.length > 0
    ? toolSuccessRates.reduce((sum, t) => sum + t.successRate, 0) / toolSuccessRates.length
    : 0;

  const sortedByRate = [...toolSuccessRates].sort((a, b) => a.successRate - b.successRate);
  const mostProblematic = sortedByRate[0]?.successRate < 0.8 ? sortedByRate[0]?.toolName : null;
  const mostSuccessful = sortedByRate[sortedByRate.length - 1]?.successRate > 0.9 ? sortedByRate[sortedByRate.length - 1]?.toolName : null;

  console.log(`   分析完成：整体成功率 - ${(overallSuccessRate * 100).toFixed(1)}%`);

  console.log('\n5️⃣ 分析对话质量评分...');
  const conversationQuality = analyzeConversationQuality(feedbackRecords);
  console.log(`   平均质量评分: ${conversationQuality.avgQualityScore.toFixed(2)}`);
  console.log(`   质量趋势: ${conversationQuality.trend}`);

  console.log('\n6️⃣ 归类失败模式...');
  const failureModes = classifyFailureModes(feedbackRecords);
  console.log(`   识别到 ${failureModes.modes.length} 种失败模式`);

  console.log('\n7️⃣ 触发优化周期...');
  const optimizationResult = await triggerOptimizationCycle();

  console.log('\n8️⃣ 生成洞察报告...');
  const report: EvolutionInsightReport = {
    generatedAt: new Date().toISOString(),
    analysisPeriod: {
      start: analysisStart,
      end: startTime,
      duration: `${Math.round((startTime - analysisStart) / (24 * 60 * 60 * 1000))} 天`,
    },
    dataQuality: {
      evolutionMetricsCount: evolutionMetrics.length,
      feedbackRecordsCount: feedbackRecords.length,
      correctionRecordsCount: correctionRecords.length,
      lowSatisfactionRecordsCount: lowSatisfactionRecords.length,
    },
    lowSatisfactionTrend: {
      analysis: lowSatisfactionTrend,
      summary,
    },
    toolSuccessRates: {
      rates: toolSuccessRates,
      summary: {
        overallSuccessRate,
        mostProblematicTool: mostProblematic,
        mostSuccessfulTool: mostSuccessful,
        trendAnalysis: overallSuccessRate > 0.9 ? '优秀' : overallSuccessRate > 0.8 ? '良好' : overallSuccessRate > 0.7 ? '一般' : '需要改进',
      },
    },
    conversationQuality,
    failureModes,
    optimizationTrigger: {
      triggered: optimizationResult.triggered,
      reason: '每日午夜定时优化',
      cycleId: optimizationResult.cycleId,
      timestamp: optimizationResult.triggered ? Date.now() : undefined,
    },
    recommendations: generateRecommendations({
      lowSatisfactionTrend: { summary },
      toolSuccessRates: { summary: { mostProblematicTool: mostProblematic, mostSuccessfulTool: mostSuccessful, overallSuccessRate, trendAnalysis: '' } },
      conversationQuality,
      failureModes,
    }),
  };

  const evolutionDir = path.join(process.cwd(), 'data', 'evolution');
  if (!fs.existsSync(evolutionDir)) {
    fs.mkdirSync(evolutionDir, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const reportPath = path.join(evolutionDir, `daily-report-${today}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  console.log('\n✅ 夜间全量分析完成！');
  console.log(`   报告已保存: ${reportPath}`);
  console.log(`   分析时长: ${duration} 秒`);
  console.log(`   发现问题: ${report.recommendations.length} 项建议`);

  report.recommendations.forEach((rec, i) => {
    console.log(`   ${i + 1}. ${rec}`);
  });
}

main().catch((error) => {
  console.error('❌ 夜间分析脚本执行失败:', error);
  process.exit(1);
});

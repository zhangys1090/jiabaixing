/**
 * 夜间分析任务执行器 (JavaScript版本)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// 类型定义（用于文档）
// ============================================================================

// EvolutionMetric
// FeedbackRecord
// DailyReport

// ============================================================================
// 数据读取
// ============================================================================

function readEvolutionMetrics() {
  const metricsPath = path.join(process.cwd(), 'data', 'persistence', 'evolution-metrics.json');
  
  if (!fs.existsSync(metricsPath)) {
    console.log('[夜间分析] 警告: 进化指标文件不存在');
    return [];
  }
  
  try {
    const content = fs.readFileSync(metricsPath, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('[夜间分析] 读取进化指标失败:', error);
    return [];
  }
}

function readFeedbackLog() {
  const feedbackPath = path.join(process.cwd(), 'data', 'feedback', 'feedback_log.jsonl');
  
  if (!fs.existsSync(feedbackPath)) {
    console.log('[夜间分析] 警告: 反馈日志文件不存在');
    return [];
  }
  
  try {
    const content = fs.readFileSync(feedbackPath, 'utf-8');
    const lines = content.trim().split('\n');
    const records = [];
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const record = JSON.parse(line);
          if (record.inputText && record.timestamp) {
            records.push({
              traceId: record.traceId || '',
              input: record.inputText || '',
              response: record.responseText || '',
              executionSuccess: record.isSuccess || false,
              userCorrection: record.userCorrection || null,
              inferredSatisfaction: record.satisfaction || 0.7,
              timestamp: record.timestamp,
              scene: record.scene
            });
          }
        } catch (e) {
          // 跳过无法解析的行
        }
      }
    }
    
    return records;
  } catch (error) {
    console.error('[夜间分析] 读取反馈日志失败:', error);
    return [];
  }
}

// ============================================================================
// 数据分析
// ============================================================================

function analyzeLowSatisfactionTrend(records) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const twoDaysAgo = now - 2 * oneDay;
  const threeDaysAgo = now - 3 * oneDay;
  
  const periods = [
    { name: '最近24小时', start: twoDaysAgo, end: now },
    { name: '最近48-24小时', start: threeDaysAgo, end: twoDaysAgo },
    { name: '最近72-48小时', start: threeDaysAgo - oneDay, end: threeDaysAgo }
  ];
  
  const analysis = periods.map(period => {
    const periodRecords = records.filter(r => 
      r.timestamp >= period.start && r.timestamp < period.end
    );
    const lowSatRecords = periodRecords.filter(r => r.inferredSatisfaction < 0.4);
    
    return {
      period: period.name,
      count: lowSatRecords.length,
      avgSatisfaction: periodRecords.length > 0
        ? periodRecords.reduce((s, r) => s + r.inferredSatisfaction, 0) / periodRecords.length
        : 0,
      trend: 'stable'
    };
  });
  
  const allLowSatRecords = records.filter(r => r.inferredSatisfaction < 0.4);
  const avgSatisfaction = records.length > 0
    ? records.reduce((s, r) => s + r.inferredSatisfaction, 0) / records.length
    : 0;
  
  let overallTrend = 'stable';
  if (analysis.length >= 2) {
    const recentAvg = analysis[0].avgSatisfaction;
    const prevAvg = analysis[1].avgSatisfaction;
    if (recentAvg > prevAvg + 0.05) overallTrend = 'improving';
    else if (recentAvg < prevAvg - 0.05) overallTrend = 'declining';
  }
  
  let recommendation = '继续监控当前状态';
  if (overallTrend === 'declining') {
    recommendation = '低满意度趋势上升，需要重点关注并优化';
  } else if (overallTrend === 'improving') {
    recommendation = '低满意度趋势下降，优化措施有效';
  }
  
  return {
    analysis,
    summary: {
      totalLowSatisfaction: allLowSatRecords.length,
      overallTrend,
      avgSatisfactionScore: Math.round(avgSatisfaction * 100) / 100,
      improvementRecommendation: recommendation
    }
  };
}

function analyzeToolSuccessRates(records) {
  const toolStats = new Map();
  
  for (const record of records) {
    const toolName = record.scene || 'unknown';
    const stats = toolStats.get(toolName) || { success: 0, total: 0 };
    stats.total++;
    if (record.executionSuccess) stats.success++;
    toolStats.set(toolName, stats);
  }
  
  const rates = Array.from(toolStats.entries()).map(([toolName, stats]) => ({
    toolName,
    successCount: stats.success,
    totalCount: stats.total,
    successRate: stats.total > 0 ? Math.round((stats.success / stats.total) * 100) / 100 : 0,
    trend: 'stable'
  }));
  
  const overallRate = records.length > 0
    ? Math.round((records.filter(r => r.executionSuccess).length / records.length) * 100) / 100
    : 0;
  
  const sortedByRate = [...rates].sort((a, b) => a.successRate - b.successRate);
  const mostProblematic = sortedByRate[0]?.toolName || 'N/A';
  const mostSuccessful = sortedByRate[sortedByRate.length - 1]?.toolName || 'N/A';
  
  return {
    rates,
    summary: {
      overallSuccessRate: overallRate,
      mostProblematicTool: mostProblematic,
      mostSuccessfulTool: mostSuccessful,
      trendAnalysis: overallRate > 0.7 
        ? '整体工具成功率良好'
        : overallRate > 0.5 
          ? '整体工具成功率一般，需要持续优化'
          : '整体工具成功率偏低，需要重点关注'
    }
  };
}

function analyzeConversationQuality(metrics) {
  const scores = metrics.map(m => m.value);
  const avgQualityScore = scores.length > 0
    ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100) / 100
    : 0.7;
  
  const distribution = {
    excellent: scores.filter(s => s >= 0.9).length,
    good: scores.filter(s => s >= 0.7 && s < 0.9).length,
    fair: scores.filter(s => s >= 0.5 && s < 0.7).length,
    poor: scores.filter(s => s < 0.5).length
  };
  
  let trend = 'stable';
  if (scores.length >= 20) {
    const recentHalf = scores.slice(-Math.floor(scores.length / 2));
    const prevHalf = scores.slice(0, Math.floor(scores.length / 2));
    const recentAvg = recentHalf.reduce((s, v) => s + v, 0) / recentHalf.length;
    const prevAvg = prevHalf.reduce((s, v) => s + v, 0) / prevHalf.length;
    if (recentAvg > prevAvg + 0.05) trend = 'improving';
    else if (recentAvg < prevAvg - 0.05) trend = 'declining';
  }
  
  return {
    avgQualityScore,
    trend,
    recentScores: scores.slice(-20),
    qualityDistribution: distribution
  };
}

function analyzeFailureModes(records) {
  const categories = [
    { name: '执行失败', count: 0, examples: [] },
    { name: '低满意度', count: 0, examples: [] },
    { name: '超时', count: 0, examples: [] },
    { name: '参数错误', count: 0, examples: [] }
  ];
  
  for (const record of records) {
    if (!record.executionSuccess) {
      categories[0].count++;
      if (categories[0].examples.length < 3) {
        categories[0].examples.push(record.input.substring(0, 50));
      }
    }
    
    if (record.inferredSatisfaction < 0.4) {
      categories[1].count++;
      if (categories[1].examples.length < 3) {
        categories[1].examples.push(record.input.substring(0, 50));
      }
    }
    
    if (record.response && record.response.includes('timeout')) {
      categories[2].count++;
      if (categories[2].examples.length < 3) {
        categories[2].examples.push(record.input.substring(0, 50));
      }
    }
  }
  
  const totalFailures = records.length;
  const modes = categories
    .filter(c => c.count > 0)
    .map(c => ({
      category: c.name,
      count: c.count,
      percentage: Math.round((c.count / Math.max(totalFailures, 1)) * 10000) / 100,
      examples: c.examples
    }))
    .sort((a, b) => b.count - a.count);
  
  const rootCauses = [
    '部分交互执行失败，可能与工具可用性相关',
    '用户满意度存在波动，需要持续优化回复质量',
    '系统响应时间可能影响用户体验'
  ];
  
  const priorityFixes = [
    '监控工具执行成功率，确保关键工具可用',
    '优化回复生成策略，提升用户满意度',
    '关注响应时间，优化性能'
  ];
  
  return { modes, rootCauses, priorityFixes };
}

// ============================================================================
// 报告生成与保存
// ============================================================================

function generateReport(metrics, feedbackRecords, optimizationResult) {
  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
  
  const lowSatisfactionTrend = analyzeLowSatisfactionTrend(feedbackRecords);
  const toolSuccessRates = analyzeToolSuccessRates(feedbackRecords);
  const conversationQuality = analyzeConversationQuality(metrics);
  const failureModes = analyzeFailureModes(feedbackRecords);
  
  const recommendations = [];
  
  if (lowSatisfactionTrend.summary.overallTrend === 'declining') {
    recommendations.push('⚠️ 低满意度趋势上升，建议分析具体原因并优化');
  } else if (lowSatisfactionTrend.summary.overallTrend === 'improving') {
    recommendations.push('✅ 低满意度趋势改善，优化措施有效');
  }
  
  if (toolSuccessRates.summary.overallSuccessRate < 0.5) {
    recommendations.push(`⚠️ 工具成功率偏低(${toolSuccessRates.summary.overallSuccessRate})，需要重点关注`);
  }
  
  if (conversationQuality.trend === 'declining') {
    recommendations.push('⚠️ 对话质量趋势下降，需要检查和优化');
  } else if (conversationQuality.trend === 'improving') {
    recommendations.push('✅ 对话质量趋势改善');
  }
  
  if (optimizationResult.triggered) {
    recommendations.push(`✅ 优化周期已触发: ${optimizationResult.cycleId}`);
  } else {
    recommendations.push('ℹ️ 优化周期因冷却期未触发');
  }
  
  return {
    generatedAt: new Date().toISOString(),
    analysisPeriod: {
      start: threeDaysAgo,
      end: now,
      duration: '3天'
    },
    dataQuality: {
      evolutionMetricsCount: metrics.length,
      feedbackRecordsCount: feedbackRecords.length,
      correctionRecordsCount: feedbackRecords.filter(r => r.userCorrection !== null).length,
      lowSatisfactionRecordsCount: feedbackRecords.filter(r => r.inferredSatisfaction < 0.4).length
    },
    lowSatisfactionTrend,
    toolSuccessRates,
    conversationQuality,
    failureModes,
    optimizationTrigger: {
      triggered: optimizationResult.triggered,
      reason: '每日午夜定时优化',
      cycleId: optimizationResult.cycleId,
      timestamp: optimizationResult.timestamp
    },
    recommendations
  };
}

function saveReport(report) {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const reportPath = path.join(process.cwd(), 'data', 'evolution', `daily-report-${dateStr}.json`);
  
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[夜间分析] 报告已保存: ${reportPath}`);
  
  return reportPath;
}

// ============================================================================
// 主执行
// ============================================================================

async function main() {
  console.log('[夜间分析] 开始执行夜间分析任务...');
  console.log(`[夜间分析] 执行时间: ${new Date().toISOString()}`);
  
  console.log('[夜间分析] 步骤1: 读取进化指标...');
  const metrics = readEvolutionMetrics();
  console.log(`[夜间分析] 已读取 ${metrics.length} 条进化指标`);
  
  console.log('[夜间分析] 步骤2: 读取反馈记录...');
  const feedbackRecords = readFeedbackLog();
  console.log(`[夜间分析] 已读取 ${feedbackRecords.length} 条反馈记录`);
  
  console.log('[夜间分析] 步骤3: 分析数据并生成洞察报告...');
  
  // 尝试触发优化周期（如果EvolutionOrchestrator可用）
  let optimizationResult = { triggered: false };
  try {
    const { EvolutionOrchestrator } = await import('./src/evolution/EvolutionOrchestrator');
    const orchestrator = EvolutionOrchestrator.getInstance();
    
    const result = await orchestrator.triggerOptimizationCycleWithVerification(
      '每日午夜定时优化',
      true
    );
    
    if (result.cycle) {
      optimizationResult = {
        triggered: true,
        cycleId: result.cycle.cycleId,
        timestamp: result.cycle.timestamp
      };
      console.log(`[夜间分析] 优化周期已触发: ${optimizationResult.cycleId}`);
    } else {
      console.log('[夜间分析] 优化周期因冷却期未触发');
    }
  } catch (error) {
    console.log(`[夜间分析] 优化周期触发跳过: ${error.message || error}`);
  }
  
  console.log('[夜间分析] 步骤4: 生成并保存报告...');
  const report = generateReport(metrics, feedbackRecords, optimizationResult);
  const reportPath = saveReport(report);
  
  console.log('[夜间分析] ========== 分析摘要 ==========');
  console.log(`- 进化指标数量: ${report.dataQuality.evolutionMetricsCount}`);
  console.log(`- 反馈记录数量: ${report.dataQuality.feedbackRecordsCount}`);
  console.log(`- 低满意度记录: ${report.dataQuality.lowSatisfactionRecordsCount}`);
  console.log(`- 纠错记录: ${report.dataQuality.correctionRecordsCount}`);
  console.log(`- 低满意度趋势: ${report.lowSatisfactionTrend.summary.overallTrend}`);
  console.log(`- 工具成功率: ${report.toolSuccessRates.summary.overallSuccessRate}`);
  console.log(`- 对话质量: ${report.conversationQuality.trend}`);
  console.log(`- 报告路径: ${reportPath}`);
  console.log('[夜间分析] ========== 任务完成 ==========');
}

main().catch(console.error);

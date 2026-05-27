/**
 * 进化系统夜间全量分析脚本 (Standalone JavaScript Version)
 * 不依赖项目模块，纯 Node.js 实现
 *
 * 执行内容：
 * 1. 读取持久化的进化指标（data/persistence/evolution-metrics.json）
 * 2. 读取反馈记录（data/feedback/feedback_log.jsonl）
 * 3. 生成进化洞察报告
 * 4. 触发 EvolutionOrchestrator 优化周期
 * 5. 保存分析报告到 data/evolution/daily-report-YYYYMMDD.json
 *
 * 用法：node scripts/evolution-nightly-analysis.js
 */

const fs = require('fs');
const path = require('path');

// ==================== 数据结构定义 ====================

function readEvolutionMetrics() {
  const metricsPath = path.join(process.cwd(), 'data', 'persistence', 'evolution-metrics.json');
  try {
    if (!fs.existsSync(metricsPath)) {
      console.log('⚠️ 进化指标文件不存在，跳过加载');
      return [];
    }
    const data = fs.readFileSync(metricsPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ 读取进化指标失败:', error);
    return [];
  }
}

function readFeedbackRecords() {
  const feedbackPath = path.join(process.cwd(), 'data', 'feedback', 'feedback_log.jsonl');
  const records = [];

  try {
    if (!fs.existsSync(feedbackPath)) {
      console.log('⚠️ 反馈日志文件不存在');
      return records;
    }

    const content = fs.readFileSync(feedbackPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        records.push(record);
      } catch (parseError) {
        // Skip invalid JSON lines
      }
    }
  } catch (error) {
    console.error('❌ 读取反馈日志失败:', error);
  }

  return records;
}

function analyzeLowSatisfactionTrend(records) {
  // 基于 isSuccess 和 execution pattern 推断满意度
  const lowSatisfactionRecords = records.filter(r => !r.isSuccess || r.loopCount > 3);

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

    // 推断满意度：基于执行成功率和循环次数
    const avgSatisfaction = periodRecords.length > 0
      ? periodRecords.reduce((sum, r) => {
          let score = 0.7;
          if (!r.isSuccess) score -= 0.3;
          if (r.loopCount > 5) score -= 0.2;
          else if (r.loopCount > 3) score -= 0.1;
          return sum + Math.max(0, Math.min(1, score));
        }, 0) / periodRecords.length
      : 0.7;

    return {
      period: period.label,
      count: periodRecords.length,
      avgSatisfaction,
      trend: 'stable',
    };
  });
}

function calculateToolSuccessRates(records) {
  const toolStats = new Map();

  for (const record of records) {
    if (!record.toolExecutions || !Array.isArray(record.toolExecutions)) continue;

    for (const tool of record.toolExecutions) {
      const toolName = tool.toolName || 'unknown';
      const existing = toolStats.get(toolName) || { success: 0, total: 0 };

      existing.total++;
      if (tool.success) existing.success++;

      toolStats.set(toolName, existing);
    }
  }

  const results = [];
  for (const [toolName, stats] of toolStats.entries()) {
    results.push({
      toolName,
      successCount: stats.success,
      totalCount: stats.total,
      successRate: stats.total > 0 ? stats.success / stats.total : 0,
      trend: 'stable',
    });
  }

  return results.sort((a, b) => b.successRate - a.successRate);
}

function analyzeConversationQuality(records) {
  if (records.length === 0) {
    return {
      avgQualityScore: 0,
      trend: 'stable',
      recentScores: [],
      qualityDistribution: { excellent: 0, good: 0, fair: 0, poor: 0 },
    };
  }

  // 推断质量分数：基于成功率、循环次数、执行时间
  const scores = records.map(r => {
    let score = 0.7;

    if (r.isSuccess) score += 0.2;
    else score -= 0.3;

    if (r.loopCount <= 2) score += 0.1;
    else if (r.loopCount > 5) score -= 0.2;
    else if (r.loopCount > 3) score -= 0.1;

    if (r.totalExecutionTime < 5000) score += 0.1;
    else if (r.totalExecutionTime > 60000) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  });

  const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const recentScores = scores.slice(-20);

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  const recentRecords = records.filter(r => r.timestamp > now - oneDay);
  const previousRecords = records.filter(r => r.timestamp <= now - oneDay && r.timestamp > now - 2 * oneDay);

  const recentAvg = recentRecords.length > 0
    ? recentRecords.reduce((sum, r) => {
        let score = 0.7;
        if (r.isSuccess) score += 0.2;
        if (r.loopCount <= 2) score += 0.1;
        return sum + Math.max(0, Math.min(1, score));
      }, 0) / recentRecords.length
    : 0.7;

  const previousAvg = previousRecords.length > 0
    ? previousRecords.reduce((sum, r) => {
        let score = 0.7;
        if (r.isSuccess) score += 0.2;
        if (r.loopCount <= 2) score += 0.1;
        return sum + Math.max(0, Math.min(1, score));
      }, 0) / previousRecords.length
    : 0.7;

  let trend = 'stable';
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

function classifyFailureModes(records) {
  const modes = [];
  const rootCauses = [];
  const priorityFixes = [];

  const failedRecords = records.filter(r => !r.isSuccess);
  const highLoopRecords = records.filter(r => r.loopCount > 3);
  const timeoutRecords = records.filter(r =>
    r.failureReasons && r.failureReasons.some(r => r.includes('timeout'))
  );

  if (failedRecords.length > 0) {
    const examples = failedRecords.slice(0, 3).map(r => (r.inputText || r.input || '').substring(0, 50));
    modes.push({
      category: '执行失败',
      count: failedRecords.length,
      percentage: (failedRecords.length / records.length) * 100,
      examples,
    });
    rootCauses.push('工具执行过程中出现错误');
    priorityFixes.push('检查工具注册和参数传递机制');
  }

  if (highLoopRecords.length > 0) {
    const examples = highLoopRecords.slice(0, 3).map(r => (r.inputText || r.input || '').substring(0, 50));
    modes.push({
      category: '循环次数过多',
      count: highLoopRecords.length,
      percentage: (highLoopRecords.length / records.length) * 100,
      examples,
    });
    rootCauses.push('任务规划或执行效率低下');
    priorityFixes.push('优化任务拆分和执行策略');
  }

  if (timeoutRecords.length > 0) {
    modes.push({
      category: '执行超时',
      count: timeoutRecords.length,
      percentage: (timeoutRecords.length / records.length) * 100,
      examples: ['命令执行超时', '工具调用超时'],
    });
    rootCauses.push('命令或工具执行时间过长');
    priorityFixes.push('优化超时配置和执行策略');
  }

  return { modes, rootCauses, priorityFixes };
}

function generateRecommendations(report) {
  const recommendations = [];

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

// ==================== 主流程 ====================

async function main() {
  console.log('🌙 进化系统夜间全量分析开始...\n');

  const startTime = Date.now();
  const analysisStart = startTime - 3 * 24 * 60 * 60 * 1000;

  console.log('1️⃣ 读取持久化进化指标...');
  const evolutionMetrics = readEvolutionMetrics();
  console.log(`   已加载 ${evolutionMetrics.length} 条进化指标`);

  console.log('\n2️⃣ 读取反馈记录...');
  let feedbackRecords = readFeedbackRecords();

  // 过滤最近3天的数据
  feedbackRecords = feedbackRecords.filter(
    r => r.timestamp >= analysisStart && r.timestamp <= startTime
  );

  console.log(`   已加载 ${feedbackRecords.length} 条反馈记录`);

  const correctionRecords = feedbackRecords.filter(r => r.userCorrection !== null);
  const lowSatisfactionRecords = feedbackRecords.filter(r => !r.isSuccess || r.loopCount > 3);

  console.log(`   - 推断低满意度记录: ${lowSatisfactionRecords.length} 条`);

  console.log('\n3️⃣ 分析低满意度趋势...');
  const lowSatisfactionTrend = analyzeLowSatisfactionTrend(feedbackRecords);

  const summary = {
    totalLowSatisfaction: lowSatisfactionRecords.length,
    overallTrend: lowSatisfactionTrend.length >= 2
      ? (lowSatisfactionTrend[0].count > lowSatisfactionTrend[1].count ? 'increasing' :
         lowSatisfactionTrend[0].count < lowSatisfactionTrend[1].count ? 'decreasing' : 'stable')
      : 'stable',
    avgSatisfactionScore: lowSatisfactionRecords.length > 0
      ? lowSatisfactionRecords.reduce((sum, r) => {
          let score = 0.7;
          if (!r.isSuccess) score -= 0.3;
          if (r.loopCount > 5) score -= 0.2;
          return sum + Math.max(0, Math.min(1, score));
        }, 0) / lowSatisfactionRecords.length
      : 0.7,
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
  const toolSuccessRates = calculateToolSuccessRates(feedbackRecords);

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

  console.log('\n7️⃣ 生成洞察报告...');

  const report = {
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
      rates: toolSuccessRates.slice(0, 10), // Top 10 tools
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
      triggered: false, // 无法在无模块环境中触发
      reason: '每日午夜定时优化 - 需要完整运行环境',
      cycleId: null,
      timestamp: null,
      note: '需要在完整运行环境中调用 EvolutionOrchestrator.triggerOptimizationCycleWithVerification',
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

  console.log('\n📋 报告摘要:');
  console.log(`   - 数据质量: 进化指标 ${report.dataQuality.evolutionMetricsCount} 条，反馈记录 ${report.dataQuality.feedbackRecordsCount} 条`);
  console.log(`   - 低满意度: ${report.dataQuality.lowSatisfactionRecordsCount} 条 (${(report.dataQuality.lowSatisfactionRecordsCount / Math.max(1, report.dataQuality.feedbackRecordsCount) * 100).toFixed(1)}%)`);
  console.log(`   - 工具分析: ${toolSuccessRates.length} 种工具，整体成功率 ${(overallSuccessRate * 100).toFixed(1)}%`);
  console.log(`   - 质量评分: ${(conversationQuality.avgQualityScore * 100).toFixed(1)}% (${conversationQuality.trend})`);
  console.log(`   - 失败模式: ${failureModes.modes.length} 种`);

  if (report.toolSuccessRates.summary.mostProblematicTool) {
    console.log(`   - 重点关注: ${report.toolSuccessRates.summary.mostProblematicTool} 工具成功率较低`);
  }
}

// 执行主流程
main().catch((error) => {
  console.error('❌ 夜间分析脚本执行失败:', error);
  process.exit(1);
});

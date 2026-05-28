/**
 * Harness Phase 11: 自评估管道 — CI/CD 评估门禁
 *
 * 检查评估报告是否满足质量门禁标准：
 * - 最低通过率
 * - 最低平均评分
 * - 回归容忍度
 * - 阻断类别
 * - pass@k 指标支持
 */

import { Logger } from '../../utils/Logger';
import type { EvalReportSummary } from './EvalTrendAnalyzer';
import { EvalTrendAnalyzer } from './EvalTrendAnalyzer';

/** 门禁配置 */
export interface EvalGateConfig {
  /** 最低通过率 (0-1)，默认 0.8 */
  minPassRate: number;
  /** 最低平均评分 (0-100)，默认 70 */
  minAverageScore: number;
  /** 回归容忍度 — passRate允许下降幅度 (0-1)，默认 0.05 */
  regressionTolerance: number;
  /** 阻断类别 — 这些类别必须100%通过 */
  blockedCategories: string[];
  /** pass@k 配置：运行k次，至少通过n次 */
  passAtK?: { k: number; n: number };
}

const DEFAULT_GATE_CONFIG: EvalGateConfig = {
  minPassRate: 0.8,
  minAverageScore: 70,
  regressionTolerance: 0.05,
  blockedCategories: ['safety'],
};

/** 门禁结果 */
export interface GateResult {
  /** 是否通过 */
  passed: boolean;
  /** 失败原因列表 */
  failures: string[];
  /** 建议操作 */
  suggestions: string[];
  /** 详细检查项 */
  checks: GateCheck[];
}

/** 单项检查 */
export interface GateCheck {
  /** 检查名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 当前值 */
  actual: string;
  /** 阈值 */
  threshold: string;
}

export class EvalGate {
  private config: EvalGateConfig;
  private trendAnalyzer: EvalTrendAnalyzer;

  constructor(config?: Partial<EvalGateConfig>) {
    this.config = { ...DEFAULT_GATE_CONFIG, ...config };
    this.trendAnalyzer = new EvalTrendAnalyzer();
  }

  /**
   * 检查报告是否通过门禁
   */
  check(report: EvalReportSummary): GateResult {
    const failures: string[] = [];
    const suggestions: string[] = [];
    const checks: GateCheck[] = [];

    const passRateCheck: GateCheck = {
      name: '通过率',
      passed: report.passRate >= this.config.minPassRate,
      actual: `${(report.passRate * 100).toFixed(1)}%`,
      threshold: `≥${(this.config.minPassRate * 100).toFixed(1)}%`,
    };
    checks.push(passRateCheck);
    if (!passRateCheck.passed) {
      failures.push(
        `通过率不达标: ${(report.passRate * 100).toFixed(1)}% < ${(this.config.minPassRate * 100).toFixed(1)}%`
      );
      suggestions.push('修复失败的评估案例，提高通过率');
    }

    const scoreCheck: GateCheck = {
      name: '平均评分',
      passed: report.averageScore >= this.config.minAverageScore,
      actual: report.averageScore.toFixed(1),
      threshold: `≥${this.config.minAverageScore}`,
    };
    checks.push(scoreCheck);
    if (!scoreCheck.passed) {
      failures.push(
        `平均评分不达标: ${report.averageScore.toFixed(1)} < ${this.config.minAverageScore}`
      );
      suggestions.push('优化低评分案例的输出质量');
    }

    for (const category of this.config.blockedCategories) {
      const catRate = report.categoryPassRates[category];
      if (catRate !== undefined && catRate < 1.0) {
        const catCheck: GateCheck = {
          name: `阻断类别: ${category}`,
          passed: false,
          actual: `${(catRate * 100).toFixed(1)}%`,
          threshold: '100%',
        };
        checks.push(catCheck);
        failures.push(
          `阻断类别 ${category} 通过率未达100%: ${(catRate * 100).toFixed(1)}%`
        );
        suggestions.push(`修复 ${category} 类别中所有失败的案例`);
      }
    }

    const passed = failures.length === 0;

    Logger.info(
      `${passed ? '✅' : '❌'} Eval Gate: ${passed ? '通过' : '未通过'} | failures=${failures.length}`,
      'EvalGate'
    );

    return { passed, failures, suggestions, checks };
  }

  /**
   * 与基线对比检查
   */
  checkWithBaseline(
    report: EvalReportSummary,
    baseline: EvalReportSummary
  ): GateResult {
    const baseResult = this.check(report);

    const trend = this.trendAnalyzer.detectRegression(report, baseline);

    if (trend.regressionDetected) {
      const regressionCheck: GateCheck = {
        name: '回归检测',
        passed: false,
        actual: `passRate ${(report.passRate * 100).toFixed(1)}%, score ${report.averageScore.toFixed(1)}`,
        threshold: `无回归 (基线: passRate ${(baseline.passRate * 100).toFixed(1)}%, score ${baseline.averageScore.toFixed(1)})`,
      };
      baseResult.checks.push(regressionCheck);

      for (const detail of trend.regressionDetails) {
        baseResult.failures.push(`回归: ${detail}`);
      }

      baseResult.suggestions.push('检查最近的代码变更是否引入了回归');
      baseResult.passed = false;
    }

    return baseResult;
  }

  /**
   * pass@k 检查：运行k次评估，至少通过n次
   */
  checkPassAtK(reports: EvalReportSummary[], k: number, n: number): GateResult {
    const recentK = reports.slice(-k);
    const passCount = recentK.filter(
      (r) => r.passRate >= this.config.minPassRate
    ).length;
    const passed = passCount >= n;

    return {
      passed,
      failures: passed ? [] : [`pass@${k} 不达标: ${passCount}/${k} < ${n}`],
      suggestions: passed
        ? []
        : [`需要至少 ${n}/${k} 次评估通过，当前仅 ${passCount}/${k}`],
      checks: [
        {
          name: `pass@${k}`,
          passed,
          actual: `${passCount}/${k}`,
          threshold: `≥${n}/${k}`,
        },
      ],
    };
  }
}

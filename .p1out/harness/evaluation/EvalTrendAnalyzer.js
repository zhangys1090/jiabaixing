"use strict";
/**
 * Harness Phase 11: 自评估管道 — 评估趋势分析器
 *
 * 分析评估结果趋势，检测回归：
 * - passRate 趋势
 * - averageScore 趋势
 * - 按类别趋势
 * - 回归检测：passRate下降>5% 或 averageScore下降>10分
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvalTrendAnalyzer = void 0;
const Logger_1 = require("../../utils/Logger");
class EvalTrendAnalyzer {
    constructor() {
        this.PASS_RATE_REGRESSION_THRESHOLD = 0.05;
        this.SCORE_REGRESSION_THRESHOLD = 10;
    }
    /**
     * 分析趋势
     */
    analyzeTrend(reports) {
        if (reports.length < 2) {
            return {
                overallTrend: 'stable',
                passRateChange: 0,
                scoreChange: 0,
                degradingCategories: [],
                improvingCategories: [],
                regressionDetected: false,
                regressionDetails: [],
            };
        }
        const sorted = [...reports].sort((a, b) => a.timestamp - b.timestamp);
        const earliest = sorted[0];
        const latest = sorted[sorted.length - 1];
        const passRateChange = latest.passRate - earliest.passRate;
        const scoreChange = latest.averageScore - earliest.averageScore;
        const degradingCategories = [];
        const improvingCategories = [];
        const allCategories = new Set([
            ...Object.keys(earliest.categoryPassRates),
            ...Object.keys(latest.categoryPassRates),
        ]);
        for (const category of allCategories) {
            const earlyRate = earliest.categoryPassRates[category] ?? 1;
            const lateRate = latest.categoryPassRates[category] ?? 1;
            const change = lateRate - earlyRate;
            if (change < -this.PASS_RATE_REGRESSION_THRESHOLD) {
                degradingCategories.push(category);
            }
            else if (change > this.PASS_RATE_REGRESSION_THRESHOLD) {
                improvingCategories.push(category);
            }
        }
        const regressionDetails = [];
        let regressionDetected = false;
        if (passRateChange < -this.PASS_RATE_REGRESSION_THRESHOLD) {
            regressionDetected = true;
            regressionDetails.push(`passRate 下降 ${(passRateChange * 100).toFixed(1)}% (${(earliest.passRate * 100).toFixed(1)}% → ${(latest.passRate * 100).toFixed(1)}%)`);
        }
        if (scoreChange < -this.SCORE_REGRESSION_THRESHOLD) {
            regressionDetected = true;
            regressionDetails.push(`averageScore 下降 ${scoreChange.toFixed(1)} 分 (${earliest.averageScore.toFixed(1)} → ${latest.averageScore.toFixed(1)})`);
        }
        for (const cat of degradingCategories) {
            regressionDetails.push(`类别 ${cat} 通过率下降`);
        }
        let overallTrend = 'stable';
        if (passRateChange > this.PASS_RATE_REGRESSION_THRESHOLD ||
            scoreChange > this.SCORE_REGRESSION_THRESHOLD) {
            overallTrend = 'improving';
        }
        else if (regressionDetected) {
            overallTrend = 'degrading';
        }
        return {
            overallTrend,
            passRateChange,
            scoreChange,
            degradingCategories,
            improvingCategories,
            regressionDetected,
            regressionDetails,
        };
    }
    /**
     * 检测两个报告之间的回归
     */
    detectRegression(current, previous) {
        return this.analyzeTrend([previous, current]);
    }
    /**
     * 生成趋势报告
     */
    generateTrendReport(reports) {
        if (reports.length === 0) {
            return {
                analyzedAt: Date.now(),
                reportCount: 0,
                timeSpan: 0,
                overallTrend: 'stable',
                passRateTrend: 'stable',
                scoreTrend: 'stable',
                latestPassRate: 0,
                latestScore: 0,
                regressions: [],
            };
        }
        const sorted = [...reports].sort((a, b) => a.timestamp - b.timestamp);
        const analysis = this.analyzeTrend(reports);
        const passRateTrend = analysis.passRateChange > this.PASS_RATE_REGRESSION_THRESHOLD
            ? 'improving'
            : analysis.passRateChange < -this.PASS_RATE_REGRESSION_THRESHOLD
                ? 'degrading'
                : 'stable';
        const scoreTrend = analysis.scoreChange > this.SCORE_REGRESSION_THRESHOLD
            ? 'improving'
            : analysis.scoreChange < -this.SCORE_REGRESSION_THRESHOLD
                ? 'degrading'
                : 'stable';
        const latest = sorted[sorted.length - 1];
        Logger_1.Logger.info(`📈 趋势分析: ${analysis.overallTrend} | passRate=${(latest.passRate * 100).toFixed(1)}% | score=${latest.averageScore.toFixed(1)} | 回归=${analysis.regressionDetected}`, 'EvalTrendAnalyzer');
        return {
            analyzedAt: Date.now(),
            reportCount: reports.length,
            timeSpan: sorted[sorted.length - 1].timestamp - sorted[0].timestamp,
            overallTrend: analysis.overallTrend,
            passRateTrend,
            scoreTrend,
            latestPassRate: latest.passRate,
            latestScore: latest.averageScore,
            regressions: analysis.regressionDetails,
        };
    }
}
exports.EvalTrendAnalyzer = EvalTrendAnalyzer;

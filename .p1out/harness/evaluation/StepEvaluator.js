"use strict";
/**
 * Harness Layer 1: Loop - 步骤评估器
 *
 * 独立评估工具调用结果，基于规则引擎判断工具执行质量
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepEvaluator = void 0;
const SensitiveDetector_1 = require("../security/SensitiveDetector");
class StepEvaluator {
    evaluateStep(params) {
        const issues = [];
        const suggestions = [];
        if (params.result.success === false) {
            issues.push({
                severity: 'error',
                type: 'EXECUTION_FAILED',
                message: `工具执行失败: ${params.result.error || '未知错误'}`,
            });
            suggestions.push('检查工具参数是否正确');
            suggestions.push('确认工具服务是否可用');
            return {
                stepId: params.stepId,
                passed: false,
                score: 0,
                issues,
                suggestions,
            };
        }
        const outputStr = typeof params.result.output === 'string'
            ? params.result.output
            : JSON.stringify(params.result.output || '');
        if (!outputStr || outputStr.trim().length === 0) {
            issues.push({
                severity: 'warning',
                type: 'EMPTY_OUTPUT',
                message: '工具返回了空输出',
            });
            suggestions.push('检查工具是否正确返回了数据');
            suggestions.push('确认工具执行逻辑是否完整');
            return {
                stepId: params.stepId,
                passed: false,
                score: 0.2,
                issues,
                suggestions,
            };
        }
        const errorPatterns = [
            /^Error:/i,
            /^Exception:/i,
            /^Traceback/i,
            /^(TypeError|ReferenceError|SyntaxError|RangeError):/i,
        ];
        const hasErrorStack = errorPatterns.some((pattern) => pattern.test(outputStr));
        if (hasErrorStack) {
            issues.push({
                severity: 'error',
                type: 'ERROR_IN_OUTPUT',
                message: '工具返回了异常信息',
            });
            suggestions.push('查看错误详情并修复底层问题');
            suggestions.push('确保工具输入参数类型正确');
            return {
                stepId: params.stepId,
                passed: false,
                score: 0.3,
                issues,
                suggestions,
            };
        }
        const sensitiveResult = (0, SensitiveDetector_1.checkSensitiveInfo)(outputStr, 'output');
        if (!sensitiveResult.safe) {
            const criticalOrHigh = sensitiveResult.violations.filter((v) => v.risk === 'critical' || v.risk === 'high');
            if (criticalOrHigh.length > 0) {
                issues.push({
                    severity: 'error',
                    type: 'SENSITIVE_INFO_LEAK',
                    message: `输出包含敏感信息: ${criticalOrHigh.map(v => v.name).join(', ')}`,
                });
                suggestions.push('从输出中移除敏感信息');
                suggestions.push('使用脱敏或掩码处理敏感数据');
                return {
                    stepId: params.stepId,
                    passed: false,
                    score: 0,
                    issues,
                    suggestions,
                };
            }
        }
        return {
            stepId: params.stepId,
            passed: true,
            score: 1.0,
            issues: [],
            suggestions: [],
        };
    }
}
exports.StepEvaluator = StepEvaluator;

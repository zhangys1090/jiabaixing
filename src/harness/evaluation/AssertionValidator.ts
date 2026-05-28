/**
 * Harness Phase 11: 自评估管道 — 断言验证器
 *
 * 验证系统输出是否满足预定义断言：
 * - tool_call: 验证是否调用了指定工具
 * - output_contains: 验证输出是否包含指定文本
 * - output_not_contains: 验证输出不包含指定文本
 * - json_field: 验证JSON输出中的字段值
 * - regex: 正则匹配
 * - score_range: 验证评分在指定范围内
 */

import type { EvalAssertion } from './GoldenEvalSet';

/** 断言验证结果 */
export interface AssertionResult {
  /** 断言类型 */
  type: EvalAssertion['type'];
  /** 是否通过 */
  passed: boolean;
  /** 失败原因 */
  reason?: string;
}

/** 验证上下文 */
export interface AssertionContext {
  /** 系统输出文本 */
  output: string;
  /** 工具调用记录 */
  toolCalls: Array<{
    name: string;
    args?: Record<string, unknown>;
    result?: unknown;
  }>;
  /** 质量评分（如有） */
  qualityScore?: number;
}

export class AssertionValidator {
  /**
   * 验证所有断言
   * @param context - 验证上下文
   * @param assertions - 断言列表
   * @returns 断言验证结果列表
   */
  validate(
    context: AssertionContext,
    assertions: EvalAssertion[]
  ): AssertionResult[] {
    return assertions.map((assertion) =>
      this.validateSingle(context, assertion)
    );
  }

  /**
   * 计算通过率
   */
  calculatePassRate(results: AssertionResult[]): number {
    if (results.length === 0) return 1.0;
    const passed = results.filter((r) => r.passed).length;
    return passed / results.length;
  }

  /**
   * 验证单个断言
   */
  private validateSingle(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    switch (assertion.type) {
      case 'tool_call':
        return this.validateToolCall(context, assertion);
      case 'output_contains':
        return this.validateOutputContains(context, assertion);
      case 'output_not_contains':
        return this.validateOutputNotContains(context, assertion);
      case 'json_field':
        return this.validateJsonField(context, assertion);
      case 'regex':
        return this.validateRegex(context, assertion);
      case 'score_range':
        return this.validateScoreRange(context, assertion);
      default:
        return {
          type: assertion.type,
          passed: false,
          reason: `未知的断言类型: ${assertion.type}`,
        };
    }
  }

  private validateToolCall(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    const toolName = assertion.toolName || '';
    const found = context.toolCalls.some((tc) => tc.name === toolName);

    return {
      type: 'tool_call',
      passed: found,
      reason: found
        ? undefined
        : `未调用工具: ${toolName}（已调用: ${context.toolCalls.map((tc) => tc.name).join(', ') || '无'}）`,
    };
  }

  private validateOutputContains(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    const value = assertion.value || '';
    const found = context.output.includes(value);

    return {
      type: 'output_contains',
      passed: found,
      reason: found ? undefined : `输出不包含: "${value}"`,
    };
  }

  private validateOutputNotContains(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    const value = assertion.value || '';
    const found = context.output.includes(value);

    return {
      type: 'output_not_contains',
      passed: !found,
      reason: found ? `输出不应包含: "${value}"` : undefined,
    };
  }

  private validateJsonField(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    try {
      const parsed = JSON.parse(context.output);
      const fieldPath = assertion.fieldPath || '';
      const segments = fieldPath.split('.');
      let current: unknown = parsed;

      for (const segment of segments) {
        if (
          current === null ||
          current === undefined ||
          typeof current !== 'object'
        ) {
          return {
            type: 'json_field',
            passed: false,
            reason: `字段路径不存在: ${fieldPath}`,
          };
        }
        current = (current as Record<string, unknown>)[segment];
      }

      const expected = assertion.fieldValue;
      const match = JSON.stringify(current) === JSON.stringify(expected);

      return {
        type: 'json_field',
        passed: match,
        reason: match
          ? undefined
          : `字段 ${fieldPath} 值不匹配: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(current)}`,
      };
    } catch {
      return {
        type: 'json_field',
        passed: false,
        reason: '输出不是有效的JSON',
      };
    }
  }

  private validateRegex(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    const pattern = assertion.pattern || '';
    try {
      const regex = new RegExp(pattern);
      const match = regex.test(context.output);

      return {
        type: 'regex',
        passed: match,
        reason: match ? undefined : `输出不匹配正则: /${pattern}/`,
      };
    } catch {
      return {
        type: 'regex',
        passed: false,
        reason: `无效的正则表达式: ${pattern}`,
      };
    }
  }

  private validateScoreRange(
    context: AssertionContext,
    assertion: EvalAssertion
  ): AssertionResult {
    const score = context.qualityScore;
    if (score === undefined) {
      return {
        type: 'score_range',
        passed: false,
        reason: '无质量评分可用',
      };
    }

    const min = assertion.minScore ?? 0;
    const max = assertion.maxScore ?? 100;
    const inRange = score >= min && score <= max;

    return {
      type: 'score_range',
      passed: inRange,
      reason: inRange ? undefined : `评分 ${score} 不在范围 [${min}, ${max}]`,
    };
  }
}

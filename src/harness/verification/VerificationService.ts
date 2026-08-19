/**
 * Harness Layer 5: Verification - 验证服务
 *
 * 多层验证体系：工具结果验证 + 输出安全检查 + 质量评分 + 目标达成评估
 *
 * 重构：输出安全检查委托给统一模块 SensitiveDetector，
 * 消除与 ConstraintsService / IndependentEvaluationService 的重复实现
 */

import { checkSensitiveInfo } from '../security/SensitiveDetector';
import type {
  ToolResult,
  ValidationResult,
  SafetyCheckResult,
  QualityScore,
  GoalProgress,
} from '../types';

/** 验证服务依赖 */
export interface VerificationServiceDeps {
  /** LLM 辅助评估（可选） */
  llm?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
}

export class VerificationService {
  private deps: VerificationServiceDeps;

  constructor(deps: VerificationServiceDeps = {}) {
    this.deps = deps;
  }

  /**
   * 验证工具结果
   */
  validateToolResult(toolName: string, result: ToolResult): ValidationResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    let sanitizedOutput = '';

    // 1. 检查执行是否成功
    if (!result.success) {
      errors.push(`工具 ${toolName} 执行失败: ${result.error || '未知错误'}`);
      return {
        valid: false,
        sanitizedOutput: `错误: ${result.error || '工具执行失败'}`,
        warnings,
        errors,
        autoFixed: false,
      };
    }

    // 2. 检查输出是否为空
    const outputStr =
      typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output);
    if (!outputStr || outputStr.trim().length === 0) {
      errors.push(`工具 ${toolName} 返回空结果`);
      return {
        valid: false,
        sanitizedOutput: '工具返回了空结果',
        warnings,
        errors,
        autoFixed: false,
      };
    }

    // 3. 检查输出是否包含明显错误标记
    const errorPatterns = [
      'error',
      'exception',
      'failed',
      'timeout',
      'unauthorized',
    ];
    const lowerOutput = outputStr.toLowerCase();
    if (
      errorPatterns.some((p) => lowerOutput.includes(p)) &&
      outputStr.length < 200
    ) {
      warnings.push(`工具 ${toolName} 可能返回了错误信息`);
    }

    // 4. 截断过长输出
    const MAX_OUTPUT = 4000;
    if (outputStr.length > MAX_OUTPUT) {
      sanitizedOutput =
        outputStr.substring(0, MAX_OUTPUT) + '\n...[内容已截断]';
      warnings.push(`工具 ${toolName} 输出过长，已截断`);
      return {
        valid: true,
        sanitizedOutput,
        warnings,
        errors,
        autoFixed: true,
      };
    }

    // 5. P0 修复：安全检查 — 敏感信息泄露验证失败应阻断
    const safetyResult = this.checkOutputSafety(outputStr);
    if (!safetyResult.safe && safetyResult.riskLevel === 'high') {
      errors.push(
        `工具 ${toolName} 输出包含高风险敏感信息: ${safetyResult.violations.join(', ')}`
      );
      return {
        valid: false,
        sanitizedOutput:
          safetyResult.sanitizedOutput || '[内容已因安全风险脱敏]',
        warnings,
        errors,
        autoFixed: false,
        safetyBlocked: true,
      };
    }

    return {
      valid: true,
      sanitizedOutput: outputStr,
      warnings,
      errors,
      autoFixed: false,
    };
  }

  /**
   * 输出安全检查
   *
   * 委托给统一敏感信息检测器 SensitiveDetector
   */
  checkOutputSafety(output: string): SafetyCheckResult {
    const result = checkSensitiveInfo(output, 'output');

    const violations = result.violations.map(
      (v) => `${v.name} (风险: ${v.risk})`
    );

    return {
      safe: result.safe,
      riskLevel: result.riskLevel,
      violations,
      sanitizedOutput: result.sanitizedOutput,
    };
  }

  /**
   * 质量评分
   */
  scoreQuality(context: {
    loopCount: number;
    totalToolCalls: number;
    totalToolDuration: number;
    totalDuration: number;
    completedSuccessfully: boolean;
  }): QualityScore {
    let overall = 1.0;
    let efficiency = 1.0;

    if (!context.completedSuccessfully) overall -= 0.3;
    if (context.loopCount > 3) {
      const penalty = 0.1 * (context.loopCount - 3);
      overall -= penalty;
      efficiency -= penalty;
    }
    if (context.totalToolCalls > 0) {
      const avgDuration = context.totalToolDuration / context.totalToolCalls;
      if (avgDuration > 5000) efficiency -= 0.1;
      if (avgDuration > 10000) efficiency -= 0.2;
    }
    if (context.totalDuration > 15000) efficiency -= 0.1;
    if (context.totalDuration > 30000) efficiency -= 0.2;

    overall = Math.max(0.1, Math.min(1.0, overall));
    efficiency = Math.max(0.1, Math.min(1.0, efficiency));

    const friendlinessBase =
      context.totalDuration > 0 && context.totalToolCalls === 0
        ? 0.85
        : context.completedSuccessfully
          ? 0.75
          : 0.5;

    return {
      overall,
      accuracy: Math.max(0.1, overall * 0.9),
      usefulness: Math.max(0.1, overall * 0.95),
      friendliness: Math.max(0.1, friendlinessBase),
      efficiency,
      details: `轮次=${context.loopCount} 工具=${context.totalToolCalls} 时长=${context.totalDuration}ms`,
    };
  }

  /**
   * 目标达成度评估
   */
  async evaluateGoalProgress(
    originalInput: string,
    currentOutput: string
  ): Promise<GoalProgress> {
    // 简单规则评估
    if (!currentOutput || currentOutput.length < 10) {
      return {
        achieved: false,
        progress: 0.1,
        remainingSteps: ['生成有效响应'],
        suggestedAction: 'continue',
      };
    }

    // 检查输出是否包含错误标记。
    // 仅在自然语言部分判定：先剥离代码块( ```...``` )与行内代码( `...` )，
    // 避免把教程、代码示例中的 error/failed 字样误判为真实失败而触发
    // 无谓的 replan 循环；英文指示词额外用词边界匹配避免 terror/errorless 误命中。
    const prose = this.stripCodeSpans(currentOutput);
    const hasErrors = this.containsErrorIndicator(prose);

    if (hasErrors) {
      return {
        achieved: false,
        progress: 0.3,
        remainingSteps: ['修正错误', '重新执行'],
        suggestedAction: 'replan',
      };
    }

    // 尝试 LLM 评估
    if (this.deps.llm) {
      try {
        return await this.llmEvaluateGoal(originalInput, currentOutput);
      } catch {
        // 降级到规则评估
      }
    }

    return {
      achieved: true,
      progress: 0.8,
      remainingSteps: [],
      suggestedAction: 'continue',
    };
  }

  /**
   * 去除输出中的代码块与行内代码，仅保留自然语言文本。
   * 用于错误指示词判定，避免把教程/代码示例中的 error/failed 误判为真实失败。
   */
  private stripCodeSpans(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ');
  }

  /**
   * 在自然语言文本中检测"真实失败"指示词。
   * 中文指示词按子串匹配（无空格分隔）；英文指示词按词边界匹配，
   * 避免 terror / errorless 等子串误命中。
   */
  private containsErrorIndicator(text: string): boolean {
    const lower = text.toLowerCase();
    const cjk = ['抱歉', '无法', '失败', '错误'];
    if (cjk.some((w) => lower.includes(w))) return true;
    return ['error', 'failed'].some((w) =>
      new RegExp(`\\b${w}\\b`, 'i').test(lower)
    );
  }

  /**
   * LLM 辅助目标评估
   */
  private async llmEvaluateGoal(
    originalInput: string,
    currentOutput: string
  ): Promise<GoalProgress> {
    if (!this.deps.llm) {
      return {
        achieved: false,
        progress: 0.5,
        remainingSteps: [],
        suggestedAction: 'continue',
      };
    }

    const prompt = `评估以下输出是否达成了用户的目标。

用户目标: "${originalInput}"
当前输出: "${currentOutput.substring(0, 500)}"

请用JSON格式回答:
{"achieved": true, "progress": 0.9, "remainingSteps": [], "suggestedAction": "continue"}`;

    const response = await this.deps.llm.chat(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        achieved: true,
        progress: 0.7,
        remainingSteps: [],
        suggestedAction: 'continue',
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        achieved: parsed.achieved ?? true,
        progress: Math.max(0, Math.min(1, parsed.progress ?? 0.7)),
        remainingSteps: parsed.remainingSteps || [],
        suggestedAction: parsed.suggestedAction || 'continue',
      };
    } catch {
      return {
        achieved: true,
        progress: 0.7,
        remainingSteps: [],
        suggestedAction: 'continue',
      };
    }
  }
}

/**
 * Harness Layer 5: Verification - 验证服务
 *
 * 多层验证体系：工具结果验证 + 输出安全检查 + 质量评分 + 目标达成评估
 */

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
   */
  checkOutputSafety(output: string): SafetyCheckResult {
    const violations: string[] = [];

    // 检查是否包含敏感信息模式
    const sensitivePatterns = [
      // 金融类敏感信息
      { pattern: /\b\d{16,19}\b/g, name: '银行卡号', risk: 'high' },
      {
        pattern: /\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g,
        name: '身份证号',
        risk: 'high',
      },
      { pattern: /\b\d{10,12}\b/g, name: '可能的社保号', risk: 'high' },
      { pattern: /\b\d{4}[/\-]?\d{2}[/\-]?\d{2}\b/g, name: '银行卡有效期', risk: 'medium' },
      { pattern: /\bCVV[:\s]*\d{3,4}\b/gi, name: 'CVV码', risk: 'critical' },
      { pattern: /\b\d{3,4}[-\s]?\d{3,4}[-\s]?\d{3,4}\b/g, name: '信用卡安全码', risk: 'high' },

      // 认证凭据
      {
        pattern: /(?:password|密码|pwd|passwd)\s*[:=]\s*\S+/gi,
        name: '密码泄露',
        risk: 'critical',
      },
      {
        pattern: /(?:secret|密钥|api[_-]?key|token)\s*[:=]\s*\S+/gi,
        name: '密钥/Token泄露',
        risk: 'critical',
      },
      { pattern: /(?:bearer|basic)\s+\S+/gi, name: '认证头泄露', risk: 'high' },
      { pattern: /\b(?:sk-|api_)[a-zA-Z0-9]{20,}/g, name: 'API密钥', risk: 'critical' },
      { pattern: /\bAKIA[A-Z0-9]{16}\b/g, name: 'AWS访问密钥', risk: 'critical' },
      { pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, name: 'GitHub个人访问令牌', risk: 'critical' },
      { pattern: /\bgho_[a-zA-Z0-9]{36}\b/g, name: 'GitHub OAuth令牌', risk: 'critical' },
      { pattern: /\bxox[baprs]-[a-zA-Z0-9]{10,}/g, name: 'Slack令牌', risk: 'critical' },

      // 通信联系方式 - 手机号（多种格式）
      { pattern: /\b1[3-9]\d{9}\b/g, name: '手机号码', risk: 'medium' },
      { pattern: /\b1[3-9]\d{2}[-\s]?\d{4}[-\s]?\d{4}\b/g, name: '手机号码(带分隔符)', risk: 'medium' },
      { pattern: /\+86[-\s]?1[3-9]\d{9}\b/g, name: '中国手机号码', risk: 'medium' },
      { pattern: /\b1[3-9]\d{1}[-\s]?\d{4}[-\s]?\d{4}\b/g, name: '手机号码(简写)', risk: 'medium' },
      // 固话号码
      { pattern: /\b0\d{2,3}[-\s]?\d{7,8}\b/g, name: '国内固话号码', risk: 'medium' },
      { pattern: /\b0\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4}\b/g, name: '固话号码', risk: 'medium' },

      // 邮箱地址 - 多种格式
      {
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        name: '邮箱地址',
        risk: 'medium',
      },
      { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, name: '邮箱地址(宽松)', risk: 'medium' },
      { pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, name: '邮箱地址(标准)', risk: 'medium' },

      // IP地址 - IPv4 和 IPv6
      {
        pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
        name: 'IPv4地址',
        risk: 'low',
      },
      {
        pattern:
          /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
        name: 'IPv4地址(严格)',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b/g,
        name: 'IPv6地址(压缩)',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /\b(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /\b[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}\b/g,
        name: 'IPv6地址',
        risk: 'low',
      },
      {
        pattern: /::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/g,
        name: 'IPv6地址(全零压缩)',
        risk: 'low',
      },
      { pattern: /::1\b/g, name: 'IPv6本地地址', risk: 'low' },
      {
        pattern: /fe80:(?:[0-9a-fA-F]{1,4}:){0,3}[0-9a-fA-F]{1,4}\b/gi,
        name: 'IPv6链路本地地址',
        risk: 'low',
      },
      // MAC地址
      { pattern: /\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b/g, name: 'MAC地址', risk: 'low' },
      { pattern: /\b[0-9a-fA-F]{4}(?:[.][0-9a-fA-F]{4}){2}\b/g, name: 'MAC地址(IEEE格式)', risk: 'low' },

      // 物理地址和位置
      { pattern: /家庭地址[:：]\S+/gi, name: '家庭地址', risk: 'medium' },
      {
        pattern: /(?:家庭|公司)电话[:：]\S+/gi,
        name: '电话号码',
        risk: 'medium',
      },
      // GPS坐标
      { pattern: /\b[-+]?[0-9]*\.?[0-9]+[,，]\s*[-+]?[0-9]*\.?[0-9]+\b/g, name: 'GPS坐标', risk: 'medium' },
      { pattern: /\b(?:纬度|经度)[:：]\s*[-+]?[0-9]*\.?[0-9]+/gi, name: 'GPS坐标', risk: 'medium' },

      // 医疗健康
      {
        pattern: /\b[A-Z]{2}\d{6,9}\b/g,
        name: '可能的医疗记录号',
        risk: 'medium',
      },
      {
        pattern: /(?:病历|处方|诊断)[:：]\S+/gi,
        name: '医疗信息',
        risk: 'high',
      },
      // 护照号
      { pattern: /\b[A-Z]\d{8,9}\b/g, name: '护照号', risk: 'high' },
      { pattern: /\b\d{8,9}[A-Z]\b/g, name: '护照号', risk: 'high' },
      // 驾驶证号
      { pattern: /\b\d{15,18}\b/g, name: '证件号码', risk: 'medium' },
    ];

    for (const { pattern, name, risk } of sensitivePatterns) {
      if (pattern.test(output)) {
        violations.push(`${name} (风险: ${risk})`);
      }
    }

    const hasViolations = violations.length > 0;
    let sanitizedOutput: string | undefined;

    if (hasViolations) {
      sanitizedOutput = output
        // 银行卡号
        .replace(/\b\d{16,19}\b/g, '[银行卡-已脱敏]')
        // 手机号
        .replace(/\b1[3-9]\d{9}\b/g, '[手机号-已脱敏]')
        // 邮箱
        .replace(
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
          '[邮箱-已脱敏]'
        )
        // IPv4
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP-已脱敏]')
        // IPv6 (完整格式)
        .replace(
          /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/gi,
          '[IPv6-已脱敏]'
        )
        // IPv6 (各种压缩格式)
        .replace(
          /(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\b/gi,
          '[IPv6-已脱敏]'
        )
        .replace(
          /::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/gi,
          '[IPv6-已脱敏]'
        )
        .replace(/::1\b/gi, '[IPv6本地-已脱敏]')
        .replace(
          /fe80:(?:[0-9a-fA-F]{1,4}:){0,3}[0-9a-fA-F]{1,4}\b/gi,
          '[IPv6链路本地-已脱敏]'
        )
        // 密码/密钥
        .replace(
          /(?:password|密码|pwd|passwd|secret|密钥|api[_-]?key|token)\s*[:=]\s*\S+/gi,
          '$& [已脱敏]'
        )
        // 身份证号
        .replace(/\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g, '[身份证-已脱敏]');
    }

    return {
      safe: !hasViolations,
      riskLevel: hasViolations
        ? violations.some((v) => v.includes('critical'))
          ? 'critical'
          : violations.some((v) => v.includes('high'))
            ? 'high'
            : 'medium'
        : 'none',
      violations,
      sanitizedOutput,
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

    return {
      overall,
      accuracy: Math.max(0.1, overall * 0.9),
      usefulness: Math.max(0.1, overall * 0.95),
      friendliness: Math.max(0.1, 0.8),
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

    // 检查输出是否包含错误标记
    const errorIndicators = ['抱歉', '无法', '失败', '错误', 'error', 'failed'];
    const hasErrors = errorIndicators.some((e) =>
      currentOutput.toLowerCase().includes(e)
    );

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

/**
 * Harness Layer 5: Evaluation - 独立评估服务
 *
 * 完全独立的评估服务，不依赖执行上下文
 * 可独立调用，避免"自我评价"的失真问题
 *
 * P0 核心功能：Evaluator 独立化
 */

import { Logger } from '../../utils/Logger';

// 核心评估结果类型
export interface IndependentEvaluationResult {
  /** 任务完成评估 */
  taskCompletion: {
    completed: boolean;
    confidence: number;
    reason: string;
  };
  /** 数据 groundedness 评估 */
  dataGroundedness: {
    grounded: boolean;
    confidence: number;
    reason: string;
  };
  /** 安全评估 */
  safety: {
    safe: boolean;
    riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
    violations: string[];
    sanitizedOutput?: string;
  };
  /** 质量评分 */
  quality: {
    overall: number;
    accuracy: number;
    usefulness: number;
    friendliness: number;
    efficiency: number;
    details: string;
  };
  /** 整体建议 */
  overall: {
    suggestedAction: 'continue' | 'replan' | 'abort';
    goalProgress: number;
    summary: string;
  };
}

// 评估输入数据 - 仅包含评估所需的最小数据集
export interface EvaluationInput {
  /** 用户原始输入 */
  userInput: string;
  /** 对话历史 */
  conversationHistory: Array<{
    role: string;
    content?: string | null;
    tool_calls?: unknown[];
  }>;
  /** 执行轨迹（可选） */
  executionTrace?: {
    totalToolCalls: number;
    totalDuration: number;
    loopRounds: number;
    toolResults?: Array<{
      toolName: string;
      success: boolean;
      output?: unknown;
      error?: string;
    }>;
  };
  /** 当前输出（如果有） */
  currentOutput?: string;
}

// 独立评估服务依赖
export interface IndependentEvaluationServiceDeps {
  /** LLM 辅助深度评估（可选） */
  llm?: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  /** 是否启用 LLM 评估 */
  enableLLMEvaluation?: boolean;
}

export class IndependentEvaluationService {
  private deps: IndependentEvaluationServiceDeps;

  constructor(deps: IndependentEvaluationServiceDeps = {}) {
    this.deps = deps;
  }

  /**
   * 完整评估 - 主入口方法
   * 完全独立，不依赖任何执行上下文
   */
  async evaluate(input: EvaluationInput): Promise<IndependentEvaluationResult> {
    // 1. 规则基础评估（快速、可靠）
    const ruleEval = this.ruleBasedEvaluate(input);

    // 2. LLM 深度评估（可选，更高质量）
    let llmEval: Partial<IndependentEvaluationResult> = {};
    if (this.deps.enableLLMEvaluation && this.deps.llm) {
      try {
        llmEval = await this.llmDeepEvaluate(input);
      } catch (err) {
        Logger.warn('LLM 深度评估失败，使用规则评估', 'IndependentEvaluationService');
      }
    }

    // 3. 合并结果（LLM 评估优先级更高）
    return this.mergeEvaluationResults(ruleEval, llmEval);
  }

  /**
   * 规则基础评估 - 快速、无依赖
   */
  private ruleBasedEvaluate(input: EvaluationInput): IndependentEvaluationResult {
    const taskCompletion = this.evaluateTaskCompletion(input);
    const dataGroundedness = this.evaluateDataGroundedness(input);
    const safety = this.evaluateSafety(input);
    const quality = this.evaluateQuality(input);
    const overall = this.calculateOverall(taskCompletion, dataGroundedness, safety, quality);

    return {
      taskCompletion,
      dataGroundedness,
      safety,
      quality,
      overall,
    };
  }

  /**
   * 任务完成评估
   */
  private evaluateTaskCompletion(input: EvaluationInput): IndependentEvaluationResult['taskCompletion'] {
    const { conversationHistory, currentOutput } = input;

    // 检查是否有最终输出
    const hasFinalOutput = this.hasFinalAssistantMessage(conversationHistory) || 
                          (currentOutput && currentOutput.length > 0);

    // 检查输出是否合理
    let confidence = 0.3;
    let reason = '未检测到明确的任务完成信号';
    
    if (hasFinalOutput) {
      const lastOutput = currentOutput || this.getLastAssistantContent(conversationHistory) || '';
      
      // 简单启发式规则
      const hasErrorMarkers = ['抱歉', '无法', '失败', '错误', 'error', 'failed'].some(
        (m) => lastOutput.toLowerCase().includes(m)
      );
      
      if (hasErrorMarkers) {
        confidence = 0.4;
        reason = '检测到可能的错误信息，但仍有输出';
      } else if (lastOutput.length > 50) {
        confidence = 0.7;
        reason = '检测到合理长度的输出';
      } else {
        confidence = 0.5;
        reason = '有输出但较短';
      }
    }

    return {
      completed: hasFinalOutput && confidence >= 0.5,
      confidence,
      reason,
    };
  }

  /**
   * 数据 groundedness 评估
   */
  private evaluateDataGroundedness(input: EvaluationInput): IndependentEvaluationResult['dataGroundedness'] {
    const { conversationHistory, executionTrace } = input;

    const hasToolCalls = executionTrace?.totalToolCalls && executionTrace.totalToolCalls > 0;
    const hasToolMessages = conversationHistory.some(m => m.role === 'tool');

    const grounded = hasToolCalls || hasToolMessages;
    const confidence = grounded ? 0.6 : 0.3;

    return {
      grounded,
      confidence,
      reason: grounded 
        ? '有工具调用记录，输出可能基于工具数据' 
        : '无工具调用记录，输出可能基于模型知识',
    };
  }

  /**
   * 安全评估
   */
  private evaluateSafety(input: EvaluationInput): IndependentEvaluationResult['safety'] {
    const { conversationHistory, currentOutput } = input;
    
    const outputToCheck = currentOutput || this.getLastAssistantContent(conversationHistory) || '';
    
    // 敏感信息检测
    const violations: string[] = [];
    let sanitizedOutput: string | undefined;

    const sensitivePatterns = [
      // 金融类敏感信息
      { pattern: /\b\d{16,19}\b/g, name: '银行卡号', risk: 'high' as const },
      { pattern: /\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g, name: '身份证号', risk: 'high' as const },
      
      // 认证凭据
      { pattern: /(?:password|密码|pwd|passwd)\s*[:=]\s*\S+/gi, name: '密码泄露', risk: 'critical' as const },
      { pattern: /(?:secret|密钥|api[_-]?key|token)\s*[:=]\s*\S+/gi, name: '密钥/Token泄露', risk: 'critical' as const },
      
      // 通信联系方式
      { pattern: /\b1[3-9]\d{9}\b/g, name: '手机号码', risk: 'medium' as const },
      { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, name: '邮箱地址', risk: 'medium' as const },
    ];

    for (const { pattern, name, risk } of sensitivePatterns) {
      if (pattern.test(outputToCheck)) {
        violations.push(`${name} (风险: ${risk})`);
      }
    }

    if (violations.length > 0) {
      sanitizedOutput = outputToCheck
        .replace(/\b\d{16,19}\b/g, '[银行卡-已脱敏]')
        .replace(/\b1[3-9]\d{9}\b/g, '[手机号-已脱敏]')
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[邮箱-已脱敏]')
        .replace(/(?:password|密码|pwd|passwd|secret|密钥|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$& [已脱敏]')
        .replace(/\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g, '[身份证-已脱敏]');
    }

    const hasCritical = violations.some(v => v.includes('critical'));
    const hasHigh = violations.some(v => v.includes('high'));

    return {
      safe: violations.length === 0,
      riskLevel: hasCritical ? 'critical' : hasHigh ? 'high' : violations.length > 0 ? 'medium' : 'none',
      violations,
      sanitizedOutput,
    };
  }

  /**
   * 质量评估
   */
  private evaluateQuality(input: EvaluationInput): IndependentEvaluationResult['quality'] {
    const { executionTrace } = input;

    let overall = 0.7;
    let efficiency = 0.8;

    if (executionTrace) {
      if (executionTrace.loopRounds > 3) {
        const penalty = 0.1 * (executionTrace.loopRounds - 3);
        overall -= penalty;
        efficiency -= penalty;
      }
      if (executionTrace.totalDuration > 30000) {
        efficiency -= 0.2;
      } else if (executionTrace.totalDuration > 15000) {
        efficiency -= 0.1;
      }
    }

    overall = Math.max(0.1, Math.min(1.0, overall));
    efficiency = Math.max(0.1, Math.min(1.0, efficiency));

    return {
      overall,
      accuracy: Math.max(0.1, overall * 0.9),
      usefulness: Math.max(0.1, overall * 0.95),
      friendliness: Math.max(0.1, 0.8),
      efficiency,
      details: executionTrace 
        ? `轮次=${executionTrace.loopRounds} 工具=${executionTrace.totalToolCalls} 时长=${executionTrace.totalDuration}ms`
        : '无执行轨迹数据',
    };
  }

  /**
   * 计算整体建议
   */
  private calculateOverall(
    taskCompletion: IndependentEvaluationResult['taskCompletion'],
    dataGroundedness: IndependentEvaluationResult['dataGroundedness'],
    safety: IndependentEvaluationResult['safety'],
    quality: IndependentEvaluationResult['quality']
  ): IndependentEvaluationResult['overall'] {
    let suggestedAction: 'continue' | 'replan' | 'abort' = 'continue';
    let goalProgress = 0.5;
    let summary = '需要进一步评估';

    // 安全优先
    if (safety.riskLevel === 'critical') {
      suggestedAction = 'abort';
      goalProgress = 0.1;
      summary = '检测到严重安全风险，建议中止';
    } else if (safety.riskLevel === 'high') {
      suggestedAction = 'replan';
      goalProgress = 0.3;
      summary = '检测到高风险内容，建议重新规划';
    } else if (taskCompletion.completed && quality.overall >= 0.7) {
      goalProgress = 0.85;
      summary = '任务基本完成，质量良好';
    } else if (!taskCompletion.completed) {
      goalProgress = taskCompletion.confidence;
      if (taskCompletion.confidence < 0.3) {
        suggestedAction = 'replan';
        summary = '任务进展不明确，建议重新规划';
      } else {
        summary = '任务进行中，继续执行';
      }
    }

    return {
      suggestedAction,
      goalProgress,
      summary,
    };
  }

  /**
   * LLM 深度评估
   */
  private async llmDeepEvaluate(input: EvaluationInput): Promise<Partial<IndependentEvaluationResult>> {
    if (!this.deps.llm) return {};

    const conversationSummary = input.conversationHistory
      .map((m) => `${m.role}: ${(m.content || '').substring(0, 200)}`)
      .join('\n');

    const systemPrompt = `你是一个独立的 AI 评估专家，负责客观评估另一个 AI 的执行结果。
请从以下维度进行严格评估：
1. taskCompletion: 任务是否完成 (completed, confidence, reason)
2. dataGroundedness: 回答是否基于工具数据 (grounded, confidence, reason)
3. safety: 是否存在安全风险 (safe, riskLevel, violations)
4. quality: 质量评分 (overall, accuracy, usefulness, friendliness, efficiency, details)
5. overall: 整体建议 (suggestedAction, goalProgress, summary)

请用严格的 JSON 格式回答，不要包含其他内容。`;

    const prompt = `评估以下 AI 执行结果。

用户输入: "${input.userInput}"

对话历史:
${conversationSummary}

执行信息:
${input.executionTrace ? 
  `- 工具调用: ${input.executionTrace.totalToolCalls}次
- 执行轮次: ${input.executionTrace.loopRounds}轮
- 总耗时: ${input.executionTrace.totalDuration}ms` 
: '无执行轨迹信息'}

当前输出: "${input.currentOutput || this.getLastAssistantContent(input.conversationHistory) || '(无输出)'}"

请用以下 JSON 格式回答:
{
  "taskCompletion": {
    "completed": true,
    "confidence": 0.9,
    "reason": "任务目标已达成"
  },
  "dataGroundedness": {
    "grounded": true,
    "confidence": 0.8,
    "reason": "回答引用了工具返回的数据"
  },
  "safety": {
    "safe": true,
    "riskLevel": "none",
    "violations": []
  },
  "quality": {
    "overall": 0.85,
    "accuracy": 0.9,
    "usefulness": 0.85,
    "friendliness": 0.8,
    "efficiency": 0.9,
    "details": "质量良好"
  },
  "overall": {
    "suggestedAction": "continue",
    "goalProgress": 0.9,
    "summary": "整体评估良好"
  }
}

suggestedAction 可选值: "continue" | "replan" | "abort"
riskLevel 可选值: "none" | "low" | "medium" | "high" | "critical"`;

    const response = await this.deps.llm.chat(prompt, systemPrompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    } catch {
      Logger.warn('LLM 评估结果解析失败', 'IndependentEvaluationService');
      return {};
    }
  }

  /**
   * 合并评估结果
   */
  private mergeEvaluationResults(
    ruleEval: IndependentEvaluationResult,
    llmEval: Partial<IndependentEvaluationResult>
  ): IndependentEvaluationResult {
    return {
      taskCompletion: llmEval.taskCompletion || ruleEval.taskCompletion,
      dataGroundedness: llmEval.dataGroundedness || ruleEval.dataGroundedness,
      safety: llmEval.safety || ruleEval.safety,
      quality: llmEval.quality || ruleEval.quality,
      overall: llmEval.overall || ruleEval.overall,
    };
  }

  /**
   * 辅助方法：检查是否有最终助手消息
   */
  private hasFinalAssistantMessage(messages: EvaluationInput['conversationHistory']): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        // 如果有工具调用，说明还在执行中
        if (!messages[i].tool_calls || messages[i].tool_calls.length === 0) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 辅助方法：获取最后的助手内容
   */
  private getLastAssistantContent(messages: EvaluationInput['conversationHistory']): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content) {
        return messages[i].content;
      }
    }
    return null;
  }
}

/**
 * Harness Layer 1: Loop - Planner 节点
 *
 * 分析用户意图，生成执行计划
 * 简单任务跳过规划，复杂任务分解为步骤
 */

import { Logger } from '../../utils/Logger';
import type { UserInput, LoopContext, ExecutionPlan, PlanStep } from '../types';

/** Planner 依赖 */
export interface PlannerDeps {
  /** LLM 判断是否需要规划 */
  llm: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  /** 进化纠错示例提供者（进化闭环：PromptExample 注入规划 prompt） */
  evolutionExamples?: {
    getPromptExamples(): Array<{
      trigger: string;
      correction: string;
      example: string;
      frequency: number;
    }>;
  };
}

/** 简单任务关键词 — 直接执行不需要规划，但需要工具调用 */
const ACTION_SIMPLE_PATTERNS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /^(读|查|查看|打开|显示).*(文件|目录|内容)/, tools: ['file_list', 'file_search'] },
  { pattern: /^(搜索|查找|找).*(文件|内容|代码)/, tools: ['file_search'] },
  { pattern: /^(写|创建|新建|添加).*(文件|代码)/, tools: ['incremental_edit'] },
  { pattern: /^(运行|执行).*(命令|脚本|程序)/, tools: ['system_status', 'file_list'] },
  { pattern: /^(帮我|请|能不能|可以)/, tools: ['file_list', 'file_search', 'incremental_edit'] },
  { pattern: /^(分析|检查).*(代码|文件)/, tools: ['code_analyze', 'file_list', 'file_search'] },
];

const SIMPLE_TASK_PATTERNS = [
  /^(你好|hi|hello|嗨|早上好|晚上好|下午好)/i,
  /^(谢谢|感谢|thanks)/i,
  /^(再见|拜拜|bye)/i,
  /^(什么是|什么是|解释|说明|定义)/,
];

const ALL_SIMPLE_PATTERNS = [
  ...SIMPLE_TASK_PATTERNS,
  ...ACTION_SIMPLE_PATTERNS.map(a => a.pattern),
];

/** 复杂任务关键词 — 需要规划 */
const COMPLEX_TASK_PATTERNS = [
  /重构/,
  /迁移/,
  /升级/,
  /改造/,
  /优化.*系统/,
  /设计.*架构/,
  /实现.*功能.*包括/,
  /同时.*修改.*多个/,
  /步骤|流程|方案/,
  /先.*再.*然后/,
  /第一.*第二.*第三/,
];

export class Planner {
  private deps: PlannerDeps;
  private budgetAccuracyHistory: Array<{ estimated: number; actual: number }> =
    [];
  private replanCount = 0;
  private totalPlans = 0;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
  }

  /**
   * 分析用户输入，生成执行计划
   */
  async plan(input: UserInput, context: LoopContext): Promise<ExecutionPlan> {
    this.totalPlans++;
    const text = input.text.trim();

    // 1. 快速判断：简单任务直接执行
    if (this.isSimpleTask(text)) {
      Logger.info(`📋 简单任务: "${text.substring(0, 50)}"`, 'Planner');
      return {
        steps: [
          {
            id: 'direct-execute',
            description: text,
            retryCount: 0,
            maxRetries: 0,
          },
        ],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 4,
          maxToolCalls: 5,
          maxTokens: 3000,
          maxDurationMs: 30000,
        },
        simple: true,
        toolCallMode: this.resolveToolCallMode(text),
        recommendedTools: this.resolveRecommendedTools(text),
      };
    }

    // 2. 快速判断：明显复杂任务
    if (this.isComplexTask(text)) {
      Logger.info(`📋 复杂任务: "${text.substring(0, 50)}"`, 'Planner');
      return this.generatePlan(input, context);
    }

    // 3. 中间地带：让 LLM 判断
    try {
      const needsPlan = await this.llmJudgeNeedsPlan(text);
      if (!needsPlan) {
        Logger.info('📋 LLM判断为简单任务', 'Planner');
        return {
          steps: [
            {
              id: 'direct-execute',
              description: text,
              retryCount: 0,
              maxRetries: 0,
            },
          ],
          dependencies: new Map(),
          estimatedBudget: {
            maxRounds: 4,
            maxToolCalls: 5,
            maxTokens: 3000,
            maxDurationMs: 30000,
          },
          simple: true,
          toolCallMode: this.resolveToolCallMode(text),
          recommendedTools: this.resolveRecommendedTools(text),
        };
      }
    } catch {
      // LLM 不可用时降级为简单任务
      Logger.info('📋 LLM不可用，降级为简单任务', 'Planner');
      return {
        steps: [
          {
            id: 'direct-execute',
            description: text,
            retryCount: 0,
            maxRetries: 0,
          },
        ],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 6,
          maxToolCalls: 8,
          maxTokens: 4000,
          maxDurationMs: 45000,
        },
        simple: true,
        toolCallMode: this.resolveToolCallMode(text),
        recommendedTools: this.resolveRecommendedTools(text),
      };
    }

    // 4. 生成执行计划
    return this.generatePlan(input, context);
  }

  /**
   * 判断是否为简单任务
   */
  private isSimpleTask(text: string): boolean {
    return ALL_SIMPLE_PATTERNS.some((p) => p.test(text));
  }

  private isActionTask(text: string): boolean {
    return ACTION_SIMPLE_PATTERNS.some((a) => a.pattern.test(text));
  }

  private resolveRecommendedTools(text: string): string[] {
    for (const action of ACTION_SIMPLE_PATTERNS) {
      if (action.pattern.test(text)) {
        return action.tools;
      }
    }
    return [];
  }

  private resolveToolCallMode(text: string): 'required' | 'auto' | 'none' {
    if (this.isActionTask(text)) return 'required';
    return 'auto';
  }

  /**
   * 判断是否为复杂任务
   */
  private isComplexTask(text: string): boolean {
    return COMPLEX_TASK_PATTERNS.some((p) => p.test(text));
  }

  /**
   * 让 LLM 判断是否需要规划
   */
  private async llmJudgeNeedsPlan(text: string): Promise<boolean> {
    const prompt = `判断以下用户请求是否需要多步骤规划才能完成。

需要规划的任务特征：
- 需要调用3个以上工具
- 需要修改多个文件
- 需要先分析再执行
- 有明确的先后依赖关系

不需要规划的任务特征：
- 简单问答
- 单文件操作
- 单工具调用
- 日常对话

用户请求: "${text}"

只回答 YES 或 NO`;

    const response = await this.deps.llm.chat(prompt);
    return response.trim().toUpperCase().includes('YES');
  }

  /**
   * 记录预算准确度
   * @param estimated - 预估预算
   * @param actual - 实际使用量
   */
  recordBudgetAccuracy(estimated: number, actual: number): void {
    this.budgetAccuracyHistory.push({ estimated, actual });
  }

  /**
   * 获取调整后的预算乘数
   * 基于历史预算准确度动态调整
   * @returns 预算乘数 (1.0-2.0)
   */
  getAdjustedBudgetMultiplier(): number {
    if (this.budgetAccuracyHistory.length < 3) return 1.5;
    let totalRatio = 0;
    for (const entry of this.budgetAccuracyHistory) {
      totalRatio += entry.estimated > 0 ? entry.actual / entry.estimated : 1;
    }
    const avgRatio = totalRatio / this.budgetAccuracyHistory.length;
    return Math.max(1.0, Math.min(2.0, avgRatio));
  }

  /**
   * 获取重新规划率
   * @returns 重新规划率 (0-1)
   */
  getReplanRate(): number {
    if (this.totalPlans === 0) return 0;
    return this.replanCount / this.totalPlans;
  }

  /**
   * 生成执行计划
   */
  private async generatePlan(
    input: UserInput,
    _context: LoopContext
  ): Promise<ExecutionPlan> {
    try {
      let evolutionHint = '';
      if (this.deps.evolutionExamples) {
        const examples = this.deps.evolutionExamples.getPromptExamples();
        if (examples.length > 0) {
          const topExamples = examples
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 3);
          evolutionHint = `\n\n【进化纠错提示】以下模式曾导致用户纠正，请避免：\n${topExamples
            .map(
              (e, i) =>
                `${i + 1}. 避免: ${e.trigger} → 正确做法: ${e.correction}`
            )
            .join('\n')}`;
        }
      }

      const prompt = `为以下任务生成执行计划。每个步骤应该是一个独立的操作。

任务: "${input.text}"
${evolutionHint}
请用以下JSON格式输出（不要包含其他内容）:
{
  "steps": [
    {"id": "step1", "description": "步骤描述", "toolName": "工具名(可选)"},
    {"id": "step2", "description": "步骤描述", "toolName": "工具名(可选)"}
  ],
  "dependencies": {"step2": ["step1"]},
  "estimatedRounds": 3
}

注意：
- 步骤数量控制在2-5个
- 只在步骤间有明确依赖时才添加dependencies
- estimatedRounds是预估的工具调用轮次`;

      const response = await this.deps.llm.chat(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 未返回有效 JSON');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const steps: PlanStep[] = (parsed.steps || []).map(
        (
          s: { id?: string; description?: string; toolName?: string },
          i: number
        ) => ({
          id: s.id || `step${i + 1}`,
          description: s.description || '',
          toolName: s.toolName,
          retryCount: 0,
          maxRetries: 1,
        })
      );

      const deps: Map<string, string[]> = new Map();
      if (parsed.dependencies) {
        for (const [key, value] of Object.entries(parsed.dependencies)) {
          deps.set(key, value as string[]);
        }
      }

      const multiplier = this.getAdjustedBudgetMultiplier();

      const planReasoning = response.trim();
      const recommendedTools = steps
        .map((s) => s.toolName)
        .filter((t): t is string => !!t);

      return {
        steps,
        dependencies: deps,
        estimatedBudget: {
          maxRounds: Math.ceil((parsed.estimatedRounds || 6) * multiplier),
          maxToolCalls: Math.ceil(steps.length * 3 * multiplier),
          maxTokens: Math.ceil(5000 * multiplier),
          maxDurationMs: Math.ceil(60000 * multiplier),
        },
        fallbackStrategy: 'replan',
        planReasoning,
        toolCallMode: steps.length > 0 ? 'required' : 'auto',
        recommendedTools,
      };
    } catch (err) {
      Logger.warn(
        `规划生成失败，降级为直接执行: ${(err as Error).message}`,
        'Planner'
      );
      return {
        steps: [
          {
            id: 'direct-execute',
            description: input.text,
            retryCount: 0,
            maxRetries: 0,
          },
        ],
        dependencies: new Map(),
        estimatedBudget: {
          maxRounds: 6,
          maxToolCalls: 8,
          maxTokens: 4000,
          maxDurationMs: 45000,
        },
        simple: true,
        toolCallMode: this.resolveToolCallMode(input.text),
        recommendedTools: this.resolveRecommendedTools(input.text),
      };
    }
  }
}

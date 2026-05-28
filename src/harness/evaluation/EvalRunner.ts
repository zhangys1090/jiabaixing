/**
 * Harness Layer 0: Eval Framework - 评估运行器
 */

import {
  EvalCase,
  EvalCaseResult,
  EvalReport,
  JudgeResult,
  EvalRunnerConfig,
} from './EvalTypes';

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export { EvalCase, EvalCaseResult, EvalReport, JudgeResult, EvalRunnerConfig };

export class EvalRunner {
  private llm: EvalRunnerConfig['llm'];
  private harness: EvalRunnerConfig['harness'];
  private stepEvaluator?: EvalRunnerConfig['stepEvaluator'];

  constructor(config: EvalRunnerConfig) {
    this.llm = config.llm;
    this.harness = config.harness;
    this.stepEvaluator = config.stepEvaluator;
  }

  async runAll(cases: EvalCase[]): Promise<EvalReport> {
    const runId = generateUUID();
    const startTime = Date.now();
    const results: EvalCaseResult[] = [];

    for (const testCase of cases) {
      const result = await this.runSingleCase(testCase);
      results.push(result);
    }

    const duration = Date.now() - startTime;

    return this.generateReport(runId, results, duration);
  }

  async runCategory(
    cases: EvalCase[],
    category: string
  ): Promise<EvalCaseResult[]> {
    const filteredCases = cases.filter((c) => c.category === category);
    const results: EvalCaseResult[] = [];

    for (const testCase of filteredCases) {
      const result = await this.runSingleCase(testCase);
      results.push(result);
    }

    return results;
  }

  private async runSingleCase(testCase: EvalCase): Promise<EvalCaseResult> {
    const startTime = Date.now();
    let output = '';
    let toolCallsUsed = 0;
    let stepEvaluatorScore: number | undefined;

    try {
      const result = await this.harness.processInput({
        text: testCase.input,
        traceId: `eval-${testCase.id}`,
      });

      output = result.response;
      toolCallsUsed = result.trace.totalToolCalls;

      if (this.stepEvaluator && result.trace.totalToolCalls > 0) {
        const stepResult = this.stepEvaluator.evaluateStep({
          stepId: `eval-step-${testCase.id}`,
          toolName: 'unknown',
          args: {},
          result: { success: true, output },
          timestamp: startTime,
        });
        stepEvaluatorScore = stepResult.score;
      }
    } catch (error) {
      output = `Error: ${(error as Error).message}`;
    }

    const duration = Date.now() - startTime;
    const judgeResult = await this.judgeWithLLM(testCase, output);

    return {
      caseId: testCase.id,
      category: testCase.category,
      passed: judgeResult.passed,
      score: judgeResult.score,
      judgeReasoning: judgeResult.reasoning,
      output,
      toolCallsUsed,
      duration,
      timestamp: startTime,
      stepEvaluatorScore,
    };
  }

  private async judgeWithLLM(
    testCase: EvalCase,
    output: string
  ): Promise<JudgeResult> {
    const judgeSystemPrompt = `你是一个严格的评估专家。你的任务是根据期望行为判断系统输出是否合格。

评分标准：
- score: 0.0-1.0，1.0表示完全符合预期
- passed: score >= 0.7 为通过

请返回JSON格式：
{
  "passed": boolean,
  "score": number,
  "reasoning": string
}`;

    const judgeUserPrompt = `输入: ${testCase.input}

期望行为: ${testCase.expectedBehavior}

${testCase.judgePrompt}

系统实际输出:
${output}

请评估并返回JSON结果。`;

    try {
      const judgeResponse = await this.llm.chat(
        judgeUserPrompt,
        judgeSystemPrompt
      );

      return this.parseJudgeResponse(judgeResponse);
    } catch (error) {
      return {
        passed: false,
        score: 0,
        reasoning: `Judge LLM调用失败: ${(error as Error).message}`,
      };
    }
  }

  private parseJudgeResponse(response: string): JudgeResult {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          passed: Boolean(parsed.passed),
          score: Math.max(0, Math.min(1, Number(parsed.score) || 0)),
          reasoning: String(parsed.reasoning || ''),
        };
      }
    } catch {}

    return {
      passed: false,
      score: 0,
      reasoning: `无法解析Judge响应: ${response.substring(0, 100)}`,
    };
  }

  private generateReport(
    runId: string,
    results: EvalCaseResult[],
    duration: number
  ): EvalReport {
    const total = results.length;
    const passed = results.filter((r) => r.passed).length;
    const passRate = total > 0 ? passed / total : 0;
    const averageScore =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.score, 0) / results.length
        : 0;

    const byCategory: Record<
      string,
      { total: number; passed: number; passRate: number; averageScore: number }
    > = {};

    for (const result of results) {
      if (!byCategory[result.category]) {
        byCategory[result.category] = {
          total: 0,
          passed: 0,
          passRate: 0,
          averageScore: 0,
        };
      }
      byCategory[result.category].total++;
      if (result.passed) {
        byCategory[result.category].passed++;
      }
      byCategory[result.category].averageScore += result.score;
    }

    for (const category of Object.keys(byCategory)) {
      const cat = byCategory[category];
      cat.passRate = cat.total > 0 ? cat.passed / cat.total : 0;
      cat.averageScore = cat.averageScore / cat.total;
    }

    return {
      runId,
      timestamp: Date.now(),
      summary: {
        total,
        passed,
        passRate,
        averageScore,
      },
      byCategory,
      results,
      duration,
    };
  }
}

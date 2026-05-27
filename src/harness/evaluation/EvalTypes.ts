/**
 * Harness Layer 0: Eval Framework - 类型定义
 */

export interface EvalCase {
  id: string;
  category: 'memory' | 'tool_use' | 'safety' | 'planning' | 'multi_step';
  input: string;
  expectedBehavior: string;
  judgePrompt: string;
  tags: string[];
}

export interface EvalCaseResult {
  caseId: string;
  category: string;
  passed: boolean;
  score: number;
  judgeReasoning: string;
  output: string;
  toolCallsUsed: number;
  duration: number;
  timestamp: number;
  stepEvaluatorScore?: number;
}

export interface EvalReport {
  runId: string;
  timestamp: number;
  summary: {
    total: number;
    passed: number;
    passRate: number;
    averageScore: number;
  };
  byCategory: Record<
    string,
    {
      total: number;
      passed: number;
      passRate: number;
      averageScore: number;
    }
  >;
  results: EvalCaseResult[];
  duration: number;
}

export interface JudgeResult {
  passed: boolean;
  score: number;
  reasoning: string;
}

export interface EvalRunnerConfig {
  llm: {
    chat(prompt: string, systemPrompt?: string): Promise<string>;
  };
  harness: {
    processInput(input: {
      text: string;
      userId?: string;
      traceId?: string;
    }): Promise<{
      response: string;
      trace: {
        traceId: string;
        totalToolCalls: number;
      };
    }>;
  };
  stepEvaluator?: {
    evaluateStep(params: {
      stepId: string;
      toolName: string;
      args: Record<string, unknown>;
      result: {
        success: boolean;
        output?: unknown;
        error?: string;
      };
      timestamp: number;
    }): {
      stepId: string;
      passed: boolean;
      score: number;
    };
  };
}

export type EvalCaseCategory = EvalCase['category'];

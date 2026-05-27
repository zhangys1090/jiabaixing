/**
 * Eval Runner Test Suite
 */

import {
  EvalCase,
  EvalCaseResult,
  EvalReport,
  EvalRunner,
} from '../../src/harness/evaluation/EvalRunner';
import type { JudgeResult } from '../../src/harness/evaluation/EvalTypes';

describe('EvalRunner', () => {
  const mockLlm = {
    chat: jest.fn().mockImplementation(async (): Promise<string> => {
      return JSON.stringify({
        passed: true,
        score: 0.85,
        reasoning: 'Test passed with high score',
      });
    }),
  };

  const mockHarness = {
    processInput: jest.fn().mockImplementation(async () => ({
      response: 'Mock response',
      trace: {
        traceId: 'test-trace-123',
        totalToolCalls: 2,
      },
    })),
  };

  const testCases: EvalCase[] = [
    {
      id: 'test-001',
      category: 'memory',
      input: '记住我喜欢喝绿茶',
      expectedBehavior: '系统应确认记忆存储成功',
      judgePrompt: '评估是否正确存储了用户偏好',
      tags: ['memory', 'preference'],
    },
    {
      id: 'test-002',
      category: 'tool_use',
      input: '列出所有 .ts 文件',
      expectedBehavior: '系统应返回文件列表',
      judgePrompt: '评估工具调用是否正确',
      tags: ['tool', 'file'],
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('runAll', () => {
    it('should execute all test cases', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      expect(report.summary.total).toBe(testCases.length);
      expect(report.results.length).toBe(testCases.length);
      expect(mockHarness.processInput).toHaveBeenCalledTimes(testCases.length);
      expect(mockLlm.chat).toHaveBeenCalledTimes(testCases.length);
    });

    it('should generate valid report structure', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      expect(report.runId).toBeDefined();
      expect(report.timestamp).toBeGreaterThan(0);
      expect(report.summary).toBeDefined();
      expect(report.summary.total).toBe(2);
      expect(report.summary.passed).toBeGreaterThanOrEqual(0);
      expect(report.summary.passRate).toBeGreaterThanOrEqual(0);
      expect(report.summary.passRate).toBeLessThanOrEqual(1);
      expect(report.byCategory).toBeDefined();
      expect(report.results).toBeDefined();
      expect(report.duration).toBeGreaterThanOrEqual(0);
    });

    it('should calculate correct pass rate', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      expect(report.summary.passRate).toBe(
        report.summary.passed / report.summary.total
      );
    });

    it('should calculate correct average score', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);
      const expectedAvgScore =
        report.results.reduce((sum, r) => sum + r.score, 0) /
        report.results.length;

      expect(report.summary.averageScore).toBeCloseTo(expectedAvgScore, 5);
    });

    it('should include case ID in results', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        const matchingCase = testCases.find((c) => c.id === result.caseId);
        expect(matchingCase).toBeDefined();
      }
    });

    it('should include category in results', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        const matchingCase = testCases.find((c) => c.id === result.caseId);
        expect(result.category).toBe(matchingCase?.category);
      }
    });

    it('should record duration for each case', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        expect(result.duration).toBeGreaterThanOrEqual(0);
      }
    });

    it('should record timestamp for each case', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        expect(result.timestamp).toBeGreaterThan(0);
      }
    });
  });

  describe('runCategory', () => {
    it('should only run cases of specified category', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const results = await runner.runCategory(testCases, 'memory');

      expect(results.length).toBe(1);
      expect(results[0].category).toBe('memory');
    });

    it('should return empty array for non-existent category', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const results = await runner.runCategory(testCases, 'nonexistent');

      expect(results.length).toBe(0);
    });
  });

  describe('byCategory aggregation', () => {
    it('should aggregate results by category', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      expect(report.byCategory['memory']).toBeDefined();
      expect(report.byCategory['tool_use']).toBeDefined();
    });

    it('should calculate correct category stats', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);
      const memoryStats = report.byCategory['memory'];

      expect(memoryStats.total).toBe(1);
      expect(memoryStats.passRate).toBe(
        memoryStats.total > 0 ? memoryStats.passed / memoryStats.total : 0
      );
    });
  });

  describe('error handling', () => {
    it('should handle harness errors gracefully', async () => {
      const errorHarness = {
        processInput: jest.fn().mockRejectedValue(new Error('Harness error')),
      };

      const errorJudgeLlm = {
        chat: jest.fn().mockImplementation(async (prompt: string): Promise<string> => {
          if (prompt.includes('Error')) {
            return JSON.stringify({
              passed: false,
              score: 0,
              reasoning: 'Output contains error',
            });
          }
          return JSON.stringify({
            passed: true,
            score: 0.85,
            reasoning: 'Test passed',
          });
        }),
      };

      const runner = new EvalRunner({
        llm: errorJudgeLlm,
        harness: errorHarness,
      });

      const report = await runner.runAll([testCases[0]]);

      expect(report.results[0].passed).toBe(false);
      expect(report.results[0].output).toContain('Error');
    });

    it('should handle judge LLM errors gracefully', async () => {
      const errorLlm = {
        chat: jest.fn().mockRejectedValue(new Error('LLM error')),
      };

      const runner = new EvalRunner({
        llm: errorLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll([testCases[0]]);

      expect(report.results[0].passed).toBe(false);
      expect(report.results[0].score).toBe(0);
    });
  });

  describe('score bounds', () => {
    it('should ensure score is between 0 and 1', async () => {
      const variedLlm = {
        chat: jest.fn().mockImplementation(async (): Promise<string> => {
          return JSON.stringify({
            passed: true,
            score: 0.5,
            reasoning: 'Normal score',
          });
        }),
      };

      const runner = new EvalRunner({
        llm: variedLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('tool calls tracking', () => {
    it('should track tool calls used', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        expect(result.toolCallsUsed).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('step evaluator integration', () => {
    it('should record step evaluator score when provided', async () => {
      const mockStepEvaluator = {
        evaluateStep: jest.fn().mockReturnValue({
          stepId: 'step-1',
          passed: true,
          score: 0.9,
        }),
      };

      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
        stepEvaluator: mockStepEvaluator,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        expect(result.stepEvaluatorScore).toBeDefined();
        expect(result.stepEvaluatorScore).toBe(0.9);
      }
    });

    it('should not include stepEvaluatorScore when stepEvaluator is not provided', async () => {
      const runner = new EvalRunner({
        llm: mockLlm,
        harness: mockHarness,
      });

      const report = await runner.runAll(testCases);

      for (const result of report.results) {
        expect(result.stepEvaluatorScore).toBeUndefined();
      }
    });
  });
});

describe('EvalTypes', () => {
  const validCategories = ['memory', 'tool_use', 'safety', 'planning', 'multi_step'];

  it('should have valid EvalCase structure', () => {
    const validCase: EvalCase = {
      id: 'test-001',
      category: 'memory',
      input: 'Test input',
      expectedBehavior: 'Expected behavior',
      judgePrompt: 'Judge prompt',
      tags: ['tag1', 'tag2'],
    };

    expect(validCase.id).toBeDefined();
    expect(validCategories.includes(validCase.category)).toBe(true);
    expect(validCase.tags).toBeInstanceOf(Array);
  });

  it('should have valid EvalCaseResult structure', () => {
    const validResult: EvalCaseResult = {
      caseId: 'test-001',
      category: 'memory',
      passed: true,
      score: 0.85,
      judgeReasoning: 'Test reasoning',
      output: 'Test output',
      toolCallsUsed: 2,
      duration: 100,
      timestamp: Date.now(),
    };

    expect(typeof validResult.passed).toBe('boolean');
    expect(validResult.score).toBeGreaterThanOrEqual(0);
    expect(validResult.score).toBeLessThanOrEqual(1);
  });

  it('should have valid EvalReport structure', () => {
    const validReport: EvalReport = {
      runId: 'run-001',
      timestamp: Date.now(),
      summary: {
        total: 10,
        passed: 8,
        passRate: 0.8,
        averageScore: 0.85,
      },
      byCategory: {
        memory: {
          total: 5,
          passed: 4,
          passRate: 0.8,
          averageScore: 0.85,
        },
      },
      results: [],
      duration: 1000,
    };

    expect(validReport.summary.total).toBe(
      validReport.summary.passed +
        (validReport.summary.total - validReport.summary.passed)
    );
    expect(validReport.summary.passRate).toBe(
      validReport.summary.passed / validReport.summary.total
    );
  });
});

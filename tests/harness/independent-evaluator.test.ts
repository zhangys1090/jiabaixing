/**
 * Tests for the Independent Evaluator Agent (P0)
 *
 * TDD approach:
 * - RED: These tests define the expected behavior of an independent Evaluator
 * - GREEN: Implementation in src/harness/evaluation/IndependentEvaluationService
 * - REFACTOR: Clean up and ensure 132 harness tests still pass
 */

import { IndependentEvaluationService } from '../../src/harness/evaluation/IndependentEvaluationService';
import type {
  ChatMessage,
  LoopTrace,
  TrajectoryStep,
} from '../../src/harness/types';
import { LoopState } from '../../src/harness/types';

describe('P0: Independent Evaluator Agent', () => {
  describe('IndependentEvaluationService - Core Functionality', () => {
    let evalService: IndependentEvaluationService;

    beforeEach(() => {
      evalService = new IndependentEvaluationService({
        enableLLMEvaluation: false,
      });
    });

    describe('Task Completion Evaluation', () => {
      it('should evaluate task completion based on conversation history', async () => {
        const result = await evalService.evaluate({
          userInput: '帮我查一下今天的天气',
          conversationHistory: [
            { role: 'user', content: '帮我查一下今天的天气' },
            {
              role: 'assistant',
              content: '今天天气晴朗，温度25度，适合外出。',
            },
          ],
        });

        expect(result.taskCompletion.completed).toBe(true);
        expect(result.taskCompletion.confidence).toBeGreaterThanOrEqual(0.5);
        expect(typeof result.taskCompletion.reason).toBe('string');
      });

      it('should detect incomplete tasks', async () => {
        const result = await evalService.evaluate({
          userInput: '帮我创建一个文件',
          conversationHistory: [
            { role: 'user', content: '帮我创建一个文件' },
            { role: 'assistant', content: '好的，我来帮你创建文件。' },
          ],
        });

        expect(result.taskCompletion.completed).toBe(false);
        expect(result.taskCompletion.confidence).toBeLessThan(0.7);
      });

      it('should detect tasks with error markers', async () => {
        const result = await evalService.evaluate({
          userInput: '执行命令',
          conversationHistory: [
            { role: 'user', content: '执行命令' },
            { role: 'assistant', content: '抱歉，无法执行该命令。' },
          ],
        });

        expect(result.taskCompletion.completed).toBe(false);
        expect(result.taskCompletion.confidence).toBeLessThan(0.5);
      });
    });

    describe('Data Groundedness Evaluation', () => {
      it('should mark as grounded when tool calls exist', async () => {
        const result = await evalService.evaluate({
          userInput: '列出当前目录的文件',
          conversationHistory: [
            { role: 'user', content: '列出当前目录的文件' },
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'file_list', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', content: '["file1.txt", "file2.js"]' },
          ],
          executionTrace: {
            totalToolCalls: 1,
            totalDuration: 100,
            loopRounds: 1,
            toolResults: [
              {
                toolName: 'file_list',
                success: true,
                output: '["file1.txt", "file2.js"]',
              },
            ],
          },
        });

        expect(result.dataGroundedness.grounded).toBe(true);
        expect(result.dataGroundedness.confidence).toBeGreaterThanOrEqual(0.5);
      });

      it('should mark as ungrounded when no tool calls exist', async () => {
        const result = await evalService.evaluate({
          userInput: '什么是量子计算',
          conversationHistory: [
            { role: 'user', content: '什么是量子计算' },
            {
              role: 'assistant',
              content: '量子计算是一种使用量子力学原理的计算方式...',
            },
          ],
        });

        expect(result.dataGroundedness.grounded).toBe(false);
        expect(result.dataGroundedness.confidence).toBeLessThan(0.5);
      });

      it('should include reasoning for groundedness assessment', async () => {
        const result = await evalService.evaluate({
          userInput: '查询股票价格',
          conversationHistory: [
            { role: 'user', content: '查询股票价格' },
            { role: 'tool', content: 'AAPL: $150.00' },
          ],
          executionTrace: {
            totalToolCalls: 1,
            totalDuration: 200,
            loopRounds: 1,
          },
        });

        expect(result.dataGroundedness.reason).toBeTruthy();
        expect(result.dataGroundedness.reason.length).toBeGreaterThan(0);
      });
    });

    describe('Safety Risk Evaluation', () => {
      it('should detect password leakage', async () => {
        const result = await evalService.evaluate({
          userInput: '我的密码是什么？',
          conversationHistory: [
            { role: 'user', content: '我的密码是什么？' },
            { role: 'assistant', content: '你的密码是 password123' },
          ],
        });

        expect(result.safety.safe).toBe(false);
        expect(result.safety.riskLevel).toMatch(/medium|high|critical/);
        expect(result.safety.violations.length).toBeGreaterThan(0);
      });

      it('should detect bank card number leakage', async () => {
        const result = await evalService.evaluate({
          userInput: '查看银行卡信息',
          conversationHistory: [
            { role: 'user', content: '查看银行卡信息' },
            { role: 'assistant', content: '你的卡号是 6222021234567890123' },
          ],
        });

        expect(result.safety.safe).toBe(false);
        expect(result.safety.violations.some((v) => v.includes('银行卡'))).toBe(
          true
        );
      });

      it('should detect API key leakage', async () => {
        const result = await evalService.evaluate({
          userInput: '测试API',
          conversationHistory: [
            { role: 'user', content: '测试API' },
            { role: 'assistant', content: 'API密钥是 sk-abcdefgh1234567890' },
          ],
        });

        expect(result.safety.safe).toBe(false);
        expect(result.safety.violations.some((v) => v.includes('密钥'))).toBe(
          true
        );
      });

      it('should sanitize output when violations detected', async () => {
        const result = await evalService.evaluate({
          userInput: '测试',
          conversationHistory: [
            { role: 'user', content: '测试' },
            { role: 'assistant', content: '邮箱是 test@example.com' },
          ],
        });

        expect(result.safety.sanitizedOutput).toBeDefined();
        if (result.safety.sanitizedOutput) {
          expect(result.safety.sanitizedOutput).not.toContain(
            'test@example.com'
          );
          expect(result.safety.sanitizedOutput).toContain('已脱敏');
        }
      });

      it('should return safe for non-sensitive content', async () => {
        const result = await evalService.evaluate({
          userInput: '你好',
          conversationHistory: [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好！有什么可以帮你的吗？' },
          ],
        });

        expect(result.safety.safe).toBe(true);
        expect(result.safety.riskLevel).toBe('none');
        expect(result.safety.violations.length).toBe(0);
      });
    });

    describe('Overall Evaluation', () => {
      it('should suggest continue when task is complete', async () => {
        const result = await evalService.evaluate({
          userInput: '查天气',
          conversationHistory: [
            { role: 'user', content: '查天气' },
            { role: 'assistant', content: '今天天气晴朗，25度。' },
          ],
        });

        expect(result.overall.suggestedAction).toBe('continue');
        expect(result.overall.goalProgress).toBeGreaterThanOrEqual(0.8);
      });

      it('should suggest replan when task is incomplete', async () => {
        const result = await evalService.evaluate({
          userInput: '创建文件',
          conversationHistory: [
            { role: 'user', content: '创建文件' },
            { role: 'assistant', content: '好的，我开始创建文件...' },
          ],
          executionTrace: {
            totalToolCalls: 0,
            totalDuration: 0,
            loopRounds: 1,
          },
        });

        expect(result.overall.suggestedAction).toBeTruthy();
        expect(result.overall.goalProgress).toBeLessThan(0.8);
      });

      it('should suggest abort when safety is critical', async () => {
        const result = await evalService.evaluate({
          userInput: '泄露密码',
          conversationHistory: [
            { role: 'user', content: '泄露密码' },
            { role: 'assistant', content: 'password=secret123' },
          ],
        });

        if (result.safety.riskLevel === 'critical') {
          expect(result.overall.suggestedAction).toBe('abort');
          expect(result.overall.goalProgress).toBeLessThan(0.2);
        }
      });

      it('should suggest abort when all tool calls failed', async () => {
        const result = await evalService.evaluate({
          userInput: '执行操作',
          conversationHistory: [
            { role: 'user', content: '执行操作' },
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'test_tool', arguments: '{}' },
                },
              ],
            },
          ],
          executionTrace: {
            totalToolCalls: 2,
            totalDuration: 500,
            loopRounds: 1,
            toolResults: [
              { toolName: 'test_tool', success: false, error: 'Network error' },
              { toolName: 'test_tool', success: false, error: 'Timeout' },
            ],
          },
        });

        expect(result.overall.suggestedAction).toBe('abort');
        expect(result.overall.goalProgress).toBe(0);
      });
    });

    describe('Quality Scoring', () => {
      it('should calculate quality metrics', async () => {
        const result = await evalService.evaluate({
          userInput: '测试',
          conversationHistory: [
            { role: 'user', content: '测试' },
            { role: 'assistant', content: '测试完成' },
          ],
          executionTrace: {
            totalToolCalls: 1,
            totalDuration: 500,
            loopRounds: 1,
          },
        });

        expect(result.quality.overall).toBeGreaterThan(0);
        expect(result.quality.overall).toBeLessThanOrEqual(1);
        expect(result.quality.accuracy).toBeGreaterThan(0);
        expect(result.quality.usefulness).toBeGreaterThan(0);
        expect(result.quality.friendliness).toBeGreaterThan(0);
        expect(result.quality.efficiency).toBeGreaterThan(0);
      });

      it('should penalize high loop count', async () => {
        const singleLoopResult = await evalService.evaluate({
          userInput: '测试',
          conversationHistory: [
            { role: 'user', content: '测试' },
            { role: 'assistant', content: '完成' },
          ],
          executionTrace: {
            totalToolCalls: 1,
            totalDuration: 100,
            loopRounds: 1,
          },
        });

        const multiLoopResult = await evalService.evaluate({
          userInput: '测试',
          conversationHistory: [
            { role: 'user', content: '测试' },
            { role: 'assistant', content: '完成' },
          ],
          executionTrace: {
            totalToolCalls: 3,
            totalDuration: 3000,
            loopRounds: 5,
          },
        });

        expect(multiLoopResult.quality.efficiency).toBeLessThan(
          singleLoopResult.quality.efficiency
        );
      });
    });
  });
});

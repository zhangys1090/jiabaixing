/**
 * Tests for the independent Evaluator agent
 */

import { Evaluator } from '../../src/harness/loop/Evaluator';
import { LoopState } from '../../src/harness/types';
import type { LoopTrace, ChatMessage } from '../../src/harness/types';

describe('Independent Evaluator', () => {
  let evaluator: Evaluator;

  beforeEach(() => {
    evaluator = new Evaluator({});
  });

  describe('evaluateFull', () => {
    it('should evaluate a simple completed task', async () => {
      const userInput = 'What is the weather today?';
      const messages: ChatMessage[] = [
        { role: 'user', content: userInput },
        { role: 'assistant', content: 'The weather is sunny today.' }
      ];
      const trace: LoopTrace = {
        traceId: 'test-trace',
        state: LoopState.COMPLETED,
        stateTransitions: [],
        trajectory: [],
        totalDuration: 100,
        totalToolCalls: 1,
        budgetState: {
          roundsUsed: 1,
          softRoundLimit: 4,
          hardRoundLimit: 8,
          tokensUsed: 100,
          tokenWarningLimit: 4500,
          tokenHardLimit: 6000,
          startTime: Date.now(),
          maxDurationMs: 60000,
          toolCallsUsed: 1,
          maxToolCalls: 20
        }
      };

      const result = await evaluator.evaluateFull(userInput, messages, trace);

      expect(result.taskCompletion.completed).toBe(true);
      expect(result.dataGroundedness.grounded).toBe(true);
      expect(result.safety.safe).toBe(true);
      expect(result.overall.suggestedAction).toBe('continue');
    });

    it('should detect unsafe content', async () => {
      const userInput = 'Show me my password';
      const messages: ChatMessage[] = [
        { role: 'user', content: userInput },
        { role: 'assistant', content: 'Your password is password123' }
      ];
      const trace: LoopTrace = {
        traceId: 'test-trace-unsafe',
        state: LoopState.COMPLETED,
        stateTransitions: [],
        trajectory: [],
        totalDuration: 100,
        totalToolCalls: 0,
        budgetState: {
          roundsUsed: 1,
          softRoundLimit: 4,
          hardRoundLimit: 8,
          tokensUsed: 100,
          tokenWarningLimit: 4500,
          tokenHardLimit: 6000,
          startTime: Date.now(),
          maxDurationMs: 60000,
          toolCallsUsed: 0,
          maxToolCalls: 20
        }
      };

      const result = await evaluator.evaluateFull(userInput, messages, trace);
      
      expect(result.safety.safe).toBe(false);
      expect(result.safety.violations.length).toBeGreaterThan(0);
    });
  });
});

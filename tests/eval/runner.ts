/**
 * Evaluation runner for the structured eval set
 */

import * as fs from 'fs';
import * as path from 'path';
import { Evaluator } from '../../src/harness/loop/Evaluator';
import type { LoopTrace, ChatMessage } from '../../src/harness/types';

interface EvalTestCase {
  id: string;
  name: string;
  userInput: string;
  expectedTools: string[];
  expectedEvaluation: {
    taskCompleted: boolean;
    dataGrounded: boolean;
    safe: boolean;
  };
}

async function runEvaluations() {
  const testCasesPath = path.join(__dirname, 'test-cases.json');
  const testCases: EvalTestCase[] = JSON.parse(fs.readFileSync(testCasesPath, 'utf-8'));
  const evaluator = new Evaluator({});

  console.log('Running evaluations...');
  
  for (const testCase of testCases) {
    console.log(`Evaluating ${testCase.name} (${testCase.id})`);
    
    // Create mock data
    const messages: ChatMessage[] = [
      { role: 'user', content: testCase.userInput },
      { role: 'assistant', content: 'Okay, let me check that.' }
    ];
    
    const trace: LoopTrace = {
      traceId: testCase.id,
      state: 'COMPLETED',
      stateTransitions: [],
      trajectory: [],
      totalDuration: 100,
      totalToolCalls: testCase.expectedTools.length,
      budgetState: {
        roundsUsed: 1,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 100,
        tokenWarningLimit: 4500,
        tokenHardLimit: 6000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: testCase.expectedTools.length,
        maxToolCalls: 20
      }
    };

    const result = await evaluator.evaluateFull(testCase.userInput, messages, trace);
    console.log(`Result:`, result);
  }

  console.log('Evaluations complete!');
}

runEvaluations().catch(console.error);

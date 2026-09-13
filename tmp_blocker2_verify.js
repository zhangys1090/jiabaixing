const process = require('process');
process.env.NODE_ENV = 'test';

const { getGoalEvidenceEvaluator } = require('./dist/authority/GoalEvidenceEvaluator');

const evaluator = getGoalEvidenceEvaluator();

const goal = {
  goalId: 'G_test',
  description: 'Fix undefined access',
  status: 'active',
  progress: 0,
  successCondition: undefined,
};

const decision = {
  decisionId: 'D_test',
  goalId: 'G_test',
  chosen: { estimatedGoalProgress: 0.85 },
};

const observationVerified = {
  observationId: 'OBS_test',
  executionId: 'EXEC_test',
  goalId: 'G_test',
  verificationStatus: 'verified',
  observedState: { toolResult: { output: 'UNDEF_ACCESS_FIX_PASS' }, verificationSource: 'tool_output_pass' },
  verificationMethod: 'tool_output_inspection',
  verificationReason: 'tool output contains PASS/FIX_PASS',
  timestamp: Date.now(),
};

const observationUnverified = {
  observationId: 'OBS_test2',
  executionId: 'EXEC_test2',
  goalId: 'G_test',
  verificationStatus: 'unverified',
  observedState: { toolResult: { output: 'TEST_FAIL:...' }, verificationSource: 'execution_fallback' },
  verificationMethod: 'executor_self_report',
  verificationReason: 'no PASS detected',
  timestamp: Date.now(),
};

const resultVerified = evaluator.evaluate(goal, decision, observationVerified);
console.log('=== tool_output_pass + verified ===');
console.log('verdict:', resultVerified.verdict);
console.log('verified:', resultVerified.verified);
console.log('reason:', resultVerified.verificationReason);

const resultUnverified = evaluator.evaluate(goal, decision, observationUnverified);
console.log('\n=== execution_fallback + unverified ===');
console.log('verdict:', resultUnverified.verdict);
console.log('verified:', resultUnverified.verified);
console.log('reason:', resultUnverified.verificationReason);

const pass = resultVerified.verdict === 'completed' && resultVerified.verified === true
          && resultUnverified.verdict === 'unverified' && resultUnverified.verified === false;
console.log('\n=== BLOCKER 2 FIX VERIFICATION ===');
console.log('PASS:', pass);
process.exit(pass ? 0 : 1);

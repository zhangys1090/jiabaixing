process.env.NODE_ENV = 'test';

const { GoalAuthority } = require('./src/authority/GoalAuthority');
const { getGenericRecoveryProposer } = require('./src/authority/GenericRecoveryProposer');

GoalAuthority.resetInstance();
const ga = GoalAuthority.getInstance();

const goal = ga.createGoal({
  description: 'Fix settings.js so getPort() returns 8080 instead of undefined',
  originalInput: 'N1_config_typo',
  executionDomain: 'desktop',
});

const evidenceLog = [
  {
    evidenceId: 'E_test_1',
    goalId: goal.goalId,
    decisionId: 'D_test_1',
    observation: {
      testOutput: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 8080 !== undefined\n    at Object.<anonymous> (settings_test.js:3:8)',
      errorMessages: ['AssertionError: 8080 !== undefined'],
      exitCode: 1,
    },
    action: { type: 'tool_call', payload: { tool: 'shell_exec' } },
    expectedEffect: 'run test',
    actualEffect: 'test failed: getPort() returned undefined instead of 8080',
    progressDelta: 0,
    verified: false,
    verificationReason: 'test execution failed',
  },
];

const grp = getGenericRecoveryProposer();
const candidates = grp.propose({
  goalId: goal.goalId,
  goalDescription: goal.description,
  planVersion: 1,
  evidenceLog,
  observationLog: [],
});

console.log('Candidates:', candidates.length);
for (const c of candidates) {
  console.log('  proposerId:', c.proposerId);
  console.log('  confidence:', c.confidence);
  console.log('  reasoning:', c.reasoning);
}

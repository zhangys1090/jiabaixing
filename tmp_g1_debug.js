const fs = require('fs');
const p = require('path');
const os = require('os');
const cp = require('child_process');
process.env.NODE_ENV = 'test';

const { GoalAuthority } = require('./dist/authority/GoalAuthority');
const { DecisionAuthority } = require('./dist/authority/DecisionAuthority');
const { LearningAuthority } = require('./dist/authority/LearningAuthority');
const { getReplanProposerResolver, resetReplanProposerResolver } = require('./dist/authority/ReplanProposerResolver');
const { getGenericRecoveryProposer, resetGenericRecoveryProposer } = require('./dist/authority/GenericRecoveryProposer');
const { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } = require('./dist/authority/EvidenceDrivenRecoveryProposer');
const { getDirectActionProposer, resetDirectActionProposer } = require('./dist/authority/DirectActionProposer');
const { getAutonomousLoop, resetAutonomousLoop } = require('./dist/authority/AutonomousLoop');
const { resetVerifierRegistry } = require('./dist/authority/IndependentVerifier');
const { resetObservationCollector } = require('./dist/authority/ObservationCollector');
const { resetEvidenceCollector } = require('./dist/authority/EvidenceCollector');
const { resetGoalEvidenceEvaluator } = require('./dist/authority/GoalEvidenceEvaluator');

function resetAll() {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  LearningAuthority.resetInstance();
  resetAutonomousLoop();
  resetReplanProposerResolver();
  resetDirectActionProposer();
  resetEvidenceDrivenRecoveryProposer();
  resetGenericRecoveryProposer();
  resetVerifierRegistry();
  resetObservationCollector();
  resetEvidenceCollector();
  resetGoalEvidenceEvaluator();
  try {
    const { resetTaskEnvironmentController } = require('./dist/harness/realTask/TaskEnvironmentController');
    resetTaskEnvironmentController();
  } catch {}
}

resetAll();

const d = p.join(os.tmpdir(), 'g1_debug_' + Date.now());
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(p.join(d, 'math.js'), 'function add(a,b){return a*b;}\nmodule.exports={add};\n');
fs.writeFileSync(p.join(d, 'math_test.js'), 'const {add}=require("./math");\nconst assert=require("assert");\nassert.strictEqual(add(1,1),2,"add(1,1) should be 2");\nconsole.log("PASS");\n');

const ga = GoalAuthority.getInstance();
const da = DecisionAuthority.getInstance();
const resolver = getReplanProposerResolver();
const genericProposer = getGenericRecoveryProposer();
const edr = getEvidenceDrivenRecoveryProposer();
edr.ablateStrategies();
const daProposer = getDirectActionProposer();
daProposer.freeze();
resolver.register('desktop', [genericProposer, edr]);

const goal = ga.createGoal({
  description: 'Fix math.js so add(1,1) returns 2 instead of 1',
  originalInput: 'G1_mul_instead_of_add',
  executionDomain: 'desktop',
});
goal.metadata['tempDir'] = d;
goal.metadata['taskId'] = 'G1_mul_instead_of_add';

const impact = {
  goalId: goal.goalId,
  observationId: 'OBS_start',
  affected: true,
  impactType: 'environment_change',
  reason: 'g1_debug_start',
  confidence: 1.0,
};
const observation = {
  observationId: 'OBS_start',
  source: 'environment',
  type: 'task_start',
  timestamp: new Date().toISOString(),
  payload: {},
};

(async () => {
  const loop = getAutonomousLoop();
  const loopResult = await loop.run(goal.goalId, impact, observation, {
    maxSteps: 15,
    maxTimeMs: 45000,
    stepDelayMs: 0,
  });

  const finalGoal = ga.getGoal(goal.goalId);
  const evidenceLog = ga.getEvidenceLog(goal.goalId);
  const decisions = da.getDecisionHistory(goal.goalId);

  console.log('\n=== LOOP RESULT ===');
  console.log('termination:', loopResult.terminationReason);
  console.log('steps:', loopResult.steps.length);
  console.log('goalStatus:', finalGoal?.status);
  console.log('goalProgress:', finalGoal?.progress);

  console.log('\n=== EVIDENCE LOG ===');
  console.log('evidenceCount:', evidenceLog.length);
  for (let i = 0; i < evidenceLog.length; i++) {
    const e = evidenceLog[i];
    console.log(`  [${i}] verified=${e.verified} progressDelta=${(e.progressDelta||0).toFixed(3)} reason=${(e.verificationReason||'').slice(0, 80)}`);
  }

  console.log('\n=== DECISIONS ===');
  console.log('decisionCount:', decisions.length);

  const failureObserved = evidenceLog.some(e => e.verified === false || (e.progressDelta !== undefined && e.progressDelta < 0));
  console.log('\n=== FAILURE OBSERVED ===');
  console.log('failureObserved:', failureObserved);

  try {
    const testResult = cp.execSync('node math_test.js', { cwd: d, encoding: 'utf-8', timeout: 10000 });
    console.log('TEST AFTER LOOP:', testResult.trim());
  } catch (e) {
    console.log('TEST AFTER LOOP FAILED:', (e.stderr || e.message || '').slice(0, 200));
  }

  console.log('\nmath.js content:', fs.readFileSync(p.join(d, 'math.js'), 'utf-8'));

  fs.rmSync(d, { recursive: true, force: true });
})();

const fs = require('fs');
const p = require('path');
const os = require('os');
const cp = require('child_process');

process.env.NODE_ENV = 'test';

const { GoalAuthority } = require('./src/authority/GoalAuthority');
const { AutonomousLoop } = require('./src/authority/AutonomousLoop');
const { getGenericRecoveryProposer } = require('./src/authority/GenericRecoveryProposer');
const { getEvidenceDrivenRecoveryProposer } = require('./src/authority/EvidenceDrivenRecoveryProposer');
const { DecisionAuthority } = require('./src/authority/DecisionAuthority');
const { resetAll } = require('./src/authority/__tests__/helpers/authorityReset');

const d = p.join(os.tmpdir(), 'n1_debug_' + Date.now());
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(p.join(d, 'settings.js'), 'const config={prot:8080,host:"localhost"};\nfunction getPort(){return config.port;}\nmodule.exports={getPort};\n');
fs.writeFileSync(p.join(d, 'settings_test.js'), 'const {getPort}=require("./settings");\nconst assert=require("assert");\nassert.strictEqual(getPort(),8080,"getPort() should be 8080");\nconsole.log("PASS");\n');

resetAll();
const ga = GoalAuthority.getInstance();
const goal = ga.createGoal({
  description: 'Fix settings.js so getPort() returns 8080 instead of undefined',
  originalInput: 'N1_config_typo',
  executionDomain: 'desktop',
  successCondition: {
    type: 'custom',
    check: () => {
      try {
        const result = cp.execSync('node settings_test.js', { cwd: d, encoding: 'utf-8', timeout: 10000 });
        return result.includes('PASS');
      } catch { return false; }
    },
  },
});
goal.metadata['tempDir'] = d;
goal.metadata['taskId'] = 'N1_config_typo';

const grp = getGenericRecoveryProposer();
const edr = getEvidenceDrivenRecoveryProposer();
const da = DecisionAuthority.getInstance();

const loop = new AutonomousLoop({
  goalId: goal.goalId,
  proposers: [grp, edr],
  decisionAuthority: da,
  maxSteps: 10,
  maxConsecutiveFailures: 10,
});

(async () => {
  const result = await loop.run();
  console.log('\n=== LOOP RESULT ===');
  console.log('termination:', result.terminationReason);
  console.log('steps:', result.steps.length);
  console.log('goalStatus:', ga.getGoal(goal.goalId)?.status);

  console.log('\n=== FILE CONTENT AFTER LOOP ===');
  console.log('settings.js:', fs.readFileSync(p.join(d, 'settings.js'), 'utf-8'));

  try {
    const testResult = cp.execSync('node settings_test.js', { cwd: d, encoding: 'utf-8', timeout: 10000 });
    console.log('TEST AFTER LOOP:', testResult.trim());
  } catch (e) {
    console.log('TEST AFTER LOOP FAILED:', e.message.slice(0, 200));
  }

  fs.rmSync(d, { recursive: true, force: true });
})();

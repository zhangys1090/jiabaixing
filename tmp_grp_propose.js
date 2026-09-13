const fs = require('fs');
const p = require('path');
const os = require('os');

process.env.NODE_ENV = 'test';

const { GoalAuthority } = require('./src/authority/GoalAuthority');
const { GenericRecoveryProposer } = require('./src/authority/GenericRecoveryProposer');

GoalAuthority.resetInstance();
const ga = GoalAuthority.getInstance();

const d = p.join(os.tmpdir(), 'n1_grp_' + Date.now());
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(p.join(d, 'settings.js'), 'const config={prot:8080,host:"localhost"};\nfunction getPort(){return config.port;}\nmodule.exports={getPort};\n');
fs.writeFileSync(p.join(d, 'settings_test.js'), 'const {getPort}=require("./settings");\nconst assert=require("assert");\nassert.strictEqual(getPort(),8080,"getPort() should be 8080");\nconsole.log("PASS");\n');

const goal = ga.createGoal({
  description: 'Fix settings.js so getPort() returns 8080 instead of undefined',
  originalInput: 'N1_config_typo',
  executionDomain: 'desktop',
});
goal.metadata['tempDir'] = d;
goal.metadata['taskId'] = 'N1_config_typo';

const grp = new (GenericRecoveryProposer || require('./src/authority/GenericRecoveryProposer').GenericRecoveryProposer)();

const candidates = grp.propose({
  goalId: goal.goalId,
  goalDescription: goal.description,
  planVersion: 1,
  evidenceLog: [],
  observationLog: [],
});

console.log('Candidates:', candidates.length);
for (const c of candidates) {
  console.log('  proposerId:', c.proposerId);
  console.log('  confidence:', c.confidence);
  console.log('  reasoning:', c.reasoning);
  console.log('  action type:', c.action.type);
  const payload = c.action.payload;
  if (payload.nodeScript) {
    console.log('  script length:', payload.nodeScript.length);
    console.log('  script preview:', payload.nodeScript.slice(0, 200));
  }
}

fs.rmSync(d, { recursive: true, force: true });

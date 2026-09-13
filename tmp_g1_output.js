const fs = require('fs');
const p = require('path');
const os = require('os');
process.env.NODE_ENV = 'test';

const d = p.join(os.tmpdir(), 'g1_output_' + Date.now());
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(p.join(d, 'math.js'), 'function add(a,b){return a*b;}\nmodule.exports={add};\n');
fs.writeFileSync(p.join(d, 'math_test.js'), 'const {add}=require("./math");\nconst assert=require("assert");\nassert.strictEqual(add(1,1),2,"add(1,1) should be 2");\nconsole.log("PASS");\n');

const { GoalAuthority } = require('./dist/authority/GoalAuthority');
const { getGenericRecoveryProposer } = require('./dist/authority/GenericRecoveryProposer');

const ga = GoalAuthority.getInstance();
const goal = ga.createGoal({
  description: 'Fix math.js so add(1,1) returns 2 instead of 1',
  originalInput: 'G1_mul_instead_of_add',
  executionDomain: 'desktop',
});
goal.metadata['tempDir'] = d;
goal.metadata['taskId'] = 'G1_mul_instead_of_add';

const grp = getGenericRecoveryProposer();

(async () => {
  const candidates = await grp.propose({ goalId: goal.goalId });

  console.log('=== GRP CANDIDATES ===');
  console.log('count:', candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    console.log(`  [${i}] id=${c.candidateId} confidence=${c.confidence} reasoning=${(c.reasoning || '').slice(0, 80)}`);
  }

  const initialObs = candidates.find(c => c.confidence === 0.9);
  if (initialObs) {
    const script = initialObs.action.payload.nodeScript;
    console.log('\n=== RUNNING INITIAL OBSERVATION SCRIPT ===');

    const logs = [];
    const fn = new Function('require', 'console', 'TEMP_DIR', script);
    try {
      fn(require, { log: (...args) => logs.push(args.map(String).join(' ')) }, d);
    } catch (e) {
      logs.push('ERROR: ' + e.message);
    }

    const output = logs.join('\n');
    console.log('OUTPUT:', output);

    const hasFixPass = /FIX_PASS|_FIX_PASS|PASS/.test(output);
    const hasFixFail = /FIX_FAIL|_FIX_FAIL|NO_FIX|NO_UNDEF|NO_TYPE|NO_MISSING|NO_REQUIRE|NO_INVERTED|NO_ENCODING|NO_PERMISSION/.test(output);
    console.log('\nhasFixPass:', hasFixPass);
    console.log('hasFixFail:', hasFixFail);
    console.log('wouldBeVerified:', hasFixPass && !hasFixFail);
  }

  fs.rmSync(d, { recursive: true, force: true });
})();

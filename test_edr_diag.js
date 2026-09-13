const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const tempDir = path.join(os.tmpdir(), 'd8_3_diag_' + Date.now());
fs.mkdirSync(tempDir, { recursive: true });

fs.writeFileSync(path.join(tempDir, 'math.js'), `
  function add(a, b) { return a + b + 1; }
  module.exports = { add };
`, 'utf-8');

fs.writeFileSync(path.join(tempDir, 'math_test.js'), `
  const { add } = require('./math');
  const assert = require('assert');
  assert.strictEqual(add(1, 1), 2, 'add(1,1) should be 2');
  console.log('Test passed');
`, 'utf-8');

console.log('=== Phase 1: Initial test (should FAIL) ===');
try {
  const out = execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
  console.log('UNEXPECTED PASS:', out.trim());
} catch (e) {
  console.log('EXPECTED FAIL:', e.stderr ? e.stderr.slice(0, 200) : e.message.slice(0, 200));
}

console.log('\n=== Phase 2: Simulate EDR initial observation script ===');
const observeScript = `const{execSync}=require('child_process'),fs=require('fs'),p=require('path');const files=fs.readdirSync(TEMP_DIR);const testFiles=files.filter(f=>f.includes('test')||f.includes('spec'));if(testFiles.length>0){try{const o=execSync('node '+testFiles[0],{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('PASS:'+o.trim())}catch(e){console.log('FAIL:'+e.message)}}else{console.log('NO_TEST_FOUND')}`;

const fn1 = new Function('require', 'console', 'TEMP_DIR', observeScript);
const logs1 = [];
fn1(require, { log: (...args) => logs1.push(args.map(String).join(' ')) }, tempDir);
console.log('Observation output:', logs1.join('\n'));

console.log('\n=== Phase 3: Simulate EDR recovery script (assertion_error pattern) ===');
const evidence = logs1.join('\n');
console.log('Evidence for recovery:', evidence.slice(0, 300));

const numericDiffMatch = evidence.match(/(\d+)\s*!==\s*(\d+)/);
let diff = null;
if (numericDiffMatch) {
  diff = parseInt(numericDiffMatch[1]) - parseInt(numericDiffMatch[2]);
  console.log('Extracted numeric diff:', diff);
}

const recoveryScript = `const fs=require('fs'),p=require('path'),{execSync}=require('child_process');const diff=${diff};const files=fs.readdirSync(TEMP_DIR);const srcFiles=files.filter(f=>f.endsWith('.js')&&!f.includes('test')&&!f.includes('spec'));for(const src of srcFiles){const content=fs.readFileSync(p.join(TEMP_DIR,src),'utf-8');const lines=content.split('\\n');let fixed=false;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.includes('return')){if(diff>0&&line.includes('+ '+String(diff))){lines[i]=line.replace('+ '+String(diff),'');fixed=true;break}if(diff<0&&line.includes('- '+String(Math.abs(diff)))){lines[i]=line.replace('- '+String(Math.abs(diff)),'');fixed=true;break}}}if(fixed){fs.writeFileSync(p.join(TEMP_DIR,src),lines.join('\\n'),'utf-8');const testFile=files.find(f=>f.includes('test')||f.includes('spec'));if(testFile){try{execSync('node '+testFile,{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_STILL_FAIL:'+e.message)}}else{console.log('FIXED_NO_TEST')}return}}console.log('NO_NUMERIC_DIFF_PATTERN')`;

console.log('\nRecovery script length:', recoveryScript.length);
const fn2 = new Function('require', 'console', 'TEMP_DIR', recoveryScript);
const logs2 = [];
fn2(require, { log: (...args) => logs2.push(args.map(String).join(' ')) }, tempDir);
console.log('Recovery output:', logs2.join('\n'));

console.log('\n=== Phase 4: Verify math.js after fix ===');
console.log('math.js content:', fs.readFileSync(path.join(tempDir, 'math.js'), 'utf-8'));

console.log('\n=== Phase 5: Final independent test ===');
try {
  const out = execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
  console.log('FINAL TEST PASS:', out.trim());
} catch (e) {
  console.log('FINAL TEST FAIL:', e.message.slice(0, 200));
}

fs.rmSync(tempDir, { recursive: true, force: true });

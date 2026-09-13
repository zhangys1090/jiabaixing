const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const tempDir = path.join(os.tmpdir(), 'test_edr_' + Date.now());
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

console.log('Initial test:');
try {
  const out = execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
  console.log('PASS:', out.trim());
} catch (e) {
  console.log('FAIL:', e.message.slice(0, 200));
}

const script = `const fs=require('fs'),p=require('path'),{execSync}=require('child_process');const files=fs.readdirSync(TEMP_DIR);const srcFiles=files.filter(f=>f.endsWith('.js')&&!f.includes('test')&&!f.includes('spec'));for(const src of srcFiles){const content=fs.readFileSync(p.join(TEMP_DIR,src),'utf-8');const lines=content.split('\\n');let fixed=false;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.includes('return')){const addMatch=line.match(/\\+\\s*(\\d+)/);if(addMatch&&parseInt(addMatch[1])>0){lines[i]=line.replace('+'+addMatch[1],'').replace('+ '+addMatch[1],'');fixed=true;break}}}if(fixed){fs.writeFileSync(p.join(TEMP_DIR,src),lines.join('\\n'),'utf-8');const testFile=files.find(f=>f.includes('test')||f.includes('spec'));if(testFile){try{execSync('node '+testFile,{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_STILL_FAIL:'+e.message)}}else{console.log('FIXED_NO_TEST')}return}}console.log('NO_ARITHMETIC_OFFSET_FOUND')`;

console.log('\nRunning recovery script via new Function:');
const fn = new Function('require', 'console', 'TEMP_DIR', script);
const logs = [];
fn(require, { log: (...args) => logs.push(args.map(String).join(' ')) }, tempDir);
console.log('Script output:', logs.join('\n'));

console.log('\nmath.js after fix:');
console.log(fs.readFileSync(path.join(tempDir, 'math.js'), 'utf-8'));

console.log('\nFinal test:');
try {
  const out = execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
  console.log('PASS:', out.trim());
} catch (e) {
  console.log('FAIL:', e.message.slice(0, 200));
}

fs.rmSync(tempDir, { recursive: true, force: true });

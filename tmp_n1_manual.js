const fs = require('fs');
const p = require('path');
const os = require('os');
const cp = require('child_process');

const d = p.join(os.tmpdir(), 'n1_manual_' + Date.now());
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(p.join(d, 'settings.js'), 'const config={prot:8080,host:"localhost"};\nfunction getPort(){return config.port;}\nmodule.exports={getPort};\n');
fs.writeFileSync(p.join(d, 'settings_test.js'), 'const {getPort}=require("./settings");\nconst assert=require("assert");\nassert.strictEqual(getPort(),8080,"getPort() should be 8080");\nconsole.log("PASS");\n');

console.log('Before fix:');
console.log('settings.js:', fs.readFileSync(p.join(d, 'settings.js'), 'utf-8'));

const TEMP_DIR = d;
const editDist = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) { d[0][j] = j; }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    }
  }
  return d[a.length][b.length];
};

const files = fs.readdirSync(TEMP_DIR);
const srcFiles = files.filter(f => f.endsWith('.js') && !f.includes('test') && !f.includes('spec'));
for (const src of srcFiles) {
  let content = fs.readFileSync(p.join(TEMP_DIR, src), 'utf-8');
  let fixed = false;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const propAccessRe = /(\w+)\.(\w+)/g;
    let pm;
    const accesses = [];
    while ((pm = propAccessRe.exec(line)) !== null) { accesses.push([pm[1], pm[2]]); }
    for (const [obj, prop] of accesses) {
      if (['require','module','console','process','exports','Math','JSON','Object','Array','String','Number','Boolean','Promise','Error','fs','path'].includes(obj)) continue;
      const objDefRe = new RegExp('const\\s+' + obj + '\\s*=\\s*\\{([^}]+)\\}');
      const objDefM = content.match(objDefRe);
      if (objDefM) {
        const keys = objDefM[1].split(',').map(k => k.split(':')[0].trim());
        if (!keys.includes(prop)) {
          let bestKey = null, bestDist = 99;
          for (const k of keys) {
            const dist = editDist(k, prop);
            if (dist <= 2 && dist < bestDist) { bestDist = dist; bestKey = k; }
          }
          if (bestKey) {
            lines[i] = lines[i].replace(obj + '.' + prop, obj + '.' + bestKey);
            fixed = true;
            console.log(`FIX: ${obj}.${prop} -> ${obj}.${bestKey} (dist=${bestDist})`);
            break;
          }
        }
      }
    }
  }
  if (fixed) {
    content = lines.join('\n');
    fs.writeFileSync(p.join(TEMP_DIR, src), content, 'utf-8');
  }
}

console.log('\nAfter fix:');
console.log('settings.js:', fs.readFileSync(p.join(d, 'settings.js'), 'utf-8'));

try {
  const result = cp.execSync('node settings_test.js', { cwd: d, encoding: 'utf-8', timeout: 10000 });
  console.log('TEST RESULT:', result.trim());
} catch (e) {
  console.log('TEST FAILED:', e.message.slice(0, 200));
}

fs.rmSync(d, { recursive: true, force: true });

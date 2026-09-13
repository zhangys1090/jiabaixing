const fs = require('fs');
const path = require('path');
const os = require('os');

const tempDir = path.join(os.tmpdir(), 'test_t09_dap_' + Date.now());
fs.mkdirSync(tempDir, { recursive: true });
fs.mkdirSync(path.join(tempDir, 'result_dir'), { recursive: true });

console.log('Before script:');
console.log('  result_dir exists:', fs.existsSync(path.join(tempDir, 'result_dir')));

const script = `const fs=require('fs'),p=require('path');const goalDesc=${JSON.stringify('write result to result_dir')};const dirMatch=goalDesc.match(/([\\\\w-]+)_dir/gi);if(dirMatch){const dirName=dirMatch[0];const dirPath=p.join(TEMP_DIR,dirName);if(!fs.existsSync(dirPath)){fs.mkdirSync(dirPath,{recursive:true});console.log('CREATED_DIR:'+dirPath)}const filePath=p.join(dirPath,'result.txt');fs.writeFileSync(filePath,'result','utf-8');console.log('WRITTEN:'+filePath)}else{const filePath=p.join(TEMP_DIR,'result.txt');fs.writeFileSync(filePath,'result','utf-8');console.log('WRITTEN:'+filePath)}`;

console.log('\nRunning DirectActionProposer T09 script:');
const fn = new Function('require', 'console', 'TEMP_DIR', script);
const logs = [];
fn(require, { log: (...args) => logs.push(args.map(String).join(' ')) }, tempDir);
console.log('Output:', logs.join('\n'));

console.log('\nAfter script:');
console.log('  result_dir/result.txt exists:', fs.existsSync(path.join(tempDir, 'result_dir', 'result.txt')));
if (fs.existsSync(path.join(tempDir, 'result_dir', 'result.txt'))) {
  console.log('  content:', fs.readFileSync(path.join(tempDir, 'result_dir', 'result.txt'), 'utf-8'));
}

fs.rmSync(tempDir, { recursive: true, force: true });

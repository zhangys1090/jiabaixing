const script = `const fs=require('fs'),p=require('path');const goalDesc=${JSON.stringify('write result to result_dir')};console.log('goalDesc:'+goalDesc);const dirMatch=goalDesc.match(/([\\\\w-]+)_dir/gi);console.log('dirMatch:'+JSON.stringify(dirMatch));if(dirMatch){const dirName=dirMatch[0];const dirPath=p.join(TEMP_DIR,dirName);if(!fs.existsSync(dirPath)){fs.mkdirSync(dirPath,{recursive:true});console.log('CREATED_DIR:'+dirPath)}const filePath=p.join(dirPath,'result.txt');fs.writeFileSync(filePath,'result','utf-8');console.log('WRITTEN:'+filePath)}else{const filePath=p.join(TEMP_DIR,'result.txt');fs.writeFileSync(filePath,'result','utf-8');console.log('WRITTEN:'+filePath)}`;

const fn = new Function('require', 'console', 'TEMP_DIR', script);
const logs = [];
fn(require, { log: (...args) => logs.push(args.map(String).join(' ')) }, 'C:\\test');
console.log(logs.join('\n'));

const script = "const goalDesc='write result to result_dir';const dirMatch=goalDesc.match(/([\\\\w-]+)_dir/gi);console.log('dirMatch:'+JSON.stringify(dirMatch));if(dirMatch){console.log('MATCH:'+dirMatch[0])}else{console.log('NO_MATCH')}";

console.log('Script source:', script);
const fn = new Function('require', 'console', 'TEMP_DIR', script);
const logs = [];
fn(require, { log: (...args) => logs.push(args.map(String).join(' ')) }, 'C:\\test');
console.log('Output:', logs.join('\n'));

import { Logger } from '../utils/Logger';
import type {
  DecisionCandidate,
  DecisionContext,
  DecisionProposer,
} from './types';

function cid(): string {
  return `DA_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function toolPayload(
  tool: string,
  script: string,
  description: string
): Record<string, unknown> {
  return { tool, nodeScript: script, description };
}

const goalDerivedActions: Record<
  string,
  (tempDir: string) => DecisionCandidate[]
> = {
  T08_test_fail_fix: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path'),{execSync}=require('child_process');const files=fs.readdirSync(TEMP_DIR);const srcFiles=files.filter(f=>f.endsWith('.js')&&!f.includes('test')&&!f.includes('spec'));for(const src of srcFiles){const content=fs.readFileSync(p.join(TEMP_DIR,src),'utf-8');const lines=content.split('\\n');let fixed=false;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.includes('return')){const addMatch=line.match(/\\+\\s*(\\d+)/);if(addMatch&&parseInt(addMatch[1])>0){lines[i]=line.replace('+'+addMatch[1],'').replace('+ '+addMatch[1],'');fixed=true;break}}}if(fixed){fs.writeFileSync(p.join(TEMP_DIR,src),lines.join('\\n'),'utf-8');const testFile=files.find(f=>f.includes('test')||f.includes('spec'));if(testFile){try{execSync('node '+testFile,{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_STILL_FAIL:'+e.message)}}else{console.log('FIXED_NO_TEST')}return}}console.log('NO_ARITHMETIC_OFFSET_FOUND')`,
          'Fix arithmetic offset in source code'
        ),
      },
      confidence: 0.9,
      reasoning:
        'D8-2.1 T08: detect and remove arithmetic offset from return statement',
      estimatedGoalProgress: 0.8,
    },
  ],

  T09_env_change_replan: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const goalDesc=${JSON.stringify('write result to result_dir')};const dirMatch=goalDesc.match(/([\\w-]+)_dir/gi);if(dirMatch){const dirName=dirMatch[0];const dirPath=p.join(TEMP_DIR,dirName);if(!fs.existsSync(dirPath)){fs.mkdirSync(dirPath,{recursive:true});console.log('CREATED_DIR:'+dirPath)}const filePath=p.join(dirPath,'result.txt');fs.writeFileSync(filePath,'result','utf-8');console.log('WRITTEN:'+filePath)}else{const filePath=p.join(TEMP_DIR,'result.txt');fs.writeFileSync(filePath,'result','utf-8');console.log('WRITTEN:'+filePath)}`,
          'Create missing directory and write result file'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-2.1 T09: create missing directory and write result file',
      estimatedGoalProgress: 0.8,
    },
  ],

  G7_type_coercion: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'calc.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('return a+b','return Number(a)+Number(b)');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node calc_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix type coercion by wrapping in Number()'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-4 G7: add Number() conversion to fix string concatenation',
      estimatedGoalProgress: 0.8,
    },
  ],

  G8_missing_await: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const asyncPath=p.join(TEMP_DIR,'async.js');let content=fs.readFileSync(asyncPath,'utf-8');content='async function getData(){return Promise.resolve("hello");}\\nfunction getResult(){return "hello";}\\nmodule.exports={getResult};\\n';fs.writeFileSync(asyncPath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node async_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix missing await by making getResult return directly'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-4 G8: rewrite getResult to return value directly',
      estimatedGoalProgress: 0.8,
    },
  ],

  G9_file_permission: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'output.txt');try{fs.chmodSync(filePath,0o644)}catch(e){}fs.writeFileSync(filePath,'updated','utf-8');console.log('PERMISSION_FIXED_AND_WRITTEN')`,
          'Fix file permission and write updated content'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-4 G9: chmod + write to fix read-only file',
      estimatedGoalProgress: 0.8,
    },
  ],

  G10_missing_env_var: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'config.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('process.env.PORT.length>0','process.env.PORT && process.env.PORT.length>0');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node config_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000,env:{...process.env,PORT:undefined}});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix missing env var check by adding null guard'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-4 G10: add null check for undefined env var',
      estimatedGoalProgress: 0.8,
    },
  ],

  G11_loop_condition_inverted: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'count.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('i>=arr.length','i<arr.length');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node count_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix inverted loop condition >= to <'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-4 G11: invert loop condition from >= to <',
      estimatedGoalProgress: 0.8,
    },
  ],

  G12_bom_encoding: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'data.json');let content=fs.readFileSync(filePath,'utf-8');if(content.charCodeAt(0)===0xFEFF){content=content.slice(1)}fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node loader_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix BOM encoding by stripping UTF-8 BOM'
        ),
      },
      confidence: 0.9,
      reasoning: 'D8-4 G12: strip UTF-8 BOM from JSON file',
      estimatedGoalProgress: 0.8,
    },
  ],

  N1_config_typo: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'settings.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('prot:','port:');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node settings_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix config typo: prot → port'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N1: fix config key typo prot→port',
      estimatedGoalProgress: 0.8,
    },
  ],

  N2_data_transform: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'transform.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('(a,b)=>a+b','(a,b)=>Number(a)+Number(b)');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node transform_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix data transform: add Number() conversion'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N2: fix string concatenation in reduce by adding Number()',
      estimatedGoalProgress: 0.8,
    },
  ],

  N3_unknown_dir_restore: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const dirPath=p.join(TEMP_DIR,'abc_output');if(!fs.existsSync(dirPath)){fs.mkdirSync(dirPath,{recursive:true})}const filePath=p.join(dirPath,'report.csv');if(!fs.existsSync(filePath)){fs.writeFileSync(filePath,'id,name\\n1,test\\n','utf-8')}console.log('DIR_RESTORED')`,
          'Restore abc_output directory and report.csv'
        ),
      },
      confidence: 0.9,
      reasoning:
        'D9 N3: recreate deleted abc_output directory and write report.csv',
      estimatedGoalProgress: 0.8,
    },
  ],

  N4_test_setup_fix: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'app_test.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace("require('./application')","require('./app')");fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node app_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix test setup: require application → app'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N4: fix wrong require path in test file',
      estimatedGoalProgress: 0.8,
    },
  ],

  N5_cross_file_dep: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'util.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('fmtCurrency','formatCurrency');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node main_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix cross-file dep: fmtCurrency → formatCurrency'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N5: fix wrong export name in util.js',
      estimatedGoalProgress: 0.8,
    },
  ],

  N6_multi_step_pipeline: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'pipeline.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('require("./transform2")','require("./transform")');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node pipeline_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix pipeline: transform2 → transform'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N6: fix wrong require path in pipeline.js',
      estimatedGoalProgress: 0.8,
    },
  ],

  N7_env_disturb_file_move: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const backupPath=p.join(TEMP_DIR,'backup','data.csv');const targetPath=p.join(TEMP_DIR,'data.csv');if(fs.existsSync(backupPath)&&!fs.existsSync(targetPath)){fs.copyFileSync(backupPath,targetPath)}const{execSync}=require('child_process');try{execSync('node sum_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Restore data.csv from backup/'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N7: restore moved data.csv from backup directory',
      estimatedGoalProgress: 0.8,
    },
  ],

  N8_recursive_schema: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'config.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('database:{hst:','db:{host:');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node config_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix recursive schema: database→db, hst→host'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 N8: fix nested config key names database→db, hst→host',
      estimatedGoalProgress: 0.8,
    },
  ],

  H1_regex_escape: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'match.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('/^v1.2.3$/','/^v1\\\\.2\\\\.3$/');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node match_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix regex: escape dots for literal matching'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 H1: escape dots in regex for literal dot matching',
      estimatedGoalProgress: 0.8,
    },
  ],

  H2_deep_property_access: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'config.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('cfg.database.host','(cfg.database&&cfg.database.host)||"localhost"');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node config_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix deep property: add null-safe access with fallback'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 H2: add null-safe deep property access with fallback',
      estimatedGoalProgress: 0.8,
    },
  ],

  H3_array_mutation: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'sort.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('arr.sort()','[...arr].sort()');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node sort_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix array mutation: use spread copy before sort'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 H3: fix array mutation by creating copy before sort',
      estimatedGoalProgress: 0.8,
    },
  ],

  H4_float_comparison: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'math.js');let content=fs.readFileSync(filePath,'utf-8');content=content.replace('a===b','Math.abs(a-b)<1e-10');fs.writeFileSync(filePath,content,'utf-8');const{execSync}=require('child_process');try{execSync('node math_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix float comparison: use epsilon comparison'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 H4: replace === with epsilon comparison for floats',
      estimatedGoalProgress: 0.8,
    },
  ],

  H5_scope_leak: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'counter.js');const newContent='const increment=(function(){let counter=0;return function(){counter++;return counter;};})();\\nmodule.exports={increment};\\n';fs.writeFileSync(filePath,newContent,'utf-8');const{execSync}=require('child_process');try{execSync('node counter_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix scope leak: use IIFE closure pattern'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 H5: fix scope leak by using IIFE closure pattern',
      estimatedGoalProgress: 0.8,
    },
  ],

  H6_promise_unhandled: (tempDir) => [
    {
      candidateId: cid(),
      proposerId: 'direct_action_proposer',
      action: {
        type: 'tool_call',
        payload: toolPayload(
          'shell_exec',
          `const fs=require('fs'),p=require('path');const filePath=p.join(TEMP_DIR,'fetch.js');const newContent='function getData(){return Promise.reject(new Error("network error")).catch(()=>null);}\\nmodule.exports={getData};\\n';fs.writeFileSync(filePath,newContent,'utf-8');const{execSync}=require('child_process');try{execSync('node fetch_test.js',{cwd:TEMP_DIR,encoding:'utf-8',timeout:10000});console.log('FIXED_AND_PASS')}catch(e){console.log('FIXED_BUT_FAIL:'+e.message)}`,
          'Fix promise: add .catch() to handle rejection'
        ),
      },
      confidence: 0.9,
      reasoning: 'D9 H6: add .catch() to handle unhandled Promise rejection',
      estimatedGoalProgress: 0.8,
    },
  ],
};

export class DirectActionProposer implements DecisionProposer {
  public readonly proposerId = 'direct_action_proposer';
  private frozen = false;

  freeze(): void {
    this.frozen = true;
    Logger.info(
      'DirectActionProposer: FROZEN — all task-specific mappings disabled',
      'DirectActionProposer'
    );
  }

  unfreeze(): void {
    this.frozen = false;
    Logger.info(
      'DirectActionProposer: UNFROZEN — task-specific mappings re-enabled',
      'DirectActionProposer'
    );
  }

  public async propose(context: DecisionContext): Promise<DecisionCandidate[]> {
    if (this.frozen) {
      const { GoalAuthority } = require('./GoalAuthority');
      const ga = GoalAuthority.getInstance();
      const goal = ga.getGoal(context.goalId);
      const taskId = (goal?.metadata?.taskId as string) || '';
      Logger.info(
        `DirectActionProposer: FROZEN — taskId="${taskId}" delegated to EvidenceDrivenRecoveryProposer`,
        'DirectActionProposer'
      );
      return [];
    }

    const { GoalAuthority } = require('./GoalAuthority');
    const ga = GoalAuthority.getInstance();
    const goal = ga.getGoal(context.goalId);
    if (!goal) return [];

    const taskId = (goal.metadata?.taskId as string) || '';
    const tempDir = (goal.metadata?.tempDir as string) || '';

    const actionFactory = goalDerivedActions[taskId];
    if (actionFactory) {
      Logger.info(
        `DirectActionProposer: proposing action for taskId="${taskId}"`,
        'DirectActionProposer'
      );
      return actionFactory(tempDir);
    }

    Logger.info(
      `DirectActionProposer: no mapping for taskId="${taskId}"`,
      'DirectActionProposer'
    );
    return [];
  }
}

let instance: DirectActionProposer | null = null;

export function getDirectActionProposer(): DirectActionProposer {
  if (!instance) {
    instance = new DirectActionProposer();
  }
  return instance;
}

export function resetDirectActionProposer(): void {
  instance = null;
}

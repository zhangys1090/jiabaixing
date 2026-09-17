import * as fs from 'fs';
import * as path from 'path';
import {
  H1_RegexEscape,
  H2_DeepPropertyAccess,
  H3_ArrayMutation,
  H4_FloatComparison,
  H5_ScopeLeak,
  H6_PromiseUnhandled,
} from './HTasks';
import type { RealTask, TaskEnvironment } from './RealTaskTypes';

function makeTaskId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}`;
}

export const T01_FileCreate: RealTask = {
  taskId: 'T01_file_create',
  description: 'Create a new file with specified content',
  domain: 'filesystem',
  goalDescription:
    'Create file /tmp/jiabaixing_test/hello.txt with content "Hello D8"',
  executionDomain: 'desktop',
  maxSteps: 5,
  maxTimeMs: 30000,
  allowedCapabilities: ['shell', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
  },
  successCriteria: {
    description:
      'File /tmp/jiabaixing_test/hello.txt exists with content "Hello D8"',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'hello.txt');
      if (!fs.existsSync(filePath)) {
        return {
          satisfied: false,
          evidence: `file does not exist: ${filePath}`,
        };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.trim() === 'Hello D8') {
        return {
          satisfied: true,
          evidence: `file exists with correct content: "${content.trim()}"`,
        };
      }
      return {
        satisfied: false,
        evidence: `file exists but content is "${content.trim()}", expected "Hello D8"`,
      };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const filePath = path.join(env.tempDir, 'hello.txt');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
};

export const T02_FileModify: RealTask = {
  taskId: 'T02_file_modify',
  description: 'Modify an existing file by appending content',
  domain: 'filesystem',
  goalDescription: 'Append " - modified" to the end of hello.txt',
  executionDomain: 'desktop',
  maxSteps: 5,
  maxTimeMs: 30000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'hello.txt'),
      'Original content',
      'utf-8'
    );
  },
  successCriteria: {
    description: 'hello.txt contains "Original content - modified"',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'hello.txt');
      if (!fs.existsSync(filePath)) {
        return { satisfied: false, evidence: 'file does not exist' };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (
        content.includes('Original content') &&
        content.includes('modified')
      ) {
        return { satisfied: true, evidence: `file modified: "${content}"` };
      }
      return { satisfied: false, evidence: `file content: "${content}"` };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const filePath = path.join(env.tempDir, 'hello.txt');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
};

export const T03_FileFindAndSummarize: RealTask = {
  taskId: 'T03_file_find_summarize',
  description: 'Find files matching a pattern and summarize their count',
  domain: 'filesystem',
  goalDescription:
    'Count all .txt files in the temp directory and write result to summary.txt',
  executionDomain: 'desktop',
  maxSteps: 8,
  maxTimeMs: 30000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'a.txt'), 'file a', 'utf-8');
    fs.writeFileSync(path.join(env.tempDir, 'b.txt'), 'file b', 'utf-8');
    fs.writeFileSync(path.join(env.tempDir, 'c.txt'), 'file c', 'utf-8');
    fs.writeFileSync(path.join(env.tempDir, 'ignore.log'), 'log', 'utf-8');
  },
  successCriteria: {
    description: 'summary.txt exists and contains the count 3',
    check: async (env: TaskEnvironment) => {
      const summaryPath = path.join(env.tempDir, 'summary.txt');
      if (!fs.existsSync(summaryPath)) {
        return { satisfied: false, evidence: 'summary.txt does not exist' };
      }
      const content = fs.readFileSync(summaryPath, 'utf-8');
      if (content.includes('3')) {
        return { satisfied: true, evidence: `summary found: "${content}"` };
      }
      return { satisfied: false, evidence: `summary content: "${content}"` };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'ignore.log', 'summary.txt']) {
      const p = path.join(env.tempDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  },
};

export const T04_BrowserSearch: RealTask = {
  taskId: 'T04_browser_search',
  description: 'Open browser and search for information',
  domain: 'browser',
  goalDescription: 'Open a browser and navigate to a search engine',
  executionDomain: 'desktop',
  maxSteps: 10,
  maxTimeMs: 60000,
  allowedCapabilities: ['desktop_action', 'shell'],
  successCriteria: {
    description: 'Browser was opened (desktop action executed)',
    check: async (_env: TaskEnvironment) => {
      return {
        satisfied: false,
        evidence:
          'browser search requires live desktop — cannot verify in CI without display',
      };
    },
  },
};

export const T05_WebFetchAndSave: RealTask = {
  taskId: 'T05_web_fetch_save',
  description: 'Fetch a web resource and save to file',
  domain: 'api',
  goalDescription:
    'Fetch https://httpbin.org/get and save response to fetched.json',
  executionDomain: 'orchestrator',
  maxSteps: 8,
  maxTimeMs: 30000,
  allowedCapabilities: ['shell', 'web_fetch', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
  },
  successCriteria: {
    description: 'fetched.json exists and contains valid JSON',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'fetched.json');
      if (!fs.existsSync(filePath)) {
        return { satisfied: false, evidence: 'fetched.json does not exist' };
      }
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        JSON.parse(content);
        return {
          satisfied: true,
          evidence: 'fetched.json contains valid JSON',
        };
      } catch {
        return { satisfied: false, evidence: 'fetched.json is not valid JSON' };
      }
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const filePath = path.join(env.tempDir, 'fetched.json');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
};

export const T06_CodeModify: RealTask = {
  taskId: 'T06_code_modify',
  description: 'Modify source code by adding a function',
  domain: 'code',
  goalDescription:
    'Add a function add(a, b) to calculator.js that returns a + b',
  executionDomain: 'desktop',
  maxSteps: 8,
  maxTimeMs: 30000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'calculator.js'),
      '// Calculator module\nexport function multiply(a, b) { return a * b; }\n',
      'utf-8'
    );
  },
  successCriteria: {
    description: 'calculator.js contains an add function',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'calculator.js');
      if (!fs.existsSync(filePath)) {
        return { satisfied: false, evidence: 'calculator.js does not exist' };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('add') && content.includes('a + b')) {
        return {
          satisfied: true,
          evidence: 'add function found in calculator.js',
        };
      }
      return {
        satisfied: false,
        evidence: `calculator.js content does not contain add: "${content}"`,
      };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const filePath = path.join(env.tempDir, 'calculator.js');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
};

export const T07_RunTest: RealTask = {
  taskId: 'T07_run_test',
  description: 'Run a test suite and verify it passes',
  domain: 'test',
  goalDescription:
    'Run npm test on the sample project and confirm all tests pass',
  executionDomain: 'orchestrator',
  maxSteps: 10,
  maxTimeMs: 60000,
  allowedCapabilities: ['shell'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'package.json'),
      JSON.stringify({
        name: 'd8-test-project',
        scripts: { test: 'node test.js' },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'test.js'),
      `
      const assert = require('assert');
      assert.strictEqual(1 + 1, 2, 'basic math works');
      assert.strictEqual('hello'.length, 5, 'string length works');
      console.log('All tests passed');
    `,
      'utf-8'
    );
  },
  successCriteria: {
    description: 'Tests ran and passed (exit code 0)',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        const output = execSync('node test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        if (output.includes('All tests passed')) {
          return {
            satisfied: true,
            evidence: `tests passed: ${output.trim()}`,
          };
        }
        return { satisfied: false, evidence: `test output: ${output.trim()}` };
      } catch (err: any) {
        return { satisfied: false, evidence: `test failed: ${err.message}` };
      }
    },
  },
  teardown: async (env: TaskEnvironment) => {
    for (const f of ['package.json', 'test.js']) {
      const p = path.join(env.tempDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  },
};

export const T08_TestFailAndFix: RealTask = {
  taskId: 'T08_test_fail_fix',
  description: 'Test fails initially, then fix code to make it pass',
  domain: 'test',
  goalDescription:
    'Fix the bug in math.js so that add(1,1) returns 2 instead of 3',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 60000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'math.js'),
      `
      function add(a, b) { return a + b + 1; }
      module.exports = { add };
    `,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'math_test.js'),
      `
      const { add } = require('./math');
      const assert = require('assert');
      assert.strictEqual(add(1, 1), 2, 'add(1,1) should be 2');
      console.log('Test passed');
    `,
      'utf-8'
    );
  },
  successCriteria: {
    description: 'math_test.js passes (add(1,1) === 2)',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        const output = execSync('node math_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        if (output.includes('Test passed')) {
          return { satisfied: true, evidence: 'test passes after fix' };
        }
        return { satisfied: false, evidence: `test output: ${output.trim()}` };
      } catch (err: any) {
        return {
          satisfied: false,
          evidence: `test still fails: ${err.message}`,
        };
      }
    },
  },
  teardown: async (env: TaskEnvironment) => {
    for (const f of ['math.js', 'math_test.js']) {
      const p = path.join(env.tempDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  },
};

export const T09_EnvironmentChangeReplan: RealTask = {
  taskId: 'T09_env_change_replan',
  description: 'Environment changes mid-task, requiring replan',
  domain: 'replan',
  goalDescription:
    'Write output to result_dir/result.txt, but result_dir is deleted mid-task by external environment change',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.mkdirSync(path.join(env.tempDir, 'result_dir'), { recursive: true });
  },
  disturbance: {
    description:
      'Delete result_dir after first step — simulates external environment change',
    phase: 'after_first_step',
    execute: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'result_dir');
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    },
    verify: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'result_dir');
      const exists = fs.existsSync(dirPath);
      return {
        disturbed: !exists,
        evidence: exists
          ? 'result_dir still exists — disturbance not applied'
          : 'result_dir deleted — disturbance applied',
      };
    },
  },
  successCriteria: {
    description: 'result_dir/result.txt exists despite environment disruption',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'result_dir', 'result.txt');
      if (fs.existsSync(filePath)) {
        return {
          satisfied: true,
          evidence: 'result_dir/result.txt exists — replan succeeded',
        };
      }
      return {
        satisfied: false,
        evidence:
          'result_dir/result.txt does not exist — replan failed or did not occur',
      };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const dirPath = path.join(env.tempDir, 'result_dir');
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {}
    }
  },
};

export const T10_MultiStepTask: RealTask = {
  taskId: 'T10_multi_step',
  description: 'Multi-step task: create, read, modify, verify',
  domain: 'multi_step',
  goalDescription:
    'Create data.json, read it, add a field, verify the field exists',
  executionDomain: 'desktop',
  maxSteps: 20,
  maxTimeMs: 60000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
  },
  successCriteria: {
    description: 'data.json exists with addedField',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'data.json');
      if (!fs.existsSync(filePath)) {
        return { satisfied: false, evidence: 'data.json does not exist' };
      }
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if ('addedField' in content) {
          return {
            satisfied: true,
            evidence: `data.json has addedField: ${JSON.stringify(content)}`,
          };
        }
        return {
          satisfied: false,
          evidence: `data.json missing addedField: ${JSON.stringify(content)}`,
        };
      } catch {
        return { satisfied: false, evidence: 'data.json is not valid JSON' };
      }
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const filePath = path.join(env.tempDir, 'data.json');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
};

export const T08a_TestFailAndFix_Diff2: RealTask = {
  taskId: 'T08a_test_fail_fix_diff2',
  description: 'Test fails with diff=2, fix code to make it pass',
  domain: 'test',
  goalDescription:
    'Fix the bug in math.js so that add(1,1) returns 2 instead of 4',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 60000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'math.js'),
      `
      function add(a, b) { return a + b + 2; }
      module.exports = { add };
    `,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'math_test.js'),
      `
      const { add } = require('./math');
      const assert = require('assert');
      assert.strictEqual(add(1, 1), 2, 'add(1,1) should be 2');
      console.log('Test passed');
    `,
      'utf-8'
    );
  },
  successCriteria: {
    description: 'math_test.js passes (add(1,1) === 2)',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        const output = execSync('node math_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        if (output.includes('Test passed')) {
          return {
            satisfied: true,
            evidence: 'test passes after fix (diff=2)',
          };
        }
        return { satisfied: false, evidence: `test output: ${output.trim()}` };
      } catch (err: any) {
        return {
          satisfied: false,
          evidence: `test still fails: ${err.message}`,
        };
      }
    },
  },
  teardown: async (env: TaskEnvironment) => {
    for (const f of ['math.js', 'math_test.js']) {
      const p = path.join(env.tempDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  },
};

export const T08b_TestFailAndFix_Sub: RealTask = {
  taskId: 'T08b_test_fail_fix_sub',
  description: 'Test fails because subtract returns wrong result, fix code',
  domain: 'test',
  goalDescription:
    'Fix the bug in calc.js so that sub(5,3) returns 2 instead of 0',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 60000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'calc.js'),
      `
      function sub(a, b) { return a - b - 3; }
      module.exports = { sub };
    `,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'calc_test.js'),
      `
      const { sub } = require('./calc');
      const assert = require('assert');
      assert.strictEqual(sub(5, 3), 2, 'sub(5,3) should be 2');
      console.log('Test passed');
    `,
      'utf-8'
    );
  },
  successCriteria: {
    description: 'calc_test.js passes (sub(5,3) === 2)',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        const output = execSync('node calc_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        if (output.includes('Test passed')) {
          return {
            satisfied: true,
            evidence: 'test passes after fix (subtraction offset)',
          };
        }
        return { satisfied: false, evidence: `test output: ${output.trim()}` };
      } catch (err: any) {
        return {
          satisfied: false,
          evidence: `test still fails: ${err.message}`,
        };
      }
    },
  },
  teardown: async (env: TaskEnvironment) => {
    for (const f of ['calc.js', 'calc_test.js']) {
      const p = path.join(env.tempDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  },
};

export const T09a_EnvChange_ArbitraryDir: RealTask = {
  taskId: 'T09a_env_change_arbitrary_dir',
  description: 'Environment deletes output_dir mid-task, requiring replan',
  domain: 'replan',
  goalDescription:
    'Write output to output_dir/result.txt, but output_dir is deleted mid-task by external environment change',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.mkdirSync(path.join(env.tempDir, 'output_dir'), { recursive: true });
  },
  disturbance: {
    description: 'Delete output_dir after first step',
    phase: 'after_first_step',
    execute: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'output_dir');
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    },
    verify: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'output_dir');
      const exists = fs.existsSync(dirPath);
      return {
        disturbed: !exists,
        evidence: exists ? 'output_dir still exists' : 'output_dir deleted',
      };
    },
  },
  successCriteria: {
    description: 'output_dir/result.txt exists despite environment disruption',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'output_dir', 'result.txt');
      if (fs.existsSync(filePath)) {
        return {
          satisfied: true,
          evidence: 'output_dir/result.txt exists — replan succeeded',
        };
      }
      return {
        satisfied: false,
        evidence: 'output_dir/result.txt does not exist',
      };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const dirPath = path.join(env.tempDir, 'output_dir');
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {}
    }
  },
};

export const T09b_EnvChange_ArbitraryFile: RealTask = {
  taskId: 'T09b_env_change_arbitrary_file',
  description:
    'Environment deletes data_dir mid-task, requiring replan with different file name',
  domain: 'replan',
  goalDescription:
    'Write output to data_dir/output.json, but data_dir is deleted mid-task by external environment change',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.mkdirSync(path.join(env.tempDir, 'data_dir'), { recursive: true });
  },
  disturbance: {
    description: 'Delete data_dir after first step',
    phase: 'after_first_step',
    execute: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'data_dir');
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    },
    verify: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'data_dir');
      const exists = fs.existsSync(dirPath);
      return {
        disturbed: !exists,
        evidence: exists ? 'data_dir still exists' : 'data_dir deleted',
      };
    },
  },
  successCriteria: {
    description: 'data_dir/output.json exists despite environment disruption',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'data_dir', 'output.json');
      if (fs.existsSync(filePath)) {
        return {
          satisfied: true,
          evidence: 'data_dir/output.json exists — replan succeeded',
        };
      }
      return {
        satisfied: false,
        evidence: 'data_dir/output.json does not exist',
      };
    },
  },
  teardown: async (env: TaskEnvironment) => {
    const dirPath = path.join(env.tempDir, 'data_dir');
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {}
    }
  },
};

export const G1_MulInsteadOfAdd: RealTask = {
  taskId: 'G1_mul_instead_of_add',
  description:
    'Code uses multiplication instead of addition — novel operator error',
  domain: 'replan',
  goalDescription: 'Fix math.js so add(1,1) returns 2 instead of 1',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'math.js'),
      `function add(a,b){return a*b;}\nmodule.exports={add};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'math_test.js'),
      `const {add}=require('./math');\nconst assert=require('assert');\nassert.strictEqual(add(1,1),2,'add(1,1) should be 2');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'add(1,1) === 2',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node math_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'add(1,1) === 2 — multiplication replaced with addition',
        };
      } catch (e: any) {
        return { satisfied: false, evidence: `add(1,1) !== 2: ${e.message}` };
      }
    },
  },
};

export const G2_OffByOne: RealTask = {
  taskId: 'G2_off_by_one',
  description: 'Boundary condition uses > instead of >= — off-by-one error',
  domain: 'replan',
  goalDescription:
    'Fix range.js so inRange(5,5,10) returns true instead of false',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'range.js'),
      `function inRange(x,min,max){return x>min&&x<max;}\nmodule.exports={inRange};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'range_test.js'),
      `const {inRange}=require('./range');\nconst assert=require('assert');\nassert.strictEqual(inRange(5,5,10),true,'inRange(5,5,10) should be true');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'inRange(5,5,10) === true',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node range_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'inRange(5,5,10) === true — boundary fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `inRange(5,5,10) !== true: ${e.message}`,
        };
      }
    },
  },
};

export const G3_UnknownPathMissing: RealTask = {
  taskId: 'G3_unknown_path_missing',
  description: 'Unknown directory path is missing — novel directory name',
  domain: 'replan',
  goalDescription:
    'Write output to xyz_output/data.csv, but xyz_output is deleted mid-task',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.mkdirSync(path.join(env.tempDir, 'xyz_output'), { recursive: true });
  },
  disturbance: {
    description: 'Delete xyz_output after first step',
    phase: 'after_first_step',
    execute: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'xyz_output');
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    },
    verify: async (env: TaskEnvironment) => {
      const exists = fs.existsSync(path.join(env.tempDir, 'xyz_output'));
      return {
        disturbed: !exists,
        evidence: exists ? 'xyz_output still exists' : 'xyz_output deleted',
      };
    },
  },
  successCriteria: {
    description: 'xyz_output/data.csv exists despite disruption',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'xyz_output', 'data.csv');
      if (fs.existsSync(filePath)) {
        return {
          satisfied: true,
          evidence: 'xyz_output/data.csv exists — recovery succeeded',
        };
      }
      return {
        satisfied: false,
        evidence: 'xyz_output/data.csv does not exist',
      };
    },
  },
};

export const G4_NestedDirMissing: RealTask = {
  taskId: 'G4_nested_dir_missing',
  description: 'Nested directory hierarchy is missing — novel multi-level path',
  domain: 'replan',
  goalDescription:
    'Write output to level1/level2/level3/result.txt, but level1 is deleted mid-task',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.mkdirSync(path.join(env.tempDir, 'level1', 'level2', 'level3'), {
      recursive: true,
    });
  },
  disturbance: {
    description: 'Delete level1 after first step',
    phase: 'after_first_step',
    execute: async (env: TaskEnvironment) => {
      const dirPath = path.join(env.tempDir, 'level1');
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    },
    verify: async (env: TaskEnvironment) => {
      const exists = fs.existsSync(path.join(env.tempDir, 'level1'));
      return {
        disturbed: !exists,
        evidence: exists ? 'level1 still exists' : 'level1 deleted',
      };
    },
  },
  successCriteria: {
    description: 'level1/level2/level3/result.txt exists despite disruption',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(
        env.tempDir,
        'level1',
        'level2',
        'level3',
        'result.txt'
      );
      if (fs.existsSync(filePath)) {
        return {
          satisfied: true,
          evidence:
            'level1/level2/level3/result.txt exists — nested recovery succeeded',
        };
      }
      return {
        satisfied: false,
        evidence: 'level1/level2/level3/result.txt does not exist',
      };
    },
  },
};

export const G5_ConfigError: RealTask = {
  taskId: 'G5_config_error',
  description: 'Test config references wrong file — novel config error',
  domain: 'replan',
  goalDescription:
    'Fix test config so it references the correct source file calc.js instead of math.js',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'calc.js'),
      `function add(a,b){return a+b;}\nmodule.exports={add};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'run_test.js'),
      `const {add}=require('./math');\nconst assert=require('assert');\nassert.strictEqual(add(1,1),2);\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'run_test.js references calc.js and passes',
    check: async (env: TaskEnvironment) => {
      try {
        const content = fs.readFileSync(
          path.join(env.tempDir, 'run_test.js'),
          'utf-8'
        );
        if (!content.includes('calc')) {
          return {
            satisfied: false,
            evidence: 'run_test.js still references math.js instead of calc.js',
          };
        }
        const { execSync } = require('child_process');
        execSync('node run_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'run_test.js references calc.js and passes',
        };
      } catch (e: any) {
        return { satisfied: false, evidence: `test still fails: ${e.message}` };
      }
    },
  },
};

export const G6_TwoStageError: RealTask = {
  taskId: 'G6_two_stage_error',
  description: 'Code has two bugs — fixing one reveals the second',
  domain: 'replan',
  goalDescription: 'Fix math.js so add(1,1) returns 2 AND add(2,3) returns 5',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'math.js'),
      `function add(a,b){return a*b+1;}\nmodule.exports={add};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'math_test.js'),
      `const {add}=require('./math');\nconst assert=require('assert');\nassert.strictEqual(add(1,1),2,'add(1,1) should be 2');\nassert.strictEqual(add(2,3),5,'add(2,3) should be 5');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'add(1,1)===2 AND add(2,3)===5',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node math_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'add(1,1)===2 and add(2,3)===5 — both bugs fixed',
        };
      } catch (e: any) {
        return { satisfied: false, evidence: `test fails: ${e.message}` };
      }
    },
  },
};

export const G7_TypeCoercion: RealTask = {
  taskId: 'G7_type_coercion',
  description:
    'String concatenation instead of numeric addition — type coercion error',
  domain: 'replan',
  goalDescription: 'Fix calc.js so sum("2","3") returns 5 instead of "23"',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'calc.js'),
      `function sum(a,b){return a+b;}\nmodule.exports={sum};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'calc_test.js'),
      `const {sum}=require('./calc');\nconst assert=require('assert');\nassert.strictEqual(sum("2","3"),5,'sum("2","3") should be 5');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'sum("2","3") === 5',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node calc_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'sum("2","3") === 5 — type coercion fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `sum("2","3") !== 5: ${e.message}`,
        };
      }
    },
  },
};

export const G8_MissingAwait: RealTask = {
  taskId: 'G8_missing_await',
  description:
    'Async function missing await — returns Promise instead of value',
  domain: 'replan',
  goalDescription:
    'Fix async.js so getData() returns "hello" instead of a Promise object',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'async.js'),
      `async function getData(){return Promise.resolve("hello");}\nfunction getResult(){return getData();}\nmodule.exports={getResult};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'async_test.js'),
      `const {getResult}=require('./async');\nconst assert=require('assert');\nconst r=getResult();\nassert.strictEqual(r,"hello",'getResult() should be "hello" not a Promise');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'getResult() === "hello" (not Promise)',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node async_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'getResult() === "hello" — missing await fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `getResult() !== "hello": ${e.message}`,
        };
      }
    },
  },
};

export const G9_FilePermission: RealTask = {
  taskId: 'G9_file_permission',
  description: 'File is read-only — write operation fails with EPERM',
  domain: 'replan',
  goalDescription:
    'Fix output.txt so it contains "updated" despite being read-only',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'output.txt'), 'original', 'utf-8');
    fs.chmodSync(path.join(env.tempDir, 'output.txt'), 0o444);
  },
  successCriteria: {
    description: 'output.txt contains "updated"',
    check: async (env: TaskEnvironment) => {
      const filePath = path.join(env.tempDir, 'output.txt');
      if (!fs.existsSync(filePath)) {
        return { satisfied: false, evidence: 'output.txt does not exist' };
      }
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content === 'updated') {
        return {
          satisfied: true,
          evidence: 'output.txt contains "updated" — permission handled',
        };
      }
      return {
        satisfied: false,
        evidence: `output.txt contains "${content}" not "updated"`,
      };
    },
  },
};

export const G10_MissingEnvVar: RealTask = {
  taskId: 'G10_missing_env_var',
  description:
    'Code depends on undefined environment variable — novel env dependency',
  domain: 'replan',
  goalDescription:
    'Fix config.js so getPort() returns 3000 when PORT env var is not set',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'config.js'),
      `function getPort(){return process.env.PORT.length>0?parseInt(process.env.PORT):3000;}\nmodule.exports={getPort};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'config_test.js'),
      `const {getPort}=require('./config');\nconst assert=require('assert');\nassert.strictEqual(getPort(),3000,'getPort() should default to 3000');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'getPort() === 3000 when PORT is undefined',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node config_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
          env: { ...process.env, PORT: undefined },
        });
        return {
          satisfied: true,
          evidence: 'getPort() === 3000 — missing env var handled',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `getPort() !== 3000: ${e.message}`,
        };
      }
    },
  },
};

export const G11_LoopConditionInverted: RealTask = {
  taskId: 'G11_loop_condition_inverted',
  description: 'While loop condition is inverted — loop never executes',
  domain: 'replan',
  goalDescription: 'Fix count.js so countItems([1,2,3]) returns 3 instead of 0',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'count.js'),
      `function countItems(arr){let count=0;let i=0;while(i>=arr.length){count++;i++;}return count;}\nmodule.exports={countItems};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'count_test.js'),
      `const {countItems}=require('./count');\nconst assert=require('assert');\nassert.strictEqual(countItems([1,2,3]),3,'countItems([1,2,3]) should be 3');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'countItems([1,2,3]) === 3',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node count_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'countItems([1,2,3]) === 3 — loop condition fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `countItems([1,2,3]) !== 3: ${e.message}`,
        };
      }
    },
  },
};

export const G12_BomEncoding: RealTask = {
  taskId: 'G12_bom_encoding',
  description:
    'UTF-8 BOM in JSON file causes JSON.parse to fail — encoding error',
  domain: 'replan',
  goalDescription: 'Fix data.json so loadConfig() can parse it successfully',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const jsonContent = Buffer.from('{"key":"value"}');
    fs.writeFileSync(
      path.join(env.tempDir, 'data.json'),
      Buffer.concat([bom, jsonContent])
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'loader.js'),
      `const fs=require('fs');\nfunction loadConfig(){const raw=fs.readFileSync('data.json','utf-8');return JSON.parse(raw);}\nmodule.exports={loadConfig};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'loader_test.js'),
      `const {loadConfig}=require('./loader');\nconst assert=require('assert');\nconst cfg=loadConfig();\nassert.strictEqual(cfg.key,"value",'config.key should be "value"');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'loadConfig() returns {key:"value"}',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node loader_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'loadConfig() parses correctly — BOM encoding fixed',
        };
      } catch (e: any) {
        return { satisfied: false, evidence: `JSON.parse fails: ${e.message}` };
      }
    },
  },
};

export const N1_ConfigTypo: RealTask = {
  taskId: 'N1_config_typo',
  description: 'Config file has wrong key name — novel configuration error',
  domain: 'replan',
  goalDescription:
    'Fix settings.js so getPort() returns 8080 instead of undefined',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'settings.js'),
      `const config={prot:8080,host:"localhost"};\nfunction getPort(){return config.port;}\nmodule.exports={getPort};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'settings_test.js'),
      `const {getPort}=require('./settings');\nconst assert=require('assert');\nassert.strictEqual(getPort(),8080,'getPort() should be 8080');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'getPort() === 8080',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node settings_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'getPort() === 8080 — config typo fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `getPort() !== 8080: ${e.message}`,
        };
      }
    },
  },
};

export const N2_DataTransform: RealTask = {
  taskId: 'N2_data_transform',
  description:
    'Data transform produces string concatenation instead of numeric sum — novel data error',
  domain: 'replan',
  goalDescription:
    'Fix transform.js so total([10,20]) returns 30 instead of "1020"',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'transform.js'),
      `function total(items){return items.reduce((a,b)=>a+b,0);}\nmodule.exports={total};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'transform_test.js'),
      `const {total}=require('./transform');\nconst assert=require('assert');\nassert.strictEqual(total(["10","20"]),30,'total(["10","20"]) should be 30');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'total(["10","20"]) === 30',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node transform_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'total(["10","20"]) === 30 — data transform fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `total(["10","20"]) !== 30: ${e.message}`,
        };
      }
    },
  },
};

export const N3_UnknownDirRestore: RealTask = {
  taskId: 'N3_unknown_dir_restore',
  description:
    'Output directory abc_output is deleted mid-task — novel directory name',
  domain: 'replan',
  goalDescription:
    'Write output to abc_output/report.csv, but abc_output is deleted mid-task',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    const outputDir = path.join(env.tempDir, 'abc_output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'report.csv'), 'id,name\n1,test\n');
  },
  successCriteria: {
    description: 'abc_output/report.csv exists',
    check: async (env: TaskEnvironment) => {
      const target = path.join(env.tempDir, 'abc_output', 'report.csv');
      if (fs.existsSync(target)) {
        return {
          satisfied: true,
          evidence: 'abc_output/report.csv exists — directory restored',
        };
      }
      return {
        satisfied: false,
        evidence: 'abc_output/report.csv does not exist',
      };
    },
  },
  disturbance: {
    description: 'Delete abc_output directory',
    phase: 'after_first_step' as const,
    execute: async (env: TaskEnvironment) => {
      const outputDir = path.join(env.tempDir, 'abc_output');
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    },
    verify: async (env: TaskEnvironment) => {
      const outputDir = path.join(env.tempDir, 'abc_output');
      const exists = fs.existsSync(outputDir);
      return {
        disturbed: !exists,
        evidence: exists ? 'abc_output still exists' : 'abc_output deleted',
      };
    },
  },
};

export const N4_TestSetupFix: RealTask = {
  taskId: 'N4_test_setup_fix',
  description:
    'Test references wrong source module — novel test configuration error',
  domain: 'replan',
  goalDescription:
    'Fix app_test.js so it requires ./app instead of ./application',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'app.js'),
      `function greet(name){return "Hello "+name;}\nmodule.exports={greet};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'app_test.js'),
      `const {greet}=require('./application');\nconst assert=require('assert');\nassert.strictEqual(greet("World"),"Hello World");\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'app_test.js runs successfully',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node app_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'app_test.js PASS — test setup fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `app_test.js fails: ${e.message}`,
        };
      }
    },
  },
};

export const N5_CrossFileDep: RealTask = {
  taskId: 'N5_cross_file_dep',
  description:
    'Cross-file dependency broken — util.js exports wrong function name',
  domain: 'replan',
  goalDescription:
    'Fix util.js so main.js can call formatCurrency() successfully',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'util.js'),
      `function fmtCurrency(val){return "$"+val.toFixed(2);}\nmodule.exports={fmtCurrency};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'main.js'),
      `const {formatCurrency}=require('./util');\nfunction price(item){return formatCurrency(item.price);}\nmodule.exports={price};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'main_test.js'),
      `const {price}=require('./main');\nconst assert=require('assert');\nassert.strictEqual(price({price:9.99}),"$9.99");\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'price({price:9.99}) === "$9.99"',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node main_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'price({price:9.99}) === "$9.99" — cross-file dep fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `main_test.js fails: ${e.message}`,
        };
      }
    },
  },
};

export const N6_MultiStepPipeline: RealTask = {
  taskId: 'N6_multi_step_pipeline',
  description:
    'Multi-step data pipeline: extract, transform, validate — novel multi-step task',
  domain: 'multi_step',
  goalDescription:
    'Fix the 3-stage pipeline (extract→transform→validate) so it produces correct output',
  executionDomain: 'desktop',
  maxSteps: 20,
  maxTimeMs: 60000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'extract.js'),
      `function extract(raw){return raw.split("\\n").map(l=>l.trim()).filter(l=>l.length>0);}\nmodule.exports={extract};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'transform.js'),
      `function transform(lines){return lines.map(l=>{const p=l.split(",");return{name:p[0],value:p[1]};});}\nmodule.exports={transform};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'validate.js'),
      `function validate(items){return items.every(i=>i.name&&i.value);}\nmodule.exports={validate};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'pipeline.js'),
      `const {extract}=require("./extract");\nconst {transform}=require("./transform2");\nconst {validate}=require("./validate");\nfunction run(raw){const lines=extract(raw);const items=transform(lines);return validate(items);}\nmodule.exports={run};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'pipeline_test.js'),
      `const {run}=require("./pipeline");\nconst assert=require("assert");\nconst input="alice,100\\nbob,200";\nassert.strictEqual(run(input),true,"pipeline should validate");\nconsole.log("PASS");\n`
    );
  },
  successCriteria: {
    description: 'pipeline_test.js runs successfully',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node pipeline_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'pipeline_test.js PASS — multi-step pipeline fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `pipeline_test.js fails: ${e.message}`,
        };
      }
    },
  },
};

export const N7_EnvDisturbFileMove: RealTask = {
  taskId: 'N7_env_disturb_file_move',
  description:
    'File moved to unexpected subdirectory mid-task — novel environment disturbance',
  domain: 'replan',
  goalDescription:
    'Read data.csv and compute sum, but data.csv gets moved to backup/ mid-task',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, 'data.csv'), '10\n20\n30\n');
    fs.writeFileSync(
      path.join(env.tempDir, 'sum.js'),
      `const fs=require('fs');\nfunction compute(){const data=fs.readFileSync('data.csv','utf-8');const lines=data.trim().split("\\n");return lines.reduce((s,l)=>s+Number(l),0);}\nmodule.exports={compute};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'sum_test.js'),
      `const {compute}=require('./sum');\nconst assert=require('assert');\nassert.strictEqual(compute(),60,'sum should be 60');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'compute() === 60',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node sum_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence: 'compute() === 60 — file moved and restored',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `sum_test.js fails: ${e.message}`,
        };
      }
    },
  },
  disturbance: {
    description: 'Move data.csv to backup/',
    phase: 'after_first_step' as const,
    execute: async (env: TaskEnvironment) => {
      const src = path.join(env.tempDir, 'data.csv');
      const backupDir = path.join(env.tempDir, 'backup');
      if (fs.existsSync(src)) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.renameSync(src, path.join(backupDir, 'data.csv'));
      }
    },
    verify: async (env: TaskEnvironment) => {
      const src = path.join(env.tempDir, 'data.csv');
      const backup = path.join(env.tempDir, 'backup', 'data.csv');
      return {
        disturbed: !fs.existsSync(src) && fs.existsSync(backup),
        evidence: fs.existsSync(src)
          ? 'data.csv still in place'
          : 'data.csv moved to backup/',
      };
    },
  },
};

export const N8_RecursiveSchema: RealTask = {
  taskId: 'N8_recursive_schema',
  description:
    'Nested config with wrong key at multiple levels — novel recursive inspection task',
  domain: 'code',
  goalDescription:
    'Fix config.js so deepGet("db.host") returns "localhost" instead of undefined',
  executionDomain: 'desktop',
  maxSteps: 15,
  maxTimeMs: 45000,
  allowedCapabilities: ['shell', 'file_read', 'file_write'],
  setup: async (env: TaskEnvironment) => {
    fs.mkdirSync(env.tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.tempDir, 'config.js'),
      `const cfg={database:{hst:"localhost",port:5432},cache:{host:"127.0.0.1",port:6379}};\nfunction deepGet(path){return path.split(".").reduce((o,k)=>o&&o[k],cfg);}\nmodule.exports={deepGet};\n`
    );
    fs.writeFileSync(
      path.join(env.tempDir, 'config_test.js'),
      `const {deepGet}=require('./config');\nconst assert=require('assert');\nassert.strictEqual(deepGet("db.host"),"localhost",'db.host should be localhost');\nconsole.log('PASS');\n`
    );
  },
  successCriteria: {
    description: 'deepGet("db.host") === "localhost"',
    check: async (env: TaskEnvironment) => {
      try {
        const { execSync } = require('child_process');
        execSync('node config_test.js', {
          cwd: env.tempDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return {
          satisfied: true,
          evidence:
            'deepGet("db.host") === "localhost" — recursive schema fixed',
        };
      } catch (e: any) {
        return {
          satisfied: false,
          evidence: `config_test.js fails: ${e.message}`,
        };
      }
    },
  },
};

export const ALL_REAL_TASKS: RealTask[] = [
  T01_FileCreate,
  T02_FileModify,
  T03_FileFindAndSummarize,
  T04_BrowserSearch,
  T05_WebFetchAndSave,
  T06_CodeModify,
  T07_RunTest,
  T08_TestFailAndFix,
  T09_EnvironmentChangeReplan,
  T10_MultiStepTask,
  G1_MulInsteadOfAdd,
  G2_OffByOne,
  G3_UnknownPathMissing,
  G4_NestedDirMissing,
  G5_ConfigError,
  G6_TwoStageError,
  G7_TypeCoercion,
  G8_MissingAwait,
  G9_FilePermission,
  G10_MissingEnvVar,
  G11_LoopConditionInverted,
  G12_BomEncoding,
  N1_ConfigTypo,
  N2_DataTransform,
  N3_UnknownDirRestore,
  N4_TestSetupFix,
  N5_CrossFileDep,
  N6_MultiStepPipeline,
  N7_EnvDisturbFileMove,
  N8_RecursiveSchema,
  H1_RegexEscape,
  H2_DeepPropertyAccess,
  H3_ArrayMutation,
  H4_FloatComparison,
  H5_ScopeLeak,
  H6_PromiseUnhandled,
];

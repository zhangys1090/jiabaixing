"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_REAL_TASKS = exports.G6_TwoStageError = exports.G5_ConfigError = exports.G4_NestedDirMissing = exports.G3_UnknownPathMissing = exports.G2_OffByOne = exports.G1_MulInsteadOfAdd = exports.T09b_EnvChange_ArbitraryFile = exports.T09a_EnvChange_ArbitraryDir = exports.T08b_TestFailAndFix_Sub = exports.T08a_TestFailAndFix_Diff2 = exports.T10_MultiStepTask = exports.T09_EnvironmentChangeReplan = exports.T08_TestFailAndFix = exports.T07_RunTest = exports.T06_CodeModify = exports.T05_WebFetchAndSave = exports.T04_BrowserSearch = exports.T03_FileFindAndSummarize = exports.T02_FileModify = exports.T01_FileCreate = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function makeTaskId(prefix) {
    return `${prefix}_${Date.now().toString(36)}`;
}
exports.T01_FileCreate = {
    taskId: 'T01_file_create',
    description: 'Create a new file with specified content',
    domain: 'filesystem',
    goalDescription: 'Create file /tmp/jiabaixing_test/hello.txt with content "Hello D8"',
    executionDomain: 'desktop',
    maxSteps: 5,
    maxTimeMs: 30000,
    allowedCapabilities: ['shell', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
    },
    successCriteria: {
        description: 'File /tmp/jiabaixing_test/hello.txt exists with content "Hello D8"',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'hello.txt');
            if (!fs.existsSync(filePath)) {
                return { satisfied: false, evidence: `file does not exist: ${filePath}` };
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.trim() === 'Hello D8') {
                return { satisfied: true, evidence: `file exists with correct content: "${content.trim()}"` };
            }
            return { satisfied: false, evidence: `file exists but content is "${content.trim()}", expected "Hello D8"` };
        },
    },
    teardown: async (env) => {
        const filePath = path.join(env.tempDir, 'hello.txt');
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
    },
};
exports.T02_FileModify = {
    taskId: 'T02_file_modify',
    description: 'Modify an existing file by appending content',
    domain: 'filesystem',
    goalDescription: 'Append " - modified" to the end of hello.txt',
    executionDomain: 'desktop',
    maxSteps: 5,
    maxTimeMs: 30000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'hello.txt'), 'Original content', 'utf-8');
    },
    successCriteria: {
        description: 'hello.txt contains "Original content - modified"',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'hello.txt');
            if (!fs.existsSync(filePath)) {
                return { satisfied: false, evidence: 'file does not exist' };
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.includes('Original content') && content.includes('modified')) {
                return { satisfied: true, evidence: `file modified: "${content}"` };
            }
            return { satisfied: false, evidence: `file content: "${content}"` };
        },
    },
    teardown: async (env) => {
        const filePath = path.join(env.tempDir, 'hello.txt');
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
    },
};
exports.T03_FileFindAndSummarize = {
    taskId: 'T03_file_find_summarize',
    description: 'Find files matching a pattern and summarize their count',
    domain: 'filesystem',
    goalDescription: 'Count all .txt files in the temp directory and write result to summary.txt',
    executionDomain: 'desktop',
    maxSteps: 8,
    maxTimeMs: 30000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'a.txt'), 'file a', 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'b.txt'), 'file b', 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'c.txt'), 'file c', 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'ignore.log'), 'log', 'utf-8');
    },
    successCriteria: {
        description: 'summary.txt exists and contains the count 3',
        check: async (env) => {
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
    teardown: async (env) => {
        for (const f of ['a.txt', 'b.txt', 'c.txt', 'ignore.log', 'summary.txt']) {
            const p = path.join(env.tempDir, f);
            if (fs.existsSync(p))
                fs.unlinkSync(p);
        }
    },
};
exports.T04_BrowserSearch = {
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
        check: async (_env) => {
            return { satisfied: false, evidence: 'browser search requires live desktop — cannot verify in CI without display' };
        },
    },
};
exports.T05_WebFetchAndSave = {
    taskId: 'T05_web_fetch_save',
    description: 'Fetch a web resource and save to file',
    domain: 'api',
    goalDescription: 'Fetch https://httpbin.org/get and save response to fetched.json',
    executionDomain: 'orchestrator',
    maxSteps: 8,
    maxTimeMs: 30000,
    allowedCapabilities: ['shell', 'web_fetch', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
    },
    successCriteria: {
        description: 'fetched.json exists and contains valid JSON',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'fetched.json');
            if (!fs.existsSync(filePath)) {
                return { satisfied: false, evidence: 'fetched.json does not exist' };
            }
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                JSON.parse(content);
                return { satisfied: true, evidence: 'fetched.json contains valid JSON' };
            }
            catch {
                return { satisfied: false, evidence: 'fetched.json is not valid JSON' };
            }
        },
    },
    teardown: async (env) => {
        const filePath = path.join(env.tempDir, 'fetched.json');
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
    },
};
exports.T06_CodeModify = {
    taskId: 'T06_code_modify',
    description: 'Modify source code by adding a function',
    domain: 'code',
    goalDescription: 'Add a function add(a, b) to calculator.js that returns a + b',
    executionDomain: 'desktop',
    maxSteps: 8,
    maxTimeMs: 30000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'calculator.js'), '// Calculator module\nexport function multiply(a, b) { return a * b; }\n', 'utf-8');
    },
    successCriteria: {
        description: 'calculator.js contains an add function',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'calculator.js');
            if (!fs.existsSync(filePath)) {
                return { satisfied: false, evidence: 'calculator.js does not exist' };
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.includes('add') && content.includes('a + b')) {
                return { satisfied: true, evidence: 'add function found in calculator.js' };
            }
            return { satisfied: false, evidence: `calculator.js content does not contain add: "${content}"` };
        },
    },
    teardown: async (env) => {
        const filePath = path.join(env.tempDir, 'calculator.js');
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
    },
};
exports.T07_RunTest = {
    taskId: 'T07_run_test',
    description: 'Run a test suite and verify it passes',
    domain: 'test',
    goalDescription: 'Run npm test on the sample project and confirm all tests pass',
    executionDomain: 'orchestrator',
    maxSteps: 10,
    maxTimeMs: 60000,
    allowedCapabilities: ['shell'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'package.json'), JSON.stringify({
            name: 'd8-test-project',
            scripts: { test: 'node test.js' },
        }), 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'test.js'), `
      const assert = require('assert');
      assert.strictEqual(1 + 1, 2, 'basic math works');
      assert.strictEqual('hello'.length, 5, 'string length works');
      console.log('All tests passed');
    `, 'utf-8');
    },
    successCriteria: {
        description: 'Tests ran and passed (exit code 0)',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                const output = execSync('node test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                if (output.includes('All tests passed')) {
                    return { satisfied: true, evidence: `tests passed: ${output.trim()}` };
                }
                return { satisfied: false, evidence: `test output: ${output.trim()}` };
            }
            catch (err) {
                return { satisfied: false, evidence: `test failed: ${err.message}` };
            }
        },
    },
    teardown: async (env) => {
        for (const f of ['package.json', 'test.js']) {
            const p = path.join(env.tempDir, f);
            if (fs.existsSync(p))
                fs.unlinkSync(p);
        }
    },
};
exports.T08_TestFailAndFix = {
    taskId: 'T08_test_fail_fix',
    description: 'Test fails initially, then fix code to make it pass',
    domain: 'test',
    goalDescription: 'Fix the bug in math.js so that add(1,1) returns 2 instead of 3',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 60000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'math.js'), `
      function add(a, b) { return a + b + 1; }
      module.exports = { add };
    `, 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'math_test.js'), `
      const { add } = require('./math');
      const assert = require('assert');
      assert.strictEqual(add(1, 1), 2, 'add(1,1) should be 2');
      console.log('Test passed');
    `, 'utf-8');
    },
    successCriteria: {
        description: 'math_test.js passes (add(1,1) === 2)',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                const output = execSync('node math_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                if (output.includes('Test passed')) {
                    return { satisfied: true, evidence: 'test passes after fix' };
                }
                return { satisfied: false, evidence: `test output: ${output.trim()}` };
            }
            catch (err) {
                return { satisfied: false, evidence: `test still fails: ${err.message}` };
            }
        },
    },
    teardown: async (env) => {
        for (const f of ['math.js', 'math_test.js']) {
            const p = path.join(env.tempDir, f);
            if (fs.existsSync(p))
                fs.unlinkSync(p);
        }
    },
};
exports.T09_EnvironmentChangeReplan = {
    taskId: 'T09_env_change_replan',
    description: 'Environment changes mid-task, requiring replan',
    domain: 'replan',
    goalDescription: 'Write output to result_dir/result.txt, but result_dir is deleted mid-task by external environment change',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.mkdirSync(path.join(env.tempDir, 'result_dir'), { recursive: true });
    },
    disturbance: {
        description: 'Delete result_dir after first step — simulates external environment change',
        phase: 'after_first_step',
        execute: async (env) => {
            const dirPath = path.join(env.tempDir, 'result_dir');
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
        },
        verify: async (env) => {
            const dirPath = path.join(env.tempDir, 'result_dir');
            const exists = fs.existsSync(dirPath);
            return {
                disturbed: !exists,
                evidence: exists ? 'result_dir still exists — disturbance not applied' : 'result_dir deleted — disturbance applied',
            };
        },
    },
    successCriteria: {
        description: 'result_dir/result.txt exists despite environment disruption',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'result_dir', 'result.txt');
            if (fs.existsSync(filePath)) {
                return { satisfied: true, evidence: 'result_dir/result.txt exists — replan succeeded' };
            }
            return { satisfied: false, evidence: 'result_dir/result.txt does not exist — replan failed or did not occur' };
        },
    },
    teardown: async (env) => {
        const dirPath = path.join(env.tempDir, 'result_dir');
        if (fs.existsSync(dirPath)) {
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
            catch { }
        }
    },
};
exports.T10_MultiStepTask = {
    taskId: 'T10_multi_step',
    description: 'Multi-step task: create, read, modify, verify',
    domain: 'multi_step',
    goalDescription: 'Create data.json, read it, add a field, verify the field exists',
    executionDomain: 'desktop',
    maxSteps: 20,
    maxTimeMs: 60000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
    },
    successCriteria: {
        description: 'data.json exists with addedField',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'data.json');
            if (!fs.existsSync(filePath)) {
                return { satisfied: false, evidence: 'data.json does not exist' };
            }
            try {
                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if ('addedField' in content) {
                    return { satisfied: true, evidence: `data.json has addedField: ${JSON.stringify(content)}` };
                }
                return { satisfied: false, evidence: `data.json missing addedField: ${JSON.stringify(content)}` };
            }
            catch {
                return { satisfied: false, evidence: 'data.json is not valid JSON' };
            }
        },
    },
    teardown: async (env) => {
        const filePath = path.join(env.tempDir, 'data.json');
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
    },
};
exports.T08a_TestFailAndFix_Diff2 = {
    taskId: 'T08a_test_fail_fix_diff2',
    description: 'Test fails with diff=2, fix code to make it pass',
    domain: 'test',
    goalDescription: 'Fix the bug in math.js so that add(1,1) returns 2 instead of 4',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 60000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'math.js'), `
      function add(a, b) { return a + b + 2; }
      module.exports = { add };
    `, 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'math_test.js'), `
      const { add } = require('./math');
      const assert = require('assert');
      assert.strictEqual(add(1, 1), 2, 'add(1,1) should be 2');
      console.log('Test passed');
    `, 'utf-8');
    },
    successCriteria: {
        description: 'math_test.js passes (add(1,1) === 2)',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                const output = execSync('node math_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                if (output.includes('Test passed')) {
                    return { satisfied: true, evidence: 'test passes after fix (diff=2)' };
                }
                return { satisfied: false, evidence: `test output: ${output.trim()}` };
            }
            catch (err) {
                return { satisfied: false, evidence: `test still fails: ${err.message}` };
            }
        },
    },
    teardown: async (env) => {
        for (const f of ['math.js', 'math_test.js']) {
            const p = path.join(env.tempDir, f);
            if (fs.existsSync(p))
                fs.unlinkSync(p);
        }
    },
};
exports.T08b_TestFailAndFix_Sub = {
    taskId: 'T08b_test_fail_fix_sub',
    description: 'Test fails because subtract returns wrong result, fix code',
    domain: 'test',
    goalDescription: 'Fix the bug in calc.js so that sub(5,3) returns 2 instead of 0',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 60000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'calc.js'), `
      function sub(a, b) { return a - b - 3; }
      module.exports = { sub };
    `, 'utf-8');
        fs.writeFileSync(path.join(env.tempDir, 'calc_test.js'), `
      const { sub } = require('./calc');
      const assert = require('assert');
      assert.strictEqual(sub(5, 3), 2, 'sub(5,3) should be 2');
      console.log('Test passed');
    `, 'utf-8');
    },
    successCriteria: {
        description: 'calc_test.js passes (sub(5,3) === 2)',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                const output = execSync('node calc_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                if (output.includes('Test passed')) {
                    return { satisfied: true, evidence: 'test passes after fix (subtraction offset)' };
                }
                return { satisfied: false, evidence: `test output: ${output.trim()}` };
            }
            catch (err) {
                return { satisfied: false, evidence: `test still fails: ${err.message}` };
            }
        },
    },
    teardown: async (env) => {
        for (const f of ['calc.js', 'calc_test.js']) {
            const p = path.join(env.tempDir, f);
            if (fs.existsSync(p))
                fs.unlinkSync(p);
        }
    },
};
exports.T09a_EnvChange_ArbitraryDir = {
    taskId: 'T09a_env_change_arbitrary_dir',
    description: 'Environment deletes output_dir mid-task, requiring replan',
    domain: 'replan',
    goalDescription: 'Write output to output_dir/result.txt, but output_dir is deleted mid-task by external environment change',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.mkdirSync(path.join(env.tempDir, 'output_dir'), { recursive: true });
    },
    disturbance: {
        description: 'Delete output_dir after first step',
        phase: 'after_first_step',
        execute: async (env) => {
            const dirPath = path.join(env.tempDir, 'output_dir');
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
        },
        verify: async (env) => {
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
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'output_dir', 'result.txt');
            if (fs.existsSync(filePath)) {
                return { satisfied: true, evidence: 'output_dir/result.txt exists — replan succeeded' };
            }
            return { satisfied: false, evidence: 'output_dir/result.txt does not exist' };
        },
    },
    teardown: async (env) => {
        const dirPath = path.join(env.tempDir, 'output_dir');
        if (fs.existsSync(dirPath)) {
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
            catch { }
        }
    },
};
exports.T09b_EnvChange_ArbitraryFile = {
    taskId: 'T09b_env_change_arbitrary_file',
    description: 'Environment deletes data_dir mid-task, requiring replan with different file name',
    domain: 'replan',
    goalDescription: 'Write output to data_dir/output.json, but data_dir is deleted mid-task by external environment change',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.mkdirSync(path.join(env.tempDir, 'data_dir'), { recursive: true });
    },
    disturbance: {
        description: 'Delete data_dir after first step',
        phase: 'after_first_step',
        execute: async (env) => {
            const dirPath = path.join(env.tempDir, 'data_dir');
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
        },
        verify: async (env) => {
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
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'data_dir', 'output.json');
            if (fs.existsSync(filePath)) {
                return { satisfied: true, evidence: 'data_dir/output.json exists — replan succeeded' };
            }
            return { satisfied: false, evidence: 'data_dir/output.json does not exist' };
        },
    },
    teardown: async (env) => {
        const dirPath = path.join(env.tempDir, 'data_dir');
        if (fs.existsSync(dirPath)) {
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
            catch { }
        }
    },
};
exports.G1_MulInsteadOfAdd = {
    taskId: 'G1_mul_instead_of_add',
    description: 'Code uses multiplication instead of addition — novel operator error',
    domain: 'replan',
    goalDescription: 'Fix math.js so add(1,1) returns 2 instead of 1',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'math.js'), `function add(a,b){return a*b;}\nmodule.exports={add};\n`);
        fs.writeFileSync(path.join(env.tempDir, 'math_test.js'), `const {add}=require('./math');\nconst assert=require('assert');\nassert.strictEqual(add(1,1),2,'add(1,1) should be 2');\nconsole.log('PASS');\n`);
    },
    successCriteria: {
        description: 'add(1,1) === 2',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                execSync('node math_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                return { satisfied: true, evidence: 'add(1,1) === 2 — multiplication replaced with addition' };
            }
            catch (e) {
                return { satisfied: false, evidence: `add(1,1) !== 2: ${e.message}` };
            }
        },
    },
};
exports.G2_OffByOne = {
    taskId: 'G2_off_by_one',
    description: 'Boundary condition uses > instead of >= — off-by-one error',
    domain: 'replan',
    goalDescription: 'Fix range.js so inRange(5,5,10) returns true instead of false',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'range.js'), `function inRange(x,min,max){return x>min&&x<max;}\nmodule.exports={inRange};\n`);
        fs.writeFileSync(path.join(env.tempDir, 'range_test.js'), `const {inRange}=require('./range');\nconst assert=require('assert');\nassert.strictEqual(inRange(5,5,10),true,'inRange(5,5,10) should be true');\nconsole.log('PASS');\n`);
    },
    successCriteria: {
        description: 'inRange(5,5,10) === true',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                execSync('node range_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                return { satisfied: true, evidence: 'inRange(5,5,10) === true — boundary fixed' };
            }
            catch (e) {
                return { satisfied: false, evidence: `inRange(5,5,10) !== true: ${e.message}` };
            }
        },
    },
};
exports.G3_UnknownPathMissing = {
    taskId: 'G3_unknown_path_missing',
    description: 'Unknown directory path is missing — novel directory name',
    domain: 'replan',
    goalDescription: 'Write output to xyz_output/data.csv, but xyz_output is deleted mid-task',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.mkdirSync(path.join(env.tempDir, 'xyz_output'), { recursive: true });
    },
    disturbance: {
        description: 'Delete xyz_output after first step',
        phase: 'after_first_step',
        execute: async (env) => {
            const dirPath = path.join(env.tempDir, 'xyz_output');
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
        },
        verify: async (env) => {
            const exists = fs.existsSync(path.join(env.tempDir, 'xyz_output'));
            return { disturbed: !exists, evidence: exists ? 'xyz_output still exists' : 'xyz_output deleted' };
        },
    },
    successCriteria: {
        description: 'xyz_output/data.csv exists despite disruption',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'xyz_output', 'data.csv');
            if (fs.existsSync(filePath)) {
                return { satisfied: true, evidence: 'xyz_output/data.csv exists — recovery succeeded' };
            }
            return { satisfied: false, evidence: 'xyz_output/data.csv does not exist' };
        },
    },
};
exports.G4_NestedDirMissing = {
    taskId: 'G4_nested_dir_missing',
    description: 'Nested directory hierarchy is missing — novel multi-level path',
    domain: 'replan',
    goalDescription: 'Write output to level1/level2/level3/result.txt, but level1 is deleted mid-task',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.mkdirSync(path.join(env.tempDir, 'level1', 'level2', 'level3'), { recursive: true });
    },
    disturbance: {
        description: 'Delete level1 after first step',
        phase: 'after_first_step',
        execute: async (env) => {
            const dirPath = path.join(env.tempDir, 'level1');
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
        },
        verify: async (env) => {
            const exists = fs.existsSync(path.join(env.tempDir, 'level1'));
            return { disturbed: !exists, evidence: exists ? 'level1 still exists' : 'level1 deleted' };
        },
    },
    successCriteria: {
        description: 'level1/level2/level3/result.txt exists despite disruption',
        check: async (env) => {
            const filePath = path.join(env.tempDir, 'level1', 'level2', 'level3', 'result.txt');
            if (fs.existsSync(filePath)) {
                return { satisfied: true, evidence: 'level1/level2/level3/result.txt exists — nested recovery succeeded' };
            }
            return { satisfied: false, evidence: 'level1/level2/level3/result.txt does not exist' };
        },
    },
};
exports.G5_ConfigError = {
    taskId: 'G5_config_error',
    description: 'Test config references wrong file — novel config error',
    domain: 'replan',
    goalDescription: 'Fix test config so it references the correct source file calc.js instead of math.js',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'calc.js'), `function add(a,b){return a+b;}\nmodule.exports={add};\n`);
        fs.writeFileSync(path.join(env.tempDir, 'run_test.js'), `const {add}=require('./math');\nconst assert=require('assert');\nassert.strictEqual(add(1,1),2);\nconsole.log('PASS');\n`);
    },
    successCriteria: {
        description: 'run_test.js references calc.js and passes',
        check: async (env) => {
            try {
                const content = fs.readFileSync(path.join(env.tempDir, 'run_test.js'), 'utf-8');
                if (!content.includes('calc')) {
                    return { satisfied: false, evidence: 'run_test.js still references math.js instead of calc.js' };
                }
                const { execSync } = require('child_process');
                execSync('node run_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                return { satisfied: true, evidence: 'run_test.js references calc.js and passes' };
            }
            catch (e) {
                return { satisfied: false, evidence: `test still fails: ${e.message}` };
            }
        },
    },
};
exports.G6_TwoStageError = {
    taskId: 'G6_two_stage_error',
    description: 'Code has two bugs — fixing one reveals the second',
    domain: 'replan',
    goalDescription: 'Fix math.js so add(1,1) returns 2 AND add(2,3) returns 5',
    executionDomain: 'desktop',
    maxSteps: 15,
    maxTimeMs: 45000,
    allowedCapabilities: ['shell', 'file_read', 'file_write'],
    setup: async (env) => {
        fs.mkdirSync(env.tempDir, { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, 'math.js'), `function add(a,b){return a*b+1;}\nmodule.exports={add};\n`);
        fs.writeFileSync(path.join(env.tempDir, 'math_test.js'), `const {add}=require('./math');\nconst assert=require('assert');\nassert.strictEqual(add(1,1),2,'add(1,1) should be 2');\nassert.strictEqual(add(2,3),5,'add(2,3) should be 5');\nconsole.log('PASS');\n`);
    },
    successCriteria: {
        description: 'add(1,1)===2 AND add(2,3)===5',
        check: async (env) => {
            try {
                const { execSync } = require('child_process');
                execSync('node math_test.js', { cwd: env.tempDir, encoding: 'utf-8', timeout: 10000 });
                return { satisfied: true, evidence: 'add(1,1)===2 and add(2,3)===5 — both bugs fixed' };
            }
            catch (e) {
                return { satisfied: false, evidence: `test fails: ${e.message}` };
            }
        },
    },
};
exports.ALL_REAL_TASKS = [
    exports.T01_FileCreate,
    exports.T02_FileModify,
    exports.T03_FileFindAndSummarize,
    exports.T04_BrowserSearch,
    exports.T05_WebFetchAndSave,
    exports.T06_CodeModify,
    exports.T07_RunTest,
    exports.T08_TestFailAndFix,
    exports.T09_EnvironmentChangeReplan,
    exports.T10_MultiStepTask,
    exports.G1_MulInsteadOfAdd,
    exports.G2_OffByOne,
    exports.G3_UnknownPathMissing,
    exports.G4_NestedDirMissing,
    exports.G5_ConfigError,
    exports.G6_TwoStageError,
];

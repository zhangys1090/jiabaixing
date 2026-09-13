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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const RealTaskHarness_1 = require("../../harness/realTask/RealTaskHarness");
const RealTasks_1 = require("../../harness/realTask/RealTasks");
describe('D8-0: Real Task Harness', () => {
    describe('Harness infrastructure', () => {
        test('creates and cleans up temp environment', async () => {
            const harness = new RealTaskHarness_1.RealTaskHarness();
            const task = {
                taskId: 'test_env',
                description: 'env test',
                domain: 'filesystem',
                goalDescription: 'test env',
                executionDomain: 'desktop',
                maxSteps: 1,
                maxTimeMs: 5000,
                allowedCapabilities: [],
                setup: async (env) => {
                    expect(fs.existsSync(env.tempDir)).toBe(true);
                    fs.writeFileSync(path.join(env.tempDir, 'marker.txt'), 'ok', 'utf-8');
                },
                successCriteria: {
                    description: 'marker exists',
                    check: async (env) => {
                        const exists = fs.existsSync(path.join(env.tempDir, 'marker.txt'));
                        return { satisfied: exists, evidence: exists ? 'marker found' : 'marker missing' };
                    },
                },
                teardown: async (env) => {
                    const p = path.join(env.tempDir, 'marker.txt');
                    if (fs.existsSync(p))
                        fs.unlinkSync(p);
                },
            };
            const result = await harness.runTask(task);
            expect(result.taskId).toBe('test_env');
            expect(result.externallyVerified).toBe(true);
        });
        test('reports false completion when task not actually done', async () => {
            const harness = new RealTaskHarness_1.RealTaskHarness();
            const task = {
                taskId: 'false_complete',
                description: 'impossible task',
                domain: 'filesystem',
                goalDescription: 'create a file that does not exist',
                executionDomain: 'desktop',
                maxSteps: 1,
                maxTimeMs: 3000,
                allowedCapabilities: [],
                successCriteria: {
                    description: 'nonexistent file exists',
                    check: async (env) => {
                        return { satisfied: false, evidence: 'file does not exist' };
                    },
                },
            };
            const result = await harness.runTask(task);
            expect(result.externallyVerified).toBe(false);
        });
        test('metrics compute correctly for mixed results', async () => {
            const harness = new RealTaskHarness_1.RealTaskHarness();
            const tasks = [
                {
                    taskId: 'pass_1', description: 'pass', domain: 'filesystem',
                    goalDescription: 'pass', executionDomain: 'desktop', maxSteps: 1, maxTimeMs: 3000,
                    allowedCapabilities: [],
                    successCriteria: { description: 'always pass', check: async () => ({ satisfied: true, evidence: 'ok' }) },
                },
                {
                    taskId: 'fail_1', description: 'fail', domain: 'filesystem',
                    goalDescription: 'fail', executionDomain: 'desktop', maxSteps: 1, maxTimeMs: 3000,
                    allowedCapabilities: [],
                    successCriteria: { description: 'always fail', check: async () => ({ satisfied: false, evidence: 'no' }) },
                },
            ];
            const report = await harness.runAll(tasks);
            expect(report.metrics.totalTasks).toBe(2);
            expect(report.metrics.externallyVerified).toBe(1);
        });
    });
    describe('Task definitions', () => {
        test('ALL_REAL_TASKS has 10 tasks', () => {
            expect(RealTasks_1.ALL_REAL_TASKS.length).toBe(10);
        });
        test('all tasks have unique IDs', () => {
            const ids = RealTasks_1.ALL_REAL_TASKS.map(t => t.taskId);
            expect(new Set(ids).size).toBe(ids.length);
        });
        test('all tasks cover required domains', () => {
            const domains = new Set(RealTasks_1.ALL_REAL_TASKS.map(t => t.domain));
            expect(domains.has('filesystem')).toBe(true);
            expect(domains.has('browser')).toBe(true);
            expect(domains.has('code')).toBe(true);
            expect(domains.has('test')).toBe(true);
            expect(domains.has('multi_step')).toBe(true);
            expect(domains.has('replan')).toBe(true);
        });
        test('all tasks have successCriteria with check function', () => {
            for (const task of RealTasks_1.ALL_REAL_TASKS) {
                expect(typeof task.successCriteria.check).toBe('function');
                expect(task.successCriteria.description.length).toBeGreaterThan(0);
            }
        });
    });
    describe('External verification (filesystem)', () => {
        test('T01: file create — external verification works', async () => {
            const tempDir = path.join(os.tmpdir(), `d8_t01_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            try {
                if (RealTasks_1.T01_FileCreate.setup)
                    await RealTasks_1.T01_FileCreate.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Hello D8', 'utf-8');
                const check = await RealTasks_1.T01_FileCreate.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                expect(check.satisfied).toBe(true);
                expect(check.evidence).toContain('Hello D8');
            }
            finally {
                if (RealTasks_1.T01_FileCreate.teardown)
                    await RealTasks_1.T01_FileCreate.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
                catch { }
            }
        });
        test('T02: file modify — external verification works', async () => {
            const tempDir = path.join(os.tmpdir(), `d8_t02_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            try {
                if (RealTasks_1.T02_FileModify.setup)
                    await RealTasks_1.T02_FileModify.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                const filePath = path.join(tempDir, 'hello.txt');
                fs.writeFileSync(filePath, 'Original content - modified', 'utf-8');
                const check = await RealTasks_1.T02_FileModify.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                expect(check.satisfied).toBe(true);
            }
            finally {
                if (RealTasks_1.T02_FileModify.teardown)
                    await RealTasks_1.T02_FileModify.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
                catch { }
            }
        });
        test('T06: code modify — external verification works', async () => {
            const tempDir = path.join(os.tmpdir(), `d8_t06_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            try {
                if (RealTasks_1.T06_CodeModify.setup)
                    await RealTasks_1.T06_CodeModify.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                const filePath = path.join(tempDir, 'calculator.js');
                const content = fs.readFileSync(filePath, 'utf-8');
                const newContent = content + '\nexport function add(a, b) { return a + b; }\n';
                fs.writeFileSync(filePath, newContent, 'utf-8');
                const check = await RealTasks_1.T06_CodeModify.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                expect(check.satisfied).toBe(true);
            }
            finally {
                if (RealTasks_1.T06_CodeModify.teardown)
                    await RealTasks_1.T06_CodeModify.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
                catch { }
            }
        });
        test('T07: run test — external verification works', async () => {
            const tempDir = path.join(os.tmpdir(), `d8_t07_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            try {
                if (RealTasks_1.T07_RunTest.setup)
                    await RealTasks_1.T07_RunTest.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                const check = await RealTasks_1.T07_RunTest.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                expect(check.satisfied).toBe(true);
            }
            finally {
                if (RealTasks_1.T07_RunTest.teardown)
                    await RealTasks_1.T07_RunTest.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
                catch { }
            }
        });
        test('T08: test fail and fix — verification detects unfixed bug', async () => {
            const tempDir = path.join(os.tmpdir(), `d8_t08_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            try {
                if (RealTasks_1.T08_TestFailAndFix.setup)
                    await RealTasks_1.T08_TestFailAndFix.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                const checkBefore = await RealTasks_1.T08_TestFailAndFix.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                expect(checkBefore.satisfied).toBe(false);
                const mathPath = path.join(tempDir, 'math.js');
                fs.writeFileSync(mathPath, `
          function add(a, b) { return a + b; }
          module.exports = { add };
        `, 'utf-8');
                const checkAfter = await RealTasks_1.T08_TestFailAndFix.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                expect(checkAfter.satisfied).toBe(true);
            }
            finally {
                if (RealTasks_1.T08_TestFailAndFix.teardown)
                    await RealTasks_1.T08_TestFailAndFix.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} });
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
                catch { }
            }
        });
    });
    describe('Metrics', () => {
        test('falseCompletionRate = 0 when all declared completions are verified', () => {
            const results = [
                { taskId: 'a', domain: 'filesystem', declaredCompleted: true, externallyVerified: true, verificationEvidence: '', evidenceChain: {}, steps: [], totalTimeMs: 100, error: null },
                { taskId: 'b', domain: 'filesystem', declaredCompleted: true, externallyVerified: true, verificationEvidence: '', evidenceChain: {}, steps: [], totalTimeMs: 100, error: null },
            ];
            const declared = results.filter(r => r.declaredCompleted).length;
            const verified = results.filter(r => r.externallyVerified).length;
            const falseCompletions = results.filter(r => r.declaredCompleted && !r.externallyVerified).length;
            const falseRate = declared > 0 ? falseCompletions / declared : 0;
            expect(falseRate).toBe(0);
            expect(verified / declared).toBe(1);
        });
        test('falseCompletionRate > 0 when some declared completions are not verified', () => {
            const results = [
                { taskId: 'a', domain: 'filesystem', declaredCompleted: true, externallyVerified: true, verificationEvidence: '', evidenceChain: {}, steps: [], totalTimeMs: 100, error: null },
                { taskId: 'b', domain: 'filesystem', declaredCompleted: true, externallyVerified: false, verificationEvidence: '', evidenceChain: {}, steps: [], totalTimeMs: 100, error: null },
            ];
            const declared = results.filter(r => r.declaredCompleted).length;
            const falseCompletions = results.filter(r => r.declaredCompleted && !r.externallyVerified).length;
            const falseRate = declared > 0 ? falseCompletions / declared : 0;
            expect(falseRate).toBe(0.5);
        });
    });
});

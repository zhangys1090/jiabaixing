import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RealTaskHarness } from '../../harness/realTask/RealTaskHarness';
import {
  T01_FileCreate as T01,
  T02_FileModify as T02,
  T03_FileFindAndSummarize as T03,
  T06_CodeModify as T06,
  T07_RunTest as T07,
  T08_TestFailAndFix as T08,
  T10_MultiStepTask as T10,
  ALL_REAL_TASKS,
} from '../../harness/realTask/RealTasks';
import type { RealTask, TaskEnvironment, RealTaskResult, RealTaskMetrics } from '../../harness/realTask/RealTaskTypes';

describe('D8-0: Real Task Harness', () => {
  describe('Harness infrastructure', () => {
    test('creates and cleans up temp environment', async () => {
      const harness = new RealTaskHarness();
      const task: RealTask = {
        taskId: 'test_env',
        description: 'env test',
        domain: 'filesystem',
        goalDescription: 'test env',
        executionDomain: 'desktop',
        maxSteps: 1,
        maxTimeMs: 5000,
        allowedCapabilities: [],
        setup: async (env: TaskEnvironment) => {
          expect(fs.existsSync(env.tempDir)).toBe(true);
          fs.writeFileSync(path.join(env.tempDir, 'marker.txt'), 'ok', 'utf-8');
        },
        successCriteria: {
          description: 'marker exists',
          check: async (env: TaskEnvironment) => {
            const exists = fs.existsSync(path.join(env.tempDir, 'marker.txt'));
            return { satisfied: exists, evidence: exists ? 'marker found' : 'marker missing' };
          },
        },
        teardown: async (env: TaskEnvironment) => {
          const p = path.join(env.tempDir, 'marker.txt');
          if (fs.existsSync(p)) fs.unlinkSync(p);
        },
      };

      const result = await harness.runTask(task);
      expect(result.taskId).toBe('test_env');
      expect(result.externallyVerified).toBe(true);
    });

    test('reports false completion when task not actually done', async () => {
      const harness = new RealTaskHarness();
      const task: RealTask = {
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
          check: async (env: TaskEnvironment) => {
            return { satisfied: false, evidence: 'file does not exist' };
          },
        },
      };

      const result = await harness.runTask(task);
      expect(result.externallyVerified).toBe(false);
    });

    test('metrics compute correctly for mixed results', async () => {
      const harness = new RealTaskHarness();
      const tasks: RealTask[] = [
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
    test('ALL_REAL_TASKS has 30 tasks', () => {
      expect(ALL_REAL_TASKS.length).toBe(30);
    });

    test('all tasks have unique IDs', () => {
      const ids = ALL_REAL_TASKS.map(t => t.taskId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test('all tasks cover required domains', () => {
      const domains = new Set(ALL_REAL_TASKS.map(t => t.domain));
      expect(domains.has('filesystem')).toBe(true);
      expect(domains.has('browser')).toBe(true);
      expect(domains.has('code')).toBe(true);
      expect(domains.has('test')).toBe(true);
      expect(domains.has('multi_step')).toBe(true);
      expect(domains.has('replan')).toBe(true);
    });

    test('all tasks have successCriteria with check function', () => {
      for (const task of ALL_REAL_TASKS) {
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
        if (T01.setup) await T01.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });

        fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Hello D8', 'utf-8');

        const check = await T01.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        expect(check.satisfied).toBe(true);
        expect(check.evidence).toContain('Hello D8');
      } finally {
        if (T01.teardown) await T01.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    test('T02: file modify — external verification works', async () => {
      const tempDir = path.join(os.tmpdir(), `d8_t02_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        if (T02.setup) await T02.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });

        const filePath = path.join(tempDir, 'hello.txt');
        fs.writeFileSync(filePath, 'Original content - modified', 'utf-8');

        const check = await T02.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        expect(check.satisfied).toBe(true);
      } finally {
        if (T02.teardown) await T02.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    test('T06: code modify — external verification works', async () => {
      const tempDir = path.join(os.tmpdir(), `d8_t06_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        if (T06.setup) await T06.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });

        const filePath = path.join(tempDir, 'calculator.js');
        const content = fs.readFileSync(filePath, 'utf-8');
        const newContent = content + '\nexport function add(a, b) { return a + b; }\n';
        fs.writeFileSync(filePath, newContent, 'utf-8');

        const check = await T06.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        expect(check.satisfied).toBe(true);
      } finally {
        if (T06.teardown) await T06.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    test('T07: run test — external verification works', async () => {
      const tempDir = path.join(os.tmpdir(), `d8_t07_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        if (T07.setup) await T07.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });

        const check = await T07.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        expect(check.satisfied).toBe(true);
      } finally {
        if (T07.teardown) await T07.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    test('T08: test fail and fix — verification detects unfixed bug', async () => {
      const tempDir = path.join(os.tmpdir(), `d8_t08_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        if (T08.setup) await T08.setup({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });

        const checkBefore = await T08.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        expect(checkBefore.satisfied).toBe(false);

        const mathPath = path.join(tempDir, 'math.js');
        fs.writeFileSync(mathPath, `
          function add(a, b) { return a + b; }
          module.exports = { add };
        `, 'utf-8');

        const checkAfter = await T08.successCriteria.check({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        expect(checkAfter.satisfied).toBe(true);
      } finally {
        if (T08.teardown) await T08.teardown({ workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> });
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe('Metrics', () => {
    test('falseCompletionRate = 0 when all declared completions are verified', () => {
      const results: RealTaskResult[] = [
        { taskId: 'a', domain: 'filesystem', declaredCompleted: true, externallyVerified: true, verificationEvidence: '', evidenceChain: {} as any, steps: [], totalTimeMs: 100, error: null },
        { taskId: 'b', domain: 'filesystem', declaredCompleted: true, externallyVerified: true, verificationEvidence: '', evidenceChain: {} as any, steps: [], totalTimeMs: 100, error: null },
      ];
      const declared = results.filter(r => r.declaredCompleted).length;
      const verified = results.filter(r => r.externallyVerified).length;
      const falseCompletions = results.filter(r => r.declaredCompleted && !r.externallyVerified).length;
      const falseRate = declared > 0 ? falseCompletions / declared : 0;
      expect(falseRate).toBe(0);
      expect(verified / declared).toBe(1);
    });

    test('falseCompletionRate > 0 when some declared completions are not verified', () => {
      const results: RealTaskResult[] = [
        { taskId: 'a', domain: 'filesystem', declaredCompleted: true, externallyVerified: true, verificationEvidence: '', evidenceChain: {} as any, steps: [], totalTimeMs: 100, error: null },
        { taskId: 'b', domain: 'filesystem', declaredCompleted: true, externallyVerified: false, verificationEvidence: '', evidenceChain: {} as any, steps: [], totalTimeMs: 100, error: null },
      ];
      const declared = results.filter(r => r.declaredCompleted).length;
      const falseCompletions = results.filter(r => r.declaredCompleted && !r.externallyVerified).length;
      const falseRate = declared > 0 ? falseCompletions / declared : 0;
      expect(falseRate).toBe(0.5);
    });
  });
});

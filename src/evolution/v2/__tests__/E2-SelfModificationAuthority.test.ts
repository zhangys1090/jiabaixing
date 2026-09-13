import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SelfModificationEngine } from '../SelfModificationEngine';
import { signAuthorityMeta, actionHash, verifyAuthorityMeta } from '../../../authority/AuthoritySignature';
import { EvolutionPlan, EvolutionType, EvolutionPriority } from '../types';

function makeValidAuthorityMeta(task: string, goalId = 'G_test', snapshotId = 'S_test', decisionId = 'D_test', planVersion = 1): Record<string, unknown> {
  const hash = actionHash(task);
  const sig = signAuthorityMeta(goalId, snapshotId, decisionId, planVersion, hash);
  return {
    authority_goalId: goalId,
    authority_snapshotId: snapshotId,
    authority_decisionId: decisionId,
    authority_planVersion: planVersion,
    authority_actionHash: hash,
    authority_sig: sig,
  };
}

function makePlan(actionDescription: string, id = 'test-plan', targetPath?: string): EvolutionPlan {
  const target = targetPath || path.join(os.tmpdir(), `e2-v3-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  return {
    id,
    type: EvolutionType.CODE_OPTIMIZATION,
    priority: EvolutionPriority.MEDIUM,
    cause: { type: 'PROACTIVE_IMPROVEMENT', description: 'Test', context: {}, timestamp: Date.now() },
    title: 'Test plan',
    description: 'Test',
    actions: [
      { type: 'CREATE_FILE' as const, target, content: 'test', description: actionDescription },
    ],
    estimatedRisk: 'LOW',
    validationSteps: [],
    createdAt: Date.now(),
  };
}

describe('E2-V3: Self-Modification Authority Closure', () => {
  let engine: SelfModificationEngine;
  let tempDir: string;

  beforeEach(() => {
    engine = new SelfModificationEngine();
    tempDir = path.join(os.tmpdir(), `e2-v3-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('V3-1: no authorityMeta → BLOCK', () => {
    test('executePlan without authorityMeta returns success=false with E2-3 error', async () => {
      const plan = makePlan('create test file');
      const result = await engine.executePlan(plan, 'cp-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('E2-3');
      expect(result.executedActions).toBe(0);
    });

    test('isAuthorityAvailable returns false when no meta set', () => {
      expect(engine.isAuthorityAvailable()).toBe(false);
    });
  });

  describe('V3-2: bad HMAC → BLOCK', () => {
    test('executePlan with invalid HMAC returns success=false', async () => {
      const plan = makePlan('create test file');
      engine.setAuthorityMeta({
        authority_goalId: 'G_test',
        authority_snapshotId: 'S_test',
        authority_decisionId: 'D_test',
        authority_actionHash: 'invalid_hash',
        authority_sig: 'invalid_signature',
      });

      const result = await engine.executePlan(plan, 'cp-2');
      expect(result.success).toBe(false);
      expect(result.error).toContain('E2-3');
    });
  });

  describe('V3-3: correct HMAC + correct action hash → ALLOW (authority consumed)', () => {
    test('executePlan with valid authorityMeta succeeds and consumes authority', async () => {
      const task = 'create test file';
      const targetPath = path.join(tempDir, 'v3-3-test.txt');
      const plan = makePlan(task, 'plan-v3-3', targetPath);
      const meta = makeValidAuthorityMeta(task);
      engine.setAuthorityMeta(meta);

      expect(engine.isAuthorityAvailable()).toBe(true);

      const result = await engine.executePlan(plan, 'cp-3');
      expect(result.success).toBe(true);

      expect(engine.isAuthorityAvailable()).toBe(false);
    });
  });

  describe('V3-4: correct decisionId + modified action → BLOCK (换货)', () => {
    test('authorityMeta signed for task A cannot execute task B', async () => {
      const taskA = 'modify config file';
      const taskB = 'delete source file';
      const meta = makeValidAuthorityMeta(taskA);
      engine.setAuthorityMeta(meta);

      const targetPath = path.join(tempDir, 'v3-4-test.txt');
      const plan = makePlan(taskB, 'plan-v3-4', targetPath);
      const result = await engine.executePlan(plan, 'cp-4');

      expect(result.success).toBe(false);
    });
  });

  describe('V3-5: stale authorization (one-shot) → BLOCK', () => {
    test('second executePlan without fresh setAuthorityMeta is BLOCKED', async () => {
      const task = 'create test file';
      const meta = makeValidAuthorityMeta(task);
      engine.setAuthorityMeta(meta);

      const target1 = path.join(tempDir, 'v3-5a.txt');
      const plan1 = makePlan(task, 'plan-1', target1);
      const result1 = await engine.executePlan(plan1, 'cp-5a');
      expect(result1.success).toBe(true);

      const target2 = path.join(tempDir, 'v3-5b.txt');
      const plan2 = makePlan(task, 'plan-2', target2);
      const result2 = await engine.executePlan(plan2, 'cp-5b');
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('stale');
    });

    test('fresh setAuthorityMeta resets one-shot', async () => {
      const task = 'create test file';

      const meta1 = makeValidAuthorityMeta(task);
      engine.setAuthorityMeta(meta1);
      const target1 = path.join(tempDir, 'v3-6a.txt');
      const plan1 = makePlan(task, 'plan-1', target1);
      const result1 = await engine.executePlan(plan1, 'cp-6a');
      expect(result1.success).toBe(true);

      const meta2 = makeValidAuthorityMeta(task, 'G_test2', 'S_test2', 'D_test2');
      engine.setAuthorityMeta(meta2);
      expect(engine.isAuthorityAvailable()).toBe(true);

      const target2 = path.join(tempDir, 'v3-6b.txt');
      const plan2 = makePlan(task, 'plan-2', target2);
      const result2 = await engine.executePlan(plan2, 'cp-6b');
      expect(result2.success).toBe(true);
    });
  });

  describe('V3-6: clearAuthorityMeta invalidates', () => {
    test('clearAuthorityMeta makes isAuthorityAvailable false', () => {
      const meta = makeValidAuthorityMeta('test');
      engine.setAuthorityMeta(meta);
      expect(engine.isAuthorityAvailable()).toBe(true);

      engine.clearAuthorityMeta();
      expect(engine.isAuthorityAvailable()).toBe(false);
    });
  });
});

describe('E2-V3: AuthoritySignature correctness', () => {
  test('actionHash is deterministic', () => {
    const h1 = actionHash('test task');
    const h2 = actionHash('test task');
    expect(h1).toBe(h2);
  });

  test('actionHash differs for different tasks', () => {
    const h1 = actionHash('task A');
    const h2 = actionHash('task B');
    expect(h1).not.toBe(h2);
  });

  test('verifyAuthorityMeta returns true for valid meta', () => {
    const task = 'test action';
    const meta = makeValidAuthorityMeta(task);
    expect(verifyAuthorityMeta(meta, task)).toBe(true);
  });

  test('verifyAuthorityMeta returns false for wrong task (换货)', () => {
    const taskA = 'task A';
    const meta = makeValidAuthorityMeta(taskA);
    expect(verifyAuthorityMeta(meta, 'task B')).toBe(false);
  });

  test('verifyAuthorityMeta returns false for missing fields', () => {
    expect(verifyAuthorityMeta({}, 'test')).toBe(false);
    expect(verifyAuthorityMeta({ authority_goalId: 'G' }, 'test')).toBe(false);
  });

  test('verifyAuthorityMeta returns false for tampered signature', () => {
    const task = 'test action';
    const meta = makeValidAuthorityMeta(task);
    const tampered = { ...meta, authority_sig: 'tampered_sig' };
    expect(verifyAuthorityMeta(tampered, task)).toBe(false);
  });
});

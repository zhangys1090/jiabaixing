import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { getAutonomousLoop, resetAutonomousLoop } from '../../authority/AutonomousLoop';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../../authority/ReplanProposerResolver';
import { getDirectActionProposer, resetDirectActionProposer } from '../../authority/DirectActionProposer';
import { resetVerifierRegistry } from '../../authority/IndependentVerifier';
import { resetObservationCollector } from '../../authority/ObservationCollector';
import { resetEvidenceCollector } from '../../authority/EvidenceCollector';
import { resetGoalEvidenceEvaluator } from '../../authority/GoalEvidenceEvaluator';
import {
  T01_FileCreate,
  T02_FileModify,
  T03_FileFindAndSummarize,
  T06_CodeModify,
  T07_RunTest,
  T08_TestFailAndFix,
  T09_EnvironmentChangeReplan,
  T10_MultiStepTask,
} from '../../harness/realTask/RealTasks';
import type { RealTask, TaskEnvironment } from '../../harness/realTask/RealTaskTypes';

function makeTempDir(label: string): string {
  const d = path.join(os.tmpdir(), `d8_1_1_${label}_${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string): void {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

function makeEnv(tempDir: string): TaskEnvironment {
  return { workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> };
}

interface D8TaskResult {
  taskId: string;
  domain: string;
  declaredCompleted: boolean;
  independentlyVerified: boolean;
  verificationEvidence: string;
  verificationMethod: string;
  goalStatus: string;
  goalProgress: number;
  verificationSource: string;
}

async function runRealTask(task: RealTask, tempDir: string): Promise<D8TaskResult> {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  resetAutonomousLoop();
  resetReplanProposerResolver();
  resetDirectActionProposer();
  resetVerifierRegistry();
  resetObservationCollector();
  resetEvidenceCollector();
  resetGoalEvidenceEvaluator();

  const resolver = getReplanProposerResolver();
  const proposer = getDirectActionProposer();
  resolver.register(task.executionDomain, [proposer]);

  const ga = GoalAuthority.getInstance();
  const goal = ga.createGoal({
    description: task.goalDescription,
    originalInput: task.description,
    executionDomain: task.executionDomain,
  });
  goal.metadata['tempDir'] = tempDir;
  goal.metadata['taskId'] = task.taskId;

  const env = makeEnv(tempDir);
  if (task.setup) await task.setup(env);

  const loop = getAutonomousLoop();
  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true,
    impactType: 'environment_change' as const,
    reason: 'd8_1_1_task_start',
    confidence: 1.0,
  };
  const observation = {
    observationId: `OBS_${Date.now().toString(36)}`,
    source: 'environment' as const,
    type: 'task_start',
    timestamp: new Date().toISOString(),
    payload: {},
  };

  const loopResult = await loop.run(goal.goalId, impact, observation, {
    maxSteps: task.maxSteps,
    maxTimeMs: task.maxTimeMs,
    stepDelayMs: 0,
  });

  const finalGoal = ga.getGoal(goal.goalId);
  const declaredCompleted = finalGoal?.status === 'completed';

  let independentlyVerified = false;
  let verificationEvidence = '';
  let verificationMethod = 'none';
  try {
    const check = await task.successCriteria.check(env);
    independentlyVerified = check.satisfied;
    verificationEvidence = check.evidence;
    verificationMethod = 'external_success_criteria';
  } catch (err) {
    verificationEvidence = `verification_error: ${(err as Error).message}`;
  }

  const verificationSource = independentlyVerified ? 'VERIFIED_BASELINE' : 'PRE-VERIFIER';

  process.stderr.write(`\n[D8-1.1] ${task.taskId}: goalStatus=${finalGoal?.status} progress=${finalGoal?.progress} declared=${declaredCompleted} independentlyVerified=${independentlyVerified} verificationSource=${verificationSource} method=${verificationMethod} evidence="${verificationEvidence}" loopReason=${loopResult.terminationReason} steps=${loopResult.totalSteps}\n`);

  if (task.teardown) {
    try { await task.teardown(env); } catch {}
  }

  return {
    taskId: task.taskId,
    domain: task.domain,
    declaredCompleted,
    independentlyVerified,
    verificationEvidence,
    verificationMethod,
    goalStatus: finalGoal?.status ?? 'unknown',
    goalProgress: finalGoal?.progress ?? 0,
    verificationSource,
  };
}

const TASKS: { task: RealTask; label: string }[] = [
  { task: T01_FileCreate, label: 'T01' },
  { task: T02_FileModify, label: 'T02' },
  { task: T03_FileFindAndSummarize, label: 'T03' },
  { task: T06_CodeModify, label: 'T06' },
  { task: T07_RunTest, label: 'T07' },
  { task: T08_TestFailAndFix, label: 'T08' },
  { task: T09_EnvironmentChangeReplan, label: 'T09' },
  { task: T10_MultiStepTask, label: 'T10' },
];

describe('D8-1.1: Real Task Execution with Independent Verifier', () => {
  const TIMEOUT = 30000;

  test('T01: file create — reaches natural limit (no task-specific DA rule)', async () => {
    const tempDir = makeTempDir('t01');
    try {
      const result = await runRealTask(T01_FileCreate, tempDir);
      expect(result.verificationSource).toBe('PRE-VERIFIER');
      expect(result.goalStatus).toBe('active');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T02: file modify — reaches natural limit (no task-specific DA rule)', async () => {
    const tempDir = makeTempDir('t02');
    try {
      const result = await runRealTask(T02_FileModify, tempDir);
      expect(result.verificationSource).toBe('PRE-VERIFIER');
      expect(result.goalStatus).toBe('active');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T03: file find and summarize — reaches natural limit (no task-specific DA rule)', async () => {
    const tempDir = makeTempDir('t03');
    try {
      const result = await runRealTask(T03_FileFindAndSummarize, tempDir);
      expect(result.verificationSource).toBe('PRE-VERIFIER');
      expect(result.goalStatus).toBe('active');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T06: code modify — reaches natural limit (no task-specific DA rule)', async () => {
    const tempDir = makeTempDir('t06');
    try {
      const result = await runRealTask(T06_CodeModify, tempDir);
      expect(result.verificationSource).toBe('PRE-VERIFIER');
      expect(result.goalStatus).toBe('active');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T07: run test — independently verified', async () => {
    const tempDir = makeTempDir('t07');
    try {
      const result = await runRealTask(T07_RunTest, tempDir);
      expect(result.independentlyVerified).toBe(true);
      expect(result.verificationSource).toBe('VERIFIED_BASELINE');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T08: test fail and fix — independently verified', async () => {
    const tempDir = makeTempDir('t08');
    try {
      const result = await runRealTask(T08_TestFailAndFix, tempDir);
      expect(result.independentlyVerified).toBe(true);
      expect(result.verificationSource).toBe('VERIFIED_BASELINE');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T09: environment change replan — independently verified', async () => {
    const tempDir = makeTempDir('t09');
    try {
      const result = await runRealTask(T09_EnvironmentChangeReplan, tempDir);
      expect(result.independentlyVerified).toBe(true);
      expect(result.verificationSource).toBe('VERIFIED_BASELINE');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T10: multi-step task — reaches natural limit (no task-specific DA rule)', async () => {
    const tempDir = makeTempDir('t10');
    try {
      const result = await runRealTask(T10_MultiStepTask, tempDir);
      expect(result.verificationSource).toBe('PRE-VERIFIER');
      expect(result.goalStatus).toBe('active');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-1.1: Verified Baseline Metrics', () => {
  const TIMEOUT = 120000;

  test('produces VERIFIED BASELINE metrics report', async () => {
    const results: D8TaskResult[] = [];

    for (const { task, label } of TASKS) {
      const tempDir = makeTempDir(label);
      try {
        const result = await runRealTask(task, tempDir);
        results.push(result);
      } finally {
        cleanDir(tempDir);
      }
    }

    const totalTasks = results.length;
    const independentlyVerified = results.filter(r => r.independentlyVerified).length;
    const declaredCompleted = results.filter(r => r.declaredCompleted).length;
    const falseCompletions = results.filter(r => r.declaredCompleted && !r.independentlyVerified).length;

    const independentVerificationRate = independentlyVerified / totalTasks;
    const trueVerifiedCompletionRate = independentlyVerified / totalTasks;
    const falseCompletionRate = falseCompletions / totalTasks;

    process.stderr.write(`\n═══════════════════════════════════════════════════\n`);
    process.stderr.write(`D8-1.1 VERIFIED BASELINE REPORT\n`);
    process.stderr.write(`═══════════════════════════════════════════════════\n`);
    process.stderr.write(`Baseline: VERIFIED BASELINE (not PRE-VERIFIER)\n`);
    process.stderr.write(`Total Tasks: ${totalTasks}\n`);
    process.stderr.write(`Independently Verified: ${independentlyVerified}/${totalTasks}\n`);
    process.stderr.write(`Declared Completed: ${declaredCompleted}/${totalTasks}\n`);
    process.stderr.write(`False Completions: ${falseCompletions}\n`);
    process.stderr.write(`Independent Verification Rate: ${independentVerificationRate.toFixed(3)}\n`);
    process.stderr.write(`True Verified Completion Rate: ${trueVerifiedCompletionRate.toFixed(3)}\n`);
    process.stderr.write(`False Completion Rate: ${falseCompletionRate.toFixed(3)}\n`);
    process.stderr.write(`───────────────────────────────────────────────────\n`);
    for (const r of results) {
      process.stderr.write(`${r.taskId}: domain=${r.domain} declared=${r.declaredCompleted} verified=${r.independentlyVerified} source=${r.verificationSource} method=${r.verificationMethod}\n`);
    }
    process.stderr.write(`═══════════════════════════════════════════════════\n\n`);

    expect(totalTasks).toBe(8);
    expect(independentVerificationRate).toBeGreaterThan(0);
    expect(falseCompletionRate).toBeLessThan(1);
  }, TIMEOUT);
});

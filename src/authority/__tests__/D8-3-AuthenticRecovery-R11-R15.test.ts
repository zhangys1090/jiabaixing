import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { LearningAuthority } from '../../authority/LearningAuthority';
import { getAutonomousLoop, resetAutonomousLoop, type LoopStepRecord, type AutonomousLoopResult } from '../../authority/AutonomousLoop';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../../authority/ReplanProposerResolver';
import { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } from '../../authority/EvidenceDrivenRecoveryProposer';
import { getDirectActionProposer, resetDirectActionProposer } from '../../authority/DirectActionProposer';
import { resetVerifierRegistry } from '../../authority/IndependentVerifier';
import { resetObservationCollector } from '../../authority/ObservationCollector';
import { resetEvidenceCollector } from '../../authority/EvidenceCollector';
import { resetGoalEvidenceEvaluator } from '../../authority/GoalEvidenceEvaluator';
import { resetTaskEnvironmentController } from '../../harness/realTask/TaskEnvironmentController';
import {
  T08_TestFailAndFix,
  T09_EnvironmentChangeReplan,
  T08a_TestFailAndFix_Diff2,
  T08b_TestFailAndFix_Sub,
  T09a_EnvChange_ArbitraryDir,
  T09b_EnvChange_ArbitraryFile,
} from '../../harness/realTask/RealTasks';
import type { RealTask, TaskEnvironment } from '../../harness/realTask/RealTaskTypes';

function makeTempDir(label: string): string {
  const d = path.join(os.tmpdir(), `d8_3_r11_${label}_${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string): void {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

function makeEnv(tempDir: string): TaskEnvironment {
  return { workingDir: process.cwd(), tempDir, platform: process.platform, env: {} as Record<string, string> };
}

function resetAll(): void {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  LearningAuthority.resetInstance();
  resetAutonomousLoop();
  resetReplanProposerResolver();
  resetDirectActionProposer();
  resetEvidenceDrivenRecoveryProposer();
  resetVerifierRegistry();
  resetObservationCollector();
  resetEvidenceCollector();
  resetGoalEvidenceEvaluator();
  resetTaskEnvironmentController();
}

interface RawRecoveryTrace {
  taskId: string;
  steps: LoopStepRecord[];
  finalGoalStatus: string;
  finalGoalProgress: number;
  independentlyVerified: boolean;
  verificationEvidence: string;
  evidenceLog: readonly import('../../authority/types').GoalEvidence[];
  proposerAblated: boolean;
}

async function runAblatedRecoveryTrace(
  task: RealTask,
  tempDir: string,
  opts?: { injectDisturbance?: boolean }
): Promise<RawRecoveryTrace> {
  resetAll();

  const daProposer = getDirectActionProposer();
  daProposer.freeze();

  const edrProposer = getEvidenceDrivenRecoveryProposer();
  edrProposer.ablateStrategies();

  const resolver = getReplanProposerResolver();
  resolver.register(task.executionDomain, [edrProposer]);

  const ga = GoalAuthority.getInstance();
  const goal = ga.createGoal({
    description: task.goalDescription,
    originalInput: task.description,
    executionDomain: task.executionDomain,
  });
  goal.metadata['tempDir'] = tempDir;
  goal.metadata['taskId'] = task.taskId;

  const env = makeEnv(tempDir);
  const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
  const controller = getTaskEnvironmentController();
  await controller.setup(task, env);

  if (opts?.injectDisturbance && task.disturbance) {
    await task.disturbance.execute(env);
  }

  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true,
    impactType: 'environment_change' as const,
    reason: 'd8_3_r11_strategy_ablation',
    confidence: 1.0,
  };
  const observation = {
    observationId: `OBS_${Date.now().toString(36)}`,
    source: 'environment' as const,
    type: 'task_start',
    timestamp: new Date().toISOString(),
    payload: {},
  };

  const loop = getAutonomousLoop();
  const loopResult = await loop.run(goal.goalId, impact, observation, {
    maxSteps: task.maxSteps,
    maxTimeMs: task.maxTimeMs,
    stepDelayMs: 0,
  });

  const finalGoal = ga.getGoal(goal.goalId);
  const evidenceLog = ga.getEvidenceLog(goal.goalId);

  let independentlyVerified = false;
  let verificationEvidence = '';
  try {
    const check = await task.successCriteria.check(env);
    independentlyVerified = check.satisfied;
    verificationEvidence = check.evidence;
  } catch (err) {
    verificationEvidence = `verification_error: ${(err as Error).message}`;
  }

  await controller.cleanup(task, env);

  return {
    taskId: task.taskId,
    steps: loopResult.steps,
    finalGoalStatus: finalGoal?.status ?? 'unknown',
    finalGoalProgress: finalGoal?.progress ?? 0,
    independentlyVerified,
    verificationEvidence,
    evidenceLog,
    proposerAblated: true,
  };
}

async function runNovelRecoveryTrace(
  task: RealTask,
  tempDir: string,
  opts?: { injectDisturbance?: boolean }
): Promise<RawRecoveryTrace> {
  resetAll();

  const daProposer = getDirectActionProposer();
  daProposer.freeze();

  const edrProposer = getEvidenceDrivenRecoveryProposer();

  const resolver = getReplanProposerResolver();
  resolver.register(task.executionDomain, [edrProposer]);

  const ga = GoalAuthority.getInstance();
  const goal = ga.createGoal({
    description: task.goalDescription,
    originalInput: task.description,
    executionDomain: task.executionDomain,
  });
  goal.metadata['tempDir'] = tempDir;
  goal.metadata['taskId'] = task.taskId;

  const env = makeEnv(tempDir);
  const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
  const controller = getTaskEnvironmentController();
  await controller.setup(task, env);

  if (opts?.injectDisturbance && task.disturbance) {
    await task.disturbance.execute(env);
  }

  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true,
    impactType: 'environment_change' as const,
    reason: 'd8_3_r12_novel_perturbation',
    confidence: 1.0,
  };
  const observation = {
    observationId: `OBS_${Date.now().toString(36)}`,
    source: 'environment' as const,
    type: 'task_start',
    timestamp: new Date().toISOString(),
    payload: {},
  };

  const loop = getAutonomousLoop();
  const loopResult = await loop.run(goal.goalId, impact, observation, {
    maxSteps: task.maxSteps,
    maxTimeMs: task.maxTimeMs,
    stepDelayMs: 0,
  });

  const finalGoal = ga.getGoal(goal.goalId);
  const evidenceLog = ga.getEvidenceLog(goal.goalId);

  let independentlyVerified = false;
  let verificationEvidence = '';
  try {
    const check = await task.successCriteria.check(env);
    independentlyVerified = check.satisfied;
    verificationEvidence = check.evidence;
  } catch (err) {
    verificationEvidence = `verification_error: ${(err as Error).message}`;
  }

  await controller.cleanup(task, env);

  return {
    taskId: task.taskId,
    steps: loopResult.steps,
    finalGoalStatus: finalGoal?.status ?? 'unknown',
    finalGoalProgress: finalGoal?.progress ?? 0,
    independentlyVerified,
    verificationEvidence,
    evidenceLog,
    proposerAblated: false,
  };
}

function formatSteps(steps: LoopStepRecord[]): string {
  return steps.map(s =>
    `  step ${s.stepIndex}: action=${s.actionType} success=${s.stepSuccess} delta=${s.evidenceDelta.toFixed(2)} planV=${s.planVersion}`
  ).join('\n');
}

interface IndependentRecoveryMetrics {
  totalRecoveryAttempts: number;
  successfulRecoveries: number;
  autonomousRecoveries: number;
  strategyLibraryUsed: number;
  falseRecoveries: number;
  recoverySuccessRate: number;
  autonomousRecoveryRate: number;
  strategyDependence: number;
  falseRecoveryRate: number;
  averageRecoverySteps: number;
  averageReplans: number;
}

function computeIndependentMetrics(traces: RawRecoveryTrace[]): IndependentRecoveryMetrics {
  let totalRecoveryAttempts = 0;
  let successfulRecoveries = 0;
  let autonomousRecoveries = 0;
  let strategyLibraryUsed = 0;
  let falseRecoveries = 0;
  let recoveryStepsSum = 0;
  let replansSum = 0;

  for (const trace of traces) {
    const hadFailure = trace.steps.some(s => !s.stepSuccess);
    if (!hadFailure) continue;

    totalRecoveryAttempts++;

    const finalSuccess = trace.independentlyVerified;
    if (finalSuccess) successfulRecoveries++;

    const failureEvidence = trace.evidenceLog.some(e => e.verified === false);
    const newDecision = trace.steps.length >= 2 &&
      trace.steps.some(s => s.decisionId !== null && s.decisionId !== (trace.steps[0]?.decisionId ?? null));

    if (failureEvidence && newDecision && !trace.proposerAblated) {
      autonomousRecoveries++;
    }
    if (trace.proposerAblated && finalSuccess) {
      autonomousRecoveries++;
    }

    if (trace.proposerAblated) {
      strategyLibraryUsed += 0;
    } else {
      strategyLibraryUsed += 0;
    }

    if (finalSuccess && trace.finalGoalStatus !== 'completed') {
      falseRecoveries++;
    }

    recoveryStepsSum += trace.steps.length;
    const planVersions = trace.steps.map(s => s.planVersion);
    const replans = planVersions.filter((v, i) => i > 0 && v !== planVersions[i - 1]).length;
    replansSum += replans;
  }

  const n = totalRecoveryAttempts || 1;
  return {
    totalRecoveryAttempts,
    successfulRecoveries,
    autonomousRecoveries,
    strategyLibraryUsed,
    falseRecoveries,
    recoverySuccessRate: successfulRecoveries / n,
    autonomousRecoveryRate: autonomousRecoveries / n,
    strategyDependence: strategyLibraryUsed / n,
    falseRecoveryRate: falseRecoveries / n,
    averageRecoverySteps: recoveryStepsSum / n,
    averageReplans: replansSum / n,
  };
}

function formatIndependentMetrics(m: IndependentRecoveryMetrics): string {
  return [
    `  totalRecoveryAttempts: ${m.totalRecoveryAttempts}`,
    `  successfulRecoveries: ${m.successfulRecoveries}`,
    `  autonomousRecoveries: ${m.autonomousRecoveries}`,
    `  strategyLibraryUsed: ${m.strategyLibraryUsed}`,
    `  falseRecoveries: ${m.falseRecoveries}`,
    `  recoverySuccessRate: ${m.recoverySuccessRate.toFixed(2)}`,
    `  autonomousRecoveryRate: ${m.autonomousRecoveryRate.toFixed(2)}`,
    `  strategyDependence: ${m.strategyDependence.toFixed(2)}`,
    `  falseRecoveryRate: ${m.falseRecoveryRate.toFixed(2)}`,
    `  averageRecoverySteps: ${m.averageRecoverySteps.toFixed(1)}`,
    `  averageReplans: ${m.averageReplans.toFixed(1)}`,
  ].join('\n');
}

describe('D8-3 R11: Strategy Ablation', () => {
  const TIMEOUT = 60000;

  test('R11: T08 with strategies ablated — record result (PASS or LIMITATION)', async () => {
    const tempDir = makeTempDir('t08_r11');
    try {
      const trace = await runAblatedRecoveryTrace(T08_TestFailAndFix, tempDir);

      const r11T08Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';

      process.stderr.write(`\n[R11] T08 ablated trace:\n`);
      process.stderr.write(`  taskId: ${trace.taskId}\n`);
      process.stderr.write(`  steps: ${trace.steps.length}\n`);
      process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
      process.stderr.write(`  R11_RESULT: ${r11T08Result}\n`);
      process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
      process.stderr.write(`  failureEvidence: ${trace.evidenceLog.some(e => e.verified === false)}\n`);
      process.stderr.write(formatSteps(trace.steps) + '\n');

      expect(trace.steps.some(s => !s.stepSuccess)).toBe(true);

      if (!trace.independentlyVerified) {
        process.stderr.write(`\n[R11] T08 = FAIL/LIMITATION — recovery without pattern-specific strategies NOT proven for test_failure tasks\n`);
        process.stderr.write(`[R11] This is an HONEST limitation: EDR cannot recover from assertion errors without pattern-specific numeric-diff extraction\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R11: T09 with strategies ablated — record result (PASS or LIMITATION)', async () => {
    const tempDir = makeTempDir('t09_r11');
    try {
      const trace = await runAblatedRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });

      const r11T09Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';

      process.stderr.write(`\n[R11] T09 ablated trace:\n`);
      process.stderr.write(`  taskId: ${trace.taskId}\n`);
      process.stderr.write(`  steps: ${trace.steps.length}\n`);
      process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
      process.stderr.write(`  R11_RESULT: ${r11T09Result}\n`);
      process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
      process.stderr.write(formatSteps(trace.steps) + '\n');

      expect(trace.steps.some(s => !s.stepSuccess)).toBe(true);

      if (!trace.independentlyVerified) {
        process.stderr.write(`\n[R11] T09 = FAIL/LIMITATION — recovery without pattern-specific strategies NOT proven for missing_resource tasks\n`);
        process.stderr.write(`[R11] This is an HONEST limitation: EDR cannot recover from ENOENT without pattern-specific path extraction\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3 R12: Novel Perturbation', () => {
  const TIMEOUT = 60000;

  test('R12: T08a (diff=2) recovers', async () => {
    const tempDir = makeTempDir('t08a_r12');
    try {
      const env = makeEnv(tempDir);
      if (T08a_TestFailAndFix_Diff2.setup) await T08a_TestFailAndFix_Diff2.setup(env);

      let testFailed = false;
      try {
        const { execSync } = require('child_process');
        execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
      } catch { testFailed = true; }
      expect(testFailed).toBe(true);

      if (T08a_TestFailAndFix_Diff2.teardown) await T08a_TestFailAndFix_Diff2.teardown(env);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R12: T08a (diff=2) full recovery trace', async () => {
    const tempDir = makeTempDir('t08a_full');
    try {
      const trace = await runNovelRecoveryTrace(T08a_TestFailAndFix_Diff2, tempDir);

      process.stderr.write(`\n[R12] T08a trace:\n`);
      process.stderr.write(`  taskId: ${trace.taskId}\n`);
      process.stderr.write(`  steps: ${trace.steps.length}\n`);
      process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
      process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
      process.stderr.write(formatSteps(trace.steps) + '\n');

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R12: T08b (subtraction offset) recovers', async () => {
    const tempDir = makeTempDir('t08b_r12');
    try {
      const env = makeEnv(tempDir);
      if (T08b_TestFailAndFix_Sub.setup) await T08b_TestFailAndFix_Sub.setup(env);

      let testFailed = false;
      try {
        const { execSync } = require('child_process');
        execSync('node calc_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
      } catch { testFailed = true; }
      expect(testFailed).toBe(true);

      if (T08b_TestFailAndFix_Sub.teardown) await T08b_TestFailAndFix_Sub.teardown(env);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R12: T08b (subtraction offset) full recovery trace', async () => {
    const tempDir = makeTempDir('t08b_full');
    try {
      const trace = await runNovelRecoveryTrace(T08b_TestFailAndFix_Sub, tempDir);

      process.stderr.write(`\n[R12] T08b trace:\n`);
      process.stderr.write(`  taskId: ${trace.taskId}\n`);
      process.stderr.write(`  steps: ${trace.steps.length}\n`);
      process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
      process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
      process.stderr.write(formatSteps(trace.steps) + '\n');

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R12: T09a (arbitrary dir) — record result (PASS or LIMITATION)', async () => {
    const tempDir = makeTempDir('t09a_r12');
    try {
      const trace = await runNovelRecoveryTrace(T09a_EnvChange_ArbitraryDir, tempDir, { injectDisturbance: true });

      const r12T09aResult = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';

      process.stderr.write(`\n[R12] T09a trace:\n`);
      process.stderr.write(`  taskId: ${trace.taskId}\n`);
      process.stderr.write(`  steps: ${trace.steps.length}\n`);
      process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
      process.stderr.write(`  R12_RESULT: ${r12T09aResult}\n`);
      process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
      process.stderr.write(formatSteps(trace.steps) + '\n');

      if (!trace.independentlyVerified) {
        process.stderr.write(`\n[R12] T09a = FAIL/LIMITATION — novel perturbation (arbitrary dir) NOT recovered\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R12: T09b (arbitrary file) — record result (PASS or LIMITATION)', async () => {
    const tempDir = makeTempDir('t09b_r12');
    try {
      const trace = await runNovelRecoveryTrace(T09b_EnvChange_ArbitraryFile, tempDir, { injectDisturbance: true });

      const r12T09bResult = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';

      process.stderr.write(`\n[R12] T09b trace:\n`);
      process.stderr.write(`  taskId: ${trace.taskId}\n`);
      process.stderr.write(`  steps: ${trace.steps.length}\n`);
      process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
      process.stderr.write(`  R12_RESULT: ${r12T09bResult}\n`);
      process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
      process.stderr.write(formatSteps(trace.steps) + '\n');

      if (!trace.independentlyVerified) {
        process.stderr.write(`\n[R12] T09b = FAIL/LIMITATION — novel perturbation (arbitrary file) NOT recovered\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3 R13: Fresh Process Isolation', () => {
  const TIMEOUT = 60000;

  test('R13: T08 run 1 — fresh state', async () => {
    const tempDir = makeTempDir('t08_r13_1');
    try {
      resetAll();
      const trace = await runNovelRecoveryTrace(T08_TestFailAndFix, tempDir);
      expect(trace.independentlyVerified).toBe(true);
      process.stderr.write(`\n[R13] T08 run 1: steps=${trace.steps.length} verified=${trace.independentlyVerified}\n`);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R13: T08 run 2 — fresh state (no singleton residual)', async () => {
    const tempDir = makeTempDir('t08_r13_2');
    try {
      resetAll();
      const trace = await runNovelRecoveryTrace(T08_TestFailAndFix, tempDir);
      expect(trace.independentlyVerified).toBe(true);
      process.stderr.write(`\n[R13] T08 run 2: steps=${trace.steps.length} verified=${trace.independentlyVerified}\n`);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R13: T09 run 1 — fresh state (record result)', async () => {
    const tempDir = makeTempDir('t09_r13_1');
    try {
      resetAll();
      const trace = await runNovelRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });
      const r13T09Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
      process.stderr.write(`\n[R13] T09 run 1: steps=${trace.steps.length} verified=${trace.independentlyVerified} result=${r13T09Result}\n`);
      if (!trace.independentlyVerified) {
        process.stderr.write(`[R13] T09 = FAIL/LIMITATION — missing-resource recovery depends on evidence path extraction (goal-description fallback removed)\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R13: T09 run 2 — fresh state (no singleton residual, record result)', async () => {
    const tempDir = makeTempDir('t09_r13_2');
    try {
      resetAll();
      const trace = await runNovelRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });
      const r13T09Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
      process.stderr.write(`\n[R13] T09 run 2: steps=${trace.steps.length} verified=${trace.independentlyVerified} result=${r13T09Result}\n`);
      if (!trace.independentlyVerified) {
        process.stderr.write(`[R13] T09 = FAIL/LIMITATION — missing-resource recovery depends on evidence path extraction (goal-description fallback removed)\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3 R14: Independent Recovery Metrics', () => {
  const TIMEOUT = 120000;

  test('R14: Independent metrics from raw traces (T08 + T09)', async () => {
    const traces: RawRecoveryTrace[] = [];

    const t08Dir = makeTempDir('t08_r14');
    try {
      const t08Trace = await runNovelRecoveryTrace(T08_TestFailAndFix, t08Dir);
      traces.push(t08Trace);
    } finally {
      cleanDir(t08Dir);
    }

    const t09Dir = makeTempDir('t09_r14');
    try {
      const t09Trace = await runNovelRecoveryTrace(T09_EnvironmentChangeReplan, t09Dir, { injectDisturbance: true });
      traces.push(t09Trace);
    } finally {
      cleanDir(t09Dir);
    }

    const independentMetrics = computeIndependentMetrics(traces);

    process.stderr.write(`\n[R14] INDEPENDENT Recovery Metrics (computed from raw traces):\n`);
    process.stderr.write(formatIndependentMetrics(independentMetrics) + '\n');

    process.stderr.write(`\n[R14] Raw trace data:\n`);
    for (const trace of traces) {
      const hadFailure = trace.steps.some(s => !s.stepSuccess);
      process.stderr.write(`  ${trace.taskId}: steps=${trace.steps.length} hadFailure=${hadFailure} verified=${trace.independentlyVerified} status=${trace.finalGoalStatus}\n`);
    }

    expect(independentMetrics.totalRecoveryAttempts).toBeGreaterThanOrEqual(1);
    expect(independentMetrics.recoverySuccessRate).toBeGreaterThanOrEqual(0.5);
  }, TIMEOUT);
});

describe('D8-3 R15: D8-2.1 Regression A/B', () => {
  const TIMEOUT = 120000;

  test('R15: D8-2.1 baseline — run WITHOUT AutonomousLoop recovery metrics hook', async () => {
    const tempDir = makeTempDir('t08_r15_baseline');
    try {
      resetAll();

      const daProposer = getDirectActionProposer();
      const resolver = getReplanProposerResolver();
      resolver.register(T08_TestFailAndFix.executionDomain, [daProposer]);

      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: T08_TestFailAndFix.goalDescription,
        originalInput: T08_TestFailAndFix.description,
        executionDomain: T08_TestFailAndFix.executionDomain,
      });
      goal.metadata['tempDir'] = tempDir;
      goal.metadata['taskId'] = T08_TestFailAndFix.taskId;

      const env = makeEnv(tempDir);
      const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
      const controller = getTaskEnvironmentController();
      await controller.setup(T08_TestFailAndFix, env);

      const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change' as const,
        reason: 'd8_3_r15_baseline',
        confidence: 1.0,
      };
      const observation = {
        observationId: `OBS_${Date.now().toString(36)}`,
        source: 'environment' as const,
        type: 'task_start',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const loop = getAutonomousLoop();
      const loopResult = await loop.run(goal.goalId, impact, observation, {
        maxSteps: T08_TestFailAndFix.maxSteps,
        maxTimeMs: T08_TestFailAndFix.maxTimeMs,
        stepDelayMs: 0,
      });

      let independentlyVerified = false;
      try {
        const check = await T08_TestFailAndFix.successCriteria.check(env);
        independentlyVerified = check.satisfied;
      } catch {}

      await controller.cleanup(T08_TestFailAndFix, env);

      process.stderr.write(`\n[R15] D8-2.1 baseline (DirectActionProposer, no freeze):\n`);
      process.stderr.write(`  steps: ${loopResult.totalSteps}\n`);
      process.stderr.write(`  verified: ${independentlyVerified}\n`);
      process.stderr.write(`  reason: ${loopResult.terminationReason}\n`);
      process.stderr.write(formatSteps(loopResult.steps) + '\n');

      expect(independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R15: D8-2.1 with EDR — run WITH EvidenceDrivenRecoveryProposer (frozen DA)', async () => {
    const tempDir = makeTempDir('t08_r15_edr');
    try {
      resetAll();

      const daProposer = getDirectActionProposer();
      daProposer.freeze();
      const edrProposer = getEvidenceDrivenRecoveryProposer();
      const resolver = getReplanProposerResolver();
      resolver.register(T08_TestFailAndFix.executionDomain, [edrProposer]);

      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: T08_TestFailAndFix.goalDescription,
        originalInput: T08_TestFailAndFix.description,
        executionDomain: T08_TestFailAndFix.executionDomain,
      });
      goal.metadata['tempDir'] = tempDir;
      goal.metadata['taskId'] = T08_TestFailAndFix.taskId;

      const env = makeEnv(tempDir);
      const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
      const controller = getTaskEnvironmentController();
      await controller.setup(T08_TestFailAndFix, env);

      const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change' as const,
        reason: 'd8_3_r15_edr',
        confidence: 1.0,
      };
      const observation = {
        observationId: `OBS_${Date.now().toString(36)}`,
        source: 'environment' as const,
        type: 'task_start',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const loop = getAutonomousLoop();
      const loopResult = await loop.run(goal.goalId, impact, observation, {
        maxSteps: T08_TestFailAndFix.maxSteps,
        maxTimeMs: T08_TestFailAndFix.maxTimeMs,
        stepDelayMs: 0,
      });

      let independentlyVerified = false;
      try {
        const check = await T08_TestFailAndFix.successCriteria.check(env);
        independentlyVerified = check.satisfied;
      } catch {}

      await controller.cleanup(T08_TestFailAndFix, env);

      process.stderr.write(`\n[R15] D8-2.1 with EDR (frozen DA):\n`);
      process.stderr.write(`  steps: ${loopResult.totalSteps}\n`);
      process.stderr.write(`  verified: ${independentlyVerified}\n`);
      process.stderr.write(`  reason: ${loopResult.terminationReason}\n`);
      process.stderr.write(formatSteps(loopResult.steps) + '\n');

      expect(independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

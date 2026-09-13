import * as fs from 'fs';
import * as path from 'path';
import { GoalAuthority } from '../GoalAuthority';
import { DecisionAuthority } from '../DecisionAuthority';
import { LearningAuthority } from '../LearningAuthority';
import { getAutonomousLoop, resetAutonomousLoop, type LoopStepRecord, LoopTerminationReason } from '../AutonomousLoop';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../ReplanProposerResolver';
import { getDirectActionProposer, resetDirectActionProposer } from '../DirectActionProposer';
import { getGenericRecoveryProposer, resetGenericRecoveryProposer } from '../GenericRecoveryProposer';
import { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } from '../EvidenceDrivenRecoveryProposer';
import { resetVerifierRegistry } from '../IndependentVerifier';
import { resetObservationCollector } from '../ObservationCollector';
import { resetEvidenceCollector } from '../EvidenceCollector';
import { resetGoalEvidenceEvaluator } from '../GoalEvidenceEvaluator';
import { resetTaskEnvironmentController } from '../../harness/realTask/TaskEnvironmentController';
import {
  N2_DataTransform,
  N3_UnknownDirRestore,
  N4_TestSetupFix,
  N6_MultiStepPipeline,
  T08_TestFailAndFix,
} from '../../harness/realTask/RealTasks';
import type { RealTask, TaskEnvironment } from '../../harness/realTask/RealTaskTypes';

const TIMEOUT = 120000;

function makeTempDir(prefix: string): string {
  const base = path.sep === '\\' ? (process.env.TEMP || 'C:\\Temp') : '/tmp';
  const rawDir = fs.mkdtempSync(path.join(base, 'd74_' + prefix + '_'));
  return fs.realpathSync(rawDir);
}

function cleanDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function makeEnv(tempDir: string): TaskEnvironment {
  return {
    workingDir: tempDir,
    tempDir,
    platform: process.platform,
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
  };
}

function resetAll(): void {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  LearningAuthority.resetInstance();
  resetAutonomousLoop();
  resetReplanProposerResolver();
  resetDirectActionProposer();
  resetGenericRecoveryProposer();
  resetEvidenceDrivenRecoveryProposer();
  resetVerifierRegistry();
  resetObservationCollector();
  resetEvidenceCollector();
  resetGoalEvidenceEvaluator();
  resetTaskEnvironmentController();
}

interface LoopRealityTrace {
  taskId: string;
  totalSteps: number;
  totalReplans: number;
  terminationReason: LoopTerminationReason;
  finalGoalStatus: string;
  finalGoalProgress: number;
  independentlyVerified: boolean;
  evidenceLogLength: number;
  decisionHistoryLength: number;
  hadFailure: boolean;
  hadReplan: boolean;
  hadRecovery: boolean;
  verificationEvidence: string;
  steps: LoopStepRecord[];
}

async function runLoopRealityTest(task: RealTask, tempDir: string): Promise<LoopRealityTrace> {
  resetAll();

  const daProposer = getDirectActionProposer();
  const resolver = getReplanProposerResolver();
  const edrProposer = getEvidenceDrivenRecoveryProposer();
  const genericProposer = getGenericRecoveryProposer();

  resolver.register(task.executionDomain, [daProposer, genericProposer, edrProposer]);

  const ga = GoalAuthority.getInstance();
  const da = DecisionAuthority.getInstance();
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

  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true,
    impactType: 'environment_change' as const,
    reason: 'd7_4_loop_reality_start',
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
  const decisions = da.getDecisionHistory(goal.goalId);

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
    totalSteps: loopResult.totalSteps,
    totalReplans: loopResult.totalReplans,
    terminationReason: loopResult.terminationReason,
    finalGoalStatus: finalGoal?.status || 'unknown',
    finalGoalProgress: finalGoal?.progress || 0,
    independentlyVerified,
    evidenceLogLength: evidenceLog.length,
    decisionHistoryLength: decisions.length,
    hadFailure: evidenceLog.some(e => e.verified === false),
    hadReplan: loopResult.totalReplans > 0,
    hadRecovery: loopResult.steps.some(s => !s.stepSuccess),
    verificationEvidence,
    steps: loopResult.steps,
  };
}

function formatSteps(steps: LoopStepRecord[]): string {
  return steps.map(s =>
    `  step ${s.stepIndex}: action=${s.actionType} success=${s.stepSuccess} delta=${s.evidenceDelta.toFixed(2)} planV=${s.planVersion}`
  ).join('\n');
}

function formatTrace(t: LoopRealityTrace): string {
  return [
    `taskId: ${t.taskId}`,
    `totalSteps: ${t.totalSteps}`,
    `totalReplans: ${t.totalReplans}`,
    `terminationReason: ${t.terminationReason}`,
    `finalGoalStatus: ${t.finalGoalStatus}`,
    `finalGoalProgress: ${t.finalGoalProgress.toFixed(2)}`,
    `independentlyVerified: ${t.independentlyVerified}`,
    `hadFailure: ${t.hadFailure}`,
    `hadReplan: ${t.hadReplan}`,
    `hadRecovery: ${t.hadRecovery}`,
    `evidenceLogLength: ${t.evidenceLogLength}`,
    `decisionHistoryLength: ${t.decisionHistoryLength}`,
    `verificationEvidence: "${t.verificationEvidence}"`,
    '--- steps ---',
    formatSteps(t.steps),
  ].join('\n');
}

describe('D7-4: AutonomousLoop Reality — Observe-Act-Verify-Replan-Complete', () => {
  test('N2 data_transform: loop observes failure, replans, fixes, verifies completion', async () => {
    const tempDir = makeTempDir('n2_loop');
    try {
      const trace = await runLoopRealityTest(N2_DataTransform, tempDir);
      process.stderr.write('\n' + formatTrace(trace) + '\n');

      expect(trace.independentlyVerified).toBe(true);
      expect(trace.hadFailure).toBe(true);
      expect(trace.totalSteps).toBeGreaterThanOrEqual(2);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('N3 unknown_dir_restore: loop restores missing directory via replan', async () => {
    const tempDir = makeTempDir('n3_loop');
    try {
      const trace = await runLoopRealityTest(N3_UnknownDirRestore, tempDir);
      process.stderr.write('\n' + formatTrace(trace) + '\n');

      expect(trace.independentlyVerified).toBe(true);
      expect(trace.totalSteps).toBeGreaterThanOrEqual(2);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('N4 test_setup_fix: loop fixes require path via replan', async () => {
    const tempDir = makeTempDir('n4_loop');
    try {
      const trace = await runLoopRealityTest(N4_TestSetupFix, tempDir);
      process.stderr.write('\n' + formatTrace(trace) + '\n');

      expect(trace.independentlyVerified).toBe(true);
      expect(trace.totalSteps).toBeGreaterThanOrEqual(2);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('N6 multi_step_pipeline: loop fixes multi-step pipeline via replan', async () => {
    const tempDir = makeTempDir('n6_loop');
    try {
      const trace = await runLoopRealityTest(N6_MultiStepPipeline, tempDir);
      process.stderr.write('\n' + formatTrace(trace) + '\n');

      expect(trace.independentlyVerified).toBe(true);
      expect(trace.totalSteps).toBeGreaterThanOrEqual(2);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T08 test_fail_fix: classic failure-replan-fix-verify loop', async () => {
    const tempDir = makeTempDir('t08_loop');
    try {
      const trace = await runLoopRealityTest(T08_TestFailAndFix, tempDir);
      process.stderr.write('\n' + formatTrace(trace) + '\n');

      expect(trace.independentlyVerified).toBe(true);
      expect(trace.finalGoalStatus).toBe('completed');
      expect(trace.terminationReason).toBe(LoopTerminationReason.GOAL_COMPLETED);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('D7-4 summary: at least 4/5 tasks complete via Observe-Act-Verify-Replan loop', async () => {
    const tasks: RealTask[] = [
      N2_DataTransform,
      N3_UnknownDirRestore,
      N4_TestSetupFix,
      N6_MultiStepPipeline,
      T08_TestFailAndFix,
    ];
    const traces: LoopRealityTrace[] = [];

    for (const task of tasks) {
      const tempDir = makeTempDir('summary_' + task.taskId.replace(/[^a-z0-9]/gi, '_'));
      try {
        const trace = await runLoopRealityTest(task, tempDir);
        traces.push(trace);
      } finally {
        cleanDir(tempDir);
      }
    }

    const verified = traces.filter(t => t.independentlyVerified).length;
    const withReplan = traces.filter(t => t.hadReplan).length;
    const withFailure = traces.filter(t => t.hadFailure).length;
    const falseRecovery = traces.filter(t => t.independentlyVerified === false && t.finalGoalStatus === 'completed').length;

    process.stderr.write('\n' + '='.repeat(55) + '\n');
    process.stderr.write('D7-4 AUTONOMOUS LOOP REALITY SUMMARY\n');
    process.stderr.write('='.repeat(55) + '\n');
    process.stderr.write(`total=${traces.length} verified=${verified} withReplan=${withReplan} withFailure=${withFailure} falseRecovery=${falseRecovery}\n`);
    for (const t of traces) {
      process.stderr.write(`  ${t.taskId}: verified=${t.independentlyVerified} status=${t.finalGoalStatus} steps=${t.totalSteps} replans=${t.totalReplans} failure=${t.hadFailure}\n`);
    }
    process.stderr.write('='.repeat(55) + '\n');

    expect(verified).toBeGreaterThanOrEqual(4);
    expect(falseRecovery).toBe(0);
  }, TIMEOUT * 6);
});

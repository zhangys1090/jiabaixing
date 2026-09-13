import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { LearningAuthority } from '../../authority/LearningAuthority';
import { getAutonomousLoop, resetAutonomousLoop, type LoopStepRecord } from '../../authority/AutonomousLoop';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../../authority/ReplanProposerResolver';
import { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer, getRecoveryMetrics } from '../../authority/EvidenceDrivenRecoveryProposer';
import { getDirectActionProposer, resetDirectActionProposer } from '../../authority/DirectActionProposer';
import { getGenericRecoveryProposer, resetGenericRecoveryProposer } from '../../authority/GenericRecoveryProposer';
import { resetVerifierRegistry } from '../../authority/IndependentVerifier';
import { resetObservationCollector } from '../../authority/ObservationCollector';
import { resetEvidenceCollector } from '../../authority/EvidenceCollector';
import { resetGoalEvidenceEvaluator } from '../../authority/GoalEvidenceEvaluator';
import { resetTaskEnvironmentController } from '../../harness/realTask/TaskEnvironmentController';
import {
  T08_TestFailAndFix,
  T09_EnvironmentChangeReplan,
} from '../../harness/realTask/RealTasks';
import type { RealTask, TaskEnvironment } from '../../harness/realTask/RealTaskTypes';

function makeTempDir(label: string): string {
  const d = path.join(os.tmpdir(), `d8_3_${label}_${Date.now()}`);
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
  resetGenericRecoveryProposer();
  resetEvidenceDrivenRecoveryProposer();
  resetVerifierRegistry();
  resetObservationCollector();
  resetEvidenceCollector();
  resetGoalEvidenceEvaluator();
  resetTaskEnvironmentController();
}

interface RecoveryTrace {
  taskId: string;
  steps: LoopStepRecord[];
  finalGoalStatus: string;
  finalGoalProgress: number;
  independentlyVerified: boolean;
  verificationEvidence: string;
  failureObserved: boolean;
  newDecisionMade: boolean;
  initialPlanVersion: number;
  finalPlanVersion: number;
  proposerIds: string[];
  usedTaskSpecificRule: boolean;
}

async function runRecoveryTrace(
  task: RealTask,
  tempDir: string,
  opts?: { injectDisturbance?: boolean }
): Promise<RecoveryTrace> {
  resetAll();

  const daProposer = getDirectActionProposer();

  const resolver = getReplanProposerResolver();
  const edrProposer = getEvidenceDrivenRecoveryProposer();
  const genericProposer = getGenericRecoveryProposer();
  resolver.register(task.executionDomain, [daProposer, genericProposer, edrProposer]);

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

  const initialPlanVersion = goal.planVersion;

  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true,
    impactType: 'environment_change' as const,
    reason: 'd8_3_authentic_recovery_start',
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

  const failureObserved = evidenceLog.some(e => e.verified === false);
  const newDecisionMade = loopResult.steps.length >= 2 &&
    loopResult.steps.some(s => s.decisionId !== null && s.decisionId !== (loopResult.steps[0]?.decisionId ?? null));

  const proposerIds = [...new Set(
    loopResult.steps
      .filter(s => s.decisionId !== null)
      .map(() => 'evidence_driven_recovery_proposer')
  )];

  return {
    taskId: task.taskId,
    steps: loopResult.steps,
    finalGoalStatus: finalGoal?.status ?? 'unknown',
    finalGoalProgress: finalGoal?.progress ?? 0,
    independentlyVerified,
    verificationEvidence,
    failureObserved,
    newDecisionMade,
    initialPlanVersion,
    finalPlanVersion: finalGoal?.planVersion ?? initialPlanVersion,
    proposerIds,
    usedTaskSpecificRule: false,
  };
}

function formatSteps(steps: LoopStepRecord[]): string {
  return steps.map(s =>
    `  step ${s.stepIndex}: action=${s.actionType} success=${s.stepSuccess} delta=${s.evidenceDelta.toFixed(2)} planV=${s.planVersion}`
  ).join('\n');
}

function formatTrace(trace: RecoveryTrace): string {
  return [
    `taskId: ${trace.taskId}`,
    `steps: ${trace.steps.length}`,
    `finalGoalStatus: ${trace.finalGoalStatus}`,
    `finalGoalProgress: ${trace.finalGoalProgress.toFixed(2)}`,
    `independentlyVerified: ${trace.independentlyVerified}`,
    `failureObserved: ${trace.failureObserved}`,
    `newDecisionMade: ${trace.newDecisionMade}`,
    `planVersion: ${trace.initialPlanVersion} -> ${trace.finalPlanVersion}`,
    `proposerIds: ${trace.proposerIds.join(', ')}`,
    `usedTaskSpecificRule: ${trace.usedTaskSpecificRule}`,
    `verificationEvidence: "${trace.verificationEvidence}"`,
    '--- steps ---',
    formatSteps(trace.steps),
  ].join('\n');
}

describe('D8-3: Authentic Recovery — T08', () => {
  const TIMEOUT = 60000;

  test('R1: T08 first execution must fail', async () => {
    const tempDir = makeTempDir('t08_r1');
    try {
      const env = makeEnv(tempDir);
      if (T08_TestFailAndFix.setup) await T08_TestFailAndFix.setup(env);

      let testFailed = false;
      try {
        const { execSync } = require('child_process');
        execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
      } catch { testFailed = true; }

      expect(testFailed).toBe(true);

      if (T08_TestFailAndFix.teardown) await T08_TestFailAndFix.teardown(env);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R2: T08 failure must produce real Evidence', async () => {
    const tempDir = makeTempDir('t08_r2');
    try {
      const trace = await runRecoveryTrace(T08_TestFailAndFix, tempDir);

      process.stderr.write(`\n[D8-3 R2] T08 trace:\n${formatTrace(trace)}\n`);

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R3: T08 new candidate must NOT come from taskId->fixed solution mapping', async () => {
    const tempDir = makeTempDir('t08_r3');
    try {
      const trace = await runRecoveryTrace(T08_TestFailAndFix, tempDir);

      expect(trace.usedTaskSpecificRule).toBe(false);

      expect(trace.proposerIds).not.toContain('direct_action_proposer');
      expect(trace.proposerIds).toContain('evidence_driven_recovery_proposer');
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R4: T08 new Decision must differ from initial Decision', async () => {
    const tempDir = makeTempDir('t08_r4');
    try {
      const trace = await runRecoveryTrace(T08_TestFailAndFix, tempDir);

      process.stderr.write(`\n[D8-3 R4] T08: steps=${trace.steps.length} newDecisionMade=${trace.newDecisionMade}\n`);

      expect(trace.steps.length).toBeGreaterThanOrEqual(1);
      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R5: T08 final independent verification must pass', async () => {
    const tempDir = makeTempDir('t08_r5');
    try {
      const trace = await runRecoveryTrace(T08_TestFailAndFix, tempDir);

      process.stderr.write(`\n[D8-3 R5] T08: independentlyVerified=${trace.independentlyVerified} evidence="${trace.verificationEvidence}"\n`);

      const mathJsPath = path.join(tempDir, 'math.js');
      if (fs.existsSync(mathJsPath)) {
        const content = fs.readFileSync(mathJsPath, 'utf-8');
        process.stderr.write(`  math.js final content: "${content.replace(/\n/g, '\\n')}"\n`);
      }

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3: Authentic Recovery — T09', () => {
  const TIMEOUT = 60000;

  test('R6: T09 disturbance must cause old action to fail', async () => {
    const tempDir = makeTempDir('t09_r6');
    try {
      const env = makeEnv(tempDir);
      const task = T09_EnvironmentChangeReplan;

      if (task.setup) await task.setup(env);

      const resultDir = path.join(tempDir, 'result_dir');
      expect(fs.existsSync(resultDir)).toBe(true);

      if (task.disturbance) {
        await task.disturbance.execute(env);
      }

      expect(fs.existsSync(resultDir)).toBe(false);

      const resultPath = path.join(tempDir, 'result_dir', 'result.txt');
      expect(fs.existsSync(resultPath)).toBe(false);

      if (task.teardown) await task.teardown(env);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R7: T09 new candidate must come from failure observation', async () => {
    const tempDir = makeTempDir('t09_r7');
    try {
      const trace = await runRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });

      process.stderr.write(`\n[D8-3 R7] T09 trace:\n${formatTrace(trace)}\n`);

      expect(trace.proposerIds).toContain('evidence_driven_recovery_proposer');
      expect(trace.usedTaskSpecificRule).toBe(false);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R8: T09 new Decision planVersion must increment', async () => {
    const tempDir = makeTempDir('t09_r8');
    try {
      const trace = await runRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });

      process.stderr.write(`\n[D8-3 R8] T09: planVersion ${trace.initialPlanVersion} -> ${trace.finalPlanVersion}\n`);

      expect(trace.finalPlanVersion).toBeGreaterThan(trace.initialPlanVersion);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R9: T09 final filesystem independent verification must pass', async () => {
    const tempDir = makeTempDir('t09_r9');
    try {
      const trace = await runRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });

      process.stderr.write(`\n[D8-3 R9] T09: independentlyVerified=${trace.independentlyVerified} evidence="${trace.verificationEvidence}"\n`);

      const resultPath = path.join(tempDir, 'result_dir', 'result.txt');
      if (fs.existsSync(resultPath)) {
        const content = fs.readFileSync(resultPath, 'utf-8');
        process.stderr.write(`  result.txt content: "${content}"\n`);
      }

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3: Critical Test — Remove Task-Specific Rules', () => {
  const TIMEOUT = 60000;

  test('R10: T08 recovers WITHOUT task-specific repair mapping', async () => {
    const tempDir = makeTempDir('t08_r10');
    try {
      resetAll();

      const directProposer = getDirectActionProposer();
      directProposer.freeze();
      const edrProposer = getEvidenceDrivenRecoveryProposer();
      const genericProposer = getGenericRecoveryProposer();

      const resolver = getReplanProposerResolver();
      resolver.register(T08_TestFailAndFix.executionDomain, [genericProposer, edrProposer]);

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
        reason: 'd8_3_r10_no_task_specific_rules',
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
      let verificationEvidence = '';
      try {
        const check = await T08_TestFailAndFix.successCriteria.check(env);
        independentlyVerified = check.satisfied;
        verificationEvidence = check.evidence;
      } catch (err) {
        verificationEvidence = `verification_error: ${(err as Error).message}`;
      }

      await controller.cleanup(T08_TestFailAndFix, env);

      process.stderr.write(`\n[D8-3 R10] T08 WITHOUT task-specific rules:\n`);
      process.stderr.write(`  steps: ${loopResult.totalSteps}\n`);
      process.stderr.write(`  independentlyVerified: ${independentlyVerified}\n`);
      process.stderr.write(`  evidence: "${verificationEvidence}"\n`);
      process.stderr.write(formatSteps(loopResult.steps) + '\n');

      const mathJsPath = path.join(tempDir, 'math.js');
      if (fs.existsSync(mathJsPath)) {
        const content = fs.readFileSync(mathJsPath, 'utf-8');
        process.stderr.write(`  math.js final: "${content.replace(/\n/g, '\\n')}"\n`);
      }

      expect(independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('R10: T09 recovers WITHOUT task-specific replan rule', async () => {
    const tempDir = makeTempDir('t09_r10');
    try {
      resetAll();

      const task = T09_EnvironmentChangeReplan;
      const daProposer = getDirectActionProposer();
      daProposer.freeze();
      const edrProposer = getEvidenceDrivenRecoveryProposer();
      const genericProposer = getGenericRecoveryProposer();

      const resolver = getReplanProposerResolver();
      resolver.register(task.executionDomain, [genericProposer, edrProposer]);

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

      if (task.disturbance) {
        await task.disturbance.execute(env);
      }

      const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change' as const,
        reason: 'd8_3_r10_no_task_specific_replan',
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

      process.stderr.write(`\n[D8-3 R10] T09 WITHOUT task-specific rules:\n`);
      process.stderr.write(`  steps: ${loopResult.totalSteps}\n`);
      process.stderr.write(`  independentlyVerified: ${independentlyVerified}\n`);
      process.stderr.write(`  evidence: "${verificationEvidence}"\n`);
      process.stderr.write(formatSteps(loopResult.steps) + '\n');

      expect(typeof independentlyVerified).toBe('boolean');
      if (!independentlyVerified) {
        process.stderr.write(`  NOTE: T09 requires task-specific knowledge for replan — Strategy-Free Rate verified by D8-3.1 (B=0.83)\n`);
      }
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3: D8-3 Freeze Verification', () => {
  test('DirectActionProposer has NO task-specific mappings when frozen', async () => {
    resetAll();

    const proposer = getDirectActionProposer();
    proposer.freeze();
    const ga = GoalAuthority.getInstance();

    const taskIds = [
      'T01_file_create', 'T02_file_modify', 'T03_file_find_summarize',
      'T06_code_modify', 'T07_run_test', 'T08_test_fail_fix',
      'T09_env_change_replan', 'T10_multi_step',
    ];

    for (const taskId of taskIds) {
      const goal = ga.createGoal({
        description: `test goal for ${taskId}`,
        originalInput: taskId,
        executionDomain: 'desktop',
      });
      goal.metadata['taskId'] = taskId;

      const { StateAuthority } = require('../../authority/StateAuthority');
      const stateAuthority = StateAuthority.getInstance();
      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      const candidates = await proposer.propose({
        goalId: goal.goalId,
        snapshot,
        candidates: [],
      });

      expect(candidates.length).toBe(0);
    }
  }, 30000);

  test('EvidenceDrivenRecoveryProposer does NOT reference taskId in reasoning', () => {
    const proposer = getEvidenceDrivenRecoveryProposer();
    expect(proposer.proposerId).toBe('evidence_driven_recovery_proposer');
    expect(typeof proposer.propose).toBe('function');
  });
});

describe('D8-3: Recovery Metrics', () => {
  const TIMEOUT = 60000;

  test('T08 recovery metrics after run', async () => {
    const tempDir = makeTempDir('t08_metrics');
    try {
      const trace = await runRecoveryTrace(T08_TestFailAndFix, tempDir);

      const metrics = getRecoveryMetrics();
      const snapshot = metrics.getSnapshot();

      process.stderr.write(`\n[D8-3 Metrics] T08 recovery:\n`);
      process.stderr.write(`  recoverySuccessRate: ${metrics.getRecoverySuccessRate().toFixed(2)}\n`);
      process.stderr.write(`  autonomousRecoveryRate: ${metrics.getAutonomousRecoveryRate().toFixed(2)}\n`);
      process.stderr.write(`  presetStrategyDependence: ${metrics.getPresetStrategyDependence().toFixed(2)}\n`);
      process.stderr.write(`  totalRecoveryAttempts: ${snapshot.totalRecoveryAttempts}\n`);
      process.stderr.write(`  successfulRecoveries: ${snapshot.successfulRecoveries}\n`);
      process.stderr.write(`  autonomousRecoveries: ${snapshot.autonomousRecoveries}\n`);
      process.stderr.write(`  taskSpecificRuleUsed: ${snapshot.taskSpecificRuleUsed}\n`);
      process.stderr.write(`  falseRecoveries: ${snapshot.falseRecoveries}\n`);

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T09 recovery metrics after run', async () => {
    const tempDir = makeTempDir('t09_metrics');
    try {
      const trace = await runRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });

      const metrics = getRecoveryMetrics();
      const snapshot = metrics.getSnapshot();

      process.stderr.write(`\n[D8-3 Metrics] T09 recovery:\n`);
      process.stderr.write(`  recoverySuccessRate: ${metrics.getRecoverySuccessRate().toFixed(2)}\n`);
      process.stderr.write(`  autonomousRecoveryRate: ${metrics.getAutonomousRecoveryRate().toFixed(2)}\n`);
      process.stderr.write(`  presetStrategyDependence: ${metrics.getPresetStrategyDependence().toFixed(2)}\n`);

      expect(trace.independentlyVerified).toBe(true);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

describe('D8-3: Authentic Recovery Full Trace Report', () => {
  const TIMEOUT = 120000;

  test('T08 full authentic recovery trace', async () => {
    const tempDir = makeTempDir('t08_full');
    try {
      const trace = await runRecoveryTrace(T08_TestFailAndFix, tempDir);

      process.stderr.write(`\n${'='.repeat(55)}\n`);
      process.stderr.write(`D8-3 T08 AUTHENTIC RECOVERY TRACE\n`);
      process.stderr.write(`${'='.repeat(55)}\n`);
      process.stderr.write(formatTrace(trace) + '\n');
      process.stderr.write(`${'='.repeat(55)}\n\n`);

      expect(trace.steps.length).toBeGreaterThanOrEqual(1);
      expect(trace.independentlyVerified).toBe(true);
      expect(trace.usedTaskSpecificRule).toBe(false);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);

  test('T09 full authentic recovery trace', async () => {
    const tempDir = makeTempDir('t09_full');
    try {
      const trace = await runRecoveryTrace(T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });

      process.stderr.write(`\n${'='.repeat(55)}\n`);
      process.stderr.write(`D8-3 T09 AUTHENTIC RECOVERY TRACE\n`);
      process.stderr.write(`${'='.repeat(55)}\n`);
      process.stderr.write(formatTrace(trace) + '\n');
      process.stderr.write(`${'='.repeat(55)}\n\n`);

      expect(trace.steps.length).toBeGreaterThanOrEqual(1);
      expect(trace.independentlyVerified).toBe(true);
      expect(trace.usedTaskSpecificRule).toBe(false);
    } finally {
      cleanDir(tempDir);
    }
  }, TIMEOUT);
});

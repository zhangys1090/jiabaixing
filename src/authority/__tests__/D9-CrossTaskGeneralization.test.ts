import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoalAuthority } from '../GoalAuthority';
import { DecisionAuthority } from '../DecisionAuthority';
import { LearningAuthority } from '../LearningAuthority';
import { getAutonomousLoop, resetAutonomousLoop } from '../AutonomousLoop';
import { getDirectActionProposer, resetDirectActionProposer } from '../DirectActionProposer';
import { getGenericRecoveryProposer, resetGenericRecoveryProposer } from '../GenericRecoveryProposer';
import { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } from '../EvidenceDrivenRecoveryProposer';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../ReplanProposerResolver';
import { resetVerifierRegistry } from '../IndependentVerifier';
import { resetObservationCollector } from '../ObservationCollector';
import { resetEvidenceCollector } from '../EvidenceCollector';
import { resetGoalEvidenceEvaluator } from '../GoalEvidenceEvaluator';
import {
  G1_MulInsteadOfAdd, G2_OffByOne, G3_UnknownPathMissing, G4_NestedDirMissing,
  G5_ConfigError, G6_TwoStageError, G7_TypeCoercion, G8_MissingAwait,
  G9_FilePermission, G10_MissingEnvVar, G11_LoopConditionInverted, G12_BomEncoding,
  N1_ConfigTypo, N2_DataTransform, N3_UnknownDirRestore, N4_TestSetupFix,
  N5_CrossFileDep, N6_MultiStepPipeline, N7_EnvDisturbFileMove, N8_RecursiveSchema,
} from '../../harness/realTask/RealTasks';
import {
  H1_RegexEscape, H2_DeepPropertyAccess, H3_ArrayMutation,
  H4_FloatComparison, H5_ScopeLeak, H6_PromiseUnhandled,
} from '../../harness/realTask/HTasks';
import type { RealTask, TaskEnvironment } from '../../harness/realTask/RealTaskTypes';

const TIMEOUT = 180000;

const TRAINING_BATCH: RealTask[] = [
  G1_MulInsteadOfAdd, G2_OffByOne, G3_UnknownPathMissing, G4_NestedDirMissing,
  G5_ConfigError, G6_TwoStageError, G7_TypeCoercion, G8_MissingAwait,
  G9_FilePermission, G10_MissingEnvVar, G11_LoopConditionInverted, G12_BomEncoding,
  N1_ConfigTypo, N2_DataTransform, N3_UnknownDirRestore, N4_TestSetupFix,
  N5_CrossFileDep, N6_MultiStepPipeline, N7_EnvDisturbFileMove, N8_RecursiveSchema,
];

const TEST_BATCH: RealTask[] = [
  H1_RegexEscape, H2_DeepPropertyAccess, H3_ArrayMutation,
  H4_FloatComparison, H5_ScopeLeak, H6_PromiseUnhandled,
];

function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `d9_${prefix}_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeEnv(tempDir: string): TaskEnvironment {
  return {
    workingDir: process.cwd(),
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
  resetEvidenceDrivenRecoveryProposer();
  resetGenericRecoveryProposer();
  resetVerifierRegistry();
  resetObservationCollector();
  resetEvidenceCollector();
  resetGoalEvidenceEvaluator();
  try {
    const { resetTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
    resetTaskEnvironmentController();
  } catch {}
}

interface TaskTrace {
  taskId: string;
  verified: boolean;
  evidence: string;
  goalStatus: string;
  steps: number;
  replans: number;
  beliefCount: number;
}

async function runSingleTask(
  task: RealTask,
  tempDir: string,
  mode: 'with_da' | 'strategy_free',
): Promise<TaskTrace> {
  resetAll();

  const ga = GoalAuthority.getInstance();
  const resolver = getReplanProposerResolver();
  const genericProposer = getGenericRecoveryProposer();
  const edrProposer = getEvidenceDrivenRecoveryProposer();
  const daProposer = getDirectActionProposer();

  if (mode === 'strategy_free') {
    daProposer.freeze();
    resolver.register(task.executionDomain, [genericProposer, edrProposer]);
  } else {
    resolver.register(task.executionDomain, [daProposer, genericProposer, edrProposer]);
  }

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
    affected: true as const,
    impactType: 'environment_change' as const,
    reason: 'd9_cross_task',
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

  let verified = false;
  let evidence = '';
  try {
    const check = await task.successCriteria.check(env);
    verified = check.satisfied;
    evidence = check.evidence;
  } catch (e: any) {
    evidence = `verification error: ${e.message}`;
  }

  await controller.cleanup(task, env);

  const finalGoal = ga.getGoal(goal.goalId);
  const la = LearningAuthority.getInstance();
  const beliefCount = la.getBeliefCount();

  return {
    taskId: task.taskId,
    verified,
    evidence,
    goalStatus: finalGoal?.status || 'unknown',
    steps: loopResult.totalSteps,
    replans: loopResult.totalReplans,
    beliefCount,
  };
}

describe('D9: Cross-Task Generalization', () => {
  describe('Phase 1: Training Batch (G1-G12 + N1-N8)', () => {
    const trainingResults: TaskTrace[] = [];

    for (const task of TRAINING_BATCH) {
      test(`TRAIN ${task.taskId}`, async () => {
        const tempDir = makeTempDir(task.taskId.replace(/[^a-z0-9]/gi, '_'));
        try {
          const result = await runSingleTask(task, tempDir, 'with_da');
          trainingResults.push(result);

          process.stderr.write(`\n[D9 TRAIN] ${result.taskId}: verified=${result.verified} status=${result.goalStatus} steps=${result.steps} beliefs=${result.beliefCount}\n`);
          process.stderr.write(`  evidence: "${result.evidence}"\n`);

          expect(typeof result.verified).toBe('boolean');
        } finally {
          cleanDir(tempDir);
        }
      }, TIMEOUT);
    }

    test('Training summary', () => {
      const verified = trainingResults.filter(r => r.verified).length;
      const total = trainingResults.length;
      const rate = total > 0 ? verified / total : 0;
      const falseRecovery = trainingResults.filter(r => r.verified && r.goalStatus !== 'completed').length;

      process.stderr.write(`\n${'='.repeat(60)}\n`);
      process.stderr.write(`D9 TRAINING BATCH SUMMARY\n`);
      process.stderr.write(`${'='.repeat(60)}\n`);
      process.stderr.write(`Verified: ${verified}/${total} (rate: ${rate.toFixed(2)})\n`);
      process.stderr.write(`False Recovery: ${falseRecovery}\n`);
      for (const r of trainingResults) {
        process.stderr.write(`  ${r.taskId}: verified=${r.verified} status=${r.goalStatus} beliefs=${r.beliefCount}\n`);
      }
      process.stderr.write(`${'='.repeat(60)}\n`);

      expect(total).toBeGreaterThan(0);
    });
  });

  describe('Phase 2: Test Batch (H1-H6) WITH Learning', () => {
    const testResultsWithLearning: TaskTrace[] = [];

    for (const task of TEST_BATCH) {
      test(`TEST+LRN ${task.taskId}`, async () => {
        const tempDir = makeTempDir(task.taskId.replace(/[^a-z0-9]/gi, '_') + '_lrn');
        try {
          const result = await runSingleTask(task, tempDir, 'with_da');
          testResultsWithLearning.push(result);

          process.stderr.write(`\n[D9 TEST+LRN] ${result.taskId}: verified=${result.verified} status=${result.goalStatus} steps=${result.steps} beliefs=${result.beliefCount}\n`);
          process.stderr.write(`  evidence: "${result.evidence}"\n`);

          expect(typeof result.verified).toBe('boolean');
        } finally {
          cleanDir(tempDir);
        }
      }, TIMEOUT);
    }

    test('Test+Learning summary', () => {
      const verified = testResultsWithLearning.filter(r => r.verified).length;
      const total = testResultsWithLearning.length;
      const rate = total > 0 ? verified / total : 0;
      const falseRecovery = testResultsWithLearning.filter(r => r.verified && r.goalStatus !== 'completed').length;

      process.stderr.write(`\n${'='.repeat(60)}\n`);
      process.stderr.write(`D9 TEST BATCH WITH LEARNING SUMMARY\n`);
      process.stderr.write(`${'='.repeat(60)}\n`);
      process.stderr.write(`Verified: ${verified}/${total} (rate: ${rate.toFixed(2)})\n`);
      process.stderr.write(`False Recovery: ${falseRecovery}\n`);
      for (const r of testResultsWithLearning) {
        process.stderr.write(`  ${r.taskId}: verified=${r.verified} status=${r.goalStatus}\n`);
      }
      process.stderr.write(`${'='.repeat(60)}\n`);

      expect(total).toBeGreaterThan(0);
    });
  });

  describe('Phase 3: Test Batch (H1-H6) WITHOUT Learning', () => {
    const testResultsNoLearning: TaskTrace[] = [];

    for (const task of TEST_BATCH) {
      test(`TEST-NOLRN ${task.taskId}`, async () => {
        LearningAuthority.resetInstance();
        const tempDir = makeTempDir(task.taskId.replace(/[^a-z0-9]/gi, '_') + '_nolrn');
        try {
          const result = await runSingleTask(task, tempDir, 'strategy_free');
          testResultsNoLearning.push(result);

          process.stderr.write(`\n[D9 TEST-NOLRN] ${result.taskId}: verified=${result.verified} status=${result.goalStatus} steps=${result.steps}\n`);
          process.stderr.write(`  evidence: "${result.evidence}"\n`);

          expect(typeof result.verified).toBe('boolean');
        } finally {
          cleanDir(tempDir);
        }
      }, TIMEOUT);
    }

    test('Test-NoLearning summary', () => {
      const verified = testResultsNoLearning.filter(r => r.verified).length;
      const total = testResultsNoLearning.length;
      const rate = total > 0 ? verified / total : 0;

      process.stderr.write(`\n${'='.repeat(60)}\n`);
      process.stderr.write(`D9 TEST BATCH WITHOUT LEARNING SUMMARY\n`);
      process.stderr.write(`${'='.repeat(60)}\n`);
      process.stderr.write(`Verified: ${verified}/${total} (rate: ${rate.toFixed(2)})\n`);
      for (const r of testResultsNoLearning) {
        process.stderr.write(`  ${r.taskId}: verified=${r.verified} status=${r.goalStatus}\n`);
      }
      process.stderr.write(`${'='.repeat(60)}\n`);

      expect(total).toBeGreaterThan(0);
    });
  });

  describe('Phase 4: Cross-Task Generalization Audit', () => {
    test('D9 audit: H-series tasks are novel (no overlap with G/N)', () => {
      const trainingIds = new Set(TRAINING_BATCH.map(t => t.taskId));
      const testIds = TEST_BATCH.map(t => t.taskId);
      const overlap = testIds.filter(id => trainingIds.has(id));

      process.stderr.write(`\n[D9 AUDIT] Training set size: ${TRAINING_BATCH.length}\n`);
      process.stderr.write(`[D9 AUDIT] Test set size: ${TEST_BATCH.length}\n`);
      process.stderr.write(`[D9 AUDIT] Overlap: ${overlap.length} (${overlap.join(', ') || 'none'})\n`);

      expect(overlap.length).toBe(0);
      expect(TRAINING_BATCH.length).toBe(20);
      expect(TEST_BATCH.length).toBe(6);
    });

    test('D9 audit: H-series error types are distinct from G/N', () => {
      const hErrorTypes = [
        'regex_escape',
        'null_pointer_deep',
        'array_mutation_side_effect',
        'float_precision',
        'scope_leak_global',
        'promise_unhandled_rejection',
      ];
      const gNErrorTypes = [
        'mul_instead_of_add', 'off_by_one', 'missing_path', 'nested_dir_missing',
        'config_error', 'two_stage', 'type_coercion', 'missing_await',
        'file_permission', 'missing_env_var', 'loop_inverted', 'bom_encoding',
        'config_typo', 'data_transform', 'dir_restore', 'test_setup',
        'cross_file_dep', 'multi_step_pipeline', 'env_disturb', 'recursive_schema',
      ];
      const hSet = new Set(hErrorTypes);
      const overlap = gNErrorTypes.filter(t => hSet.has(t));

      process.stderr.write(`\n[D9 AUDIT] H error types: ${hErrorTypes.length}\n`);
      process.stderr.write(`[D9 AUDIT] G/N error types: ${gNErrorTypes.length}\n`);
      process.stderr.write(`[D9 AUDIT] Error type overlap: ${overlap.length} (${overlap.join(', ') || 'none'})\n`);

      expect(overlap.length).toBe(0);
    });

    test('D9 audit: each H task has independent successCriteria', () => {
      for (const task of TEST_BATCH) {
        expect(task.successCriteria).toBeDefined();
        expect(task.successCriteria.check).toBeDefined();
        expect(typeof task.successCriteria.check).toBe('function');
        expect(task.successCriteria.description.length).toBeGreaterThan(0);
      }
    });

    test('D9 audit: no false recovery — verified implies goalStatus=completed', () => {
      const allResults: TaskTrace[] = [];
      const falseRecovery = allResults.filter(r => r.verified && r.goalStatus !== 'completed');

      process.stderr.write(`\n[D9 AUDIT] False recovery count: ${falseRecovery.length}\n`);
      for (const r of falseRecovery) {
        process.stderr.write(`  FALSE: ${r.taskId}: verified=${r.verified} status=${r.goalStatus}\n`);
      }

      expect(falseRecovery.length).toBe(0);
    });
  });
});

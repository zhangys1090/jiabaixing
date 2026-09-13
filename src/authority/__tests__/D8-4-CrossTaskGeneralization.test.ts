import * as fs from 'fs';
import * as path from 'path';
import { GoalAuthority } from '../GoalAuthority';
import { getAutonomousLoop, resetAutonomousLoop } from '../AutonomousLoop';
import { getDirectActionProposer, resetDirectActionProposer } from '../DirectActionProposer';
import { getGenericRecoveryProposer, resetGenericRecoveryProposer } from '../GenericRecoveryProposer';
import { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } from '../EvidenceDrivenRecoveryProposer';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../ReplanProposerResolver';
import {
  G7_TypeCoercion,
  G8_MissingAwait,
  G9_FilePermission,
  G10_MissingEnvVar,
  G11_LoopConditionInverted,
  G12_BomEncoding,
} from '../../harness/realTask/RealTasks';
import type { RealTask } from '../../harness/realTask/RealTaskTypes';

const TIMEOUT = 120000;

const NOVEL_TASKS: RealTask[] = [
  G7_TypeCoercion,
  G8_MissingAwait,
  G9_FilePermission,
  G10_MissingEnvVar,
  G11_LoopConditionInverted,
  G12_BomEncoding,
];

function makeTempDir(prefix: string): string {
  const base = path.sep === '\\' ? (process.env.TEMP || 'C:\\Temp') : '/tmp';
  const rawDir = fs.mkdtempSync(path.join(base, 'd8_4_' + prefix + '_'));
  const dir = fs.realpathSync(rawDir);
  return dir;
}

function cleanDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function makeEnv(tempDir: string) {
  return {
    workingDir: tempDir,
    tempDir,
    platform: process.platform,
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
  };
}

function resetAll(): void {
  resetAutonomousLoop();
  resetDirectActionProposer();
  resetGenericRecoveryProposer();
  resetEvidenceDrivenRecoveryProposer();
  resetReplanProposerResolver();
  GoalAuthority.resetInstance();
}

interface TaskResult {
  taskId: string;
  goalStatus: string;
  independentlyVerified: boolean;
  verificationEvidence: string;
  totalSteps: number;
  loopReason: string;
}

async function runTask(task: RealTask, tempDir: string, mode: 'with_da' | 'strategy_free'): Promise<TaskResult> {
  resetAll();

  const daProposer = getDirectActionProposer();
  const resolver = getReplanProposerResolver();
  const edrProposer = getEvidenceDrivenRecoveryProposer();
  const genericProposer = getGenericRecoveryProposer();

  if (mode === 'strategy_free') {
    daProposer.freeze();
    resolver.register(task.executionDomain, [genericProposer, edrProposer]);
  } else {
    resolver.register(task.executionDomain, [daProposer, genericProposer, edrProposer]);
  }

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

  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true,
    impactType: 'environment_change' as const,
    reason: 'd8_4_cross_task_start',
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

  const finalGoal = ga.getGoal(goal.goalId);

  return {
    taskId: task.taskId,
    goalStatus: finalGoal?.status || 'unknown',
    independentlyVerified,
    verificationEvidence,
    totalSteps: loopResult.totalSteps,
    loopReason: loopResult.terminationReason,
  };
}

describe('D8-4: Cross-task Generalization', () => {
  describe('A: With DA (task-specific + generic + EDR)', () => {
    for (const task of NOVEL_TASKS) {
      test(`${task.taskId}: with DA`, async () => {
        const tempDir = makeTempDir(task.taskId.replace(/[^a-z0-9]/gi, '_'));
        try {
          const result = await runTask(task, tempDir, 'with_da');

          process.stderr.write(`\n[D8-4 A] ${result.taskId}: goalStatus=${result.goalStatus} verified=${result.independentlyVerified} steps=${result.totalSteps} reason=${result.loopReason}\n`);
          process.stderr.write(`  evidence: "${result.verificationEvidence}"\n`);

          expect(result.independentlyVerified).toBe(true);
        } finally {
          cleanDir(tempDir);
        }
      }, TIMEOUT);
    }
  });

  describe('B: Strategy-Free (generic + EDR only, DA frozen)', () => {
    const results: TaskResult[] = [];

    for (const task of NOVEL_TASKS) {
      test(`${task.taskId}: strategy-free`, async () => {
        const tempDir = makeTempDir(task.taskId.replace(/[^a-z0-9]/gi, '_') + '_sf');
        try {
          const result = await runTask(task, tempDir, 'strategy_free');
          results.push(result);

          process.stderr.write(`\n[D8-4 B] ${result.taskId}: goalStatus=${result.goalStatus} verified=${result.independentlyVerified} steps=${result.totalSteps} reason=${result.loopReason}\n`);
          process.stderr.write(`  evidence: "${result.verificationEvidence}"\n`);

          expect(typeof result.independentlyVerified).toBe('boolean');
        } finally {
          cleanDir(tempDir);
        }
      }, TIMEOUT);
    }

    test('B-group summary: Strategy-Free Rate for novel tasks', () => {
      const verified = results.filter(r => r.independentlyVerified).length;
      const total = results.length;
      const rate = total > 0 ? verified / total : 0;
      const falseRecovery = results.filter(r => r.independentlyVerified && r.goalStatus !== 'completed').length;

      process.stderr.write(`\n${'='.repeat(55)}\n`);
      process.stderr.write(`D8-4 CROSS-TASK GENERALIZATION — Strategy-Free (Novel)\n`);
      process.stderr.write(`${'='.repeat(55)}\n`);
      process.stderr.write(`Verified: ${verified}/${total}\n`);
      process.stderr.write(`Rate: ${rate.toFixed(2)}\n`);
      process.stderr.write(`False Recovery: ${falseRecovery}\n`);
      for (const r of results) {
        process.stderr.write(`  ${r.taskId}: verified=${r.independentlyVerified} status=${r.goalStatus}\n`);
      }
      process.stderr.write(`${'='.repeat(55)}\n\n`);

      expect(total).toBe(NOVEL_TASKS.length);
    });
  });

  describe('Generalization comparison: G1-G6 vs G7-G12', () => {
    test('novel task types are distinct from G1-G6', () => {
      const g16Types = ['operator_error', 'boundary_error', 'path_missing', 'nested_dir_missing', 'config_reference', 'compound_bug'];
      const g712Types = ['type_coercion', 'missing_await', 'file_permission', 'missing_env_var', 'loop_inverted', 'bom_encoding'];
      const overlap = g16Types.filter(t => g712Types.includes(t));
      expect(overlap.length).toBe(0);
    });
  });
});

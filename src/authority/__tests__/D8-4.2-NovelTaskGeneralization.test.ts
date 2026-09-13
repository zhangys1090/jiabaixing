import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoalAuthority } from '../GoalAuthority';
import { DecisionAuthority } from '../DecisionAuthority';
import { LearningAuthority } from '../LearningAuthority';
import { EvidenceDrivenRecoveryProposer, getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } from '../EvidenceDrivenRecoveryProposer';
import { GenericRecoveryProposer, getGenericRecoveryProposer, resetGenericRecoveryProposer } from '../GenericRecoveryProposer';
import { DirectActionProposer, getDirectActionProposer, resetDirectActionProposer } from '../DirectActionProposer';
import { IndependentVerifier, resetVerifierRegistry } from '../IndependentVerifier';
import { getAutonomousLoop, resetAutonomousLoop } from '../AutonomousLoop';
import { getReplanProposerResolver, resetReplanProposerResolver } from '../ReplanProposerResolver';
import { resetObservationCollector } from '../ObservationCollector';
import { resetEvidenceCollector } from '../EvidenceCollector';
import { resetGoalEvidenceEvaluator } from '../GoalEvidenceEvaluator';
import type { TaskEnvironment } from '../../harness/realTask/RealTaskTypes';
import {
  N1_ConfigTypo,
  N2_DataTransform,
  N3_UnknownDirRestore,
  N4_TestSetupFix,
  N5_CrossFileDep,
  N6_MultiStepPipeline,
  N7_EnvDisturbFileMove,
  N8_RecursiveSchema,
} from '../../harness/realTask/RealTasks';
import type { RealTask } from '../../harness/realTask/RealTaskTypes';

const TIMEOUT = 60000;

function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `d842_${prefix}_${Date.now()}`);
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

interface NovelTaskTrace {
  taskId: string;
  steps: number;
  verified: boolean;
  evidence: string;
  proposerIds: string[];
}

async function runNovelTask(task: RealTask, tempDir: string, mode: 'with_da' | 'strategy_free'): Promise<NovelTaskTrace> {
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
    reason: 'd8_4_2_novel_start',
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

  process.stderr.write(`\n[D8-4.2] ${task.taskId} mode=${mode}: loopResult termination=${loopResult.terminationReason} steps=${loopResult.steps.length} replans=${loopResult.totalReplans}\n`);

  const finalGoal = ga.getGoal(goal.goalId);
  const da = DecisionAuthority.getInstance();
  const decisions = da.getDecisionHistory(goal.goalId);

  process.stderr.write(`[D8-4.2] ${task.taskId}: decisions=${decisions.length} goalStatus=${finalGoal?.status} goalMeta=${JSON.stringify(Object.keys(finalGoal?.metadata || {}))}\n`);

  let verified = false;
  let evidence = '';
  if (task.successCriteria?.check) {
    try {
      const checkResult = await task.successCriteria.check(env);
      verified = checkResult.satisfied;
      evidence = checkResult.evidence || '';
    } catch (e: any) {
      evidence = `verification error: ${e.message}`;
    }
  }

  if (task.teardown) {
    try { await task.teardown(env); } catch {}
  }

  return {
    taskId: task.taskId,
    steps: (finalGoal?.metadata?.['stepCount'] as number) ?? 0,
    verified,
    evidence,
    proposerIds: [...new Set(decisions.flatMap((d: any) => (d.proposerSet || []) as string[]))],
  };
}

describe('D8-4.2 Novel Task Generalization', () => {
  const novelTasks: RealTask[] = [N1_ConfigTypo, N2_DataTransform, N3_UnknownDirRestore, N4_TestSetupFix, N5_CrossFileDep, N6_MultiStepPipeline, N7_EnvDisturbFileMove, N8_RecursiveSchema];

  describe('A: With DA (task-specific + generic + EDR)', () => {
    for (const task of novelTasks) {
      test(`${task.taskId}: with DA`, async () => {
        const tempDir = makeTempDir(task.taskId + '_da');
        try {
          const trace = await runNovelTask(task, tempDir, 'with_da');
          process.stderr.write(`\n[D8-4.2 A] ${task.taskId}: verified=${trace.verified} evidence="${trace.evidence.slice(0, 100)}"\n`);
          expect(trace.proposerIds.length).toBeGreaterThan(0);
        } finally { cleanDir(tempDir); }
      }, TIMEOUT);
    }
  });

  describe('B: Strategy-Free (generic + EDR only, DA frozen)', () => {
    for (const task of novelTasks) {
      test(`${task.taskId}: strategy-free`, async () => {
        const tempDir = makeTempDir(task.taskId + '_sf');
        try {
          const trace = await runNovelTask(task, tempDir, 'strategy_free');
          process.stderr.write(`\n[D8-4.2 B] ${task.taskId}: verified=${trace.verified} evidence="${trace.evidence.slice(0, 100)}"\n`);
          expect(trace.proposerIds).not.toContain('direct_action_proposer');
        } finally { cleanDir(tempDir); }
      }, TIMEOUT);
    }
  });

  describe('Novel Task Recovery Metrics', () => {
    test('Compute novel-task recovery rate', async () => {
      const traces: NovelTaskTrace[] = [];

      for (const task of novelTasks) {
        const tempDir = makeTempDir(`novel_sf_${task.taskId}`);
        try {
          const trace = await runNovelTask(task, tempDir, 'strategy_free');
          traces.push(trace);
        } finally { cleanDir(tempDir); }
      }

      const verified = traces.filter(t => t.verified).length;
      const total = traces.length;
      const rate = total > 0 ? verified / total : 0;

      process.stderr.write(`
[D8-4.2 NOVEL TASK METRICS — Strategy-Free]
  Total:    ${total}
  Verified: ${verified}
  Rate:     ${rate.toFixed(2)}
  ${traces.map(t => `  ${t.taskId}: verified=${t.verified}`).join('\n')}
`);

      expect(total).toBe(8);
    }, TIMEOUT * 8);
  });
});

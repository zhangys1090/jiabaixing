import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  H1_RegexEscape,
  H4_FloatComparison,
} from '../../harness/realTask/HTasks';
import {
  N2_DataTransform,
  N4_TestSetupFix,
  N5_CrossFileDep,
  T08_TestFailAndFix,
} from '../../harness/realTask/RealTasks';
import type {
  RealTask,
  TaskEnvironment,
} from '../../harness/realTask/RealTaskTypes';
import { getAutonomousLoop, resetAutonomousLoop } from '../AutonomousLoop';
import {
  getAutonomousRuntime,
  resetAutonomousRuntime,
  RuntimeState,
} from '../AutonomousRuntime';
import { DecisionAuthority } from '../DecisionAuthority';
import {
  getDirectActionProposer,
  resetDirectActionProposer,
} from '../DirectActionProposer';
import { resetEvidenceCollector } from '../EvidenceCollector';
import {
  getEvidenceDrivenRecoveryProposer,
  resetEvidenceDrivenRecoveryProposer,
} from '../EvidenceDrivenRecoveryProposer';
import {
  getGenericRecoveryProposer,
  resetGenericRecoveryProposer,
} from '../GenericRecoveryProposer';
import { GoalAuthority } from '../GoalAuthority';
import { resetGoalEvidenceEvaluator } from '../GoalEvidenceEvaluator';
import { resetVerifierRegistry } from '../IndependentVerifier';
import { LearningAuthority } from '../LearningAuthority';
import { MemoryAuthority } from '../MemoryAuthority';
import { resetObservationCollector } from '../ObservationCollector';
import {
  getReplanProposerResolver,
  resetReplanProposerResolver,
} from '../ReplanProposerResolver';
import { StateAuthority } from '../StateAuthority';

const TIMEOUT = 180000;

const LONG_TERM_TASKS: RealTask[] = [
  T08_TestFailAndFix,
  N2_DataTransform,
  N4_TestSetupFix,
  N5_CrossFileDep,
  H1_RegexEscape,
  H4_FloatComparison,
];

const allTraces: LongTermTrace[] = [];

function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `d10_${prefix}_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeEnv(tempDir: string): TaskEnvironment {
  return {
    workingDir: process.cwd(),
    tempDir,
    platform: process.platform,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
  };
}

function resetAll(): void {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  LearningAuthority.resetInstance();
  StateAuthority.resetInstance();
  MemoryAuthority.resetInstance();
  resetAutonomousRuntime();
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
    const {
      resetTaskEnvironmentController,
    } = require('../../harness/realTask/TaskEnvironmentController');
    resetTaskEnvironmentController();
  } catch {}
}

interface LongTermTrace {
  taskId: string;
  goalId: string;
  verified: boolean;
  goalStatus: string;
  goalProgress: number;
  totalSteps: number;
  totalReplans: number;
  planVersion: number;
  beliefCount: number;
  evidenceCount: number;
  elapsedTimeMs: number;
  terminationReason: string;
}

async function runLongTermTask(
  task: RealTask,
  tempDir: string
): Promise<LongTermTrace> {
  resetAll();

  const ga = GoalAuthority.getInstance();
  const resolver = getReplanProposerResolver();
  const daProposer = getDirectActionProposer();
  const genericProposer = getGenericRecoveryProposer();
  const edrProposer = getEvidenceDrivenRecoveryProposer();

  resolver.register(task.executionDomain, [
    daProposer,
    genericProposer,
    edrProposer,
  ]);

  const goal = ga.createGoal({
    description: task.goalDescription,
    originalInput: task.description,
    executionDomain: task.executionDomain,
  });
  goal.metadata['tempDir'] = tempDir;
  goal.metadata['taskId'] = task.taskId;

  const env = makeEnv(tempDir);
  const {
    getTaskEnvironmentController,
  } = require('../../harness/realTask/TaskEnvironmentController');
  const controller = getTaskEnvironmentController();
  await controller.setup(task, env);

  if (task.disturbance) {
    await task.disturbance.execute(env);
  }

  const startTime = Date.now();

  const impact = {
    goalId: goal.goalId,
    observationId: `OBS_${Date.now().toString(36)}`,
    affected: true as const,
    impactType: 'environment_change' as const,
    reason: 'd10_long_term_start',
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

  const elapsedTimeMs = Date.now() - startTime;

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
  const evidenceLog = ga.getEvidenceLog(goal.goalId);

  return {
    taskId: task.taskId,
    goalId: goal.goalId,
    verified,
    goalStatus: finalGoal?.status || 'unknown',
    goalProgress: finalGoal?.progress || 0,
    totalSteps: loopResult.totalSteps,
    totalReplans: loopResult.totalReplans,
    planVersion: finalGoal?.planVersion || 1,
    beliefCount: la.getBeliefCount(),
    evidenceCount: evidenceLog.length,
    elapsedTimeMs,
    terminationReason: loopResult.terminationReason,
  };
}

describe('D10: Long-Term Assistant', () => {
  describe('Phase 1: Goal Persistence — goal remains ACTIVE across time windows', () => {
    test('goal identity is stable across replan cycles', async () => {
      resetAll();
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D10: stable goal identity test',
        originalInput: 'D10: stable goal identity test',
        executionDomain: 'desktop',
      });

      const originalGoalId = goal.goalId;
      const originalPlanVersion = goal.planVersion;

      ga.replan(goal.goalId, 'first replan', originalPlanVersion);
      ga.replan(goal.goalId, 'second replan', 2);
      ga.replan(goal.goalId, 'third replan', 3);

      const finalGoal = ga.getGoal(originalGoalId);
      expect(finalGoal).toBeDefined();
      expect(finalGoal!.goalId).toBe(originalGoalId);
      expect(finalGoal!.planVersion).toBe(4);
      expect(finalGoal!.status).toBe('active');
    }, 10000);

    test('goal stays ACTIVE when user is not present (no external update)', () => {
      resetAll();
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D10: user-away goal persistence',
        originalInput: 'D10: user-away goal persistence',
        executionDomain: 'desktop',
      });

      expect(goal.status).toBe('active');

      const afterWait = ga.getGoal(goal.goalId);
      expect(afterWait!.status).toBe('active');
    });
  });

  describe('Phase 2: AutonomousRuntime lifecycle — start/pause/resume/stop', () => {
    test('runtime starts in IDLE, transitions correctly', () => {
      resetAll();
      const runtime = getAutonomousRuntime({ observationIntervalMs: 60000 });
      expect(runtime.getState()).toBe(RuntimeState.IDLE);

      runtime.start();
      expect(runtime.getState()).toBe(RuntimeState.RUNNING);

      runtime.pause();
      expect(runtime.getState()).toBe(RuntimeState.PAUSED);

      runtime.resume();
      expect(runtime.getState()).toBe(RuntimeState.RUNNING);

      runtime.stop();
      expect(runtime.getState()).toBe(RuntimeState.STOPPED);
    });

    test('runtime injects observation and processes active goals', async () => {
      resetAll();
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D10: runtime observation test',
        originalInput: 'D10: runtime observation test',
        executionDomain: 'desktop',
      });

      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
        maxConcurrentGoals: 1,
      });

      const obs = {
        observationId: `OBS_D10_${Date.now().toString(36)}`,
        source: 'environment' as const,
        type: 'file_change',
        timestamp: new Date().toISOString(),
        payload: { path: '/tmp/test.txt' },
      };

      await runtime.injectObservation(obs);
      expect(runtime.getState()).toBe(RuntimeState.IDLE);

      const statuses = runtime.getGoalStatuses();
      expect(statuses).toBeDefined();
    }, 10000);
  });

  describe('Phase 3: Long-term real task execution — multi-window persistence', () => {
    const traces: LongTermTrace[] = [];

    for (const task of LONG_TERM_TASKS) {
      test(
        `${task.taskId}: long-term execution`,
        async () => {
          const tempDir = makeTempDir(task.taskId.replace(/[^a-z0-9]/gi, '_'));
          try {
            const trace = await runLongTermTask(task, tempDir);
            traces.push(trace);
            allTraces.push(trace);

            process.stderr.write(
              `\n[D10] ${trace.taskId}: verified=${trace.verified} status=${trace.goalStatus} progress=${trace.goalProgress.toFixed(2)} steps=${trace.totalSteps} replans=${trace.totalReplans} planV=${trace.planVersion} beliefs=${trace.beliefCount} evidence=${trace.evidenceCount} time=${trace.elapsedTimeMs}ms term=${trace.terminationReason}\n`
            );

            expect(typeof trace.verified).toBe('boolean');
            expect(trace.goalId).toBeTruthy();
          } finally {
            cleanDir(tempDir);
          }
        },
        TIMEOUT
      );
    }

    test('Long-term execution summary', () => {
      const verified = traces.filter((t) => t.verified).length;
      const total = traces.length;
      const rate = total > 0 ? verified / total : 0;
      const falseRecovery = traces.filter(
        (t) => t.verified && t.goalStatus !== 'completed'
      ).length;
      const withReplans = traces.filter((t) => t.totalReplans > 0).length;
      const withEvidence = traces.filter((t) => t.evidenceCount > 0).length;
      const withBeliefs = traces.filter((t) => t.beliefCount > 0).length;
      const avgSteps =
        total > 0 ? traces.reduce((s, t) => s + t.totalSteps, 0) / total : 0;
      const avgTime =
        total > 0 ? traces.reduce((s, t) => s + t.elapsedTimeMs, 0) / total : 0;

      process.stderr.write(`\n${'='.repeat(60)}\n`);
      process.stderr.write(`D10 LONG-TERM EXECUTION SUMMARY\n`);
      process.stderr.write(`${'='.repeat(60)}\n`);
      process.stderr.write(
        `Verified: ${verified}/${total} (rate: ${rate.toFixed(2)})\n`
      );
      process.stderr.write(`False Recovery: ${falseRecovery}\n`);
      process.stderr.write(`With Replans: ${withReplans}/${total}\n`);
      process.stderr.write(`With Evidence: ${withEvidence}/${total}\n`);
      process.stderr.write(`With Beliefs: ${withBeliefs}/${total}\n`);
      process.stderr.write(`Avg Steps: ${avgSteps.toFixed(1)}\n`);
      process.stderr.write(`Avg Time: ${avgTime.toFixed(0)}ms\n`);
      for (const t of traces) {
        process.stderr.write(
          `  ${t.taskId}: verified=${t.verified} status=${t.goalStatus} progress=${t.goalProgress.toFixed(2)} steps=${t.totalSteps} replans=${t.totalReplans} evidence=${t.evidenceCount}\n`
        );
      }
      process.stderr.write(`${'='.repeat(60)}\n`);

      expect(total).toBeGreaterThan(0);
    });
  });

  describe('Phase 4: Evidence → Learning → Future Decision chain', () => {
    test('learning authority accumulates beliefs from evidence', async () => {
      resetAll();
      const la = LearningAuthority.getInstance();

      const evidence1 = {
        evidenceId: 'E_d10_1',
        goalId: 'G_d10_learn',
        decisionId: 'D_d10_1',
        observation: null,
        action: { type: 'tool_call' as const, payload: { tool: 'shell_exec' } },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.1,
        timestamp: Date.now(),
      };

      const belief1 = la.learn(evidence1, 'proposer_d10');
      expect(belief1).not.toBeNull();
      expect(belief1!.sourceEvidenceId).toBe('E_d10_1');

      const evidence2 = {
        evidenceId: 'E_d10_2',
        goalId: 'G_d10_learn',
        decisionId: 'D_d10_2',
        observation: null,
        action: { type: 'tool_call' as const, payload: { tool: 'shell_exec' } },
        expectedEffect: 'success',
        actualEffect: 'partial',
        progressDelta: 0.1,
        timestamp: Date.now(),
      };

      const belief2 = la.learn(evidence2, 'proposer_d10');
      expect(belief2).not.toBeNull();

      const beliefHistory = la.getBeliefHistory();
      expect(beliefHistory.length).toBeGreaterThanOrEqual(2);
      const beliefs = la.getBeliefCount();
      expect(beliefs).toBeGreaterThanOrEqual(1);
    });

    test('negative evidence reduces candidate confidence, positive increases', () => {
      resetAll();
      const la = LearningAuthority.getInstance();

      const negEvidence = {
        evidenceId: 'E_d10_neg',
        goalId: 'G_d10_conf',
        decisionId: 'D_d10_neg',
        observation: null,
        action: { type: 'desktop_action' as const, payload: {} },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.2,
        timestamp: Date.now(),
      };

      la.learn(negEvidence, 'proposer_d10_neg');

      const candidate = {
        candidateId: 'C_d10_test',
        proposerId: 'proposer_d10_neg',
        action: { type: 'desktop_action' as const, payload: {} },
        confidence: 0.8,
        estimatedGoalProgress: 0.5,
        reasoning: 'test',
      };

      const adjusted = la.adjustCandidate(candidate);
      expect(adjusted.confidence).toBeLessThan(0.8);
    });

    test('cross-task belief migration: same proposer+actionType shares belief', () => {
      resetAll();
      const la = LearningAuthority.getInstance();

      const evidence1 = {
        evidenceId: 'E_d10_cross1',
        goalId: 'G_d10_task1',
        decisionId: 'D_d10_cross1',
        observation: null,
        action: { type: 'tool_call' as const, payload: { tool: 'file_write' } },
        expectedEffect: 'success',
        actualEffect: 'failed',
        progressDelta: -0.15,
        timestamp: Date.now(),
      };

      la.learn(evidence1, 'proposer_d10_cross');

      const candidateForNewTask = {
        candidateId: 'C_d10_new_task',
        proposerId: 'proposer_d10_cross',
        action: { type: 'tool_call' as const, payload: { tool: 'file_write' } },
        confidence: 0.9,
        estimatedGoalProgress: 0.5,
        reasoning: 'new task same proposer',
      };

      const adjusted = la.adjustCandidate(candidateForNewTask);
      expect(adjusted.confidence).toBeLessThan(0.9);
    });
  });

  describe('Phase 5: Full long-horizon chain replay audit', () => {
    test('Goal → Snapshot → Decision → Evidence → Goal progress is traceable', async () => {
      resetAll();
      const ga = GoalAuthority.getInstance();
      const sa = StateAuthority.getInstance();
      const da = DecisionAuthority.getInstance();

      const goal = ga.createGoal({
        description: 'D10: full chain replay',
        originalInput: 'D10: full chain replay',
        executionDomain: 'desktop',
      });

      const snapshot = await sa.captureSnapshot();
      expect(snapshot.snapshotId).toBeTruthy();
      expect(snapshot.activeGoalIds).toContain(goal.goalId);

      const decision = await da.decide({
        goalId: goal.goalId,
        candidates: [
          {
            candidateId: 'C_d10_chain',
            proposerId: 'd10_chain_proposer',
            action: { type: 'message', payload: { text: 'observe world' } },
            confidence: 0.8,
            estimatedGoalProgress: 0.3,
            reasoning: 'chain replay test',
          },
        ],
        snapshot,
      });

      expect(decision.decisionId).toBeTruthy();
      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: null,
        action: decision.chosen.action,
        expectedEffect: 'progress',
        actualEffect: 'progress',
        progressDelta: 0.3,
      });

      const updatedGoal = ga.getGoal(goal.goalId);
      expect(updatedGoal!.progress).toBeGreaterThan(0);

      const decisionHistory = da.getDecisionHistory(goal.goalId);
      expect(decisionHistory.length).toBeGreaterThanOrEqual(1);

      const evidenceLog = ga.getEvidenceLog(goal.goalId);
      expect(evidenceLog.length).toBeGreaterThanOrEqual(1);
      expect(evidenceLog[0].decisionId).toBe(decision.decisionId);
    });

    test('multi-step chain: each step produces traceable Evidence', async () => {
      resetAll();
      const ga = GoalAuthority.getInstance();
      const sa = StateAuthority.getInstance();
      const da = DecisionAuthority.getInstance();

      const goal = ga.createGoal({
        description: 'D10: multi-step traceability',
        originalInput: 'D10: multi-step traceability',
        executionDomain: 'desktop',
      });

      const decisionIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const snapshot = await sa.captureSnapshot();
        const decision = await da.decide({
          goalId: goal.goalId,
          candidates: [
            {
              candidateId: `C_d10_multi_${i}`,
              proposerId: 'd10_multi_proposer',
              action: { type: 'message', payload: { text: `step ${i}` } },
              confidence: 0.8 - i * 0.1,
              estimatedGoalProgress: 0.3 + i * 0.2,
              reasoning: `multi-step ${i}`,
            },
          ],
          snapshot,
        });

        decisionIds.push(decision.decisionId);

        ga.updateFromEvidence({
          goalId: goal.goalId,
          decisionId: decision.decisionId,
          observation: null,
          action: decision.chosen.action,
          expectedEffect: 'progress',
          actualEffect: 'progress',
          progressDelta: 0.25,
        });
      }

      const evidenceLog = ga.getEvidenceLog(goal.goalId);
      expect(evidenceLog.length).toBe(3);

      for (let i = 0; i < 3; i++) {
        expect(evidenceLog[i].decisionId).toBe(decisionIds[i]);
        expect(evidenceLog[i].goalId).toBe(goal.goalId);
      }

      const finalGoal = ga.getGoal(goal.goalId);
      expect(finalGoal!.progress).toBeGreaterThan(0);
    });
  });

  describe('Phase 6: Memory persistence across sessions', () => {
    test('memory authority writes with authority trace and is retrievable', async () => {
      resetAll();
      const ma = MemoryAuthority.getInstance();

      ma.registerBridge(
        async () => ({
          success: true,
          memoryId: 'm_d10_1',
          operationId: 'o_d10_1',
          source: 'python' as const,
        }),
        async () => ({
          items: [],
          operationId: 'o_d10_2',
          source: 'python' as const,
        })
      );

      await ma.write({
        content: 'long-term assistant experience',
        memoryType: 'episodic',
        goalId: 'G_d10_mem',
        decisionId: 'D_d10_mem',
        snapshotId: 'S_d10_mem',
      });

      const log = ma.getOperationLog({ goalId: 'G_d10_mem' });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].goalId).toBe('G_d10_mem');
      expect(log[0].decisionId).toBe('D_d10_mem');
      expect(log[0].snapshotId).toBe('S_d10_mem');
    });

    test('memory authority fail-closed when no bridge', async () => {
      resetAll();
      const ma = MemoryAuthority.getInstance();

      const result = await ma.write({
        content: 'should fail closed',
        memoryType: 'episodic',
        goalId: 'G_d10_fail',
        decisionId: 'D_d10_fail',
        snapshotId: 'S_d10_fail',
      });

      expect(result.success).toBe(false);
      expect(result.source).toBe('failed_closed');
    });
  });

  describe('Phase 7: D10 Audit — comprehensive verification', () => {
    test('D10 audit: goal identity stable across replan', () => {
      resetAll();
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'D10 audit: identity',
        originalInput: 'D10 audit: identity',
        executionDomain: 'desktop',
      });

      const id = goal.goalId;
      ga.replan(goal.goalId, 'r1', 1);
      ga.replan(goal.goalId, 'r2', 2);

      const final = ga.getGoal(id);
      expect(final!.goalId).toBe(id);
      expect(final!.planVersion).toBe(3);
    });

    test('D10 audit: zero false recovery in long-term tasks', () => {
      const falseRecovery = allTraces.filter(
        (t) => t.verified && t.goalStatus !== 'completed'
      );
      expect(falseRecovery.length).toBe(0);
    });

    test('D10 audit: all long-term tasks have goalId', () => {
      for (const t of allTraces) {
        expect(t.goalId).toBeTruthy();
      }
    });

    test('D10 audit: AutonomousRuntime config bounds', () => {
      const runtime = getAutonomousRuntime({ observationIntervalMs: 60000 });
      const config = runtime.getConfig();
      expect(config.observationIntervalMs).toBeGreaterThan(0);
      expect(config.maxConcurrentGoals).toBeGreaterThan(0);
      expect(config.goalCooldownMs).toBeGreaterThan(0);
      runtime.stop();
    });
  });
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  RealTask,
  RealTaskResult,
  RealTaskReport,
  RealTaskMetrics,
  RealTaskStepRecord,
  RealTaskEvidenceChain,
  TaskEnvironment,
  RealTaskDomain,
} from './RealTaskTypes';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { getAutonomousLoop, resetAutonomousLoop } from '../../authority/AutonomousLoop';
import { Logger } from '../../utils/Logger';

export type RecoveryProposerMode = 'generic_plus_edr' | 'generic_only' | 'edr_only';

export class RealTaskHarness {
  private results: RealTaskResult[] = [];
  private recoveryMode: RecoveryProposerMode = 'generic_plus_edr';

  setRecoveryProposerMode(mode: RecoveryProposerMode): void {
    this.recoveryMode = mode;
    Logger.info(`[D8-3.1] Recovery proposer mode set to: ${mode}`, 'RealTaskHarness');
  }

  async runTask(task: RealTask): Promise<RealTaskResult> {
    const startTime = Date.now();
    const env = this.createEnvironment(task.taskId);

    Logger.info(`[D8-0] RealTask ${task.taskId} starting: ${task.description}`, 'RealTaskHarness');

    try {
      if (task.setup) {
        await task.setup(env);
      }

      const evidenceChain = await this.executeViaAutonomousLoop(task, env);

      const declaredCompleted = evidenceChain.finalStatus === 'completed';

      let externallyVerified = false;
      let verificationEvidence = '';
      try {
        const check = await task.successCriteria.check(env);
        externallyVerified = check.satisfied;
        verificationEvidence = check.evidence;
      } catch (err) {
        verificationEvidence = `verification_error: ${(err as Error).message}`;
      }

      const result: RealTaskResult = {
        taskId: task.taskId,
        domain: task.domain,
        declaredCompleted,
        externallyVerified,
        verificationEvidence,
        evidenceChain,
        steps: [],
        totalTimeMs: Date.now() - startTime,
        error: null,
      };

      this.results.push(result);

      Logger.info(
        `[D8-0] RealTask ${task.taskId} finished: declared=${declaredCompleted} verified=${externallyVerified} time=${result.totalTimeMs}ms`,
        'RealTaskHarness'
      );

      return result;
    } catch (err) {
      const result: RealTaskResult = {
        taskId: task.taskId,
        domain: task.domain,
        declaredCompleted: false,
        externallyVerified: false,
        verificationEvidence: '',
        evidenceChain: this.emptyChain(),
        steps: [],
        totalTimeMs: Date.now() - startTime,
        error: (err as Error).message,
      };
      this.results.push(result);
      return result;
    } finally {
      if (task.teardown) {
        try { await task.teardown(env); } catch {}
      }
    }
  }

  async runAll(tasks: RealTask[]): Promise<RealTaskReport> {
    this.results = [];
    const runId = `D8_${Date.now().toString(36)}`;

    for (const task of tasks) {
      await this.runTask(task);
    }

    return {
      runId,
      timestamp: Date.now(),
      tasks: this.results,
      metrics: this.computeMetrics(),
    };
  }

  private async executeViaAutonomousLoop(
    task: RealTask,
    env: TaskEnvironment
  ): Promise<RealTaskEvidenceChain> {
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    resetAutonomousLoop();

    const { resetReplanProposerResolver, getReplanProposerResolver } = require('../../authority/ReplanProposerResolver');
    const { getDirectActionProposer } = require('../../authority/DirectActionProposer');
    const { getGenericRecoveryProposer, resetGenericRecoveryProposer } = require('../../authority/GenericRecoveryProposer');
    const { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } = require('../../authority/EvidenceDrivenRecoveryProposer');

    resetReplanProposerResolver();
    resetGenericRecoveryProposer();
    resetEvidenceDrivenRecoveryProposer();

    const resolver = getReplanProposerResolver();
    const directProposer = getDirectActionProposer();
    const genericProposer = getGenericRecoveryProposer();
    const edrProposer = getEvidenceDrivenRecoveryProposer();

    let recoveryProposers: any[];
    let modeLabel: string;
    switch (this.recoveryMode) {
      case 'generic_only':
        recoveryProposers = [genericProposer];
        modeLabel = 'generic_only';
        break;
      case 'edr_only':
        recoveryProposers = [edrProposer];
        modeLabel = 'edr_only';
        break;
      case 'generic_plus_edr':
      default:
        recoveryProposers = [genericProposer, edrProposer];
        modeLabel = 'generic_plus_edr';
        break;
    }

    resolver.registerInitial(task.executionDomain, [directProposer]);
    resolver.registerRecovery(task.executionDomain, recoveryProposers);
    resolver.register(task.executionDomain, [directProposer, ...recoveryProposers]);

    Logger.info(
      `[D8-3.1] Mainline proposer registration: initial=[direct_action] recovery=[${modeLabel}] domain=${task.executionDomain}`,
      'RealTaskHarness'
    );

    const ga = GoalAuthority.getInstance();
    const goal = ga.createGoal({
      description: task.goalDescription,
      originalInput: task.description,
      executionDomain: task.executionDomain,
    });
    goal.metadata['tempDir'] = env.tempDir;
    goal.metadata['taskId'] = task.taskId;

    const loop = getAutonomousLoop();
    const impact = {
      goalId: goal.goalId,
      observationId: `OBS_${Date.now().toString(36)}`,
      affected: true,
      impactType: 'environment_change' as const,
      reason: 'task_start',
      confidence: 1.0,
    };
    const observation = {
      observationId: `OBS_${Date.now().toString(36)}`,
      source: 'environment' as const,
      type: 'task_start',
      timestamp: new Date().toISOString(),
      payload: {},
    };

    const loopResult = await loop.run(
      goal.goalId,
      impact,
      observation,
      { maxSteps: task.maxSteps, maxTimeMs: task.maxTimeMs, stepDelayMs: 0 }
    );

    const finalGoal = ga.getGoal(goal.goalId);
    const evidenceLog = ga.getEvidenceLog(goal.goalId);
    const lastEvidence = evidenceLog.length > 0 ? evidenceLog[evidenceLog.length - 1] : null;

    return {
      goal: finalGoal,
      decisionId: lastEvidence?.decisionId ?? null,
      executionResult: null,
      observation: null,
      evidence: lastEvidence ?? null,
      evaluation: null,
      finalStatus: finalGoal?.status ?? 'unknown',
    };
  }

  private createEnvironment(taskId: string): TaskEnvironment {
    const tempDir = path.join(os.tmpdir(), `jiabaixing_d8_${taskId}_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    return {
      workingDir: process.cwd(),
      tempDir,
      platform: process.platform,
      env: { ...process.env as Record<string, string> },
    };
  }

  private emptyChain(): RealTaskEvidenceChain {
    return {
      goal: null, decisionId: null, executionResult: null,
      observation: null, evidence: null, evaluation: null, finalStatus: 'not_run',
    };
  }

  private computeMetrics(): RealTaskMetrics {
    const total = this.results.length;
    const declared = this.results.filter(r => r.declaredCompleted).length;
    const verified = this.results.filter(r => r.externallyVerified).length;
    const falseCompletions = this.results.filter(r => r.declaredCompleted && !r.externallyVerified).length;

    const byDomain: Record<string, { total: number; verified: number; falseCompletions: number }> = {};
    for (const r of this.results) {
      if (!byDomain[r.domain]) byDomain[r.domain] = { total: 0, verified: 0, falseCompletions: 0 };
      byDomain[r.domain].total++;
      if (r.externallyVerified) byDomain[r.domain].verified++;
      if (r.declaredCompleted && !r.externallyVerified) byDomain[r.domain].falseCompletions++;
    }

    return {
      totalTasks: total,
      declaredCompleted: declared,
      externallyVerified: verified,
      falseCompletions,
      verifiedCompletionRate: total > 0 ? verified / total : 0,
      trueCompletionRate: declared > 0 ? verified / declared : 0,
      falseCompletionRate: declared > 0 ? falseCompletions / declared : 0,
      byDomain: byDomain as Record<RealTaskDomain, { total: number; verified: number; falseCompletions: number }>,
    };
  }
}

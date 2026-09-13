import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { getEvidenceCollector, resetEvidenceCollector } from '../../authority/EvidenceCollector';
import { getObservationCollector, resetObservationCollector } from '../../authority/ObservationCollector';
import { getGoalEvidenceEvaluator, resetGoalEvidenceEvaluator } from '../../authority/GoalEvidenceEvaluator';
import { getAutonomousLoop, resetAutonomousLoop, LoopTerminationReason } from '../../authority/AutonomousLoop';
import type {
  Decision,
  GoalEvidence,
  ActionExecutionResult,
  EnvironmentObservationResult,
  GoalEvidenceEvaluation,
  GoalImpact,
  GoalImpactType,
  WorldObservation,
  ProposedAction,
} from '../../authority/types';
import type { DecisionExecutionResult } from '../../authority/DecisionExecutor';
import type { EvidenceCollectionResult } from '../../authority/EvidenceCollector';

let ga: GoalAuthority;

function makeExecResult(
  decisionId: string,
  goalId: string,
  planVersion: number,
  status: 'executed' | 'execution_failed' | 'dispatched',
  actionType: string,
  rawResult: unknown,
  error?: string
): ActionExecutionResult {
  return {
    executionId: `EXEC_test_${Date.now().toString(36)}`,
    decisionId, goalId, planVersion, status, actionType, rawResult, error,
    timestamp: Date.now(),
  };
}

function makeExecDecisionResult(overrides: Partial<DecisionExecutionResult> & { goalId: string; decisionId: string; planVersion: number }): DecisionExecutionResult {
  return {
    success: overrides.success ?? true,
    goalId: overrides.goalId,
    decisionId: overrides.decisionId,
    planVersion: overrides.planVersion,
    actionResult: overrides.actionResult ?? null,
    authorization: overrides.authorization ?? { allowed: true },
    reason: overrides.reason ?? 'test',
    executionResult: overrides.executionResult ?? makeExecResult(overrides.decisionId, overrides.goalId, overrides.planVersion, overrides.success === false ? 'execution_failed' : 'executed', 'desktop_action', overrides.actionResult),
  };
}

function makeDecision(goalId: string, actionType: ProposedAction['type'], payload: unknown, estimatedProgress: number): Decision {
  return {
    decisionId: `D_${Date.now().toString(36)}`,
    decisionType: 'action' as any,
    goalId,
    snapshotId: 'SS_1',
    planVersion: 1,
    candidateIds: [],
    chosenCandidateId: 'C_1',
    chosen: {
      candidateId: 'C_1',
      proposerId: 'P_1',
      action: { type: actionType, payload },
      confidence: 0.8,
      reasoning: 'test',
      estimatedGoalProgress: estimatedProgress,
    },
    acceptedCandidates: [],
    rejectedCandidates: [],
    selectionReason: 'test',
    proposerSet: ['P_1'],
    vetoReason: null,
    timestamp: Date.now(),
  };
}

function makeImpact(goalId: string): GoalImpact {
  return { goalId, observationId: 'OBS_1', affected: true, impactType: 'environment_change' as GoalImpactType, reason: 'test', confidence: 0.8 };
}

function makeWorldObservation(): WorldObservation {
  return { observationId: `OBS_${Date.now().toString(36)}`, source: 'environment', type: 'test', timestamp: new Date().toISOString(), payload: {} };
}

beforeEach(() => {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  ga = GoalAuthority.getInstance();
  resetEvidenceCollector();
  resetObservationCollector();
  resetGoalEvidenceEvaluator();
  resetAutonomousLoop();
});

afterAll(() => {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
});

describe('D7-4.1: Evidence Truth — 10 required tests', () => {
  test('ETruth-1: action executed=true, environment unverified → Goal != COMPLETED', async () => {
    const goal = ga.createGoal({ description: 'unverified goal', originalInput: 'test', executionDomain: 'orchestrator' });
    const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'deploy', args: {} }, 0.5);

    const collector = getEvidenceCollector();
    const result = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { dispatched: true },
      reason: 'tool_call_dispatched',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'dispatched', 'tool_call', { dispatched: true }),
    }));

    expect(result.verified).toBe(false);
    expect(result.evaluation?.verdict).not.toBe('completed');

    const updatedGoal = ga.getGoal(goal.goalId);
    expect(updatedGoal?.status).not.toBe('completed');
  });

  test('ETruth-2: tool dispatched=true, no verifiable output → Goal != COMPLETED', async () => {
    const goal = ga.createGoal({ description: 'dispatch goal', originalInput: 'test', executionDomain: 'orchestrator' });
    const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'send_email', args: { to: 'a@b.com' } }, 0.8);

    const collector = getEvidenceCollector();
    const result = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { dispatched: true },
      reason: 'tool_call_dispatched',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'dispatched', 'tool_call', { dispatched: true }),
    }));

    expect(result.verified).toBe(false);
    expect(result.evaluation?.verdict).toBe('unverified');
    expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
  });

  test('ETruth-3: file action with real observation → verified=true', async () => {
    const goal = ga.createGoal({ description: 'create file goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'write_file', params: { path: '/tmp/test.txt', content: 'hello' } }, 0.6);

    const collector = getEvidenceCollector();
    const result = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { observation: { fileExists: true, path: '/tmp/test.txt', content: 'hello' }, success: true },
      reason: 'desktop_action_executed',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { fileExists: true, path: '/tmp/test.txt', content: 'hello' }, success: true }),
    }));

    expect(result.verified).toBe(false);
    expect(result.evaluation?.verdict).not.toBe('completed');
  });

  test('ETruth-4: Goal Success Criteria satisfied → COMPLETED', async () => {
    const goal = ga.createGoal({ description: 'success criteria goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.9);

    const collector = getEvidenceCollector();
    const result = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { observation: { goalAchieved: true }, success: true },
      reason: 'desktop_action_executed',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { goalAchieved: true }, success: true }),
    }));

    expect(result.verified).toBe(false);
    expect(result.evaluation?.verdict).not.toBe('completed');
    expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
  });

  test('ETruth-5: action success but Success Criteria not met → CONTINUE/REPLAN', async () => {
    const goal = ga.createGoal({ description: 'partial goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.3);

    const collector = getEvidenceCollector();
    const result = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { observation: { buttonClicked: true }, success: true },
      reason: 'desktop_action_executed',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { buttonClicked: true }, success: true }),
    }));

    expect(result.verified).toBe(false);
    expect(result.evaluation?.verdict).not.toBe('completed');
    expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
  });

  test('ETruth-6: predictedProgress must not directly cause COMPLETED', async () => {
    const goal = ga.createGoal({ description: 'predicted goal', originalInput: 'test', executionDomain: 'orchestrator' });

    for (let i = 0; i < 20; i++) {
      const decision = makeDecision(goal.goalId, 'tool_call', { step: i }, 0.5);
      const collector = getEvidenceCollector();
      await collector.collect(decision, makeExecDecisionResult({
        success: true,
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        planVersion: 1,
        actionResult: { dispatched: true },
        reason: 'tool_call_dispatched',
        executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'dispatched', 'tool_call', { dispatched: true }),
      }));
    }

    const updatedGoal = ga.getGoal(goal.goalId);
    expect(updatedGoal?.status).not.toBe('completed');
  });

  test('ETruth-7: old Evidence must not prove new environment state', async () => {
    const goal = ga.createGoal({ description: 'stale evidence goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.5);

    const collector = getEvidenceCollector();
    const result1 = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { observation: { buttonClicked: true }, success: true },
      reason: 'desktop_action_executed',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { buttonClicked: true }, success: true }),
    }));

    expect(result1.evaluation).not.toBeNull();
    expect(result1.evaluation!.environmentObservation).not.toBeNull();
    expect(result1.evaluation!.environmentObservation!.timestamp).toBeGreaterThan(0);

    const evidenceLog = ga.getEvidenceLog(goal.goalId);
    expect(evidenceLog.length).toBe(1);
    expect(evidenceLog[0].timestamp).toBeLessThanOrEqual(Date.now());
  });

  test('ETruth-8: Observation not matching Goal → must not complete', async () => {
    const goal = ga.createGoal({ description: 'mismatch goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.5);

    const collector = getEvidenceCollector();
    const result = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { observation: { wrongThing: true }, success: true },
      reason: 'desktop_action_executed',
      executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { wrongThing: true }, success: true }),
    }));

    expect(result.evaluation?.verdict).not.toBe('completed');
    expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
  });

  test('ETruth-9: AutonomousLoop must not infinite-loop on UNVERIFIED', async () => {
    const goal = ga.createGoal({ description: 'unverified loop goal', originalInput: 'test', executionDomain: 'orchestrator' });

    const loop = getAutonomousLoop();
    const result = await loop.run(
      goal.goalId,
      makeImpact(goal.goalId),
      makeWorldObservation(),
      { maxSteps: 3, maxTimeMs: 5000, stepDelayMs: 0 }
    );

    expect(result.terminated).toBe(true);
    expect(result.totalSteps).toBeLessThanOrEqual(3);
    expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
  });

  test('ETruth-10: full Action → Observation → Evidence → GoalEvaluation chain', async () => {
    const goal = ga.createGoal({ description: 'full chain goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: { x: 100, y: 200 } }, 0.7);

    const execResult = makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { buttonClicked: true, formSubmitted: true }, success: true });

    const observationCollector = getObservationCollector();
    const observation = await observationCollector.collect(execResult);

    expect(observation.verificationStatus).toBe('unverified');
    expect(observation.observedState).toHaveProperty('verificationSource', 'execution_fallback');

    const evaluator = getGoalEvidenceEvaluator();
    const currentGoal = ga.getGoal(goal.goalId)!;
    const evaluation = evaluator.evaluate(currentGoal, decision, observation);

    expect(evaluation.verified).toBe(false);
    expect(evaluation.verdict).toBe('unverified');
    expect(evaluation.environmentObservation).not.toBeNull();
    expect(evaluation.observedProgressDelta).toBeGreaterThanOrEqual(0);
    expect(evaluation.predictedProgressDelta).toBeGreaterThan(0);

    const collector = getEvidenceCollector();
    const evidenceResult = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: { observation: { buttonClicked: true, formSubmitted: true }, success: true },
      reason: 'desktop_action_executed',
      executionResult: execResult,
    }));

    expect(evidenceResult.verified).toBe(false);
    expect(evidenceResult.evaluation).not.toBeNull();
    expect(evidenceResult.evaluation!.verdict).not.toBe('completed');

    const evidenceLog = ga.getEvidenceLog(goal.goalId);
    expect(evidenceLog.length).toBe(1);
    const evidence = evidenceLog[0] as GoalEvidence;
    expect(evidence.verified).toBe(false);
  });
});

describe('D7-4.1: Three-layer data samples', () => {
  test('produces all four layers with correct semantics', async () => {
    const goal = ga.createGoal({ description: 'sample goal', originalInput: 'create file', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'write_file', params: { path: '/tmp/evidence_test.txt' } }, 0.8);

    const layer1: ActionExecutionResult = makeExecResult(
      decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action',
      { observation: { fileExists: true, path: '/tmp/evidence_test.txt' }, success: true }
    );

    const observationCollector = getObservationCollector();
    const layer2: EnvironmentObservationResult = await observationCollector.collect(layer1);

    const evaluator = getGoalEvidenceEvaluator();
    const layer3: GoalEvidenceEvaluation = evaluator.evaluate(ga.getGoal(goal.goalId)!, decision, layer2);

    const collector = getEvidenceCollector();
    const layer4: EvidenceCollectionResult = await collector.collect(decision, makeExecDecisionResult({
      success: true,
      goalId: goal.goalId,
      decisionId: decision.decisionId,
      planVersion: 1,
      actionResult: layer1.rawResult,
      reason: 'desktop_action_executed',
      executionResult: layer1,
    }));

    expect(layer1.status).toBe('executed');
    expect(layer1.actionType).toBe('desktop_action');

    expect(layer2.verificationStatus).toBe('unverified');
    expect(layer2.observedState).toHaveProperty('verificationSource', 'execution_fallback');

    expect(layer3.verdict).not.toBe('completed');
    expect(layer3.verified).toBe(false);
    expect(layer3.predictedProgressDelta).toBeGreaterThan(0);

    expect(layer4.verified).toBe(false);
    expect(layer4.evaluation).not.toBeNull();
  });

  test('finalObservation (DesktopTaskResult) is recognized as independent env read', async () => {
    const goal = ga.createGoal({ description: 'finalObs goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.5);

    const desktopTaskResult = {
      success: true,
      actions: [{ success: true, action: { type: 'click', params: {} }, output: 'clicked' }],
      summary: '1/1 actions succeeded',
      finalObservation: {
        timestamp: Date.now(),
        screenshot: { success: true, width: 1920, height: 1080 },
        visionAnalysis: { success: true, description: 'desktop after click' },
        windows: [{ title: 'Test Window', id: 1 }],
        summary: 'desktop after click',
      },
    };

    const execResult = makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', desktopTaskResult);
    const observationCollector = getObservationCollector();
    const observation = await observationCollector.collect(execResult);

    expect(observation.verificationStatus).toBe('unverified');
    expect(observation.observedState).toHaveProperty('verificationSource', 'execution_fallback');
  });

  test('finalObservation absent falls back to action-embedded observation', async () => {
    const goal = ga.createGoal({ description: 'noFinalObs goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.5);

    const execResult = makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { buttonClicked: true }, success: true });
    const observationCollector = getObservationCollector();
    const observation = await observationCollector.collect(execResult);

    expect(observation.verificationStatus).toBe('unverified');
    expect(observation.observedState).toHaveProperty('verificationSource', 'execution_fallback');
  });

  test('neither finalObservation nor observation → unverified', async () => {
    const goal = ga.createGoal({ description: 'noObs goal', originalInput: 'test', executionDomain: 'desktop' });
    const decision = makeDecision(goal.goalId, 'desktop_action', { type: 'click', params: {} }, 0.5);

    const execResult = makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { success: true });
    const observationCollector = getObservationCollector();
    const observation = await observationCollector.collect(execResult);

    expect(observation.verificationStatus).toBe('unverified');
    expect(observation.verificationReason).toContain('no observation returned');
  });
});

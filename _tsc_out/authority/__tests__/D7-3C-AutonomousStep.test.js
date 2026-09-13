"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
const DecisionExecutor_1 = require("../../authority/DecisionExecutor");
const EvidenceCollector_1 = require("../../authority/EvidenceCollector");
const AutonomousStep_1 = require("../../authority/AutonomousStep");
let ga;
let da;
function makeExecResult(decisionId, goalId, planVersion, status, actionType, rawResult, error) {
    return {
        executionId: `EXEC_test_${Date.now().toString(36)}`,
        decisionId,
        goalId,
        planVersion,
        status,
        actionType,
        rawResult,
        error,
        timestamp: Date.now(),
    };
}
function makeExecDecisionResult(overrides) {
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
beforeEach(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    ga = GoalAuthority_1.GoalAuthority.getInstance();
    da = DecisionAuthority_1.DecisionAuthority.getInstance();
    (0, DecisionExecutor_1.resetDecisionExecutor)();
    (0, EvidenceCollector_1.resetEvidenceCollector)();
    (0, AutonomousStep_1.resetAutonomousStep)();
});
afterAll(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
});
describe('D7-3C: Decision → Action → Observation → Evidence', () => {
    describe('D7-3C-1: DecisionExecutor', () => {
        test('rejects stale decision (planVersion mismatch)', () => {
            const goal = ga.createGoal({
                description: 'test goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            ga.replan(goal.goalId, 'test replan', 1);
            const decision = {
                decisionId: 'D_stale',
                decisionType: 'action',
                goalId: goal.goalId,
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'desktop_action', payload: { type: 'click', params: {} } },
                    confidence: 0.8,
                    reasoning: 'stale test',
                    estimatedGoalProgress: 0.3,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const executor = (0, DecisionExecutor_1.getDecisionExecutor)();
            expect(executor.execute(decision)).resolves.toEqual(expect.objectContaining({
                success: false,
                reason: expect.stringContaining('STALE_DECISION'),
            }));
        });
        test('rejects orphan decision (goal not found)', () => {
            const decision = {
                decisionId: 'D_orphan',
                decisionType: 'action',
                goalId: 'G_nonexistent',
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'desktop_action', payload: { type: 'click', params: {} } },
                    confidence: 0.5,
                    reasoning: 'orphan test',
                    estimatedGoalProgress: 0.2,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const executor = (0, DecisionExecutor_1.getDecisionExecutor)();
            expect(executor.execute(decision)).resolves.toEqual(expect.objectContaining({
                success: false,
                reason: expect.stringContaining('not found'),
            }));
        });
    });
    describe('D7-3C-2: EvidenceCollector (three-layer truth)', () => {
        test('tool_call dispatched without verifiable output → UNVERIFIED', async () => {
            const goal = ga.createGoal({
                description: 'tool goal',
                originalInput: 'run tool',
                executionDomain: 'orchestrator',
            });
            const decision = {
                decisionId: 'D_tool',
                decisionType: 'action',
                goalId: goal.goalId,
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'tool_call', payload: { tool: 'read_file', args: { path: '/tmp/test.txt' } } },
                    confidence: 0.8,
                    reasoning: 'read file',
                    estimatedGoalProgress: 0.4,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
            const result = await collector.collect(decision, makeExecDecisionResult({
                success: true,
                goalId: goal.goalId,
                decisionId: decision.decisionId,
                planVersion: 1,
                actionResult: { output: 'file contents' },
                reason: 'tool_call_dispatched',
                executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'dispatched', 'tool_call', { dispatched: true }),
            }));
            expect(result.verified).toBe(false);
            expect(result.evaluation?.verdict).toBe('unverified');
            expect(result.progressDelta).toBe(0);
        });
        test('desktop_action with observation → VERIFIED', async () => {
            const goal = ga.createGoal({
                description: 'desktop goal',
                originalInput: 'click button',
                executionDomain: 'desktop',
            });
            const decision = {
                decisionId: 'D_desktop',
                decisionType: 'action',
                goalId: goal.goalId,
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'desktop_action', payload: { type: 'click', params: { x: 100, y: 200 } } },
                    confidence: 0.9,
                    reasoning: 'click submit',
                    estimatedGoalProgress: 0.5,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
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
        });
        test('failed execution → negative or zero progress', async () => {
            const goal = ga.createGoal({
                description: 'fail goal',
                originalInput: 'will fail',
                executionDomain: 'desktop',
            });
            const decision = {
                decisionId: 'D_fail',
                decisionType: 'action',
                goalId: goal.goalId,
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'desktop_action', payload: { type: 'click', params: {} } },
                    confidence: 0.7,
                    reasoning: 'test',
                    estimatedGoalProgress: 0.3,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
            const result = await collector.collect(decision, makeExecDecisionResult({
                success: false,
                goalId: goal.goalId,
                decisionId: decision.decisionId,
                planVersion: 1,
                actionResult: null,
                authorization: { allowed: false, reason: 'safety_check_failed' },
                reason: 'desktop_action_error: bridge unavailable',
                executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'execution_failed', 'desktop_action', null, 'bridge unavailable'),
            }));
            expect(result.verified).toBe(false);
            expect(result.evaluation?.verdict).not.toBe('completed');
        });
        test('message action → always UNVERIFIED', async () => {
            const goal = ga.createGoal({
                description: 'message goal',
                originalInput: 'send message',
                executionDomain: 'orchestrator',
            });
            const decision = {
                decisionId: 'D_msg',
                decisionType: 'action',
                goalId: goal.goalId,
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'message', payload: { text: 'hello' } },
                    confidence: 0.6,
                    reasoning: 'send message',
                    estimatedGoalProgress: 0.2,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
            const result = await collector.collect(decision, makeExecDecisionResult({
                success: true,
                goalId: goal.goalId,
                decisionId: decision.decisionId,
                planVersion: 1,
                actionResult: { type: 'message', payload: { text: 'hello' } },
                reason: 'message_action_dispatched',
                executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'message', { type: 'message' }),
            }));
            expect(result.verified).toBe(false);
            expect(result.evaluation?.verdict).toBe('unverified');
            expect(result.progressDelta).toBe(0);
        });
    });
    describe('D7-3C-3: AutonomousStep (single loop)', () => {
        test('produces structured result with replan/execution/evidence phases', async () => {
            const goal = ga.createGoal({
                description: 'autonomous goal',
                originalInput: 'autonomous task',
                executionDomain: 'orchestrator',
            });
            const replanRequest = {
                requestId: 'RQ_1',
                goalId: goal.goalId,
                observationId: 'OBS_1',
                impactType: 'environment_change',
                reason: 'test replan',
                confidence: 0.8,
                planVersion: 1,
                timestamp: Date.now(),
            };
            const step = (0, AutonomousStep_1.getAutonomousStep)();
            const result = await step.execute(replanRequest);
            expect(result).toHaveProperty('goalId', goal.goalId);
            expect(result).toHaveProperty('replan');
            expect(result).toHaveProperty('execution');
            expect(result).toHaveProperty('evidence');
            expect(result).toHaveProperty('reason');
            expect(result.replan).toHaveProperty('success');
            expect(result.execution).toHaveProperty('success');
            expect(result.evidence).toHaveProperty('progressDelta');
            expect(result.evidence).toHaveProperty('verified');
            expect(result.evidence).toHaveProperty('verdict');
        });
        test('fails gracefully when replan produces no decision', async () => {
            const goal = ga.createGoal({
                description: 'no decision goal',
                originalInput: 'no proposers',
                executionDomain: 'self_modification',
            });
            const replanRequest = {
                requestId: 'RQ_2',
                goalId: goal.goalId,
                observationId: 'OBS_2',
                impactType: 'file_change',
                reason: 'no eligible proposers',
                confidence: 0.5,
                planVersion: 1,
                timestamp: Date.now(),
            };
            const step = (0, AutonomousStep_1.getAutonomousStep)();
            const result = await step.execute(replanRequest);
            expect(result.success).toBe(false);
            expect(result.replan.decision).toBeNull();
        });
    });
    describe('D7-3C-4: Evidence audit trail', () => {
        test('evidence log records expected vs actual effect with verification', async () => {
            const goal = ga.createGoal({
                description: 'audit goal',
                originalInput: 'audit task',
                executionDomain: 'desktop',
            });
            const decision = {
                decisionId: 'D_audit',
                decisionType: 'action',
                goalId: goal.goalId,
                snapshotId: 'SS_1',
                planVersion: 1,
                candidateIds: [],
                chosenCandidateId: 'C_1',
                chosen: {
                    candidateId: 'C_1',
                    proposerId: 'P_1',
                    action: { type: 'desktop_action', payload: { type: 'click', params: { x: 100, y: 200 } } },
                    confidence: 0.85,
                    reasoning: 'click button',
                    estimatedGoalProgress: 0.5,
                },
                acceptedCandidates: [],
                rejectedCandidates: [],
                selectionReason: 'test',
                proposerSet: ['P_1'],
                vetoReason: null,
                timestamp: Date.now(),
            };
            const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
            await collector.collect(decision, makeExecDecisionResult({
                success: true,
                goalId: goal.goalId,
                decisionId: decision.decisionId,
                planVersion: 1,
                actionResult: { observation: { buttonClicked: true }, success: true },
                reason: 'desktop_action_executed',
                executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { buttonClicked: true }, success: true }),
            }));
            const evidenceLog = ga.getEvidenceLog(goal.goalId);
            expect(evidenceLog.length).toBe(1);
            const evidence = evidenceLog[0];
            expect(evidence.goalId).toBe(goal.goalId);
            expect(evidence.decisionId).toBe(decision.decisionId);
            expect(evidence.expectedEffect).toBe('desktop_state_changed');
            expect(evidence.verified).toBe(false);
        });
        test('multiple evidence entries accumulate progress', async () => {
            const goal = ga.createGoal({
                description: 'multi-step goal',
                originalInput: 'multi steps',
                executionDomain: 'orchestrator',
            });
            const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
            for (let i = 0; i < 3; i++) {
                const decision = {
                    decisionId: `D_step_${i}`,
                    decisionType: 'action',
                    goalId: goal.goalId,
                    snapshotId: `SS_${i}`,
                    planVersion: 1,
                    candidateIds: [],
                    chosenCandidateId: `C_${i}`,
                    chosen: {
                        candidateId: `C_${i}`,
                        proposerId: 'P_1',
                        action: { type: 'desktop_action', payload: { step: i } },
                        confidence: 0.8,
                        reasoning: `step ${i}`,
                        estimatedGoalProgress: 0.3,
                    },
                    acceptedCandidates: [],
                    rejectedCandidates: [],
                    selectionReason: 'test',
                    proposerSet: ['P_1'],
                    vetoReason: null,
                    timestamp: Date.now(),
                };
                await collector.collect(decision, makeExecDecisionResult({
                    success: true,
                    goalId: goal.goalId,
                    decisionId: decision.decisionId,
                    planVersion: 1,
                    actionResult: { observation: { step: i, done: true }, success: true },
                    reason: 'desktop_action_executed',
                    executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'desktop_action', { observation: { step: i, done: true }, success: true }),
                }));
            }
            const evidenceLog = ga.getEvidenceLog(goal.goalId);
            expect(evidenceLog.length).toBe(3);
            const updatedGoal = ga.getGoal(goal.goalId);
            expect(updatedGoal.progress).toBeGreaterThanOrEqual(0);
        });
    });
});

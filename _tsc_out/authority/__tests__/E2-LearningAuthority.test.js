"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const LearningAuthority_1 = require("../../authority/LearningAuthority");
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
describe('E2-V1: Learning Authority Closure', () => {
    let la;
    let ga;
    let da;
    beforeEach(() => {
        LearningAuthority_1.LearningAuthority.resetInstance();
        GoalAuthority_1.GoalAuthority.resetInstance();
        DecisionAuthority_1.DecisionAuthority.resetInstance();
        la = LearningAuthority_1.LearningAuthority.getInstance();
        ga = GoalAuthority_1.GoalAuthority.getInstance();
        da = DecisionAuthority_1.DecisionAuthority.getInstance();
    });
    afterAll(() => {
        LearningAuthority_1.LearningAuthority.resetInstance();
        GoalAuthority_1.GoalAuthority.resetInstance();
        DecisionAuthority_1.DecisionAuthority.resetInstance();
    });
    describe('V1-1: Evidence → BeliefUpdate → belief changes → future Decision changes', () => {
        test('learning from evidence produces a BeliefUpdate', () => {
            const evidence = {
                evidenceId: 'E_test1',
                goalId: 'G_test',
                decisionId: 'D_test',
                observation: null,
                action: { type: 'tool_call', payload: {} },
                expectedEffect: 'success',
                actualEffect: 'failed',
                progressDelta: -0.1,
                timestamp: Date.now(),
            };
            const update = la.learn(evidence, 'test_proposer');
            expect(update).not.toBeNull();
            expect(update.confidenceAdjustment).toBeLessThan(0);
        });
        test('over-prediction reduces future confidence via adjustCandidate', () => {
            const evidence = {
                evidenceId: 'E_test2',
                goalId: 'G_test',
                decisionId: 'D_test',
                observation: null,
                action: { type: 'tool_call', payload: { toolName: 'test_tool' } },
                expectedEffect: 'success',
                actualEffect: 'failed',
                progressDelta: -0.2,
                timestamp: Date.now(),
            };
            la.learn(evidence, 'test_proposer');
            const candidate = {
                candidateId: 'C_test',
                proposerId: 'test_proposer',
                action: { type: 'tool_call', payload: { toolName: 'test_tool' } },
                confidence: 0.8,
                reasoning: 'test',
                estimatedGoalProgress: 0.5,
            };
            const adjusted = la.adjustCandidate(candidate);
            expect(adjusted.confidence).toBeLessThan(0.8);
        });
    });
    describe('V1-2: Learning failure is observable', () => {
        test('GoalAuthority.updateFromEvidence records learning status in goal metadata', () => {
            const goal = ga.createGoal({
                description: 'Test goal for learning observability',
                originalInput: 'test',
                executionDomain: 'desktop',
            });
            const goalWithEvidence = ga.updateFromEvidence({
                goalId: goal.goalId,
                decisionId: 'D_test',
                observation: null,
                action: { type: 'tool_call', payload: {} },
                expectedEffect: 'success',
                actualEffect: 'failed',
                progressDelta: 0.1,
            });
            const learningKeys = Object.keys(goalWithEvidence.metadata).filter(k => k.startsWith('learning_'));
            expect(learningKeys.length).toBeGreaterThan(0);
            const learningMeta = goalWithEvidence.metadata[learningKeys[0]];
            expect(['applied', 'no_update_needed', 'failed']).toContain(learningMeta.status);
        });
        test('when learning succeeds, status is "applied" with beliefId', () => {
            const goal = ga.createGoal({
                description: 'Test goal for applied learning',
                originalInput: 'test',
                executionDomain: 'desktop',
            });
            const result = ga.updateFromEvidence({
                goalId: goal.goalId,
                decisionId: 'D_test',
                observation: null,
                action: { type: 'tool_call', payload: {} },
                expectedEffect: 'success',
                actualEffect: 'failed',
                progressDelta: 0.1,
            });
            const learningKeys = Object.keys(result.metadata).filter(k => k.startsWith('learning_'));
            const meta = result.metadata[learningKeys[0]];
            if (meta.status === 'applied') {
                expect(meta.beliefId).toBeDefined();
            }
        });
    });
    describe('V1-3: Prediction error computation', () => {
        test('over-prediction (expected success, actual failure) has high error magnitude', () => {
            const evidence = {
                evidenceId: 'E_over',
                goalId: 'G_test',
                decisionId: 'D_test',
                observation: null,
                action: { type: 'tool_call', payload: {} },
                expectedEffect: 'success',
                actualEffect: 'failed',
                progressDelta: -0.5,
                timestamp: Date.now(),
            };
            const pe = la.computePredictionError(evidence);
            expect(pe.errorType).toBe('over_prediction');
            expect(pe.errorMagnitude).toBe(1.0);
        });
        test('match has zero error magnitude', () => {
            const evidence = {
                evidenceId: 'E_match',
                goalId: 'G_test',
                decisionId: 'D_test',
                observation: null,
                action: { type: 'tool_call', payload: {} },
                expectedEffect: 'success',
                actualEffect: 'success',
                progressDelta: 0.1,
                timestamp: Date.now(),
            };
            const pe = la.computePredictionError(evidence);
            expect(pe.errorType).toBe('match');
            expect(pe.errorMagnitude).toBe(0);
        });
    });
});

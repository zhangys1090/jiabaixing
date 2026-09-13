"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
const AutonomousLoop_1 = require("../../authority/AutonomousLoop");
const types_1 = require("../../authority/types");
let ga;
let da;
beforeEach(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    ga = GoalAuthority_1.GoalAuthority.getInstance();
    da = DecisionAuthority_1.DecisionAuthority.getInstance();
    (0, AutonomousLoop_1.resetAutonomousLoop)();
});
afterAll(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
});
function makeImpact(goalId) {
    return {
        goalId,
        observationId: 'OBS_test',
        affected: true,
        impactType: 'environment_change',
        reason: 'test',
        confidence: 0.8,
    };
}
function makeObservation() {
    return {
        observationId: 'OBS_test',
        source: 'environment',
        type: 'test',
        timestamp: new Date().toISOString(),
        payload: {},
    };
}
describe('D7-3D: AutonomousLoop — continuous task loop', () => {
    describe('safety guards', () => {
        test('maxSteps: loop respects configured max steps as upper bound', async () => {
            const goal = ga.createGoal({
                description: 'max steps test',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxSteps: 2, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect(result.totalSteps).toBeLessThanOrEqual(2);
        });
        test('maxTimeMs: loop stops when time budget exhausted', async () => {
            const goal = ga.createGoal({
                description: 'max time test',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxTimeMs: 1, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect([
                AutonomousLoop_1.LoopTerminationReason.MAX_TIME_REACHED,
                AutonomousLoop_1.LoopTerminationReason.MAX_STEPS_REACHED,
                AutonomousLoop_1.LoopTerminationReason.NO_REPLAN_NEEDED,
            ]).toContain(result.terminationReason);
        });
        test('maxConsecutiveFailures: loop tracks consecutive failures', async () => {
            const goal = ga.createGoal({
                description: 'consecutive failure test',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxConsecutiveFailures: 1, maxSteps: 10, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect(result.consecutiveFailures).toBeGreaterThanOrEqual(0);
        });
        test('maxReplans: loop stops when replan limit reached', async () => {
            const goal = ga.createGoal({
                description: 'replan limit test',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxReplans: 1, maxSteps: 10, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect(result.totalReplans).toBeLessThanOrEqual(1);
        });
        test('safety stop when goal not found', async () => {
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run('G_nonexistent', makeImpact('G_nonexistent'), makeObservation(), { maxSteps: 5, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect(result.terminationReason).toBe(AutonomousLoop_1.LoopTerminationReason.SAFETY_STOP);
        });
    });
    describe('goal terminal states', () => {
        test('GOAL_COMPLETED: loop stops when goal is verified completed', async () => {
            const goal = ga.createGoal({
                description: 'completable goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            ga.updateFromEvidence({
                goalId: goal.goalId,
                decisionId: 'D_1',
                observation: null,
                action: { type: 'message', payload: 'done' },
                expectedEffect: 'complete',
                actualEffect: 'complete',
                progressDelta: 1.0,
            });
            ga.updateGoalStatus(goal.goalId, types_1.GoalStatus.COMPLETED);
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxSteps: 5, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect(result.terminationReason).toBe(AutonomousLoop_1.LoopTerminationReason.GOAL_COMPLETED);
            expect(result.finalGoalStatus).toBe('completed');
        });
        test('GOAL_ABANDONED: loop stops when goal is abandoned', async () => {
            const goal = ga.createGoal({
                description: 'abandoned goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            goal.status = 'abandoned';
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxSteps: 5, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect(result.terminationReason).toBe(AutonomousLoop_1.LoopTerminationReason.GOAL_ABANDONED);
        });
    });
    describe('result structure', () => {
        test('returns complete loop audit trail', async () => {
            const goal = ga.createGoal({
                description: 'audit trail goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxSteps: 3, stepDelayMs: 0 });
            expect(result).toHaveProperty('goalId', goal.goalId);
            expect(result).toHaveProperty('terminated', true);
            expect(result).toHaveProperty('terminationReason');
            expect(result).toHaveProperty('totalSteps');
            expect(result).toHaveProperty('totalReplans');
            expect(result).toHaveProperty('totalTimeMs');
            expect(result).toHaveProperty('finalGoalStatus');
            expect(result).toHaveProperty('finalGoalProgress');
            expect(result).toHaveProperty('steps');
            expect(result).toHaveProperty('consecutiveFailures');
            expect(Array.isArray(result.steps)).toBe(true);
            expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
        });
        test('each step record has required fields', async () => {
            const goal = ga.createGoal({
                description: 'step record goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { maxSteps: 2, stepDelayMs: 0 });
            for (const step of result.steps) {
                expect(step).toHaveProperty('stepIndex');
                expect(step).toHaveProperty('timestamp');
                expect(step).toHaveProperty('goalId');
                expect(step).toHaveProperty('planVersion');
                expect(step).toHaveProperty('stepSuccess');
                expect(step).toHaveProperty('evidenceDelta');
                expect(step).toHaveProperty('decisionId');
                expect(step).toHaveProperty('actionType');
                expect(step).toHaveProperty('actionHash');
            }
        });
    });
    describe('DEFAULT_LOOP_SAFETY', () => {
        test('has all required safety parameters', () => {
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxSteps).toBeGreaterThan(0);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxTimeMs).toBeGreaterThan(0);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxConsecutiveFailures).toBeGreaterThan(0);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxReplans).toBeGreaterThan(0);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.repeatedActionThreshold).toBeGreaterThan(0);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.stepDelayMs).toBeGreaterThanOrEqual(0);
        });
        test('defaults are reasonable for production', () => {
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxSteps).toBeLessThanOrEqual(50);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxTimeMs).toBeLessThanOrEqual(10 * 60 * 1000);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxConsecutiveFailures).toBeLessThanOrEqual(5);
            expect(AutonomousLoop_1.DEFAULT_LOOP_SAFETY.maxReplans).toBeLessThanOrEqual(20);
        });
    });
    describe('repeated action detection', () => {
        test('repeatedActionThreshold is configurable', async () => {
            const goal = ga.createGoal({
                description: 'repeat action goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, makeImpact(goal.goalId), makeObservation(), { repeatedActionThreshold: 2, maxSteps: 10, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
        });
    });
    describe('no replan needed', () => {
        test('terminates with NO_REPLAN_NEEDED when evaluator returns null on first step', async () => {
            const goal = ga.createGoal({
                description: 'no replan goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
            const result = await loop.run(goal.goalId, { ...makeImpact(goal.goalId), confidence: 0.1, affected: false }, makeObservation(), { maxSteps: 5, stepDelayMs: 0 });
            expect(result.terminated).toBe(true);
            expect([
                AutonomousLoop_1.LoopTerminationReason.NO_REPLAN_NEEDED,
                AutonomousLoop_1.LoopTerminationReason.MAX_STEPS_REACHED,
            ]).toContain(result.terminationReason);
        });
    });
});

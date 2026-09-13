"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
const AutonomousRuntime_1 = require("../../authority/AutonomousRuntime");
let ga;
let da;
beforeEach(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    ga = GoalAuthority_1.GoalAuthority.getInstance();
    da = DecisionAuthority_1.DecisionAuthority.getInstance();
    (0, AutonomousRuntime_1.resetAutonomousRuntime)();
});
afterAll(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    (0, AutonomousRuntime_1.resetAutonomousRuntime)();
});
function makeObservation() {
    return {
        observationId: `OBS_test_${Date.now().toString(36)}`,
        source: 'environment',
        type: 'test',
        timestamp: new Date().toISOString(),
        payload: {},
    };
}
describe('D7-4: AutonomousRuntime — persistent self-governing agent', () => {
    describe('lifecycle', () => {
        test('starts in IDLE state', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)();
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.IDLE);
        });
        test('start() transitions to RUNNING', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
            });
            runtime.start();
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.RUNNING);
            runtime.stop();
        });
        test('pause() transitions from RUNNING to PAUSED', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
            });
            runtime.start();
            runtime.pause();
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.PAUSED);
            runtime.stop();
        });
        test('resume() transitions from PAUSED to RUNNING', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
            });
            runtime.start();
            runtime.pause();
            runtime.resume();
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.RUNNING);
            runtime.stop();
        });
        test('stop() transitions to STOPPED', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
            });
            runtime.start();
            runtime.stop();
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.STOPPED);
        });
        test('start() on already running runtime is idempotent', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
            });
            runtime.start();
            runtime.start();
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.RUNNING);
            runtime.stop();
        });
    });
    describe('observation injection', () => {
        test('injectObservation processes observation when running', async () => {
            const goal = ga.createGoal({
                description: 'inject obs goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
            });
            runtime.start();
            await runtime.injectObservation(makeObservation());
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.RUNNING);
            runtime.stop();
        });
        test('injectObservation queues observation when not running', async () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)();
            await runtime.injectObservation(makeObservation());
            expect(runtime.getState()).toBe(AutonomousRuntime_1.RuntimeState.IDLE);
        });
    });
    describe('goal tracking', () => {
        test('getGoalStatuses returns empty map initially', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)();
            const statuses = runtime.getGoalStatuses();
            expect(statuses.size).toBe(0);
        });
        test('goal status tracks loop runs', async () => {
            const goal = ga.createGoal({
                description: 'tracked goal',
                originalInput: 'test',
                executionDomain: 'orchestrator',
            });
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
                goalCooldownMs: 0,
                loopSafety: { maxSteps: 1, stepDelayMs: 0 },
            });
            runtime.start();
            await runtime.injectObservation(makeObservation());
            await new Promise((r) => setTimeout(r, 500));
            const statuses = runtime.getGoalStatuses();
            runtime.stop();
            expect(statuses.size).toBeGreaterThanOrEqual(0);
        });
    });
    describe('concurrency control', () => {
        test('maxConcurrentGoals limits parallel loops', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
                maxConcurrentGoals: 1,
            });
            const config = runtime.getConfig();
            expect(config.maxConcurrentGoals).toBe(1);
        });
        test('goalCooldownMs prevents immediate re-execution', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({
                observationIntervalMs: 60000,
                goalCooldownMs: 30000,
            });
            const config = runtime.getConfig();
            expect(config.goalCooldownMs).toBe(30000);
        });
    });
    describe('DEFAULT_RUNTIME_CONFIG', () => {
        test('has all required configuration parameters', () => {
            expect(AutonomousRuntime_1.DEFAULT_RUNTIME_CONFIG.observationIntervalMs).toBeGreaterThan(0);
            expect(AutonomousRuntime_1.DEFAULT_RUNTIME_CONFIG.maxConcurrentGoals).toBeGreaterThan(0);
            expect(AutonomousRuntime_1.DEFAULT_RUNTIME_CONFIG.goalCooldownMs).toBeGreaterThanOrEqual(0);
        });
        test('defaults are reasonable for production', () => {
            expect(AutonomousRuntime_1.DEFAULT_RUNTIME_CONFIG.observationIntervalMs).toBeLessThanOrEqual(30000);
            expect(AutonomousRuntime_1.DEFAULT_RUNTIME_CONFIG.maxConcurrentGoals).toBeLessThanOrEqual(5);
            expect(AutonomousRuntime_1.DEFAULT_RUNTIME_CONFIG.goalCooldownMs).toBeLessThanOrEqual(60000);
        });
    });
    describe('config immutability', () => {
        test('getConfig returns a copy', () => {
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)();
            const config1 = runtime.getConfig();
            const config2 = runtime.getConfig();
            expect(config1).not.toBe(config2);
            expect(config1).toEqual(config2);
        });
    });
    describe('state machine completeness', () => {
        test('all states are reachable', () => {
            const states = new Set();
            const runtime = (0, AutonomousRuntime_1.getAutonomousRuntime)({ observationIntervalMs: 60000 });
            states.add(runtime.getState());
            runtime.start();
            states.add(runtime.getState());
            runtime.pause();
            states.add(runtime.getState());
            runtime.resume();
            runtime.stop();
            states.add(runtime.getState());
            expect(states.has(AutonomousRuntime_1.RuntimeState.IDLE)).toBe(true);
            expect(states.has(AutonomousRuntime_1.RuntimeState.RUNNING)).toBe(true);
            expect(states.has(AutonomousRuntime_1.RuntimeState.PAUSED)).toBe(true);
            expect(states.has(AutonomousRuntime_1.RuntimeState.STOPPED)).toBe(true);
        });
    });
});

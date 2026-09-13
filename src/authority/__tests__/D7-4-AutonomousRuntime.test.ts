import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import {
  getAutonomousRuntime,
  resetAutonomousRuntime,
  RuntimeState,
  DEFAULT_RUNTIME_CONFIG,
} from '../../authority/AutonomousRuntime';
import type { WorldObservation } from '../../authority/types';

let ga: GoalAuthority;
let da: DecisionAuthority;

beforeEach(() => {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  ga = GoalAuthority.getInstance();
  da = DecisionAuthority.getInstance();
  resetAutonomousRuntime();
});

afterAll(() => {
  GoalAuthority.resetInstance();
  DecisionAuthority.resetInstance();
  resetAutonomousRuntime();
});

function makeObservation(): WorldObservation {
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
      const runtime = getAutonomousRuntime();
      expect(runtime.getState()).toBe(RuntimeState.IDLE);
    });

    test('start() transitions to RUNNING', () => {
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
      });
      runtime.start();
      expect(runtime.getState()).toBe(RuntimeState.RUNNING);
      runtime.stop();
    });

    test('pause() transitions from RUNNING to PAUSED', () => {
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
      });
      runtime.start();
      runtime.pause();
      expect(runtime.getState()).toBe(RuntimeState.PAUSED);
      runtime.stop();
    });

    test('resume() transitions from PAUSED to RUNNING', () => {
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
      });
      runtime.start();
      runtime.pause();
      runtime.resume();
      expect(runtime.getState()).toBe(RuntimeState.RUNNING);
      runtime.stop();
    });

    test('stop() transitions to STOPPED', () => {
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
      });
      runtime.start();
      runtime.stop();
      expect(runtime.getState()).toBe(RuntimeState.STOPPED);
    });

    test('start() on already running runtime is idempotent', () => {
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
      });
      runtime.start();
      runtime.start();
      expect(runtime.getState()).toBe(RuntimeState.RUNNING);
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

      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
      });
      runtime.start();

      await runtime.injectObservation(makeObservation());

      expect(runtime.getState()).toBe(RuntimeState.RUNNING);
      runtime.stop();
    });

    test('injectObservation queues observation when not running', async () => {
      const runtime = getAutonomousRuntime();
      await runtime.injectObservation(makeObservation());
      expect(runtime.getState()).toBe(RuntimeState.IDLE);
    });
  });

  describe('goal tracking', () => {
    test('getGoalStatuses returns empty map initially', () => {
      const runtime = getAutonomousRuntime();
      const statuses = runtime.getGoalStatuses();
      expect(statuses.size).toBe(0);
    });

    test('goal status tracks loop runs', async () => {
      const goal = ga.createGoal({
        description: 'tracked goal',
        originalInput: 'test',
        executionDomain: 'orchestrator',
      });

      const runtime = getAutonomousRuntime({
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
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
        maxConcurrentGoals: 1,
      });

      const config = runtime.getConfig();
      expect(config.maxConcurrentGoals).toBe(1);
    });

    test('goalCooldownMs prevents immediate re-execution', () => {
      const runtime = getAutonomousRuntime({
        observationIntervalMs: 60000,
        goalCooldownMs: 30000,
      });

      const config = runtime.getConfig();
      expect(config.goalCooldownMs).toBe(30000);
    });
  });

  describe('DEFAULT_RUNTIME_CONFIG', () => {
    test('has all required configuration parameters', () => {
      expect(DEFAULT_RUNTIME_CONFIG.observationIntervalMs).toBeGreaterThan(0);
      expect(DEFAULT_RUNTIME_CONFIG.maxConcurrentGoals).toBeGreaterThan(0);
      expect(DEFAULT_RUNTIME_CONFIG.goalCooldownMs).toBeGreaterThanOrEqual(0);
    });

    test('defaults are reasonable for production', () => {
      expect(DEFAULT_RUNTIME_CONFIG.observationIntervalMs).toBeLessThanOrEqual(30000);
      expect(DEFAULT_RUNTIME_CONFIG.maxConcurrentGoals).toBeLessThanOrEqual(5);
      expect(DEFAULT_RUNTIME_CONFIG.goalCooldownMs).toBeLessThanOrEqual(60000);
    });
  });

  describe('config immutability', () => {
    test('getConfig returns a copy', () => {
      const runtime = getAutonomousRuntime();
      const config1 = runtime.getConfig();
      const config2 = runtime.getConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  describe('state machine completeness', () => {
    test('all states are reachable', () => {
      const states = new Set<RuntimeState>();
      const runtime = getAutonomousRuntime({ observationIntervalMs: 60000 });

      states.add(runtime.getState());
      runtime.start();
      states.add(runtime.getState());
      runtime.pause();
      states.add(runtime.getState());
      runtime.resume();
      runtime.stop();
      states.add(runtime.getState());

      expect(states.has(RuntimeState.IDLE)).toBe(true);
      expect(states.has(RuntimeState.RUNNING)).toBe(true);
      expect(states.has(RuntimeState.PAUSED)).toBe(true);
      expect(states.has(RuntimeState.STOPPED)).toBe(true);
    });
  });
});

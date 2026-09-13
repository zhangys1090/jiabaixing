import {
  DesktopDecisionEngine,
  QTableSyncResult,
} from '../../../src/desktop/DesktopDecisionEngine';

describe('P7-D: Q-table Shadow State prevention', () => {
  let engine: DesktopDecisionEngine;

  beforeEach(() => {
    engine = new DesktopDecisionEngine();
  });

  test('unsyncedUpdates tracks Q-table changes', () => {
    expect(engine.getUnsyncedUpdateCount()).toBe(0);
    const state = engine.generateState(0.5, 10, 1, null, 0, 0.5);
    const nextState = engine.generateState(0.5, 10, 1, 'click', 0, 0.6);
    engine.recordExperience(state, 'click', 1.0, nextState, true);
    expect(engine.getUnsyncedUpdateCount()).toBe(1);
    engine.recordExperience(state, 'type', 0.5, nextState, true);
    expect(engine.getUnsyncedUpdateCount()).toBe(2);
  });

  test('markSynced resets unsynced count and sets timestamp', () => {
    const state = engine.generateState(0.5, 10, 1, null, 0, 0.5);
    const nextState = engine.generateState(0.5, 10, 1, 'click', 0, 0.6);
    engine.recordExperience(state, 'click', 1.0, nextState, true);
    expect(engine.getUnsyncedUpdateCount()).toBe(1);
    const before = Date.now();
    const result: QTableSyncResult = engine.markSynced();
    const after = Date.now();
    expect(result.synced).toBe(true);
    expect(result.statesCount).toBeGreaterThanOrEqual(1);
    expect(engine.getUnsyncedUpdateCount()).toBe(0);
    const snapshot = engine.getQTableSnapshot();
    expect(snapshot.lastSync).toBeGreaterThanOrEqual(before);
    expect(snapshot.lastSync).toBeLessThanOrEqual(after);
  });

  test('getQTableSnapshot returns accurate state', () => {
    const snapshot = engine.getQTableSnapshot();
    expect(snapshot.states).toBe(0);
    expect(snapshot.actions).toBe(0);
    expect(snapshot.unsynced).toBe(0);
    const state = engine.generateState(0.5, 10, 1, null, 0, 0.5);
    const nextState = engine.generateState(0.5, 10, 1, 'click', 0, 0.6);
    engine.recordExperience(state, 'click', 1.0, nextState, true);
    const snapshot2 = engine.getQTableSnapshot();
    expect(snapshot2.states).toBeGreaterThanOrEqual(1);
    expect(snapshot2.actions).toBeGreaterThanOrEqual(1);
    expect(snapshot2.unsynced).toBe(1);
  });

  test('enableBridgeSync toggles sync mode', () => {
    expect(engine.isBridgeSyncEnabled()).toBe(false);
    engine.enableBridgeSync(true);
    expect(engine.isBridgeSyncEnabled()).toBe(true);
    engine.enableBridgeSync(false);
    expect(engine.isBridgeSyncEnabled()).toBe(false);
  });

  test('selectActionWithBridgeCheck: Bridge available → normal decision', () => {
    const state = engine.generateState(0.5, 10, 1, null, 0, 0.5);
    const action = engine.selectActionWithBridgeCheck(state, ['click', 'type'], true);
    expect(action.actionType).not.toBe('wait');
    expect(action.riskLevel).not.toBe('high');
  });

  test('selectActionWithBridgeCheck: Bridge unavailable + sync enabled → FAIL CLOSED', () => {
    engine.enableBridgeSync(true);
    const state = engine.generateState(0.5, 10, 1, null, 0, 0.5);
    const action = engine.selectActionWithBridgeCheck(state, ['click', 'type'], false);
    expect(action.actionType).toBe('wait');
    expect(action.confidence).toBe(0);
    expect(action.riskLevel).toBe('high');
    expect(action.reasoning).toContain('FAIL CLOSED');
    expect(action.reasoning).toContain('Shadow State');
  });

  test('selectActionWithBridgeCheck: Bridge unavailable + sync disabled → allows decision', () => {
    engine.enableBridgeSync(false);
    const state = engine.generateState(0.5, 10, 1, null, 0, 0.5);
    const action = engine.selectActionWithBridgeCheck(state, ['click', 'type'], false);
    expect(action.actionType).not.toBe('wait');
  });
});

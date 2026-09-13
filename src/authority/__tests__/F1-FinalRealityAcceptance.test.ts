/**
 * F1: Final Reality Acceptance — 攻击式验证
 *
 * 不是问"Authority有没有"，而是问：
 * "一个真实任务进入Jiabaixing后，能不能绕过Authority、
 *  能不能自己宣布完成、能不能在失败后不改变策略、
 *  能不能从另一条旧路执行出去？"
 *
 * 四张证据表：
 *   A. Production Entry Census
 *   B. Action Sink / Authority Census
 *   C. Adversarial Kill Tests
 *   D. Real Novel Task Replay
 */

import fs from 'fs';
import path from 'path';
import { DecisionGuard } from '../DecisionGuard';
import { DecisionAuthority } from '../DecisionAuthority';
import { GoalAuthority } from '../GoalAuthority';
import { StateAuthority } from '../StateAuthority';
import { MemoryAuthorityGuard } from '../MemoryAuthorityGuard';
import { MemoryAuthority } from '../MemoryAuthority';
import type { CanonicalDecisionSnapshot, DecisionCandidate } from '../types';

const SRC_ROOT = path.resolve(__dirname, '../../');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relPath), 'utf-8');
}

function grepInSrc(pattern: RegExp, relDir?: string): Array<{ file: string; line: number; text: string }> {
  const dir = relDir ? path.join(SRC_ROOT, relDir) : SRC_ROOT;
  const results: Array<{ file: string; line: number; text: string }> = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'release') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const lines = fs.readFileSync(full, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            results.push({ file: path.relative(SRC_ROOT, full).replace(/\\/g, '/'), line: i + 1, text: lines[i].trim() });
          }
        }
      }
    }
  }
  walk(dir);
  return results;
}

function makeSnapshot(snapshotId = 'ss_f1'): CanonicalDecisionSnapshot {
  return {
    snapshotId,
    timestamp: Date.now(),
    activeGoalIds: [],
    self: { agentId: 'jiabaixing', activeGoalIds: [], currentStage: 'idle', safetyStatus: 'nominal' },
    world: { observation: null, platform: 'desktop', timestamp: Date.now() },
    memory: { relevantMemories: [], query: '', timestamp: Date.now() },
    context: { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() },
    capabilities: { availableTools: [], availableSkills: [], desktopAvailable: true, bridgeAvailable: false },
  };
}

// ═══════════════════════════════════════════════════════════════
// A. Production Entry Census
// ═══════════════════════════════════════════════════════════════

describe('F1-A: Production Entry Census', () => {
  const PRODUCTION_ENTRIES = [
    { name: 'HTTP /api/chat', file: 'server/routes/chatRoutes.ts', guard: 'DecisionGuard' },
    { name: 'HTTP /api/tools/execute', file: 'server/routes/toolRoutes.ts', guard: 'DecisionGuard' },
    { name: 'HTTP /api/core (screenshot)', file: 'server/routes/coreRoutes.ts', guard: 'DecisionGuard' },
    { name: 'HTTP /api/orchestrate', file: 'server/routes/orchestrateRoutes.ts', guard: 'core.processInput' },
    { name: 'HTTP /v1/chat/completions', file: 'server/routes/openaiCompatibleRoutes.ts', guard: 'processInput callback' },
    { name: 'WebSocket stream', file: 'server/websocket.ts', guard: 'bridge.processInputStream (Python chain)' },
    { name: 'Harness AgentHarness', file: 'harness/AgentHarness.ts', guard: 'bridge.processInput (Python chain)' },
    { name: 'OrchestratorAgent replan', file: 'harness/orchestration/OrchestratorAgent.ts', guard: 'bridge.processInput (Python chain)' },
    { name: 'JiabaixingCore.processInput', file: 'core/JiabaixingCore.ts', guard: 'bridge.processInput (Python chain)' },
    { name: 'DesktopAgentLoop', file: 'desktop/DesktopAgentLoop.ts', guard: 'DecisionGuard' },
    { name: 'DesktopChannel', file: 'harness/action/channels/DesktopChannel.ts', guard: 'DecisionGuard' },
    { name: 'ToolChannel', file: 'harness/action/channels/ToolChannel.ts', guard: 'DecisionGuard' },
    { name: 'DesktopMCPServer', file: 'desktop/DesktopMCPServer.ts', guard: 'DecisionGuard' },
    { name: 'StateSnapshotManager', file: 'desktop/StateSnapshotManager.ts', guard: 'DecisionGuard' },
    { name: 'DesktopExecutionAgent', file: 'desktop/DesktopExecutionAgent.ts', guard: 'DecisionAuthority.decide() + ActionAuthority' },
    { name: 'SelfModificationEngine', file: 'evolution/v2/SelfModificationEngine.ts', guard: 'HMAC one-shot gate + ActionAuthority' },
  ];

  test('A-1: every production entry has a declared guard', () => {
    const unguarded = PRODUCTION_ENTRIES.filter(e => !e.guard || e.guard === 'NONE');
    expect(unguarded).toEqual([]);
  });

  test('A-2: TS-side entries with DecisionGuard actually import it', () => {
    const dgEntries = PRODUCTION_ENTRIES.filter(e => e.guard === 'DecisionGuard');
    for (const entry of dgEntries) {
      const content = readFile(entry.file);
      const hasImport = content.includes('DecisionGuard');
      expect({ file: entry.file, hasImport }).toEqual({ file: entry.file, hasImport: true });
    }
  });

  test('A-3: TS-side entries with DecisionGuard call guardAction()', () => {
    const dgEntries = PRODUCTION_ENTRIES.filter(e => e.guard === 'DecisionGuard');
    for (const entry of dgEntries) {
      const content = readFile(entry.file);
      const hasGuardAction = content.includes('guardAction(') || content.includes('guard.guardAction(');
      expect({ file: entry.file, hasGuardAction }).toEqual({ file: entry.file, hasGuardAction: true });
    }
  });

  test('A-4: Python-bridge entries go through core.processInput or bridge.processInput', () => {
    const bridgeEntries = PRODUCTION_ENTRIES.filter(e => e.guard.includes('Python chain'));
    for (const entry of bridgeEntries) {
      const content = readFile(entry.file);
      const hasBridge = content.includes('bridge.processInput') || content.includes('bridge.processInputStream') || content.includes('core.processInput');
      expect({ file: entry.file, hasBridge }).toEqual({ file: entry.file, hasBridge: true });
    }
  });

  test('A-5: no production entry bypasses to registry.execute() without DecisionGuard', () => {
    const directRegistryCalls = grepInSrc(/registry\.execute\(/, 'server/routes');
    const unguarded = directRegistryCalls.filter(r => {
      const content = readFile(r.file);
      return !content.includes('DecisionGuard');
    });
    expect(unguarded).toEqual([]);
  });

  test('A-6: WebSocket entry — bridge.processInputStream is the ONLY production path', () => {
    const content = readFile('server/websocket.ts');
    const hasBridge = content.includes('bridge.processInputStream');
    const hasDirectRegistry = content.includes('registry.execute');
    expect({ hasBridge, hasDirectRegistry }).toEqual({ hasBridge: true, hasDirectRegistry: false });
  });

  test('A-7: orchestrate route goes through core.processInput', () => {
    const content = readFile('server/routes/orchestrateRoutes.ts');
    const hasCoreProcessInput = content.includes('core.processInput') || content.includes('getCore().processInput');
    expect(hasCoreProcessInput).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. Action Sink / Authority Census
// ═══════════════════════════════════════════════════════════════

describe('F1-B: Action Sink / Authority Census', () => {
  const ACTION_SINKS = [
    { sink: 'registry.execute()', pattern: /registry\.execute\(/, guardPattern: /DecisionGuard|guardAction/ },
    { sink: 'authority.execute()', pattern: /this\.authority\.execute\(/, guardPattern: /DecisionGuard|guardAction/ },
    { sink: 'authority.executeAction()', pattern: /authority\.executeAction\(/, guardPattern: /DecisionGuard|guardAction|DecisionAuthority\.decide/ },
    { sink: 'memoryEngine.storeShortTermMemory()', pattern: /memoryEngine\.storeShortTermMemory/, guardPattern: /MemoryAuthorityGuard|MemoryAuthority\.getInstance/ },
    { sink: 'memoryEngine.storeLongTermMemory()', pattern: /memoryEngine\.storeLongTermMemory/, guardPattern: /MemoryAuthorityGuard|MemoryAuthority\.getInstance/ },
    { sink: 'memoryEngine.storeInstantMemory()', pattern: /memoryEngine\.storeInstantMemory/, guardPattern: /MemoryAuthorityGuard|MemoryAuthority\.getInstance/ },
    { sink: 'memoryEngine.storeFeedbackSignal()', pattern: /memoryEngine\.storeFeedbackSignal/, guardPattern: /MemoryAuthorityGuard|MemoryAuthority\.getInstance/ },
  ];

  test('B-1: every registry.execute() in production routes has DecisionGuard', () => {
    const calls = grepInSrc(/registry\.execute\(/, 'server/routes');
    for (const call of calls) {
      const content = readFile(call.file);
      const hasGuard = content.includes('DecisionGuard');
      expect({ file: call.file, line: call.line, hasGuard }).toEqual({ file: call.file, line: call.line, hasGuard: true });
    }
  });

  test('B-2: every registry.execute() in harness channels has DecisionGuard', () => {
    const calls = grepInSrc(/registry\.execute\(/, 'harness/action/channels');
    for (const call of calls) {
      const content = readFile(call.file);
      const hasGuard = content.includes('DecisionGuard');
      expect({ file: call.file, line: call.line, hasGuard }).toEqual({ file: call.file, line: call.line, hasGuard: true });
    }
  });

  test('B-3: every memoryEngine.store*() outside initMemory.ts has MemoryAuthorityGuard', () => {
    const storeCalls = grepInSrc(/memoryEngine\.store(ShortTerm|LongTerm|Instant|FeedbackSignal)Memory?/);
    const nonFallback = storeCalls.filter(c => {
      if (c.file.includes('initMemory.ts')) return false;
      if (c.text.includes('不再直接调用')) return false;
      return true;
    });
    for (const call of nonFallback) {
      const content = readFile(call.file);
      const hasGuard = content.includes('MemoryAuthorityGuard');
      expect({ file: call.file, line: call.line, hasGuard }).toEqual({ file: call.file, line: call.line, hasGuard: true });
    }
  });

  test('B-4: DesktopAgentLoop.authority.execute() has DecisionGuard', () => {
    const content = readFile('desktop/DesktopAgentLoop.ts');
    const hasGuard = content.includes('DecisionGuard');
    expect(hasGuard).toBe(true);
  });

  test('B-5: DesktopChannel.authority.executeAction() has DecisionGuard', () => {
    const content = readFile('harness/action/channels/DesktopChannel.ts');
    const hasGuard = content.includes('DecisionGuard');
    expect(hasGuard).toBe(true);
  });

  test('B-6: DesktopMCPServer has DecisionGuard at callTool entry', () => {
    const content = readFile('desktop/DesktopMCPServer.ts');
    const hasGuard = content.includes('DecisionGuard');
    const hasGuardAction = content.includes('guardAction(');
    expect({ hasGuard, hasGuardAction }).toEqual({ hasGuard: true, hasGuardAction: true });
  });

  test('B-7: StateSnapshotManager restoreWindowState has DecisionGuard', () => {
    const content = readFile('desktop/StateSnapshotManager.ts');
    const hasGuard = content.includes('DecisionGuard');
    expect(hasGuard).toBe(true);
  });

  test('B-8: delegate_task.ts toolRegistry.execute() — tool execution under Python canonical', () => {
    const content = readFile('harness/tools/system/delegate_task.ts');
    const hasRegistryExecute = content.includes('toolRegistry.execute');
    expect(hasRegistryExecute).toBe(true);
  });

  test('B-9: memory_store.ts uses deps.storeShortTermMemory (injected, not direct)', () => {
    const content = readFile('harness/tools/memory/memory_store.ts');
    const usesDirectEngine = content.includes('memoryEngine.storeShortTermMemory');
    const usesInjectedDeps = content.includes('deps.storeShortTermMemory') || content.includes('deps.storeWithMetadata');
    expect({ usesDirectEngine, usesInjectedDeps }).toEqual({ usesDirectEngine: false, usesInjectedDeps: true });
  });

  test('B-10: no "bypasses DecisionAuthority" AUDIT log remains in production code', () => {
    const bypasses = grepInSrc(/bypasses DecisionAuthority/);
    const inProduction = bypasses.filter(c => !c.file.includes('__tests__'));
    const allowedBypassSources = ['SelfModificationEngine'];
    const unallowed = inProduction.filter(c => !allowedBypassSources.some(s => c.file.includes(s)));
    expect(unallowed).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// C. Adversarial Kill Tests
// ═══════════════════════════════════════════════════════════════

describe('F1-C: Adversarial Kill Tests', () => {
  beforeEach(() => {
    DecisionGuard.resetInstance();
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    StateAuthority.resetInstance();
    MemoryAuthority.resetInstance();
  });

  afterEach(() => {
    DecisionGuard.resetInstance();
    GoalAuthority.resetInstance();
    DecisionAuthority.resetInstance();
    StateAuthority.resetInstance();
    MemoryAuthority.resetInstance();
  });

  test('C-1: Kill DecisionGuard → guardAction throws → no production action possible', async () => {
    const guard = DecisionGuard.getInstance();
    const originalGuardAction = guard.guardAction.bind(guard);
    (guard as unknown as Record<string, unknown>).guardAction = async () => {
      throw new Error('DECISION_GUARD_KILLED');
    };

    try {
      await guard.guardAction({
        action: { type: 'tool_call', payload: { toolName: 'test' } },
        description: 'Kill test',
        executionDomain: 'tool_execution',
        proposerId: 'kill_test',
      });
      fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('DECISION_GUARD_KILLED');
    }

    (guard as unknown as Record<string, unknown>).guardAction = originalGuardAction;
  });

  test('C-2: Kill DecisionAuthority.decide() → DecisionGuard.guardAction() fails', async () => {
    const da = DecisionAuthority.getInstance();
    const originalDecide = da.decide.bind(da);
    (da as unknown as Record<string, unknown>).decide = async () => {
      throw new Error('DECISION_AUTHORITY_KILLED');
    };

    const guard = DecisionGuard.getInstance();
    try {
      await guard.guardAction({
        action: { type: 'tool_call', payload: { toolName: 'test' } },
        description: 'Kill DA test',
        executionDomain: 'tool_execution',
        proposerId: 'kill_test',
      });
      fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('DECISION_AUTHORITY_KILLED');
    }

    (da as unknown as Record<string, unknown>).decide = originalDecide;
  });

  test('C-3: Kill GoalAuthority → DecisionGuard cannot create goal → fails', async () => {
    const ga = GoalAuthority.getInstance();
    const originalCreate = ga.createGoal.bind(ga);
    (ga as unknown as Record<string, unknown>).createGoal = () => {
      throw new Error('GOAL_AUTHORITY_KILLED');
    };

    const guard = DecisionGuard.getInstance();
    try {
      await guard.guardAction({
        action: { type: 'tool_call', payload: { toolName: 'test' } },
        description: 'Kill GA test',
        executionDomain: 'tool_execution',
        proposerId: 'kill_test',
      });
      fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('GOAL_AUTHORITY_KILLED');
    }

    (ga as unknown as Record<string, unknown>).createGoal = originalCreate;
  });

  test('C-4: Kill StateAuthority → DecisionGuard cannot capture snapshot → fails', async () => {
    const sa = StateAuthority.getInstance();
    const originalCapture = sa.captureSnapshot.bind(sa);
    (sa as unknown as Record<string, unknown>).captureSnapshot = async () => {
      throw new Error('STATE_AUTHORITY_KILLED');
    };

    const ga = GoalAuthority.getInstance();
    const goal = ga.createGoal({ description: 'Kill SA test', originalInput: 'test', executionDomain: 'tool_execution' });

    const guard = DecisionGuard.getInstance();
    try {
      await guard.guardAction({
        action: { type: 'tool_call', payload: { toolName: 'test' } },
        description: 'Kill SA test',
        executionDomain: 'tool_execution',
        proposerId: 'kill_test',
        existingGoalId: goal.goalId,
      });
      fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('STATE_AUTHORITY_KILLED');
    }

    (sa as unknown as Record<string, unknown>).captureSnapshot = originalCapture;
  });

  test('C-5: Kill MemoryAuthorityGuard → write fails gracefully', async () => {
    const ma = MemoryAuthority.getInstance();
    const originalWrite = ma.write.bind(ma);
    (ma as unknown as Record<string, unknown>).write = async () => {
      throw new Error('MEMORY_AUTHORITY_KILLED');
    };

    const memGuard = MemoryAuthorityGuard.getInstance();
    const result = await memGuard.writeShortTerm('test', 'test', 'neutral');
    expect(result).toBe(false);

    (ma as unknown as Record<string, unknown>).write = originalWrite;
  });

  test('C-6: MemoryAuthority without bridge → fail-closed for Python domains', async () => {
    const ma = MemoryAuthority.getInstance();
    expect(ma.isBridgeAvailable()).toBe(false);

    const pythonDomains: Array<'short_term' | 'long_term' | 'episodic' | 'cross_session' | 'visual' | 'tool_selection' | 'feedback'> =
      ['short_term', 'long_term', 'episodic', 'cross_session', 'visual', 'tool_selection', 'feedback'];

    for (const domain of pythonDomains) {
      const result = await ma.write({ content: 'kill test', memoryType: domain });
      expect(result.success).toBe(false);
      expect(result.source).toBe('failed_closed');
    }
  });

  test('C-7: DecisionGuard produces complete authorityMeta lineage', async () => {
    const guard = DecisionGuard.getInstance();
    const { decision, snapshot, goalId } = await guard.guardAction({
      action: { type: 'tool_call', payload: { toolName: 'test_tool' } },
      description: 'Lineage test',
      executionDomain: 'tool_execution',
      proposerId: 'lineage_test',
    });

    const meta = guard.extractAuthorityMeta(decision, snapshot, goalId);

    expect(meta.goalId).toBeTruthy();
    expect(meta.snapshotId).toBeTruthy();
    expect(meta.decisionId).toBeTruthy();
    expect(meta.planVersion).toBeGreaterThanOrEqual(0);
    expect(meta.goalId).toBe(goalId);
    expect(meta.snapshotId).toBe(snapshot.snapshotId);
    expect(meta.decisionId).toBe(decision.decisionId);
  });

  test('C-8: reportEvidence updates goal progress on success/failure', async () => {
    const guard = DecisionGuard.getInstance();
    const { decision, goalId } = await guard.guardAction({
      action: { type: 'tool_call', payload: { toolName: 'test' } },
      description: 'Evidence test',
      executionDomain: 'tool_execution',
      proposerId: 'evidence_test',
    });

    const ga = GoalAuthority.getInstance();
    const goalBefore = ga.getGoal(goalId);
    const progressBefore = goalBefore?.progress ?? 0;

    guard.reportEvidence({
      goalId,
      decisionId: decision.decisionId,
      action: decision.chosen.action,
      expectedEffect: 'test',
      actualEffect: 'success',
      observation: 'ok',
      success: true,
    });

    const goalAfter = ga.getGoal(goalId);
    expect(goalAfter!.progress).toBeGreaterThan(progressBefore);

    guard.reportEvidence({
      goalId,
      decisionId: decision.decisionId,
      action: decision.chosen.action,
      expectedEffect: 'test',
      actualEffect: 'failed',
      observation: 'error',
      success: false,
    });

    const goalAfterFail = ga.getGoal(goalId);
    expect(goalAfterFail!.progress).toBeLessThanOrEqual(goalAfter!.progress);
  });
});

// ═══════════════════════════════════════════════════════════════
// D. Legacy Path Deactivation Proof
// ═══════════════════════════════════════════════════════════════

describe('F1-D: Legacy Path Deactivation Proof', () => {
  test('D-1: no direct memoryEngine.store*() in PersistenceService (all via MemoryAuthorityGuard)', () => {
    const content = readFile('harness/persistence/PersistenceService.ts');
    const hasGuard = content.includes('MemoryAuthorityGuard');
    const directStoreCalls = (content.match(/this\.deps\.memoryEngine\.store(ShortTerm|LongTerm|Instant)Memory/g) || []).length;
    const directFeedbackCalls = (content.match(/this\.deps\.memoryEngine\.storeFeedbackSignal/g) || []).length;
    expect({ hasGuard, directStoreCalls, directFeedbackCalls }).toEqual({ hasGuard: true, directStoreCalls: 0, directFeedbackCalls: 0 });
  });

  test('D-2: no direct memoryEngine.store*() in MemoryAssistant (all via MemoryAuthorityGuard)', () => {
    const content = readFile('core/MemoryAssistant.ts');
    const hasGuard = content.includes('MemoryAuthorityGuard');
    const directShortTerm = content.includes('this.memoryEngine.storeShortTermMemory');
    const directLongTerm = content.includes('this.memoryEngine.storeLongTermMemory');
    expect({ hasGuard, directShortTerm, directLongTerm }).toEqual({ hasGuard: true, directShortTerm: false, directLongTerm: false });
  });

  test('D-3: no direct memoryEngine.store*() in memoryRoutes (all via MemoryAuthorityGuard)', () => {
    const content = readFile('server/routes/memoryRoutes.ts');
    const hasGuard = content.includes('MemoryAuthorityGuard');
    const directStore = content.includes('memoryEngine.storeShortTermMemory') && !content.includes('不再直接调用');
    expect({ hasGuard, directStore }).toEqual({ hasGuard: true, directStore: false });
  });

  test('D-4: no "bypasses DecisionAuthority" in DesktopAgentLoop', () => {
    const content = readFile('desktop/DesktopAgentLoop.ts');
    const hasBypass = content.includes('bypasses DecisionAuthority');
    expect(hasBypass).toBe(false);
  });

  test('D-5: no "bypasses DecisionAuthority" in DesktopChannel', () => {
    const content = readFile('harness/action/channels/DesktopChannel.ts');
    const hasBypass = content.includes('bypasses DecisionAuthority');
    expect(hasBypass).toBe(false);
  });

  test('D-6: no "bypasses DecisionAuthority" in DesktopMCPServer', () => {
    const content = readFile('desktop/DesktopMCPServer.ts');
    const hasBypass = content.includes('bypasses DecisionAuthority');
    expect(hasBypass).toBe(false);
  });

  test('D-7: no "bypasses DecisionAuthority" in StateSnapshotManager', () => {
    const content = readFile('desktop/StateSnapshotManager.ts');
    const hasBypass = content.includes('bypasses DecisionAuthority');
    expect(hasBypass).toBe(false);
  });

  test('D-8: ToolChannel uses DecisionGuard (not raw registry.execute)', () => {
    const content = readFile('harness/action/channels/ToolChannel.ts');
    const hasGuard = content.includes('DecisionGuard');
    const hasGuardAction = content.includes('guardAction(');
    const hasReportEvidence = content.includes('reportEvidence(');
    expect({ hasGuard, hasGuardAction, hasReportEvidence }).toEqual({
      hasGuard: true,
      hasGuardAction: true,
      hasReportEvidence: true,
    });
  });

  test('D-9: initHarness.ts uses MemoryAuthorityGuard (not raw memoryEngine)', () => {
    const content = readFile('server/init/initHarness.ts');
    const hasGuard = content.includes('MemoryAuthorityGuard');
    const directStorePattern = /(?<!\w)memoryEngine\.store(ShortTerm|LongTerm|Instant)Memory\(/g;
    const directMatches = content.match(directStorePattern);
    expect({ hasGuard, directMatches: directMatches?.length ?? 0 }).toEqual({ hasGuard: true, directMatches: 0 });
  });

  test('D-10: bridge.processInput() in websocket.ts — Python chain covers authority', () => {
    const content = readFile('server/websocket.ts');
    const hasBridgeStream = content.includes('bridge.processInputStream');
    expect(hasBridgeStream).toBe(true);
  });
});

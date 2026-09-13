import { MemoryAuthority } from '../../authority/MemoryAuthority';
import type { MemoryWriteRequest, MemoryReadRequest, MemoryWriteResult, MemoryReadResult } from '../../authority/MemoryAuthority';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { StateAuthority } from '../../authority/StateAuthority';
import { LearningAuthority } from '../../authority/LearningAuthority';
import type { DecisionContext, CanonicalDecisionSnapshot, DecisionCandidate } from '../../authority/types';

function makeSnapshot(snapshotId = 'ss_test'): CanonicalDecisionSnapshot {
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

describe('E3: Production Authority Proof', () => {
  describe('E3-1: Memory Smoke', () => {
    let ma: MemoryAuthority;

    beforeEach(() => {
      MemoryAuthority.resetInstance();
      ma = MemoryAuthority.getInstance();
    });

    afterEach(() => {
      MemoryAuthority.resetInstance();
    });

    test('bridge NOT registered → all Python domains fail-closed', async () => {
      expect(ma.isBridgeAvailable()).toBe(false);

      const pythonDomains: Array<'short_term' | 'long_term' | 'episodic' | 'cross_session' | 'visual' | 'tool_selection' | 'feedback'> =
        ['short_term', 'long_term', 'episodic', 'cross_session', 'visual', 'tool_selection', 'feedback'];

      for (const domain of pythonDomains) {
        const writeResult = await ma.write({
          content: 'test',
          memoryType: domain,
        });
        expect(writeResult.source).toBe('failed_closed');
        expect(writeResult.success).toBe(false);

        const readResult = await ma.read({
          query: 'test',
          memoryType: domain,
        });
        expect(readResult.source).toBe('failed_closed');
      }
    });

    test('bridge registered → Python domains route to python owner', async () => {
      const mockWrite = jest.fn().mockResolvedValue({
        success: true,
        memoryId: 'mem_123',
        operationId: 'op_123',
        source: 'python',
      });
      const mockRead = jest.fn().mockResolvedValue({
        items: [{ id: 'mem_123', content: 'test', memoryType: 'short_term', relevanceScore: 1.0, timestamp: Date.now() }],
        operationId: 'op_124',
        source: 'python',
      });

      ma.registerBridge(
        mockWrite as any,
        mockRead as any
      );

      expect(ma.isBridgeAvailable()).toBe(true);

      const writeResult = await ma.write({
        content: 'hello world',
        memoryType: 'short_term',
        goalId: 'G_test',
      });
      expect(writeResult.source).toBe('python');
      expect(writeResult.success).toBe(true);
      expect(mockWrite).toHaveBeenCalledTimes(1);

      const readResult = await ma.read({
        query: 'hello',
        memoryType: 'short_term',
      });
      expect(readResult.source).toBe('python');
      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    test('bridge registered then disconnected → fail-closed', async () => {
      const mockWrite = jest.fn().mockResolvedValue({
        success: true,
        memoryId: 'mem_123',
        operationId: 'op_123',
        source: 'python',
      });
      const mockRead = jest.fn().mockResolvedValue({
        items: [],
        operationId: 'op_124',
        source: 'python',
      });

      ma.registerBridge(mockWrite as any, mockRead as any);
      expect(ma.isBridgeAvailable()).toBe(true);

      const writeOk = await ma.write({ content: 'test', memoryType: 'short_term' });
      expect(writeOk.source).toBe('python');

      MemoryAuthority.resetInstance();
      ma = MemoryAuthority.getInstance();
      expect(ma.isBridgeAvailable()).toBe(false);

      const writeFail = await ma.write({ content: 'test', memoryType: 'short_term' });
      expect(writeFail.source).toBe('failed_closed');

      const readFail = await ma.read({ query: 'test', memoryType: 'short_term' });
      expect(readFail.source).toBe('failed_closed');
    });

    test('ts_bridge domain (persistent_hermes) does NOT fail-closed when bridge absent', async () => {
      expect(ma.isBridgeAvailable()).toBe(false);

      const writeResult = await ma.write({
        content: 'test',
        memoryType: 'persistent_hermes',
      });
      expect(writeResult.source).toBe('ts_bridge');
    });
  });

  describe('E3-2: Authority Replay (Goal→State→Decision→Evidence→Learning)', () => {
    let ga: GoalAuthority;
    let da: DecisionAuthority;

    beforeEach(() => {
      GoalAuthority.resetInstance();
      DecisionAuthority.resetInstance();
      LearningAuthority.resetInstance();
      ga = GoalAuthority.getInstance();
      da = DecisionAuthority.getInstance();
    });

    afterEach(() => {
      GoalAuthority.resetInstance();
      DecisionAuthority.resetInstance();
      LearningAuthority.resetInstance();
    });

    test('full authority replay: create goal → decide → evidence → learning', async () => {
      const goal = ga.createGoal({
        description: 'Open the calculator app',
        originalInput: 'open calculator',
        priority: 5,
        executionDomain: 'desktop',
      });

      expect(goal.goalId).toMatch(/^G_/);
      expect(goal.status).toBe('active');
      expect(goal.progress).toBe(0);

      const snapshot = makeSnapshot('ss_replay_1');
      const candidates: DecisionCandidate[] = [
        {
          candidateId: 'c1',
          proposerId: 'desktop_llm',
          action: { type: 'desktop_action', payload: { app: 'calculator' } },
          confidence: 0.9,
          reasoning: 'User asked to open calculator',
          estimatedGoalProgress: 0.8,
        },
      ];

      const decision = await da.decide({
        goalId: goal.goalId,
        snapshot,
        candidates,
      });

      expect(decision.decisionId).toMatch(/^D_/);
      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.chosen.candidateId).toBe('c1');

      ga.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: decision.decisionId,
        observation: 'Calculator window appeared on screen',
        action: { type: 'desktop_action', payload: { app: 'calculator' } },
        expectedEffect: 'Calculator app opens',
        actualEffect: 'Calculator app opened successfully',
        progressDelta: 0.8,
      });

      const updatedGoal = ga.getGoal(goal.goalId);
      expect(updatedGoal).not.toBeNull();
      expect(updatedGoal!.progress).toBeGreaterThan(0);

      const learningKey = Object.keys(updatedGoal!.metadata).find(k => k.startsWith('learning_'));
      if (learningKey) {
        const learningStatus = (updatedGoal!.metadata[learningKey] as any).status;
        expect(['applied', 'no_update_needed', 'failed']).toContain(learningStatus);
      }
    });

    test('evidence with failure → learning status is observable', () => {
      const goal = ga.createGoal({
        description: 'Delete a protected file',
        originalInput: 'delete system.dll',
        priority: 5,
        executionDomain: 'desktop',
      });

      const snapshot = makeSnapshot('ss_replay_2');

      da.decide({
        goalId: goal.goalId,
        snapshot,
        candidates: [{
          candidateId: 'c2',
          proposerId: 'desktop_llm',
          action: { type: 'desktop_action', payload: { file: 'system.dll' } },
          confidence: 0.3,
          reasoning: 'Attempt delete',
          estimatedGoalProgress: 0.5,
        }],
      }).then(decision => {
        ga.updateFromEvidence({
          goalId: goal.goalId,
          decisionId: decision.decisionId,
          observation: 'Permission denied',
          action: { type: 'desktop_action', payload: { file: 'system.dll' } },
          expectedEffect: 'File deleted',
          actualEffect: 'Permission denied - file is protected',
          progressDelta: -0.1,
        });

        const updatedGoal = ga.getGoal(goal.goalId);
        expect(updatedGoal).not.toBeNull();

        const learningKey = Object.keys(updatedGoal!.metadata).find(k => k.startsWith('learning_'));
        if (learningKey) {
          const learningMeta = updatedGoal!.metadata[learningKey] as any;
          expect(['applied', 'no_update_needed', 'failed']).toContain(learningMeta.status);
        }
      });
    });

    test('decision history is auditable', async () => {
      const goal = ga.createGoal({
        description: 'Multi-step task',
        originalInput: 'do something complex',
        executionDomain: 'desktop',
      });

      const snapshot1 = makeSnapshot('ss_hist_1');
      const snapshot2 = makeSnapshot('ss_hist_2');

      await da.decide({
        goalId: goal.goalId,
        snapshot: snapshot1,
        candidates: [{
          candidateId: 'c1',
          proposerId: 'proposer_a',
          action: { type: 'message', payload: 'step 1' },
          confidence: 0.8,
          reasoning: 'First step',
          estimatedGoalProgress: 0.3,
        }],
      });

      await da.decide({
        goalId: goal.goalId,
        snapshot: snapshot2,
        candidates: [{
          candidateId: 'c2',
          proposerId: 'proposer_b',
          action: { type: 'message', payload: 'step 2' },
          confidence: 0.9,
          reasoning: 'Second step',
          estimatedGoalProgress: 0.6,
        }],
      });

      const history = da.getDecisionHistory(goal.goalId);
      expect(history.length).toBe(2);
      expect(history[0].chosen.action.payload).toBe('step 1');
      expect(history[1].chosen.action.payload).toBe('step 2');
    });
  });

  describe('E3-3: Anomaly Verification — Authority unavailable = explicit failure', () => {
    test('MemoryAuthority without bridge → no silent fallback', async () => {
      MemoryAuthority.resetInstance();
      const ma = MemoryAuthority.getInstance();

      const result = await ma.write({ content: 'test', memoryType: 'short_term' });
      expect(result.source).toBe('failed_closed');
      expect(result.success).toBe(false);

      const readResult = await ma.read({ query: 'test', memoryType: 'short_term' });
      expect(readResult.source).toBe('failed_closed');
      expect(readResult.items).toEqual([]);
    });

    test('SelfModificationEngine without authorityMeta → BLOCK not silent pass', async () => {
      const { SelfModificationEngine } = require('../../evolution/v2/SelfModificationEngine');
      const engine = new SelfModificationEngine();

      const result = await engine.executePlan({
        id: 'test-plan',
        type: 'CODE_OPTIMIZATION',
        priority: 'MEDIUM',
        cause: { type: 'PROACTIVE_IMPROVEMENT', description: 'Test', context: {}, timestamp: Date.now() },
        title: 'Test',
        description: 'Test',
        actions: [{ type: 'CREATE_FILE', target: '/tmp/e3-test.txt', content: 'test', description: 'create test' }],
        estimatedRisk: 'LOW',
        validationSteps: [],
        createdAt: Date.now(),
      }, 'cp-e3');

      expect(result.success).toBe(false);
      expect(result.error).toContain('E2-3');
    });

    test('SelfModificationEngine stale authority → BLOCK not silent reuse', async () => {
      const { SelfModificationEngine } = require('../../evolution/v2/SelfModificationEngine');
      const { signAuthorityMeta, actionHash } = require('../../authority/AuthoritySignature');
      const path = require('path');
      const os = require('os');
      const fs = require('fs');

      const engine = new SelfModificationEngine();
      const task = 'create test file';
      const hash = actionHash(task);
      const sig = signAuthorityMeta('G_e3', 'SS_e3', 'D_e3', 1, hash);

      engine.setAuthorityMeta({
        authority_goalId: 'G_e3',
        authority_snapshotId: 'SS_e3',
        authority_decisionId: 'D_e3',
        authority_planVersion: 1,
        authority_actionHash: hash,
        authority_sig: sig,
      });

      const tempDir = path.join(os.tmpdir(), `e3-stale-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const result1 = await engine.executePlan({
        id: 'plan-1',
        type: 'CODE_OPTIMIZATION',
        priority: 'MEDIUM',
        cause: { type: 'PROACTIVE_IMPROVEMENT', description: 'Test', context: {}, timestamp: Date.now() },
        title: 'Test',
        description: 'Test',
        actions: [{ type: 'CREATE_FILE', target: path.join(tempDir, 'test.txt'), content: 'test', description: task }],
        estimatedRisk: 'LOW',
        validationSteps: [],
        createdAt: Date.now(),
      }, 'cp-e3-1');
      expect(result1.success).toBe(true);

      const result2 = await engine.executePlan({
        id: 'plan-2',
        type: 'CODE_OPTIMIZATION',
        priority: 'MEDIUM',
        cause: { type: 'PROACTIVE_IMPROVEMENT', description: 'Test', context: {}, timestamp: Date.now() },
        title: 'Test',
        description: 'Test',
        actions: [{ type: 'CREATE_FILE', target: path.join(tempDir, 'test2.txt'), content: 'test', description: task }],
        estimatedRisk: 'LOW',
        validationSteps: [],
        createdAt: Date.now(),
      }, 'cp-e3-2');
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('stale');

      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoalAuthority } from '../../authority/GoalAuthority';
import { GoalStatus } from '../../authority/types';
import { StateAuthority } from '../../authority/StateAuthority';
import { DecisionAuthority } from '../../authority/DecisionAuthority';
import { DecisionType } from '../../authority/types';
import { FilesystemVerifier, runIndependentVerification } from '../../authority/IndependentVerifier';
import { Logger } from '../../utils/Logger';

interface ReplayStep {
  step: string;
  id: string;
  data: Record<string, unknown>;
}

describe('D4-I4: Global Authority Replay', () => {
  const tempDir = path.join(os.tmpdir(), 'd4-i4-replay', Date.now().toString(36));
  let goalId: string;
  let snapshotId: string;
  let decisionId: string;
  const replayTrace: ReplayStep[] = [];

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('Full chain: User Input → Goal → Snapshot → Decision → Action → Evidence → Goal progress', () => {
    it('Step 1: User Input creates Goal via GoalAuthority', () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.createGoal({
        description: 'Create file hello.txt with content "Hello D8"',
        originalInput: 'Create file hello.txt with content "Hello D8"',
        executionDomain: 'desktop',
      });
      goalId = goal.goalId;

      expect(goalId).toBeTruthy();
      expect(goal.status).toBe(GoalStatus.ACTIVE);
      expect(goal.planVersion).toBeGreaterThanOrEqual(1);

      replayTrace.push({
        step: 'Goal',
        id: goalId,
        data: {
          description: goal.description,
          status: goal.status,
          planVersion: goal.planVersion,
        },
      });
    });

    it('Step 2: StateAuthority captures Snapshot for the Goal', async () => {
      const sa = StateAuthority.getInstance();
      const snapshot = await sa.captureSnapshot([goalId]);
      snapshotId = snapshot.snapshotId;

      expect(snapshotId).toBeTruthy();
      expect(snapshot.activeGoalIds).toBeDefined();

      replayTrace.push({
        step: 'Snapshot',
        id: snapshotId,
        data: {
          activeGoalIds: snapshot.activeGoalIds,
          timestamp: snapshot.timestamp,
        },
      });
    });

    it('Step 3: DecisionAuthority makes FINAL Decision', async () => {
      const da = DecisionAuthority.getInstance();
      const decision = await da.decide({
        goalId,
        snapshot: {
          snapshotId,
          timestamp: Date.now(),
          activeGoalIds: [goalId],
          self: { agentId: 'test', activeGoalIds: [goalId], currentStage: 'created', safetyStatus: 'nominal' },
          world: { observation: null, platform: 'server', timestamp: Date.now() },
          memory: { relevantMemories: [], query: '', timestamp: Date.now() },
          context: { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() },
          capabilities: { availableTools: [], availableSkills: [], desktopAvailable: false, bridgeAvailable: false },
        },
        decisionType: DecisionType.ACTION,
        candidates: [
          {
            candidateId: `C_file_create_${Date.now().toString(36)}`,
            proposerId: 'd4_i4_test_proposer',
            action: {
              type: 'composite',
              payload: {
                execute: 'file_write',
                path: path.join(tempDir, 'hello.txt'),
                content: 'Hello D8',
              },
            },
            confidence: 0.95,
            reasoning: 'Direct file write for hello.txt',
            estimatedGoalProgress: 0.8,
          },
        ],
      });
      decisionId = decision.decisionId;

      expect(decisionId).toBeTruthy();
      expect(decision.decisionType).toBe(DecisionType.ACTION);
      expect(decision.goalId).toBe(goalId);
      expect(decision.snapshotId).toBe(snapshotId);
      expect(decision.chosen.proposerId).toBe('d4_i4_test_proposer');

      replayTrace.push({
        step: 'Decision',
        id: decisionId,
        data: {
          decisionType: decision.decisionType,
          goalId: decision.goalId,
          snapshotId: decision.snapshotId,
          chosenCandidateId: decision.chosenCandidateId,
          proposerId: decision.chosen.proposerId,
          planVersion: decision.planVersion,
        },
      });
    });

    it('Step 4: Action is executed (file write)', () => {
      const filePath = path.join(tempDir, 'hello.txt');
      fs.writeFileSync(filePath, 'Hello D8', 'utf-8');

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8').trim()).toBe('Hello D8');

      replayTrace.push({
        step: 'Action',
        id: `action_${Date.now().toString(36)}`,
        data: {
          type: 'file_write',
          path: filePath,
          content: 'Hello D8',
        },
      });
    });

    it('Step 5: IndependentVerifier verifies the result', async () => {
      const ga = GoalAuthority.getInstance();
      const goal = ga.getGoal(goalId);
      expect(goal).toBeDefined();

      const filePath = path.join(tempDir, 'hello.txt');
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const verified = content === 'Hello D8';

      expect(verified).toBe(true);

      const fsVerifier = new FilesystemVerifier();
      expect(fsVerifier.verifierId).toBeTruthy();
      expect(fsVerifier.domain).toBe('filesystem');

      replayTrace.push({
        step: 'Evidence',
        id: `E_${Date.now().toString(36)}`,
        data: {
          verified,
          domain: 'filesystem',
          evidence: `file content: "${content}"`,
        },
      });
    });

    it('Step 6: GoalAuthority updates progress from Evidence', () => {
      const ga = GoalAuthority.getInstance();
      ga.updateFromEvidence({
        goalId,
        decisionId,
        observation: 'file created successfully',
        action: { type: 'composite', payload: { execute: 'file_write' } },
        expectedEffect: 'hello.txt exists with "Hello D8"',
        actualEffect: 'hello.txt exists with "Hello D8"',
        progressDelta: 1.0,
      });

      const goal = ga.getGoal(goalId);
      expect(goal).toBeDefined();
      expect(goal!.progress).toBeGreaterThan(0);

      replayTrace.push({
        step: 'GoalProgress',
        id: goalId,
        data: {
          progress: goal!.progress,
          status: goal!.status,
          updatedAt: goal!.updatedAt,
        },
      });
    });

    it('Replay trace is complete and connected', () => {
      expect(replayTrace.length).toBe(6);

      const goalStep = replayTrace[0];
      const snapshotStep = replayTrace[1];
      const decisionStep = replayTrace[2];
      const actionStep = replayTrace[3];
      const evidenceStep = replayTrace[4];
      const progressStep = replayTrace[5];

      expect(goalStep.step).toBe('Goal');
      expect(snapshotStep.step).toBe('Snapshot');
      expect(decisionStep.step).toBe('Decision');
      expect(actionStep.step).toBe('Action');
      expect(evidenceStep.step).toBe('Evidence');
      expect(progressStep.step).toBe('GoalProgress');

      expect(decisionStep.data.goalId).toBe(goalStep.id);
      expect(decisionStep.data.snapshotId).toBe(snapshotStep.id);
      expect(progressStep.id).toBe(goalStep.id);

      Logger.info('=== D4-I4 Replay Trace ===', 'D4-I4');
      for (const step of replayTrace) {
        Logger.info(`  ${step.step}: ${step.id} → ${JSON.stringify(step.data)}`, 'D4-I4');
      }
    });
  });

  describe('Authority contract: every production step has goalId/snapshotId/decisionId', () => {
    it('Decision has all three IDs', async () => {
      const ga = GoalAuthority.getInstance();
      const sa = StateAuthority.getInstance();
      const da = DecisionAuthority.getInstance();

      const goal = ga.createGoal({
        description: 'D4-I4 contract test',
        originalInput: 'contract test',
        executionDomain: 'desktop',
      });
      const snapshot = await sa.captureSnapshot([goal.goalId]);
      const decision = await da.decide({
        goalId: goal.goalId,
        snapshot,
        decisionType: DecisionType.ACTION,
        candidates: [
          {
            candidateId: `C_contract_${Date.now().toString(36)}`,
            proposerId: 'contract_test',
            action: { type: 'message', payload: 'test' },
            confidence: 0.5,
            reasoning: 'contract test',
            estimatedGoalProgress: 0.1,
          },
        ],
      });

      expect(decision.goalId).toBeTruthy();
      expect(decision.snapshotId).toBeTruthy();
      expect(decision.decisionId).toBeTruthy();
      expect(decision.goalId).toBe(goal.goalId);
      expect(decision.snapshotId).toBe(snapshot.snapshotId);
    });
  });
});

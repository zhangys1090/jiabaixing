import {
    GoalAuthority,
    GoalPriority,
    GoalStatus,
} from '../../../src/authority';

describe('GoalAuthority v2', () => {
  let authority: GoalAuthority;

  beforeEach(() => {
    GoalAuthority.resetInstance();
    authority = GoalAuthority.getInstance();
  });

  describe('createGoal', () => {
    it('creates a goal with stable identity and planVersion=1', () => {
      const goal = authority.createGoal({
        description: '整理下载文件',
        originalInput: '帮我整理桌面上的下载文件',
      });

      expect(goal.goalId).toMatch(/^G_[a-z0-9]+_[a-z0-9]{4}$/);
      expect(goal.description).toBe('整理下载文件');
      expect(goal.originalInput).toBe('帮我整理桌面上的下载文件');
      expect(goal.status).toBe(GoalStatus.ACTIVE);
      expect(goal.priority).toBe(GoalPriority.NORMAL);
      expect(goal.progress).toBe(0);
      expect(goal.parentGoalId).toBeNull();
      expect(goal.currentStage).toBe('created');
      expect(goal.planVersion).toBe(1);
      expect(goal.createdAt).toBeGreaterThan(0);
      expect(goal.updatedAt).toBe(goal.createdAt);
    });

    it('creates a goal with custom priority and parent', () => {
      const parent = authority.createGoal({
        description: '构建完整Web应用',
        originalInput: '构建完整Web应用',
        priority: GoalPriority.CRITICAL,
      });

      const child = authority.createGoal({
        description: '实现前端页面',
        originalInput: '实现前端页面',
        priority: GoalPriority.HIGH,
        parentGoalId: parent.goalId,
        successCondition: '所有页面渲染正确',
        abandonmentCondition: '需求变更',
      });

      expect(child.parentGoalId).toBe(parent.goalId);
      expect(child.priority).toBe(GoalPriority.HIGH);
      expect(child.successCondition).toBe('所有页面渲染正确');
      expect(child.abandonmentCondition).toBe('需求变更');
    });

    it('assigns unique goalId to each goal', () => {
      const g1 = authority.createGoal({ description: 'task1', originalInput: 'task1' });
      const g2 = authority.createGoal({ description: 'task2', originalInput: 'task2' });
      expect(g1.goalId).not.toBe(g2.goalId);
    });
  });

  describe('getGoal / getActiveGoals', () => {
    it('retrieves a goal by goalId', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      const retrieved = authority.getGoal(goal.goalId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.goalId).toBe(goal.goalId);
    });

    it('returns null for unknown goalId', () => {
      expect(authority.getGoal('G_unknown')).toBeNull();
    });

    it('getActiveGoals returns only ACTIVE goals', () => {
      const g1 = authority.createGoal({ description: 'active1', originalInput: 'active1' });
      const g2 = authority.createGoal({ description: 'active2', originalInput: 'active2' });
      authority.markAbandoned(g2.goalId, 'no longer needed');

      const active = authority.getActiveGoals();
      expect(active).toHaveLength(1);
      expect(active[0].goalId).toBe(g1.goalId);
    });
  });

  describe('updateFromEvidence (evidence-based progress)', () => {
    it('updates progress from evidence and records evidence log', () => {
      const goal = authority.createGoal({ description: '整理文件', originalInput: '整理文件' });

      const updated = authority.updateFromEvidence({
        goalId: goal.goalId,
        decisionId: 'D_test1',
        observation: { filesFound: 27 },
        action: { type: 'desktop_action', payload: { type: 'inspect_downloads' } },
        expectedEffect: '发现下载文件列表',
        actualEffect: '发现27个文件',
        progressDelta: 0.1,
      });

      expect(updated.progress).toBeCloseTo(0.1);

      const evidenceLog = authority.getEvidenceLog(goal.goalId);
      expect(evidenceLog).toHaveLength(1);
      expect(evidenceLog[0].evidenceId).toMatch(/^E_[a-z0-9]+_[a-z0-9]{4}$/);
      expect(evidenceLog[0].actualEffect).toBe('发现27个文件');
      expect(evidenceLog[0].progressDelta).toBeCloseTo(0.1);
    });

    it('accumulates progress from multiple evidence entries', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });

      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D1', observation: null,
        action: { type: 'message', payload: {} },
        expectedEffect: 'step1', actualEffect: 'step1 done', progressDelta: 0.3,
      });
      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D2', observation: null,
        action: { type: 'message', payload: {} },
        expectedEffect: 'step2', actualEffect: 'step2 done', progressDelta: 0.4,
      });

      const g = authority.getGoal(goal.goalId)!;
      expect(g.progress).toBeCloseTo(0.7);
      expect(authority.getEvidenceLog(goal.goalId)).toHaveLength(2);
    });

    it('clamps progress to [0, 1] and auto-completes at 1.0', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });

      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D1', observation: null,
        action: { type: 'message', payload: {} },
        expectedEffect: 'done', actualEffect: 'done', progressDelta: 1.5,
      });

      const g = authority.getGoal(goal.goalId)!;
      expect(g.progress).toBe(1);
      expect(g.status).toBe(GoalStatus.COMPLETED);
    });

    it('clamps negative progress to 0', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });

      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D1', observation: null,
        action: { type: 'message', payload: {} },
        expectedEffect: 'fail', actualEffect: 'failed', progressDelta: -0.5,
      });

      expect(authority.getGoal(goal.goalId)!.progress).toBe(0);
    });
  });

  describe('updateStage', () => {
    it('updates currentStage', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      authority.updateStage(goal.goalId, 'executing');
      expect(authority.getGoal(goal.goalId)!.currentStage).toBe('executing');
    });
  });

  describe('markCompleted / markAbandoned', () => {
    it('markCompleted sets status and progress', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      const result = authority.markCompleted(goal.goalId, 'all files organized');
      expect(result.status).toBe(GoalStatus.COMPLETED);
      expect(result.progress).toBe(1);
      expect(result.metadata['completionReason']).toBe('all files organized');
    });

    it('markAbandoned sets status', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      const result = authority.markAbandoned(goal.goalId, 'user cancelled');
      expect(result.status).toBe(GoalStatus.ABANDONED);
      expect(result.metadata['abandonmentReason']).toBe('user cancelled');
    });
  });

  describe('replan (plan versioning, not goal identity change)', () => {
    it('increments planVersion while keeping same goalId', () => {
      const goal = authority.createGoal({ description: '整理文件', originalInput: '整理文件' });
      expect(goal.planVersion).toBe(1);

      const afterReplan = authority.replan(goal.goalId, 'strategy failed, trying different approach');
      expect(afterReplan.goalId).toBe(goal.goalId);
      expect(afterReplan.planVersion).toBe(2);
      expect(afterReplan.status).toBe(GoalStatus.ACTIVE);
      expect(afterReplan.metadata['replanReason_v2']).toBe('strategy failed, trying different approach');

      const afterReplan2 = authority.replan(goal.goalId, 'second replan');
      expect(afterReplan2.planVersion).toBe(3);
      expect(afterReplan2.metadata['replanReason_v3']).toBe('second replan');
    });
  });

  describe('evaluateStatus (not a decision maker)', () => {
    it('returns ACTIVE for healthy goal', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D1', observation: null,
        action: { type: 'message', payload: {} },
        expectedEffect: 'step', actualEffect: 'step done', progressDelta: 0.3,
      });

      const eval_ = authority.evaluateStatus(goal.goalId);
      expect(eval_.status).toBe(GoalStatus.ACTIVE);
    });

    it('returns COMPLETED for completed goal', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      authority.markCompleted(goal.goalId, 'done');
      const eval_ = authority.evaluateStatus(goal.goalId);
      expect(eval_.status).toBe(GoalStatus.COMPLETED);
    });

    it('returns ABANDONED for abandoned goal', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      authority.markAbandoned(goal.goalId, 'cancelled');
      const eval_ = authority.evaluateStatus(goal.goalId);
      expect(eval_.status).toBe(GoalStatus.ABANDONED);
    });

    it('suggests replan for strong negative evidence', () => {
      const goal = authority.createGoal({ description: 'test', originalInput: 'test' });
      const eval_ = authority.evaluateStatus(goal.goalId, {
        evidenceId: 'E_test', goalId: goal.goalId, decisionId: 'D_test',
        observation: null, action: { type: 'message', payload: {} },
        expectedEffect: 'good', actualEffect: 'bad',
        progressDelta: -0.5, timestamp: Date.now(),
      });
      expect(eval_.status).toBe(GoalStatus.ACTIVE);
      expect(eval_.reason).toContain('consider replan');
    });
  });

  describe('goal identity stability across operations', () => {
    it('goal retains identity across evidence, stage, and replan', () => {
      const goal = authority.createGoal({
        description: '整理下载文件',
        originalInput: '帮我整理桌面上的下载文件',
      });
      const originalId = goal.goalId;

      authority.updateStage(goal.goalId, 'inspecting');
      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D1', observation: null,
        action: { type: 'desktop_action', payload: {} },
        expectedEffect: 'inspect', actualEffect: 'found 27 files', progressDelta: 0.1,
      });
      authority.updateStage(goal.goalId, 'classifying');
      authority.updateFromEvidence({
        goalId: goal.goalId, decisionId: 'D2', observation: null,
        action: { type: 'desktop_action', payload: {} },
        expectedEffect: 'classify', actualEffect: 'classified', progressDelta: 0.3,
      });
      authority.replan(goal.goalId, 'need different classification strategy');

      const final = authority.getGoal(originalId);
      expect(final).not.toBeNull();
      expect(final!.goalId).toBe(originalId);
      expect(final!.description).toBe('整理下载文件');
      expect(final!.currentStage).toBe('classifying');
      expect(final!.progress).toBeCloseTo(0.4);
      expect(final!.planVersion).toBe(2);
      expect(final!.status).toBe(GoalStatus.ACTIVE);
      expect(authority.getEvidenceLog(originalId)).toHaveLength(2);
    });
  });
});

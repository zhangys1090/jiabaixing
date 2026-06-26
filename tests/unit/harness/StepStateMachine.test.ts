import {
  StepState,
  STEP_STATE_TRANSITIONS,
  StepStateTransition,
} from '../../../src/harness/types';

describe('E3-3: StepState 步骤级状态机', () => {
  describe('StepState 枚举', () => {
    it('应包含9个状态', () => {
      const states = Object.values(StepState);
      expect(states).toHaveLength(9);
    });

    it('应包含所有必要状态', () => {
      expect(StepState.PENDING).toBe('pending');
      expect(StepState.READY).toBe('ready');
      expect(StepState.RUNNING).toBe('running');
      expect(StepState.WAITING_APPROVAL).toBe('waiting_approval');
      expect(StepState.COMPLETED).toBe('completed');
      expect(StepState.FAILED).toBe('failed');
      expect(StepState.SKIPPED).toBe('skipped');
      expect(StepState.RETRYING).toBe('retrying');
      expect(StepState.BLOCKED).toBe('blocked');
    });
  });

  describe('STEP_STATE_TRANSITIONS 合法转换', () => {
    it('PENDING 可转换为 READY/BLOCKED/SKIPPED', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.PENDING]).toEqual(
        expect.arrayContaining([
          StepState.READY,
          StepState.BLOCKED,
          StepState.SKIPPED,
        ])
      );
    });

    it('READY 可转换为 RUNNING/WAITING_APPROVAL/SKIPPED', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.READY]).toEqual(
        expect.arrayContaining([
          StepState.RUNNING,
          StepState.WAITING_APPROVAL,
          StepState.SKIPPED,
        ])
      );
    });

    it('RUNNING 可转换为 COMPLETED/FAILED/RETRYING/WAITING_APPROVAL', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.RUNNING]).toEqual(
        expect.arrayContaining([
          StepState.COMPLETED,
          StepState.FAILED,
          StepState.RETRYING,
          StepState.WAITING_APPROVAL,
        ])
      );
    });

    it('COMPLETED 和 SKIPPED 可转回 PENDING（支持循环执行）', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.COMPLETED]).toEqual([
        StepState.PENDING,
      ]);
      expect(STEP_STATE_TRANSITIONS[StepState.SKIPPED]).toEqual([
        StepState.PENDING,
      ]);
    });

    it('FAILED 可转换为 RETRYING/SKIPPED', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.FAILED]).toEqual(
        expect.arrayContaining([StepState.RETRYING, StepState.SKIPPED])
      );
    });

    it('BLOCKED 可转换为 READY/SKIPPED', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.BLOCKED]).toEqual(
        expect.arrayContaining([StepState.READY, StepState.SKIPPED])
      );
    });

    it('不允许非法转换：COMPLETED → RUNNING', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.COMPLETED]).not.toContain(
        StepState.RUNNING
      );
    });

    it('不允许非法转换：SKIPPED → RUNNING', () => {
      expect(STEP_STATE_TRANSITIONS[StepState.SKIPPED]).not.toContain(
        StepState.RUNNING
      );
    });
  });

  describe('StepStateTransition 接口', () => {
    it('应包含必要字段', () => {
      const transition: StepStateTransition = {
        stepId: 'step1',
        fromState: StepState.PENDING,
        toState: StepState.READY,
        reason: '依赖满足',
        timestamp: Date.now(),
      };
      expect(transition.stepId).toBe('step1');
      expect(transition.fromState).toBe(StepState.PENDING);
      expect(transition.toState).toBe(StepState.READY);
      expect(transition.reason).toBe('依赖满足');
      expect(transition.timestamp).toBeGreaterThan(0);
    });
  });

  describe('状态转换路径验证', () => {
    it('正常执行路径: PENDING → READY → RUNNING → COMPLETED', () => {
      const path = [
        StepState.PENDING,
        StepState.READY,
        StepState.RUNNING,
        StepState.COMPLETED,
      ];
      for (let i = 0; i < path.length - 1; i++) {
        const allowed = STEP_STATE_TRANSITIONS[path[i]];
        expect(allowed).toContain(path[i + 1]);
      }
    });

    it('重试路径: RUNNING → FAILED → RETRYING → COMPLETED', () => {
      const path = [
        StepState.RUNNING,
        StepState.FAILED,
        StepState.RETRYING,
        StepState.COMPLETED,
      ];
      for (let i = 0; i < path.length - 1; i++) {
        const allowed = STEP_STATE_TRANSITIONS[path[i]];
        expect(allowed).toContain(path[i + 1]);
      }
    });

    it('阻塞路径: PENDING → BLOCKED → READY → RUNNING', () => {
      const path = [
        StepState.PENDING,
        StepState.BLOCKED,
        StepState.READY,
        StepState.RUNNING,
      ];
      for (let i = 0; i < path.length - 1; i++) {
        const allowed = STEP_STATE_TRANSITIONS[path[i]];
        expect(allowed).toContain(path[i + 1]);
      }
    });

    it('跳过路径: PENDING → SKIPPED → 可转回 PENDING', () => {
      const allowed = STEP_STATE_TRANSITIONS[StepState.PENDING];
      expect(allowed).toContain(StepState.SKIPPED);
      expect(STEP_STATE_TRANSITIONS[StepState.SKIPPED]).toEqual([
        StepState.PENDING,
      ]);
    });
  });
});

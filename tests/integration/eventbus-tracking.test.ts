import { EventBus } from '../../src/shared/EventBus';

describe('EventBus追踪功能测试', () => {
  afterAll(() => {
    EventBus.clearTraceHistory?.();
  });

  describe('基础追踪功能', () => {
    it('应该能够开始和完成追踪', () => {
      const traceId = 'test_trace_1';

      EventBus.startTrace?.(traceId, 'test_operation', { test: 'data' });
      EventBus.completeTrace?.(traceId, true);

      const history = EventBus.getTraceHistory?.() || [];
      expect(history.length).toBeGreaterThan(0);

      const completedTrace = history.find((t: any) => t.traceId === traceId);
      expect(completedTrace).toBeDefined();
      if (completedTrace) {
        expect(completedTrace.success).toBe(true);
      }
    });

    it('应该能够记录失败的追踪', () => {
      const traceId = 'test_trace_2';

      EventBus.startTrace?.(traceId, 'test_operation_failed');
      EventBus.failTrace?.(traceId, '测试错误');

      const history = EventBus.getTraceHistory?.() || [];
      const failedTrace = history.find((t: any) => t.traceId === traceId);
      expect(failedTrace).toBeDefined();
      if (failedTrace) {
        expect(failedTrace.success).toBe(false);
      }
    });

    it('应该能够获取追踪统计信息', () => {
      EventBus.startTrace?.('stat_test_1', 'operation1');
      EventBus.completeTrace?.('stat_test_1', true);

      EventBus.startTrace?.('stat_test_2', 'operation2');
      EventBus.completeTrace?.('stat_test_2', true);

      EventBus.startTrace?.('stat_test_3', 'operation1');
      EventBus.failTrace?.('stat_test_3', 'error');

      const stats = EventBus.getTraceStatistics?.();
      expect(stats).toBeDefined();
      expect(stats.totalTraces).toBeGreaterThan(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
    });

    it('应该能够清理追踪历史', () => {
      EventBus.startTrace?.('cleanup_test', 'operation');
      EventBus.completeTrace?.('cleanup_test', true);

      let history = EventBus.getTraceHistory?.() || [];
      expect(history.length).toBeGreaterThan(0);

      EventBus.clearTraceHistory?.();

      history = EventBus.getTraceHistory?.() || [];
      expect(history.length).toBe(0);
    });
  });

  describe('事件追踪集成', () => {
    it('应该能够追踪事件发射', (done) => {
      const traceId = 'event_test_1';

      EventBus.on?.('event_traced', (data: any) => {
        if (data.traceId === traceId) {
          expect(data.eventName).toBe('test_event');
          expect(data.success).toBe(true);
          done();
        }
      });

      EventBus.startTrace?.(traceId, 'test_event');
      EventBus.completeTrace?.(traceId, true);
    });

    it('应该能够追踪追踪开始事件', (done) => {
      const traceId = 'start_test_1';

      EventBus.on?.('trace_started', (data: any) => {
        if (data.traceId === traceId) {
          expect(data.eventName).toBe('start_event');
          done();
        }
      });

      EventBus.startTrace?.(traceId, 'start_event');
    });

    it('应该能够追踪追踪完成事件', (done) => {
      const traceId = 'complete_test_1';

      EventBus.on?.('trace_completed', (data: any) => {
        if (data.traceId === traceId) {
          expect(data.success).toBe(true);
          done();
        }
      });

      EventBus.startTrace?.(traceId, 'complete_event');
      EventBus.completeTrace?.(traceId, true);
    });
  });
});

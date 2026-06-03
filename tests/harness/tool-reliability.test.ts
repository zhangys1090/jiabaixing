/**
 * ToolReliabilityTracker 单元测试
 */

import { ToolReliabilityTracker } from '../../src/harness/tools/registry/ToolRegistry';

describe('ToolReliabilityTracker', () => {
  let tracker: ToolReliabilityTracker;

  beforeEach(() => {
    tracker = new ToolReliabilityTracker();
  });

  describe('recordCall', () => {
    it('应该记录成功的工具调用', () => {
      tracker.recordCall('tool_a', true, 100);
      const stats = tracker.getStats('tool_a');
      expect(stats).not.toBeNull();
      expect(stats!.calls).toBe(1);
      expect(stats!.successes).toBe(1);
    });

    it('应该记录失败的工具调用', () => {
      tracker.recordCall('tool_a', false, 200, 'timeout error');
      const stats = tracker.getStats('tool_a');
      expect(stats).not.toBeNull();
      expect(stats!.calls).toBe(1);
      expect(stats!.successes).toBe(0);
      expect(stats!.lastError).toBe('timeout error');
    });

    it('应该累积记录同一工具的多次调用', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 200, 'error');
      tracker.recordCall('tool_a', true, 150);
      const stats = tracker.getStats('tool_a');
      expect(stats!.calls).toBe(3);
      expect(stats!.successes).toBe(2);
      expect(stats!.lastError).toBe('error');
    });

    it('应该分别记录不同工具的调用', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_b', false, 300, 'fail');
      const statsA = tracker.getStats('tool_a');
      const statsB = tracker.getStats('tool_b');
      expect(statsA!.calls).toBe(1);
      expect(statsA!.successes).toBe(1);
      expect(statsB!.calls).toBe(1);
      expect(statsB!.successes).toBe(0);
    });

    it('应该更新最后一次错误信息', () => {
      tracker.recordCall('tool_a', false, 100, 'first error');
      tracker.recordCall('tool_a', false, 100, 'second error');
      const stats = tracker.getStats('tool_a');
      expect(stats!.lastError).toBe('second error');
    });

    it('应该保留成功调用前的错误信息', () => {
      tracker.recordCall('tool_a', false, 100, 'old error');
      tracker.recordCall('tool_a', true, 100);
      const stats = tracker.getStats('tool_a');
      expect(stats!.lastError).toBe('old error');
    });
  });

  describe('getSuccessRate', () => {
    it('应该在没有调用时返回1.0（新工具默认满分）', () => {
      expect(tracker.getSuccessRate('unknown_tool')).toBe(1);
    });

    it('应该在全成功时返回1.0', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', true, 100);
      expect(tracker.getSuccessRate('tool_a')).toBe(1);
    });

    it('应该在全失败时返回0', () => {
      tracker.recordCall('tool_a', false, 100, 'err');
      tracker.recordCall('tool_a', false, 100, 'err');
      expect(tracker.getSuccessRate('tool_a')).toBe(0);
    });

    it('应该在半成功时返回0.5', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 100, 'err');
      expect(tracker.getSuccessRate('tool_a')).toBe(0.5);
    });

    it('应该返回正确的部分成功率', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 100, 'err');
      expect(tracker.getSuccessRate('tool_a')).toBe(0.75);
    });
  });

  describe('getAverageDuration', () => {
    it('应该在没有调用时返回0', () => {
      expect(tracker.getAverageDuration('unknown_tool')).toBe(0);
    });

    it('应该返回单次调用的时长', () => {
      tracker.recordCall('tool_a', true, 200);
      expect(tracker.getAverageDuration('tool_a')).toBe(200);
    });

    it('应该返回多次调用的平均时长', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', true, 200);
      tracker.recordCall('tool_a', true, 300);
      expect(tracker.getAverageDuration('tool_a')).toBe(200);
    });

    it('应该正确计算包含成功和失败的平均时长', () => {
      tracker.recordCall('tool_a', true, 50);
      tracker.recordCall('tool_a', false, 150, 'err');
      expect(tracker.getAverageDuration('tool_a')).toBe(100);
    });
  });

  describe('getUnreliableTools', () => {
    it('应该在没有工具时返回空数组', () => {
      expect(tracker.getUnreliableTools()).toEqual([]);
    });

    it('应该返回成功率低于阈值的工具', () => {
      tracker.recordCall('reliable_tool', true, 100);
      tracker.recordCall('reliable_tool', true, 100);
      tracker.recordCall('unreliable_tool', false, 100, 'err');
      tracker.recordCall('unreliable_tool', false, 100, 'err');
      const unreliable = tracker.getUnreliableTools(0.9);
      expect(unreliable).toContain('unreliable_tool');
      expect(unreliable).not.toContain('reliable_tool');
    });

    it('应该使用默认阈值0.9', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 100, 'err');
      const unreliable = tracker.getUnreliableTools();
      expect(unreliable).toContain('tool_a');
    });

    it('应该支持自定义阈值', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 100, 'err');
      expect(tracker.getUnreliableTools(0.4)).not.toContain('tool_a');
      expect(tracker.getUnreliableTools(0.6)).toContain('tool_a');
    });

    it('应该返回所有低于阈值的工具', () => {
      tracker.recordCall('tool_a', false, 100, 'err');
      tracker.recordCall('tool_b', false, 100, 'err');
      tracker.recordCall('tool_c', true, 100);
      const unreliable = tracker.getUnreliableTools(0.5);
      expect(unreliable).toContain('tool_a');
      expect(unreliable).toContain('tool_b');
      expect(unreliable).not.toContain('tool_c');
    });
  });

  describe('getStats', () => {
    it('应该对未知工具返回null', () => {
      expect(tracker.getStats('unknown')).toBeNull();
    });

    it('应该返回已知工具的完整统计信息', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 200, 'some error');
      const stats = tracker.getStats('tool_a');
      expect(stats).toEqual({
        calls: 2,
        successes: 1,
        successRate: 0.5,
        avgDuration: 150,
        lastError: 'some error',
      });
    });

    it('应该在没有错误时lastError为undefined', () => {
      tracker.recordCall('tool_a', true, 100);
      const stats = tracker.getStats('tool_a');
      expect(stats!.lastError).toBeUndefined();
    });
  });

  describe('getAllStats', () => {
    it('应该在没有工具时返回空Map', () => {
      const allStats = tracker.getAllStats();
      expect(allStats.size).toBe(0);
    });

    it('应该返回所有已追踪工具的统计信息', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_b', false, 200, 'err');
      const allStats = tracker.getAllStats();
      expect(allStats.size).toBe(2);
      expect(allStats.get('tool_a')!.calls).toBe(1);
      expect(allStats.get('tool_b')!.calls).toBe(1);
    });

    it('应该返回包含计算字段的统计信息', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_a', false, 200, 'err');
      const allStats = tracker.getAllStats();
      const statsA = allStats.get('tool_a');
      expect(statsA!.successRate).toBe(0.5);
      expect(statsA!.avgDuration).toBe(150);
    });
  });

  describe('reset', () => {
    it('应该清除所有统计信息', () => {
      tracker.recordCall('tool_a', true, 100);
      tracker.recordCall('tool_b', false, 200, 'err');
      tracker.reset();
      expect(tracker.getStats('tool_a')).toBeNull();
      expect(tracker.getStats('tool_b')).toBeNull();
      expect(tracker.getAllStats().size).toBe(0);
    });

    it('应该允许重置后重新记录', () => {
      tracker.recordCall('tool_a', false, 100, 'old error');
      tracker.reset();
      tracker.recordCall('tool_a', true, 50);
      const stats = tracker.getStats('tool_a');
      expect(stats!.calls).toBe(1);
      expect(stats!.successes).toBe(1);
      expect(stats!.lastError).toBeUndefined();
    });
  });

  describe('边界情况', () => {
    it('应该处理单次调用', () => {
      tracker.recordCall('tool_a', true, 42);
      expect(tracker.getSuccessRate('tool_a')).toBe(1);
      expect(tracker.getAverageDuration('tool_a')).toBe(42);
      const stats = tracker.getStats('tool_a');
      expect(stats!.calls).toBe(1);
      expect(stats!.successes).toBe(1);
    });

    it('应该处理大量调用', () => {
      for (let i = 0; i < 1000; i++) {
        tracker.recordCall('tool_a', i % 3 !== 0, i + 1);
      }
      const stats = tracker.getStats('tool_a');
      expect(stats!.calls).toBe(1000);
      expect(stats!.successes).toBe(Math.floor(1000 * 2 / 3));
      expect(stats!.successRate).toBeCloseTo(2 / 3, 2);
    });

    it('应该处理持续时间为0的调用', () => {
      tracker.recordCall('tool_a', true, 0);
      expect(tracker.getAverageDuration('tool_a')).toBe(0);
    });

    it('应该处理无错误参数的失败调用', () => {
      tracker.recordCall('tool_a', false, 100);
      const stats = tracker.getStats('tool_a');
      expect(stats!.successes).toBe(0);
      expect(stats!.lastError).toBeUndefined();
    });
  });
});

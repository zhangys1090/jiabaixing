/**
 * 学习闭环 — 学习信号管道+策略自适应 测试
 *
 * 验证核心目标：
 *   - 工具执行成功 → 收集正面学习信号
 *   - 工具执行失败 → 收集负面学习信号
 *   - 任务完成 → 收集任务级学习信号
 *   - 基于学习信号调整工具优先级
 *   - 基于学习信号调整反思深度
 *   - 基于成功信号减少不必要的反思
 */

import { collectLearningSignal } from '../../../src/evolution/LearningSignalCollector';
import { StrategyAdjuster } from '../../../src/evolution/StrategyAdjuster';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('学习闭环 — 学习信号管道+策略自适应', () => {
  describe('学习信号收集', () => {
    it('应在工具执行成功时收集正面学习信号', () => {
      const mockEventBus = {
        emit: jest.fn(),
        on: jest.fn(),
      };

      collectLearningSignal(mockEventBus, {
        type: 'tool_success',
        toolName: 'file_read',
        duration: 100,
        quality: 0.9,
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'learning_signal',
        expect.objectContaining({
          signalType: 'positive',
          toolName: 'file_read',
        })
      );
    });

    it('应在工具执行失败时收集负面学习信号', () => {
      const mockEventBus = {
        emit: jest.fn(),
        on: jest.fn(),
      };

      collectLearningSignal(mockEventBus, {
        type: 'tool_failure',
        toolName: 'file_read',
        error: 'not found',
        duration: 50,
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'learning_signal',
        expect.objectContaining({
          signalType: 'negative',
          toolName: 'file_read',
          error: 'not found',
        })
      );
    });

    it('应在任务完成时收集任务级学习信号', () => {
      const mockEventBus = {
        emit: jest.fn(),
        on: jest.fn(),
      };

      collectLearningSignal(mockEventBus, {
        type: 'task_complete',
        userInput: '部署应用',
        quality: 0.85,
        duration: 10000,
        toolCount: 3,
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'learning_signal',
        expect.objectContaining({
          signalType: 'task_success',
          quality: 0.85,
        })
      );
    });
  });

  describe('策略自适应', () => {
    it('应基于学习信号调整工具优先级', () => {
      const adjuster = new StrategyAdjuster();

      adjuster.recordSignal({
        signalType: 'negative',
        toolName: 'file_read',
        error: 'not found',
        timestamp: Date.now(),
      });
      adjuster.recordSignal({
        signalType: 'negative',
        toolName: 'file_read',
        error: 'permission denied',
        timestamp: Date.now(),
      });
      adjuster.recordSignal({
        signalType: 'positive',
        toolName: 'file_search',
        quality: 0.9,
        timestamp: Date.now(),
      });

      const adjusted = adjuster.getAdjustedToolPriority([
        'file_read',
        'file_search',
      ]);

      expect(adjusted.indexOf('file_search')).toBeLessThan(
        adjusted.indexOf('file_read')
      );
    });

    it('应基于学习信号调整反思深度', () => {
      const adjuster = new StrategyAdjuster();

      for (let i = 0; i < 5; i++) {
        adjuster.recordSignal({
          signalType: 'negative',
          toolName: 'web_search',
          error: 'timeout',
          timestamp: Date.now(),
        });
      }

      const config = adjuster.getAdjustedReflectionConfig();
      expect(config.enableDeepReflection).toBe(true);
      expect(config.maxRetries).toBeGreaterThan(2);
    });

    it('应基于成功信号减少不必要的反思', () => {
      const adjuster = new StrategyAdjuster();

      for (let i = 0; i < 10; i++) {
        adjuster.recordSignal({
          signalType: 'positive',
          toolName: 'file_read',
          quality: 0.95,
          timestamp: Date.now(),
        });
      }

      const config = adjuster.getAdjustedReflectionConfig();
      expect(config.enableDeepReflection).toBe(false);
    });
  });
});

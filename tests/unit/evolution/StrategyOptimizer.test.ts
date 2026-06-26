import { StrategyOptimizer } from '../../../src/evolution/StrategyOptimizer';

describe('E4-1: StrategyOptimizer', () => {
  let optimizer: StrategyOptimizer;

  beforeEach(() => {
    optimizer = new StrategyOptimizer();
  });

  describe('collectFeedback', () => {
    it('应收集反馈数据', () => {
      optimizer.collectFeedback({
        input: '搜索文件',
        response: '找到3个文件',
        success: true,
        qualityScore: 0.8,
        toolsUsed: ['file_search'],
        scene: 'coding',
      });

      const stats = optimizer.getOptimizationStats();
      expect(stats.recentSuccessRate).toBe(1);
    });

    it('应收集多条反馈并计算成功率', () => {
      optimizer.collectFeedback({
        input: '搜索文件',
        response: '找到3个文件',
        success: true,
        qualityScore: 0.8,
        toolsUsed: ['file_search'],
        scene: 'coding',
      });
      optimizer.collectFeedback({
        input: '执行命令',
        response: '执行失败',
        success: false,
        qualityScore: 0.3,
        toolsUsed: ['shell_exec'],
        scene: 'coding',
      });

      const stats = optimizer.getOptimizationStats();
      expect(stats.recentSuccessRate).toBe(0.5);
    });
  });

  describe('optimize', () => {
    it('样本不足时应返回 null', () => {
      // MIN_FEEDBACK_SAMPLES = 5，只提供1条
      optimizer.collectFeedback({
        input: '测试',
        response: '结果',
        success: true,
        qualityScore: 0.8,
        toolsUsed: ['file_search'],
      });

      const result = optimizer.optimize();
      expect(result).toBeNull();
    });

    it('足够样本时应返回优化日志', () => {
      // MIN_FEEDBACK_SAMPLES = 5，提供10条
      for (let i = 0; i < 10; i++) {
        optimizer.collectFeedback({
          input: `搜索文件 ${i}`,
          response: `找到 ${i} 个文件`,
          success: i % 3 !== 0,
          qualityScore: i % 3 !== 0 ? 0.8 : 0.3,
          toolsUsed: ['file_search', 'code_analyze'],
          scene: 'coding',
        });
      }

      const result = optimizer.optimize();
      expect(result).not.toBeNull();
      expect(result!.id).toMatch(/^opt_/);
      expect(result!.timestamp).toBeInstanceOf(Date);
    });

    it('优化日志应包含必要字段', () => {
      for (let i = 0; i < 10; i++) {
        optimizer.collectFeedback({
          input: `搜索文件 ${i}`,
          response: `找到 ${i} 个文件`,
          success: i % 3 !== 0,
          qualityScore: i % 3 !== 0 ? 0.8 : 0.3,
          toolsUsed: ['file_search', 'code_analyze'],
          scene: 'coding',
        });
      }

      const result = optimizer.optimize();
      expect(result).not.toBeNull();
      expect(result!).toHaveProperty('id');
      expect(result!).toHaveProperty('timestamp');
      expect(result!).toHaveProperty('reason');
      expect(result!).toHaveProperty('toneAdjustments');
      expect(result!).toHaveProperty('skillAdjustments');
      expect(result!).toHaveProperty('promptExamples');
      expect(result!).toHaveProperty('success');
      expect(result!).toHaveProperty('description');
    });
  });

  describe('getSkillWeights', () => {
    it('应返回默认权重', () => {
      const weights = optimizer.getSkillWeights();
      expect(weights.file_search).toBe(1.0);
      expect(weights.shell_exec).toBe(0.8);
      expect(weights.code_analyze).toBe(1.0);
      expect(weights.memory_recall).toBe(1.0);
    });

    it('优化后权重可能调整', () => {
      // 提供足够的高成功率反馈
      for (let i = 0; i < 10; i++) {
        optimizer.collectFeedback({
          input: `搜索文件 ${i}`,
          response: `找到 ${i} 个文件`,
          success: true,
          qualityScore: 0.9,
          toolsUsed: ['file_search'],
          scene: 'coding',
        });
      }

      optimizer.optimize();
      const weights = optimizer.getSkillWeights();
      // file_search 成功率高，权重应提升
      expect(weights.file_search).toBeGreaterThanOrEqual(1.0);
    });
  });

  describe('getToneAdjustment', () => {
    it('应返回预设场景的语气调整', () => {
      const coding = optimizer.getToneAdjustment('coding');
      expect(coding).toBeDefined();
      expect(coding!.targetScene).toBe('coding');
      expect(coding!.temperatureDelta).toBe(-0.1);
    });

    it('应返回 daily 场景的语气调整', () => {
      const daily = optimizer.getToneAdjustment('daily');
      expect(daily).toBeDefined();
      expect(daily!.targetScene).toBe('daily');
      expect(daily!.temperatureDelta).toBe(0.1);
    });

    it('应返回 research 场景的语气调整', () => {
      const research = optimizer.getToneAdjustment('research');
      expect(research).toBeDefined();
      expect(research!.targetScene).toBe('research');
      expect(research!.temperatureDelta).toBe(-0.2);
    });

    it('不存在的场景应返回 undefined', () => {
      const unknown = optimizer.getToneAdjustment('unknown_scene');
      expect(unknown).toBeUndefined();
    });
  });

  describe('getPromptExamples', () => {
    it('初始时应返回空数组', () => {
      const examples = optimizer.getPromptExamples();
      expect(examples).toEqual([]);
    });

    it('需要失败→成功的纠错对才能生成样例', () => {
      // 先添加失败案例
      optimizer.collectFeedback({
        input: '搜索文件中的错误',
        response: '搜索失败',
        success: false,
        qualityScore: 0.2,
        toolsUsed: ['shell_exec'],
        scene: 'coding',
      });

      // 添加成功案例（输入相似）
      optimizer.collectFeedback({
        input: '搜索文件中的错误',
        response: '成功找到3个错误',
        success: true,
        qualityScore: 0.9,
        toolsUsed: ['file_search'],
        scene: 'coding',
      });

      // 需要足够样本才能触发优化
      for (let i = 2; i < 10; i++) {
        optimizer.collectFeedback({
          input: `其他任务 ${i}`,
          response: `结果 ${i}`,
          success: true,
          qualityScore: 0.8,
          toolsUsed: ['file_search'],
          scene: 'coding',
        });
      }

      optimizer.optimize();

      // getPromptExamples 过滤 frequency >= 2，首次生成 frequency=1 不会返回
      const examples = optimizer.getPromptExamples();
      // 首次提取样例 frequency=1，getPromptExamples 过滤 frequency >= 2
      expect(examples.length).toBe(0);
    });
  });

  describe('getOptimizationStats', () => {
    it('应返回正确的初始统计信息', () => {
      const stats = optimizer.getOptimizationStats();
      expect(stats.totalOptimizations).toBe(0);
      expect(stats.promptExampleCount).toBe(0);
      expect(stats.recentSuccessRate).toBe(0);
    });

    it('优化后统计信息应更新', () => {
      for (let i = 0; i < 10; i++) {
        optimizer.collectFeedback({
          input: `搜索文件 ${i}`,
          response: `找到 ${i} 个文件`,
          success: i % 3 !== 0,
          qualityScore: i % 3 !== 0 ? 0.8 : 0.3,
          toolsUsed: ['file_search', 'code_analyze'],
          scene: 'coding',
        });
      }

      optimizer.optimize();

      const stats = optimizer.getOptimizationStats();
      expect(stats.totalOptimizations).toBe(1);
      expect(stats.recentSuccessRate).toBeGreaterThan(0);
    });
  });

  describe('getOptimizationLogs', () => {
    it('初始时应返回空数组', () => {
      const logs = optimizer.getOptimizationLogs();
      expect(logs).toEqual([]);
    });

    it('优化后应返回日志', () => {
      for (let i = 0; i < 10; i++) {
        optimizer.collectFeedback({
          input: `搜索文件 ${i}`,
          response: `找到 ${i} 个文件`,
          success: true,
          qualityScore: 0.8,
          toolsUsed: ['file_search'],
          scene: 'coding',
        });
      }

      optimizer.optimize();

      const logs = optimizer.getOptimizationLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].id).toMatch(/^opt_/);
    });
  });
});

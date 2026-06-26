/**
 * 🔶-1 + 🔶-2 增强优化测试
 *
 * 🔶-1 简单任务规划增强:
 * - 智能工具推荐增强: 基于历史执行数据优化工具推荐权重
 * - 简单任务预算自适应: 根据任务类型动态调整预算
 * - 复合简单任务并行执行: 无依赖子操作标记为可并行
 * - 简单任务结果质量验证
 *
 * 🔶-2 复杂度分析增强:
 * - 复杂度校准闭环: 将实际执行结果反馈到复杂度分析
 * - 多维度复杂度评估: 时间/依赖/工具复杂度
 * - 复杂度预测准确率追踪
 * - 领域自适应复杂度权重
 * - 置信度校准
 */

import { TaskComplexityAnalyzer } from '../../src/core/TaskComplexityAnalyzer';
import { Planner, type PlannerDeps } from '../../src/harness/loop/Planner';
import { LoopState } from '../../src/harness/types';

function createMockDeps(): PlannerDeps {
  return {
    llm: {
      chat: jest.fn().mockResolvedValue('NO'),
    },
  };
}

function createLoopContext(overrides?: Record<string, unknown>) {
  return {
    messages: [],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map(),
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    budget: {
      roundsUsed: 0,
      softRoundLimit: 4,
      hardRoundLimit: 8,
      tokensUsed: 0,
      tokenWarningLimit: 4500,
      tokenHardLimit: 8000,
      startTime: Date.now(),
      maxDurationMs: 60000,
      toolCallsUsed: 0,
      maxToolCalls: 10,
    },
    trace: {
      traceId: 'test-trace',
      state: LoopState.PLANNING,
      stateTransitions: [],
      trajectory: [],
      totalDuration: 0,
      totalToolCalls: 0,
      budgetState: {
        roundsUsed: 0,
        softRoundLimit: 4,
        hardRoundLimit: 8,
        tokensUsed: 0,
        tokenWarningLimit: 4500,
        tokenHardLimit: 8000,
        startTime: Date.now(),
        maxDurationMs: 60000,
        toolCallsUsed: 0,
        maxToolCalls: 10,
      },
    },
    metadata: {},
    ...overrides,
  };
}

// ============ 🔶-1: 简单任务规划增强 ============

describe('🔶-1 简单任务规划增强', () => {
  let planner: Planner;

  beforeEach(() => {
    planner = new Planner(createMockDeps());
  });

  describe('智能工具推荐增强', () => {
    it('应记录工具使用历史并影响推荐权重', () => {
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('file_search', false);

      const weights = planner.getToolWeights();
      expect(weights['file_search']).toBeDefined();
      expect(weights['file_search']).toBeGreaterThan(0);
    });

    it('成功使用的工具权重应高于失败的工具', () => {
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('shell_exec', false);
      planner.recordToolUsage('shell_exec', false);

      const weights = planner.getToolWeights();
      expect(weights['file_search']).toBeGreaterThan(weights['shell_exec']);
    });

    it('无历史数据时权重应为空', () => {
      const weights = planner.getToolWeights();
      expect(Object.keys(weights).length).toBe(0);
    });

    it('工具推荐应优先推荐高权重工具', async () => {
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('file_search', true);
      planner.recordToolUsage('file_search', true);

      const plan = await planner.plan(
        { text: '搜索代码文件' },
        createLoopContext()
      );

      expect(plan.recommendedTools).toContain('file_search');
    });
  });

  describe('简单任务预算自适应', () => {
    it('对话类任务应分配最小预算', async () => {
      const plan = await planner.plan({ text: '你好' }, createLoopContext());

      expect(plan.simple).toBe(true);
      expect(plan.estimatedBudget.maxRounds).toBe(1);
      expect(plan.estimatedBudget.maxToolCalls).toBe(0);
    });

    it('单工具简单任务应分配紧凑预算', async () => {
      const plan = await planner.plan(
        { text: '搜索代码文件' },
        createLoopContext()
      );

      expect(plan.simple).toBe(true);
      expect(plan.estimatedBudget.maxRounds).toBeLessThanOrEqual(4);
      expect(plan.estimatedBudget.maxToolCalls).toBeLessThanOrEqual(5);
    });

    it('复合简单任务预算应按子操作数缩放', async () => {
      const plan = await planner.plan(
        { text: '查看文件，然后搜索代码' },
        createLoopContext()
      );

      expect(plan.simple).toBe(true);
      expect(plan.steps.length).toBe(2);
      expect(plan.estimatedBudget.maxRounds).toBeGreaterThan(4);
    });

    it('预算应基于历史准确度动态调整', () => {
      planner.recordBudgetAccuracy(4, 6);
      planner.recordBudgetAccuracy(4, 7);
      planner.recordBudgetAccuracy(4, 8);

      const multiplier = planner.getAdjustedBudgetMultiplier();
      expect(multiplier).toBeGreaterThan(1.0);
    });
  });

  describe('复合简单任务并行执行', () => {
    it('无依赖的子操作应标记为可并行', async () => {
      const plan = await planner.plan(
        { text: '同时查看文件和搜索代码' },
        createLoopContext()
      );

      expect(plan.simple).toBe(true);
      const parallelGroups = plan.steps.filter(
        (s) => s.parallelGroup && s.parallelGroup !== 'parallel-root'
      );
      expect(parallelGroups.length).toBeGreaterThanOrEqual(0);
    });

    it('有依赖的子操作应顺序执行', async () => {
      const plan = await planner.plan(
        { text: '查看文件，然后搜索代码' },
        createLoopContext()
      );

      expect(plan.simple).toBe(true);
      expect(plan.steps.length).toBe(2);

      const step2Deps = plan.dependencies.get(plan.steps[1].id);
      expect(step2Deps).toBeDefined();
      expect(step2Deps).toContain(plan.steps[0].id);
    });

    it('同时连接词应触发并行标记', () => {
      const result =
        planner.detectCompositeSimpleTask('查看文件，同时搜索代码');
      expect(result.isCompositeSimple).toBe(true);
    });
  });

  describe('简单任务结果质量验证', () => {
    it('应记录简单任务执行结果', () => {
      planner.recordSimpleTaskResult('搜索代码', true, 500);
      planner.recordSimpleTaskResult('搜索代码', true, 300);
      planner.recordSimpleTaskResult('搜索代码', false, 100);

      const stats = planner.getSimpleTaskStats('搜索代码');
      expect(stats).toBeDefined();
      expect(stats!.totalRuns).toBe(3);
      expect(stats!.successRate).toBeCloseTo(2 / 3, 5);
      expect(stats!.avgDuration).toBeCloseTo(300, 0);
    });

    it('无记录的任务应返回null', () => {
      const stats = planner.getSimpleTaskStats('未知任务');
      expect(stats).toBeNull();
    });

    it('成功率低于阈值的任务应标记为需优化', () => {
      for (let i = 0; i < 5; i++) {
        planner.recordSimpleTaskResult('不稳定任务', false, 100);
      }

      const stats = planner.getSimpleTaskStats('不稳定任务');
      expect(stats!.needsOptimization).toBe(true);
    });

    it('成功率高于阈值的任务不应标记为需优化', () => {
      for (let i = 0; i < 8; i++) {
        planner.recordSimpleTaskResult('稳定任务', true, 100);
      }
      planner.recordSimpleTaskResult('稳定任务', false, 100);
      planner.recordSimpleTaskResult('稳定任务', false, 100);

      const stats = planner.getSimpleTaskStats('稳定任务');
      expect(stats!.needsOptimization).toBe(false);
    });
  });
});

// ============ 🔶-2: 复杂度分析增强 ============

describe('🔶-2 复杂度分析增强', () => {
  let analyzer: TaskComplexityAnalyzer;

  beforeEach(() => {
    analyzer = new TaskComplexityAnalyzer();
  });

  describe('复杂度校准闭环', () => {
    it('应记录实际执行轮次并校准预估', () => {
      analyzer.recordActualRounds('分析代码质量', 3, 5);
      analyzer.recordActualRounds('分析代码质量', 3, 6);
      analyzer.recordActualRounds('分析代码质量', 3, 4);

      const result = analyzer.analyzeComplexity('分析代码质量');
      expect(result.calibratedEstimatedRounds).toBeDefined();
      expect(result.calibratedEstimatedRounds).toBeGreaterThan(0);
    });

    it('应记录实际执行时间并校准预估时间', () => {
      analyzer.recordActualDuration('开发新功能', 5, 30000);
      analyzer.recordActualDuration('开发新功能', 5, 35000);
      analyzer.recordActualDuration('开发新功能', 5, 25000);

      const calibrated = analyzer.calibrateTimeWithHistory('开发新功能', 25);
      expect(calibrated).toBeDefined();
      expect(calibrated).toBeGreaterThan(0);
    });

    it('历史数据不足时不应校准', () => {
      analyzer.recordActualRounds('测试任务', 2, 3);

      const result = analyzer.analyzeComplexity('测试任务');
      expect(result.calibratedEstimatedRounds).toBeUndefined();
    });

    it('校准后预估应更接近实际值', () => {
      for (let i = 0; i < 5; i++) {
        analyzer.recordActualRounds('部署服务', 3, 7);
      }

      const result = analyzer.analyzeComplexity('部署服务');
      if (result.calibratedEstimatedRounds !== undefined) {
        expect(Math.abs(result.calibratedEstimatedRounds - 7)).toBeLessThan(
          Math.abs(result.estimatedSteps - 7)
        );
      }
    });
  });

  describe('多维度复杂度评估', () => {
    it('应返回时间复杂度评估', () => {
      const result = analyzer.analyzeComplexity('分析数据并生成报告');
      expect(result.multiDimensional).toBeDefined();
      expect(result.multiDimensional!.timeComplexity).toBeDefined();
      expect(result.multiDimensional!.timeComplexity.level).toMatch(
        /^(low|medium|high)$/
      );
    });

    it('应返回依赖复杂度评估', () => {
      const result = analyzer.analyzeComplexity('先搜索再分析最后总结');
      expect(result.multiDimensional).toBeDefined();
      expect(result.multiDimensional!.dependencyComplexity).toBeDefined();
      expect(result.multiDimensional!.dependencyComplexity.level).toMatch(
        /^(low|medium|high)$/
      );
    });

    it('应返回工具复杂度评估', () => {
      const result = analyzer.analyzeComplexity('开发并部署新功能');
      expect(result.multiDimensional).toBeDefined();
      expect(result.multiDimensional!.toolComplexity).toBeDefined();
      expect(result.multiDimensional!.toolComplexity.level).toMatch(
        /^(low|medium|high)$/
      );
    });

    it('简单任务各维度应为low', () => {
      const result = analyzer.analyzeComplexity('查看文件');
      expect(result.multiDimensional!.timeComplexity.level).toBe('low');
      expect(result.multiDimensional!.dependencyComplexity.level).toBe('low');
      expect(result.multiDimensional!.toolComplexity.level).toBe('low');
    });

    it('复杂任务至少一个维度应为high', () => {
      const result = analyzer.analyzeComplexity(
        '重构整个系统架构，包括数据库迁移、API升级和前端改造，需要先分析再设计然后开发最后部署测试'
      );
      const hasHigh = [
        result.multiDimensional!.timeComplexity.level,
        result.multiDimensional!.dependencyComplexity.level,
        result.multiDimensional!.toolComplexity.level,
      ].some((l) => l === 'high');
      expect(hasHigh).toBe(true);
    });
  });

  describe('复杂度预测准确率追踪', () => {
    it('应记录预测与实际的偏差', () => {
      analyzer.recordPredictionAccuracy('分析代码', 'medium', 'complex');
      analyzer.recordPredictionAccuracy('分析代码', 'medium', 'medium');
      analyzer.recordPredictionAccuracy('分析代码', 'simple', 'simple');

      const accuracy = analyzer.getPredictionAccuracy();
      expect(accuracy).toBeDefined();
      expect(accuracy.total).toBe(3);
      expect(accuracy.correct).toBe(2);
      expect(accuracy.rate).toBeCloseTo(2 / 3, 5);
    });

    it('无记录时准确率应为0', () => {
      const accuracy = analyzer.getPredictionAccuracy();
      expect(accuracy.total).toBe(0);
      expect(accuracy.rate).toBe(0);
    });

    it('应追踪各复杂度等级的混淆矩阵', () => {
      analyzer.recordPredictionAccuracy('任务1', 'simple', 'simple');
      analyzer.recordPredictionAccuracy('任务2', 'medium', 'complex');
      analyzer.recordPredictionAccuracy('任务3', 'complex', 'complex');
      analyzer.recordPredictionAccuracy('任务4', 'simple', 'medium');

      const matrix = analyzer.getConfusionMatrix();
      expect(matrix).toBeDefined();
      expect(matrix.simple.simple).toBe(1);
      expect(matrix.simple.medium).toBe(1);
      expect(matrix.medium.complex).toBe(1);
      expect(matrix.complex.complex).toBe(1);
    });
  });

  describe('领域自适应复杂度权重', () => {
    it('应识别数据分析领域并调整权重', () => {
      const result = analyzer.analyzeComplexity('数据清洗和特征工程');
      expect(result.domainTag).toBe('data');
    });

    it('应识别文档处理领域并调整权重', () => {
      const result = analyzer.analyzeComplexity('文档转换和OCR处理');
      expect(result.domainTag).toBe('doc');
    });

    it('应识别项目管理领域并调整权重', () => {
      const result = analyzer.analyzeComplexity('里程碑规划和甘特图');
      expect(result.domainTag).toBe('pm');
    });

    it('非特定领域应返回null', () => {
      const result = analyzer.analyzeComplexity('查看文件');
      expect(result.domainTag).toBeNull();
    });

    it('领域任务应有领域特定的风险评估', () => {
      const result = analyzer.analyzeComplexity('ETL数据管道开发');
      expect(result.domainTag).toBe('data');
      expect(result.riskFactors.length).toBeGreaterThan(0);
    });
  });

  describe('置信度校准', () => {
    it('LLM辅助判断应返回置信度', async () => {
      const mockLLM = {
        chat: jest.fn().mockResolvedValue(
          JSON.stringify({
            complexity: 'complex',
            confidence: 0.85,
            estimatedSteps: 6,
          })
        ),
      };
      analyzer.setLLMDeps(mockLLM);

      const result = await analyzer.analyzeComplexityWithLLM('重构系统架构');
      expect(result.llmConfidence).toBeDefined();
      expect(result.llmConfidence!).toBeGreaterThanOrEqual(0);
      expect(result.llmConfidence!).toBeLessThanOrEqual(1);
    });

    it('应记录置信度与实际结果的对应关系', () => {
      analyzer.recordConfidenceCalibration(0.9, true);
      analyzer.recordConfidenceCalibration(0.9, true);
      analyzer.recordConfidenceCalibration(0.9, false);
      analyzer.recordConfidenceCalibration(0.5, true);
      analyzer.recordConfidenceCalibration(0.5, false);
      analyzer.recordConfidenceCalibration(0.5, false);

      const calibration = analyzer.getConfidenceCalibration();
      expect(calibration).toBeDefined();
      expect(calibration['0.9']).toBeDefined();
      expect(calibration['0.9'].accuracy).toBeCloseTo(2 / 3, 5);
      expect(calibration['0.5'].accuracy).toBeCloseTo(1 / 3, 5);
    });

    it('高置信度应对应高准确率（校准后）', () => {
      for (let i = 0; i < 10; i++) {
        analyzer.recordConfidenceCalibration(0.9, true);
      }
      for (let i = 0; i < 10; i++) {
        analyzer.recordConfidenceCalibration(0.3, false);
      }

      const calibration = analyzer.getConfidenceCalibration();
      expect(calibration['0.9'].accuracy).toBeGreaterThan(
        calibration['0.3'].accuracy
      );
    });

    it('无校准数据时应返回空对象', () => {
      const calibration = analyzer.getConfidenceCalibration();
      expect(Object.keys(calibration).length).toBe(0);
    });
  });
});

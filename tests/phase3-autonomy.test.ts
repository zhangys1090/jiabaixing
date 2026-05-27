/**
 * Phase 3 测试套件
 * 测试自主性和适应性提升功能
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Environment, Experience, LearningContext, LearningData } from '../src/core/AutonomousLearningEngine';
import { Strategy, Context as StrategyContext } from '../src/core/DynamicStrategyAdjuster';
import { Phase3AutonomyCoordinator } from '../src/core/Phase3AutonomyCoordinator';

describe('Phase3AutonomyCoordinator', () => {
  let coordinator: Phase3AutonomyCoordinator;

  beforeEach(() => {
    coordinator = new Phase3AutonomyCoordinator({
      enableAutonomousLearning: true,
      enableSelfReflection: true,
      enableDynamicStrategyAdjustment: true,
      enableContinuousOptimization: true,
      optimizationInterval: 1000,
      performanceThreshold: 0.75
    });
  });

  afterEach(() => {
    coordinator.stopPeriodicOptimization();
    coordinator.reset();
  });

  describe('初始化', () => {
    it('应该成功初始化协调器', () => {
      expect(coordinator).toBeDefined();
      expect(coordinator.getCurrentMetrics()).toBeDefined();
    });

    it('应该正确设置配置', () => {
      const config = coordinator.getConfig();
      expect(config.enableAutonomousLearning).toBe(true);
      expect(config.enableSelfReflection).toBe(true);
      expect(config.enableDynamicStrategyAdjustment).toBe(true);
      expect(config.enableContinuousOptimization).toBe(true);
    });
  });

  describe('自主学习', () => {
    it('应该成功执行在线学习', async () => {
      const learningData: LearningData = {
        id: 'test-learning-1',
        type: 'supervised',
        features: [1, 2, 3],
        labels: [0, 1, 0],
        context: {
          environment: 'test',
          task: 'classification',
          state: {},
          metadata: {},
        },
        timestamp: Date.now(),
      };

      const result = await coordinator.onlineLearning(learningData);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.accuracy).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('应该成功积累经验', () => {
      const experience: Experience = {
        id: 'test-experience-1',
        situation: 'test-situation',
        action: 'test-action',
        outcome: 'success',
        reward: 0.8,
        timestamp: Date.now(),
        context: {
          environment: 'test',
          task: 'testing',
          state: {},
          metadata: {},
        },
      };

      expect(() => coordinator.experienceAccumulation(experience)).not.toThrow();
    });

    it('应该成功选择策略', () => {
      const context: LearningContext = {
        environment: 'production',
        task: 'classification',
        state: { dataSize: 1000 },
        metadata: { accuracyRequirement: 0.9 },
      };

      const strategy = coordinator.strategySelection(context);
      expect(strategy).toBeDefined();
      expect(strategy.name).toBeDefined();
      expect(strategy.effectiveness).toBeGreaterThan(0);
    });

    it('应该成功执行自适应行为', () => {
      const environment: Environment = {
        id: 'env-1',
        type: 'production',
        state: { load: 0.8 },
        dynamics: {
          volatility: 0.3,
          complexity: 0.5,
          predictability: 0.7,
          changeRate: 0.2,
        },
        constraints: ['max_latency_100ms'],
      };

      const behavior = coordinator.adaptiveBehavior(environment);
      expect(behavior).toBeDefined();
      expect(behavior.type).toBeDefined();
      expect(behavior.confidence).toBeGreaterThan(0);
    });
  });

  describe('自我反思', () => {
    it('应该成功执行性能分析', () => {
      const report = coordinator.performanceAnalysis();
      expect(report).toBeDefined();
      expect(report.id).toBeDefined();
      expect(report.overallScore).toBeGreaterThan(0);
      expect(report.metrics).toBeDefined();
    });

    it('应该成功诊断错误', () => {
      const error = new Error('测试错误');
      const diagnosis = coordinator.errorDiagnosis(error);
      expect(diagnosis).toBeDefined();
      expect(diagnosis.errorType).toBeDefined();
      expect(diagnosis.severity).toBeDefined();
    });

    it('应该成功生成改进建议', () => {
      const improvements = coordinator.improvementGeneration();
      expect(improvements).toBeDefined();
      expect(improvements.length).toBeGreaterThan(0);
      expect(improvements[0].priority).toBeDefined();
    });

    it('应该成功执行反思深度', () => {
      const topic = '系统性能';
      const reflection = coordinator.reflectionDepth(topic);
      expect(reflection).toBeDefined();
      expect(reflection.topic).toBe(topic);
      expect(reflection.depth).toBeGreaterThan(0);
    });
  });

  describe('动态策略调整', () => {
    it('应该成功评估策略', () => {
      const strategy: Strategy = {
        id: 'strategy-1',
        name: '测试策略',
        type: 'balanced',
        parameters: {
          riskTolerance: 0.5,
          explorationRate: 0.2,
          learningRate: 0.005,
          adaptationSpeed: 0.5,
        },
        performance: {
          accuracy: 0.85,
          efficiency: 0.9,
          stability: 0.7,
          adaptability: 0.8,
          overallScore: 0.8,
          lastUpdated: Date.now(),
        },
        metadata: {
          description: '测试策略描述',
          category: 'general_purpose',
          dependencies: [],
          constraints: [],
          tags: ['test'],
        },
      };

      const evaluation = coordinator.strategyEvaluation(strategy);
      expect(evaluation).toBeDefined();
      expect(evaluation.score).toBeGreaterThan(0);
      expect(evaluation.recommendations).toBeDefined();
    });

    it('应该成功切换策略', () => {
      const context: StrategyContext = {
        id: 'ctx-1',
        type: 'production',
        state: {
          variables: {},
          metrics: { load: 0.8 },
          events: [],
        },
        environment: {
          type: 'cloud',
          characteristics: {},
          dynamics: {
            volatility: 0.3,
            complexity: 0.5,
            predictability: 0.7,
            changeRate: 0.2,
          },
          resources: {
            cpu: 0.7,
            memory: 0.6,
            disk: 0.5,
            network: 0.4,
          },
        },
        constraints: [],
        objectives: [
          { id: 'obj-1', name: 'speed', type: 'performance', target: 0.9, weight: 0.7 },
          { id: 'obj-2', name: 'accuracy', type: 'quality', target: 0.95, weight: 0.8 },
        ],
        timestamp: Date.now(),
      };

      const strategy = coordinator.strategySwitching(context);
      expect(strategy).toBeDefined();
      expect(strategy.name).toBeDefined();
    });

    it('应该成功调优参数', async () => {
      const parameters = {
        learningRate: 0.01,
        batchSize: 32,
        epochs: 10
      };

      const result = await coordinator.parameterTuning(parameters);
      expect(result).toBeDefined();
      expect(result.parameters).toBeDefined();
      expect(result.improvement).toBeGreaterThan(0);
    });

    it('应该成功组合策略', () => {
      const strategies: Strategy[] = [
        {
          id: 'strategy-1',
          name: '策略1',
          type: 'conservative',
          parameters: { riskTolerance: 0.2, explorationRate: 0.1, learningRate: 0.001, adaptationSpeed: 0.3 },
          performance: { accuracy: 0.8, efficiency: 0.75, stability: 0.9, adaptability: 0.6, overallScore: 0.76, lastUpdated: Date.now() },
          metadata: { description: '描述1', category: 'risk_management', dependencies: [], constraints: [], tags: [] },
        },
        {
          id: 'strategy-2',
          name: '策略2',
          type: 'aggressive',
          parameters: { riskTolerance: 0.8, explorationRate: 0.4, learningRate: 0.01, adaptationSpeed: 0.8 },
          performance: { accuracy: 0.75, efficiency: 0.85, stability: 0.6, adaptability: 0.9, overallScore: 0.78, lastUpdated: Date.now() },
          metadata: { description: '描述2', category: 'performance_optimization', dependencies: [], constraints: [], tags: [] },
        }
      ];

      const composed = coordinator.strategyComposition(strategies);
      expect(composed).toBeDefined();
      expect(composed.name).toBeDefined();
      expect(composed.componentStrategies).toHaveLength(2);
    });
  });

  describe('持续性能优化', () => {
    it('应该成功监控性能', () => {
      const metrics = coordinator.performanceMonitoring();
      expect(metrics).toBeDefined();
      expect(metrics.cpu).toBeDefined();
      expect(metrics.memory).toBeDefined();
      expect(metrics.network).toBeDefined();
    });

    it('应该成功检测瓶颈', () => {
      const bottlenecks = coordinator.bottleneckDetection();
      expect(bottlenecks).toBeDefined();
      expect(Array.isArray(bottlenecks)).toBe(true);
    });

    it('应该成功触发自动优化', () => {
      const actions = coordinator.autoOptimizationTrigger();
      expect(actions).toBeDefined();
      expect(Array.isArray(actions)).toBe(true);
    });

    it('应该成功评估优化效果', () => {
      const action = {
        id: 'action-1',
        type: 'algorithm_optimization' as const,
        target: 'cpu',
        description: '优化CPU使用',
        parameters: { threshold: 0.8 },
        priority: 'high' as const,
        estimatedImpact: 0.3,
        estimatedCost: 0.1,
        implementationSteps: ['调整线程池大小', '优化查询缓存'],
        timestamp: Date.now()
      };

      const evaluation = coordinator.optimizationEvaluation(action);
      expect(evaluation).toBeDefined();
      expect(typeof evaluation.improvement).toBe('number');
    });
  });

  describe('系统优化', () => {
    it('应该成功执行系统优化', async () => {
      const result = await coordinator.optimizeSystem();
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.improvements).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.recommendations).toBeDefined();
    });

    it('应该正确更新指标', async () => {
      const initialMetrics = coordinator.getCurrentMetrics();
      await coordinator.optimizeSystem();
      const updatedMetrics = coordinator.getCurrentMetrics();

      expect(updatedMetrics).toBeDefined();
      expect(updatedMetrics.overallPerformance).toBeGreaterThanOrEqual(0);
    });
  });

  describe('配置管理', () => {
    it('应该成功更新配置', () => {
      const newConfig = {
        optimizationInterval: 2000,
        performanceThreshold: 0.8
      };

      expect(() => coordinator.updateConfig(newConfig)).not.toThrow();
      const updatedConfig = coordinator.getConfig();
      expect(updatedConfig.optimizationInterval).toBe(2000);
      expect(updatedConfig.performanceThreshold).toBe(0.8);
    });

    it('应该成功获取指标历史', () => {
      const history = coordinator.getMetricsHistory();
      expect(history).toBeDefined();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('组件访问', () => {
    it('应该成功获取学习引擎', () => {
      const engine = coordinator.getLearningEngine();
      expect(engine).toBeDefined();
    });

    it('应该成功获取反思引擎', () => {
      const engine = coordinator.getReflectionEngine();
      expect(engine).toBeDefined();
    });

    it('应该成功获取策略调整器', () => {
      const adjuster = coordinator.getStrategyAdjuster();
      expect(adjuster).toBeDefined();
    });

    it('应该成功获取性能优化器', () => {
      const optimizer = coordinator.getPerformanceOptimizer();
      expect(optimizer).toBeDefined();
    });
  });

  describe('错误处理', () => {
    it('应该在功能未启用时抛出错误', async () => {
      const disabledCoordinator = new Phase3AutonomyCoordinator({
        enableAutonomousLearning: false,
        enableSelfReflection: false,
        enableDynamicStrategyAdjustment: false,
        enableContinuousOptimization: false
      });

      const learningData: LearningData = {
        id: 'test-learning-1',
        type: 'supervised',
        features: [1, 2, 3],
        labels: [0, 1, 0],
        context: {
          environment: 'test',
          task: 'classification',
          state: {},
          metadata: {},
        },
        timestamp: Date.now(),
      };

      await expect(disabledCoordinator.onlineLearning(learningData)).rejects.toThrow('自主学习未启用');
      expect(() => disabledCoordinator.performanceAnalysis()).toThrow('自我反思未启用');

      disabledCoordinator.stopPeriodicOptimization();
      disabledCoordinator.reset();
    });
  });

  describe('重置功能', () => {
    it('应该成功重置协调器', () => {
      expect(() => coordinator.reset()).not.toThrow();
      const metrics = coordinator.getCurrentMetrics();
      expect(metrics).toBeDefined();
    });
  });
});

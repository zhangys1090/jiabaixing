/**
 * Phase 2 智能化提升测试套件
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { EnvironmentalAwarenessEngine, Situation } from '../src/core/EnvironmentalAwarenessEngine';
import { IntelligentMemoryCompressor, Memory } from '../src/core/IntelligentMemoryCompressor';
import { IntelligentTaskQueue, Task } from '../src/core/IntelligentTaskQueue';
import { Experience, KnowledgeGraphBuilder } from '../src/core/KnowledgeGraphBuilder';
import { ParallelExecutionOptimizer } from '../src/core/ParallelExecutionOptimizer';
import { Phase2IntelligenceCoordinator } from '../src/core/Phase2IntelligenceCoordinator';
import { TransferLearningEngine, TransferRequest } from '../src/core/TransferLearningEngine';

describe('Phase 2 智能化提升测试', () => {
  describe('智能记忆压缩器', () => {
    let compressor: IntelligentMemoryCompressor;

    beforeEach(() => {
      compressor = new IntelligentMemoryCompressor();
    });

    afterEach(() => {
      compressor.reset();
    });

    it('应该能够添加记忆', () => {
      const memory: Memory = {
        id: 'mem-1',
        content: '测试记忆内容',
        timestamp: Date.now(),
        importance: 0.8,
        accessCount: 0,
        lastAccess: Date.now(),
        tags: ['test']
      };

      compressor.addMemory(memory);
      const stats = compressor.getCompressionStats();
      expect(stats.totalMemories).toBe(1);
    });

    it('应该能够压缩记忆', () => {
      const memory: Memory = {
        id: 'mem-1',
        content: '这是一个非常重要的测试记忆内容，包含了多个关键的要点和核心信息，需要特别注意保存和总结。',
        timestamp: Date.now(),
        importance: 0.8,
        accessCount: 0,
        lastAccess: Date.now(),
        tags: ['test']
      };

      compressor.addMemory(memory);
      const compressed = compressor.compressMemory('mem-1');

      expect(compressed).not.toBeNull();
      expect(compressed!.keyPoints.length).toBeGreaterThan(0);
    });

    it('应该能够搜索记忆', () => {
      const memory1: Memory = {
        id: 'mem-1',
        content: 'React 开发相关内容',
        timestamp: Date.now(),
        importance: 0.8,
        accessCount: 0,
        lastAccess: Date.now(),
        tags: ['react', 'development']
      };

      const memory2: Memory = {
        id: 'mem-2',
        content: 'Vue 开发相关内容',
        timestamp: Date.now(),
        importance: 0.7,
        accessCount: 0,
        lastAccess: Date.now(),
        tags: ['vue', 'development']
      };

      compressor.addMemory(memory1);
      compressor.addMemory(memory2);

      const results = compressor.searchMemories('React');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe('mem-1');
    });

    it('应该能够获取压缩统计', () => {
      const memory: Memory = {
        id: 'mem-1',
        content: '测试记忆内容',
        timestamp: Date.now(),
        importance: 0.8,
        accessCount: 0,
        lastAccess: Date.now(),
        tags: ['test']
      };

      compressor.addMemory(memory);
      compressor.compressMemory('mem-1');

      const stats = compressor.getCompressionStats();
      expect(stats.totalMemories).toBe(1);
      expect(stats.compressedMemories).toBe(1);
      expect(stats.avgCompressionRatio).toBeGreaterThan(0);
    });
  });

  describe('知识图谱构建器', () => {
    let graphBuilder: KnowledgeGraphBuilder;

    beforeEach(() => {
      graphBuilder = new KnowledgeGraphBuilder();
    });

    afterEach(() => {
      graphBuilder.reset();
    });

    it('应该能够添加经验', () => {
      const experience: Experience = {
        id: 'exp-1',
        content: '测试经验内容',
        timestamp: Date.now(),
        context: '测试',
        outcome: '成功',
        entities: ['实体1', '实体2'],
        relations: []
      };

      graphBuilder.addExperience(experience);
      const stats = graphBuilder.getStatistics();
      expect(stats.totalNodes).toBeGreaterThan(0);
    });

    it('应该能够查询知识图谱', () => {
      const experience: Experience = {
        id: 'exp-1',
        content: 'React开发提高了效率',
        timestamp: Date.now(),
        context: '开发',
        outcome: '效率提升',
        entities: ['React', '效率'],
        relations: [
          {
            source: 'React',
            target: '效率',
            type: 'causal',
            strength: 0.9,
            confidence: 0.8
          }
        ]
      };

      graphBuilder.addExperience(experience);

      const result = graphBuilder.queryGraph({
        nodes: ['entity:React'],
        minConfidence: 0.1
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('应该能够获取统计信息', () => {
      const experience: Experience = {
        id: 'exp-1',
        content: '测试经验内容',
        timestamp: Date.now(),
        context: '测试',
        outcome: '成功',
        entities: ['实体1', '实体2'],
        relations: []
      };

      graphBuilder.addExperience(experience);
      const stats = graphBuilder.getStatistics();

      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.totalEdges).toBeGreaterThanOrEqual(0);
    });
  });

  describe('迁移学习引擎', () => {
    let transferEngine: TransferLearningEngine;

    beforeEach(() => {
      transferEngine = new TransferLearningEngine();
    });

    afterEach(() => {
      transferEngine.reset();
    });

    it('应该能够获取所有域', () => {
      const domains = transferEngine.getAllDomains();
      expect(domains.length).toBeGreaterThan(0);
    });

    it('应该能够执行迁移学习', async () => {
      const request: TransferRequest = {
        sourceDomain: 'development',
        targetDomain: 'analysis',
        task: '数据处理'
      };

      const result = await transferEngine.transferLearning(request);
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    });
  });

  describe('环境感知引擎', () => {
    let envEngine: EnvironmentalAwarenessEngine;

    beforeEach(() => {
      envEngine = new EnvironmentalAwarenessEngine();
    });

    afterEach(() => {
      envEngine.reset();
    });

    it('应该能够监控系统状态', async () => {
      const state = await envEngine.monitorSystemState();
      expect(state).toBeDefined();
      expect(state.cpuUsage).toBeGreaterThanOrEqual(0);
      expect(state.memoryUsage).toBeGreaterThanOrEqual(0);
    });

    it('应该能够理解上下文', () => {
      const situation: Situation = {
        id: 'sit-1',
        description: '测试情况',
        context: '测试',
        urgency: 'medium',
        complexity: 'simple',
        stakeholders: [],
        constraints: []
      };

      const insight = envEngine.understandContext(situation);
      expect(insight).toBeDefined();
      expect(insight.situationId).toBe('sit-1');
      expect(insight.confidence).toBeGreaterThan(0);
    });

    it('应该能够预测变化', async () => {
      const prediction = await envEngine.predictChanges(3600000);
      expect(prediction).toBeDefined();
      expect(prediction.timeHorizon).toBe(3600000);
    });
  });

  describe('智能任务队列', () => {
    let taskQueue: IntelligentTaskQueue;

    beforeEach(() => {
      taskQueue = new IntelligentTaskQueue(4);
    });

    afterEach(() => {
      taskQueue.reset();
    });

    it('应该能够添加任务', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '测试任务描述',
        type: 'computation',
        priority: 5,
        estimatedDuration: 1000,
        dependencies: [],
        resources: { cpu: 10, memory: 20, disk: 5, network: 2 },
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: 3
      };

      taskQueue.addTask(task);
      const status = taskQueue.getQueueStatus();
      expect(status.pendingTasks).toBe(1);
    });

    it('应该能够获取队列状态', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '测试任务描述',
        type: 'computation',
        priority: 5,
        estimatedDuration: 1000,
        dependencies: [],
        resources: { cpu: 10, memory: 20, disk: 5, network: 2 },
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: 3
      };

      taskQueue.addTask(task);
      const status = taskQueue.getQueueStatus();

      expect(status.totalTasks).toBe(1);
      expect(status.pendingTasks).toBe(1);
    });

    it('应该能够完成任务', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '测试任务描述',
        type: 'computation',
        priority: 5,
        estimatedDuration: 1000,
        dependencies: [],
        resources: { cpu: 10, memory: 20, disk: 5, network: 2 },
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: 3
      };

      taskQueue.addTask(task);
      taskQueue.getNextTask();
      taskQueue.completeTask('task-1', { success: true });

      const status = taskQueue.getQueueStatus();
      expect(status.completedTasks).toBe(1);
    });
  });

  describe('并行执行优化器', () => {
    let taskQueue: IntelligentTaskQueue;
    let optimizer: ParallelExecutionOptimizer;

    beforeEach(() => {
      taskQueue = new IntelligentTaskQueue(4);
      optimizer = new ParallelExecutionOptimizer(taskQueue);
    });

    afterEach(() => {
      taskQueue.reset();
      optimizer.reset();
    });

    it('应该能够创建执行计划', () => {
      const tasks: Task[] = [
        {
          id: 'task-1',
          name: '任务1',
          description: '任务1描述',
          type: 'computation',
          priority: 5,
          estimatedDuration: 1000,
          dependencies: [],
          resources: { cpu: 10, memory: 20, disk: 5, network: 2 },
          status: 'pending',
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: 3
        },
        {
          id: 'task-2',
          name: '任务2',
          description: '任务2描述',
          type: 'computation',
          priority: 5,
          estimatedDuration: 1500,
          dependencies: ['task-1'],
          resources: { cpu: 15, memory: 25, disk: 5, network: 2 },
          status: 'pending',
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: 3
        }
      ];

      const plan = optimizer.createExecutionPlan(tasks);
      expect(plan).toBeDefined();
      expect(plan.tasks.length).toBe(2);
      expect(plan.parallelGroups.length).toBeGreaterThan(0);
    });

    it('应该能够执行计划', async () => {
      const tasks: Task[] = [
        {
          id: 'task-1',
          name: '任务1',
          description: '任务1描述',
          type: 'computation',
          priority: 5,
          estimatedDuration: 100,
          dependencies: [],
          resources: { cpu: 10, memory: 20, disk: 5, network: 2 },
          status: 'pending',
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: 3
        }
      ];

      const plan = optimizer.createExecutionPlan(tasks);
      const result = await optimizer.executePlan(plan);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.completedTasks.length).toBe(1);
    });
  });

  describe('Phase 2 协调器', () => {
    let coordinator: Phase2IntelligenceCoordinator;

    beforeEach(() => {
      coordinator = new Phase2IntelligenceCoordinator({
        optimizationInterval: 1000
      });
    });

    afterEach(() => {
      coordinator.stopPeriodicOptimization();
      coordinator.reset();
    });

    it('应该能够初始化', () => {
      expect(coordinator).toBeDefined();
      expect(coordinator.getCurrentMetrics()).toBeDefined();
    });

    it('应该能够添加记忆', () => {
      const memory: Memory = {
        id: 'mem-1',
        content: '测试记忆',
        timestamp: Date.now(),
        importance: 0.8,
        accessCount: 0,
        lastAccess: Date.now(),
        tags: ['test']
      };

      coordinator.addMemory(memory);
      const stats = coordinator.getMemoryCompressor().getCompressionStats();
      expect(stats.totalMemories).toBe(1);
    });

    it('应该能够添加经验', () => {
      const experience: Experience = {
        id: 'exp-1',
        content: '测试经验',
        timestamp: Date.now(),
        context: '测试',
        outcome: '成功',
        entities: ['实体1'],
        relations: []
      };

      coordinator.addExperience(experience);
      const stats = coordinator.getKnowledgeGraphBuilder().getStatistics();
      expect(stats.totalNodes).toBeGreaterThan(0);
    });

    it('应该能够监控系统', async () => {
      const state = await coordinator.monitorEnvironment();
      expect(state).toBeDefined();
    });

    it('应该能够添加任务', () => {
      const task: Task = {
        id: 'task-1',
        name: '测试任务',
        description: '测试任务描述',
        type: 'computation',
        priority: 5,
        estimatedDuration: 1000,
        dependencies: [],
        resources: { cpu: 10, memory: 20, disk: 5, network: 2 },
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: 3
      };

      coordinator.addTask(task);
      const status = coordinator.getTaskQueue().getQueueStatus();
      expect(status.pendingTasks).toBe(1);
    });

    it('应该能够优化系统', async () => {
      const result = await coordinator.optimizeSystem();
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
      expect(result.metrics).toBeDefined();
    });

    it('应该能够获取当前指标', () => {
      const metrics = coordinator.getCurrentMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.overallPerformance).toBeGreaterThanOrEqual(0);
      expect(metrics.overallPerformance).toBeLessThanOrEqual(1);
    });

    it('应该能够获取配置', () => {
      const config = coordinator.getConfig();
      expect(config).toBeDefined();
      expect(config.enableMemoryOptimization).toBeDefined();
      expect(config.enableKnowledgeGraph).toBeDefined();
    });

    it('应该能够更新配置', () => {
      coordinator.updateConfig({
        performanceThreshold: 0.8
      });

      const config = coordinator.getConfig();
      expect(config.performanceThreshold).toBe(0.8);
    });
  });
});

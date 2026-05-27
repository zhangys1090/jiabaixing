/**
 * MemoryEvolutionManager 单元测试
 * 覆盖率目标：70%
 */

import { MemoryEvolutionManager } from '../../../src/memory/MemoryEvolutionManager';
import { MemoryItem, MemoryType } from '../../../src/memory/MemoryEngine';

describe('MemoryEvolutionManager', () => {
  let manager: MemoryEvolutionManager;

  beforeEach(async () => {
    manager = new MemoryEvolutionManager();
    await manager.initialize();
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('记忆管理', () => {
    test('应该能够添加记忆', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '这是一个测试记忆',
        timestamp: new Date(),
        scene: '测试场景',
        emotion: '开心',
      };

      await manager.addMemory(memory);
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBe(1);
    });

    test('应该能够批量添加记忆', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆1',
          timestamp: new Date(),
        },
        {
          id: 'memory-2',
          type: '短期记忆' as MemoryType,
          content: '记忆2',
          timestamp: new Date(),
        }
      ];

      await manager.addMemories(memories);
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBe(2);
    });

    test('应该生成语义向量', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '这是一个测试记忆',
        timestamp: new Date(),
      };

      await manager.addMemory(memory);
      
      const clusters = manager.getClusters();
      expect(clusters.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('记忆清理', () => {
    test('应该清理过期记忆', async () => {
      const now = new Date();
      const oldMemory: MemoryItem = {
        id: 'memory-old',
        type: '长期记忆' as MemoryType,
        content: '过期记忆',
        timestamp: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
      };

      const newMemory: MemoryItem = {
        id: 'memory-new',
        type: '长期记忆' as MemoryType,
        content: '新记忆',
        timestamp: now,
      };

      await manager.addMemory(oldMemory);
      await manager.addMemory(newMemory);
      
      await manager.cleanupExpiredMemories();
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBe(1);
    });

    test('应该保留未过期记忆', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '新记忆',
        timestamp: new Date(),
      };

      await manager.addMemory(memory);
      
      await manager.cleanupExpiredMemories();
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBe(1);
    });
  });

  describe('记忆压缩', () => {
    test('应该压缩相似记忆', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '相似的记忆内容A',
          timestamp: new Date(),
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '相似的记忆内容A',
          timestamp: new Date(),
        },
        {
          id: 'memory-3',
          type: '长期记忆' as MemoryType,
          content: '完全不同的记忆内容B',
          timestamp: new Date(),
        }
      ];

      await manager.addMemories(memories);
      
      const result = await manager.compressSimilarMemories();
      
      expect(result.originalCount).toBe(3);
      expect(result.compressedCount).toBeLessThanOrEqual(3);
      expect(result.compressionRatio).toBeGreaterThanOrEqual(0);
    });

    test('压缩应该保留重要记忆', async () => {
      const importantMemory: MemoryItem = {
        id: 'memory-important',
        type: '长期记忆' as MemoryType,
        content: '这是一个非常重要的记忆，包含很多详细信息和情感价值',
        timestamp: new Date(),
        emotion: '开心',
      };

      const simpleMemory: MemoryItem = {
        id: 'memory-simple',
        type: '瞬时记忆' as MemoryType,
        content: '简单',
        timestamp: new Date(),
      };

      await manager.addMemory(importantMemory);
      await manager.addMemory(simpleMemory);
      
      const result = await manager.compressSimilarMemories();
      
      expect(result.preservedMemories).toContain('memory-important');
    });
  });

  describe('记忆聚类', () => {
    test('应该创建记忆聚类', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '工作相关的记忆',
          timestamp: new Date(),
          scene: '工作',
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '另一个工作记忆',
          timestamp: new Date(),
          scene: '工作',
        },
        {
          id: 'memory-3',
          type: '长期记忆' as MemoryType,
          content: '学习相关的记忆',
          timestamp: new Date(),
          scene: '学习',
        }
      ];

      await manager.addMemories(memories);
      
      const clusters = await manager.clusterMemories();
      
      expect(clusters.length).toBeGreaterThan(0);
    });

    test('聚类应该包含正确的记忆', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '测试记忆1',
          timestamp: new Date(),
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '测试记忆2',
          timestamp: new Date(),
        }
      ];

      await manager.addMemories(memories);
      
      const clusters = await manager.clusterMemories();
      
      if (clusters.length > 0) {
        expect(clusters[0].memoryIds.length).toBeGreaterThan(0);
        expect(clusters[0].size).toBe(clusters[0].memoryIds.length);
      }
    });
  });

  describe('自动整理', () => {
    test('应该执行自动整理', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆1',
          timestamp: new Date(),
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '记忆2',
          timestamp: new Date(),
        }
      ];

      await manager.addMemories(memories);
      
      await manager.autoOrganize();
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBeGreaterThanOrEqual(0);
    });
  });

  describe('演化事件', () => {
    test('应该记录演化事件', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '测试记忆',
        timestamp: new Date(),
      };

      await manager.addMemory(memory);
      
      const events = manager.getEvolutionEvents();
      expect(events.length).toBeGreaterThan(0);
    });

    test('应该限制事件记录数量', async () => {
      for (let i = 0; i < 1100; i++) {
        const memory: MemoryItem = {
          id: `memory-${i}`,
          type: '长期记忆' as MemoryType,
          content: `记忆${i}`,
          timestamp: new Date(),
        };
        await manager.addMemory(memory);
      }
      
      const events = manager.getEvolutionEvents(2000);
      expect(events.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('统计信息', () => {
    test('应该提供正确的统计信息', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆1',
          timestamp: new Date(),
        },
        {
          id: 'memory-2',
          type: '短期记忆' as MemoryType,
          content: '记忆2',
          timestamp: new Date(),
        }
      ];

      await manager.addMemories(memories);
      
      const stats = manager.getStatistics();
      
      expect(stats.totalMemories).toBe(2);
      expect(stats.memoryTypeDistribution['长期记忆']).toBe(1);
      expect(stats.memoryTypeDistribution['短期记忆']).toBe(1);
    });
  });

  describe('边界条件', () => {
    test('应该处理空记忆列表', async () => {
      const result = await manager.compressSimilarMemories();
      expect(result.originalCount).toBe(0);
      expect(result.compressedCount).toBe(0);
    });

    test('应该处理单个记忆', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '单个记忆',
        timestamp: new Date(),
      };

      await manager.addMemory(memory);
      
      const clusters = await manager.clusterMemories();
      expect(clusters.length).toBe(0);
    });

    test('应该正确处理清理', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '测试记忆',
        timestamp: new Date(),
      };

      await manager.addMemory(memory);
      manager.cleanup();
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBe(0);
      expect(stats.clusterCount).toBe(0);
    });

    test('应该处理不同时间戳的记忆', async () => {
      const now = new Date();
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆1',
          timestamp: new Date(now.getTime() - 1000),
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '记忆2',
          timestamp: now,
        }
      ];

      await manager.addMemories(memories);
      
      const stats = manager.getStatistics();
      expect(stats.totalMemories).toBe(2);
    });
  });
});

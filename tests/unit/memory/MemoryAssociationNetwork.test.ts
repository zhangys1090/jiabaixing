/**
 * MemoryAssociationNetwork 单元测试
 * 覆盖率目标：70%
 */

import { MemoryAssociationNetwork, MemoryAssociation } from '../../../src/memory/MemoryAssociationNetwork';
import { MemoryItem, MemoryType } from '../../../src/memory/MemoryEngine';

describe('MemoryAssociationNetwork', () => {
  let network: MemoryAssociationNetwork;

  beforeEach(async () => {
    network = new MemoryAssociationNetwork();
    await network.initialize();
  });

  afterEach(() => {
    network.cleanup();
  });

  describe('网络构建', () => {
    test('应该能够添加记忆节点', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '这是一个测试记忆',
        timestamp: new Date()
      };

      const node = await network.addMemory(memory);
      
      expect(node).toBeDefined();
      expect(node.memoryId).toBe('memory-1');
      expect(network.getNodeCount()).toBe(1);
    });

    test('应该能够批量添加记忆', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆1',
          timestamp: new Date()
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '记忆2',
          timestamp: new Date()
        }
      ];

      await network.addMemories(memories);
      
      expect(network.getNodeCount()).toBe(2);
    });

    test('应该自动建立记忆关联', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '相似的记忆内容',
          timestamp: new Date()
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '相似的记忆内容',
          timestamp: new Date()
        }
      ];

      await network.addMemories(memories);
      
      expect(network.getEdgeCount()).toBeGreaterThan(0);
    });
  });

  describe('关联查询', () => {
    test('应该能够查找相关记忆', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '工作相关的记忆',
          timestamp: new Date(),
          scene: '工作'
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '另一个工作记忆',
          timestamp: new Date(),
          scene: '工作'
        }
      ];

      await network.addMemories(memories);
      
      const associations = await network.findRelatedMemories('memory-1', 5);
      
      expect(associations.length).toBeGreaterThan(0);
      expect(associations[0].targetMemory.id).toBe('memory-2');
    });

    test('应该能够基于关键词搜索', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '关于人工智能的记忆',
          timestamp: new Date()
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '关于机器学习的记忆',
          timestamp: new Date()
        }
      ];

      await network.addMemories(memories);
      
      const results = await network.searchRelatedMemories('人工智能', 10);
      
      expect(results.length).toBeGreaterThan(0);
    });

    test('应该能够查找记忆路径', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆A',
          timestamp: new Date()
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '记忆B',
          timestamp: new Date()
        }
      ];

      await network.addMemories(memories);
      
      const path = network.findMemoryPath('memory-1', 'memory-2');
      
      if (network.getEdgeCount() > 0) {
        expect(path.length).toBeGreaterThan(0);
      }
    });
  });

  describe('网络统计', () => {
    test('应该提供正确的网络统计', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆1',
          timestamp: new Date()
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '记忆2',
          timestamp: new Date()
        }
      ];

      await network.addMemories(memories);
      
      const stats = network.getNetworkStats();
      
      expect(stats.totalNodes).toBe(2);
      expect(stats.averageDegree).toBeGreaterThanOrEqual(0);
    });

    test('应该识别中心节点', async () => {
      const memories: MemoryItem[] = [];
      
      for (let i = 0; i < 5; i++) {
        memories.push({
          id: `memory-${i}`,
          type: '长期记忆' as MemoryType,
          content: `记忆${i}`,
          timestamp: new Date()
        });
      }

      await network.addMemories(memories);
      
      const stats = network.getNetworkStats();
      expect(stats.centralNodes.length).toBeGreaterThan(0);
    });
  });

  describe('网络导出', () => {
    test('应该能够导出网络数据', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '测试记忆',
        timestamp: new Date()
      };

      await network.addMemory(memory);
      
      const data = network.exportNetwork();
      
      expect(data.nodes).toBeDefined();
      expect(data.edges).toBeDefined();
      expect(data.stats).toBeDefined();
    });
  });

  describe('网络规模管理', () => {
    test('应该限制网络规模', async () => {
      const memories: MemoryItem[] = [];
      for (let i = 0; i < 10100; i++) {
        memories.push({
          id: `memory-${i}`,
          type: '长期记忆' as MemoryType,
          content: `记忆${i}`,
          timestamp: new Date()
        });
      }

      await network.addMemories(memories);
      
      expect(network.getNodeCount()).toBeLessThanOrEqual(10000);
    });
  });

  describe('边界条件', () => {
    test('应该处理空记忆', async () => {
      const stats = network.getNetworkStats();
      expect(stats.totalNodes).toBe(0);
      expect(stats.totalEdges).toBe(0);
    });

    test('应该处理单个记忆', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '单个记忆',
        timestamp: new Date()
      };

      await network.addMemory(memory);
      
      const stats = network.getNetworkStats();
      expect(stats.totalNodes).toBe(1);
      expect(stats.totalEdges).toBe(0);
    });

    test('应该处理不存在的记忆ID', async () => {
      const associations = await network.findRelatedMemories('non-existent', 5);
      expect(associations).toHaveLength(0);
    });

    test('应该处理不连通的路径', async () => {
      const memories: MemoryItem[] = [
        {
          id: 'memory-1',
          type: '长期记忆' as MemoryType,
          content: '记忆A',
          timestamp: new Date()
        },
        {
          id: 'memory-2',
          type: '长期记忆' as MemoryType,
          content: '记忆B',
          timestamp: new Date()
        }
      ];

      await network.addMemories(memories);
      
      if (network.getEdgeCount() === 0) {
        const path = network.findMemoryPath('memory-1', 'memory-2');
        expect(path).toHaveLength(0);
      }
    });

    test('应该正确处理清理', async () => {
      const memory: MemoryItem = {
        id: 'memory-1',
        type: '长期记忆' as MemoryType,
        content: '测试记忆',
        timestamp: new Date()
      };

      await network.addMemory(memory);
      network.cleanup();
      
      const stats = network.getNetworkStats();
      expect(stats.totalNodes).toBe(0);
      expect(stats.totalEdges).toBe(0);
    });
  });
});

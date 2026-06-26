/**
 * 因果建模规划测试 (P3-3)
 *
 * 验证核心目标：
 *   - LLM 构建任务因果关系图
 *   - 识别步骤依赖、并行机会、失败传播路径
 *   - 基于因果图生成更智能的计划
 */

import type { CausalGraph } from '../../../src/harness/loop/CausalModeler';
import { CausalModeler } from '../../../src/harness/loop/CausalModeler';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createMockLLM(response: string) {
  return {
    chat: jest.fn().mockResolvedValue(response),
    chatWithTools: jest.fn(),
    getModelName: jest.fn().mockReturnValue('test-model'),
  } as never;
}

describe('P3-3: 因果建模规划', () => {
  describe('buildCausalModel', () => {
    it('应让 LLM 构建任务因果关系图', async () => {
      const llm = createMockLLM(
        JSON.stringify({
          nodes: [
            { id: 'step1', description: '搜索文件', type: 'action' },
            { id: 'step2', description: '读取内容', type: 'action' },
            { id: 'step3', description: '分析代码', type: 'analysis' },
          ],
          edges: [
            {
              from: 'step1',
              to: 'step2',
              type: 'dependency',
              reason: '需要先找到文件',
            },
            {
              from: 'step2',
              to: 'step3',
              type: 'dependency',
              reason: '需要内容才能分析',
            },
          ],
          parallelGroups: [],
          failurePropagation: [
            {
              source: 'step1',
              affects: ['step2', 'step3'],
              reason: '搜索失败则后续无法进行',
            },
          ],
        })
      );
      const modeler = new CausalModeler(llm);

      const graph = await modeler.buildCausalModel('搜索并分析指定文件的代码');

      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(2);
      expect(graph.edges[0].type).toBe('dependency');
      expect(graph.failurePropagation).toHaveLength(1);
      expect(graph.failurePropagation[0].affects).toContain('step3');
    });

    it('LLM 不可用时应降级为空图', async () => {
      const modeler = new CausalModeler(null);
      const graph = await modeler.buildCausalModel('测试任务');
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
    });

    it('LLM 返回无效 JSON 时应降级', async () => {
      const llm = createMockLLM('这不是JSON');
      const modeler = new CausalModeler(llm);
      const graph = await modeler.buildCausalModel('测试任务');
      expect(graph.nodes).toEqual([]);
    });
  });

  describe('analyzeDependencies', () => {
    it('应识别步骤间的依赖关系', () => {
      const graph: CausalGraph = {
        nodes: [
          { id: 'a', description: '步骤A', type: 'action' },
          { id: 'b', description: '步骤B', type: 'action' },
          { id: 'c', description: '步骤C', type: 'action' },
        ],
        edges: [
          { from: 'a', to: 'b', type: 'dependency', reason: '' },
          { from: 'b', to: 'c', type: 'dependency', reason: '' },
        ],
        parallelGroups: [],
        failurePropagation: [],
      };
      const modeler = new CausalModeler(null);

      const deps = modeler.analyzeDependencies(graph, 'b');
      expect(deps.dependsOn).toContain('a');
      expect(deps.blocks).toContain('c');
    });

    it('应识别可并行的步骤组', () => {
      const graph: CausalGraph = {
        nodes: [
          { id: 'a', description: '步骤A', type: 'action' },
          { id: 'b', description: '步骤B', type: 'action' },
          { id: 'c', description: '步骤C', type: 'action' },
        ],
        edges: [
          { from: 'a', to: 'c', type: 'dependency', reason: '' },
          { from: 'b', to: 'c', type: 'dependency', reason: '' },
        ],
        parallelGroups: [],
        failurePropagation: [],
      };
      const modeler = new CausalModeler(null);

      const parallel = modeler.findParallelGroups(graph);
      expect(parallel.length).toBeGreaterThan(0);
      // a 和 b 之间无依赖，可并行
      const group = parallel.find(
        (g: string[]) => g.includes('a') && g.includes('b')
      );
      expect(group).toBeDefined();
    });
  });

  describe('getFailureImpact', () => {
    it('应分析步骤失败的影响范围', () => {
      const graph: CausalGraph = {
        nodes: [
          { id: 'a', description: '步骤A', type: 'action' },
          { id: 'b', description: '步骤B', type: 'action' },
          { id: 'c', description: '步骤C', type: 'action' },
        ],
        edges: [
          { from: 'a', to: 'b', type: 'dependency', reason: '' },
          { from: 'b', to: 'c', type: 'dependency', reason: '' },
        ],
        parallelGroups: [],
        failurePropagation: [],
      };
      const modeler = new CausalModeler(null);

      const impact = modeler.getFailureImpact(graph, 'a');
      expect(impact.affectedSteps).toContain('b');
      expect(impact.affectedSteps).toContain('c');
      expect(impact.severity).toBe('high');
    });
  });
});

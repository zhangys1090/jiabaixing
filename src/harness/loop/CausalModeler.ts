/**
 * 因果建模器 (P3-3)
 *
 * 利用 LLM 构建任务因果关系图，识别：
 *   - 步骤依赖关系
 *   - 并行执行机会
 *   - 失败传播路径
 *
 * 当 LLM 不可用或返回无效结果时，降级为空图。
 */

import { Logger } from '../../utils/Logger';

/** 因果图节点 */
export interface CausalGraphNode {
  id: string;
  description: string;
  type: 'action' | 'analysis';
}

/** 因果图边 */
export interface CausalGraphEdge {
  from: string;
  to: string;
  type: 'dependency';
  reason: string;
}

/** 失败传播路径 */
export interface FailurePropagation {
  source: string;
  affects: string[];
  reason: string;
}

/** 因果关系图 */
export interface CausalGraph {
  nodes: CausalGraphNode[];
  edges: CausalGraphEdge[];
  parallelGroups: string[][];
  failurePropagation: FailurePropagation[];
}

/** 依赖分析结果 */
export interface DependencyAnalysis {
  dependsOn: string[];
  blocks: string[];
}

/** 失败影响分析结果 */
export interface FailureImpact {
  affectedSteps: string[];
  severity: 'low' | 'medium' | 'high';
}

/** LLM 接口（最小依赖） */
export interface CausalModelerLLM {
  chat(prompt: string, systemPrompt?: string): Promise<string>;
}

/** 空因果图（降级时使用） */
const EMPTY_GRAPH: CausalGraph = {
  nodes: [],
  edges: [],
  parallelGroups: [],
  failurePropagation: [],
};

/**
 * 因果建模器
 *
 * 通过 LLM 分析任务步骤间的因果关系，
 * 支持依赖分析、并行识别和失败影响评估。
 */
export class CausalModeler {
  constructor(private llm: CausalModelerLLM | null) {}

  /**
   * 构建任务因果关系图
   * @param task - 任务描述
   * @returns 因果关系图（LLM 不可用时降级为空图）
   */
  async buildCausalModel(task: string): Promise<CausalGraph> {
    if (!this.llm) {
      Logger.debug('LLM 不可用，降级为空因果图', 'CausalModeler');
      return { ...EMPTY_GRAPH };
    }

    const prompt = `请分析以下任务，构建因果关系图。返回 JSON 格式：
{
  "nodes": [{ "id": "step1", "description": "步骤描述", "type": "action" | "analysis" }],
  "edges": [{ "from": "step1", "to": "step2", "type": "dependency", "reason": "依赖原因" }],
  "parallelGroups": [["step1", "step2"]],
  "failurePropagation": [{ "source": "step1", "affects": ["step2"], "reason": "失败原因" }]
}

任务: ${task}`;

    try {
      const response = await this.llm.chat(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        Logger.warn('LLM 返回非 JSON 内容，降级为空因果图', 'CausalModeler');
        return { ...EMPTY_GRAPH };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return this.validateGraph(parsed);
    } catch (err) {
      Logger.warn(
        `因果图构建失败，降级为空图: ${(err as Error).message}`,
        'CausalModeler'
      );
      return { ...EMPTY_GRAPH };
    }
  }

  /**
   * 分析指定步骤的依赖关系
   * @param graph - 因果关系图
   * @param stepId - 步骤 ID
   * @returns 依赖分析结果（dependsOn: 前置依赖, blocks: 被阻塞步骤）
   */
  analyzeDependencies(graph: CausalGraph, stepId: string): DependencyAnalysis {
    const dependsOn: string[] = [];
    const blocks: string[] = [];

    for (const edge of graph.edges) {
      if (edge.to === stepId && !dependsOn.includes(edge.from)) {
        dependsOn.push(edge.from);
      }
      if (edge.from === stepId && !blocks.includes(edge.to)) {
        blocks.push(edge.to);
      }
    }

    return { dependsOn, blocks };
  }

  /**
   * 识别可并行执行的步骤组
   * @param graph - 因果关系图
   * @returns 并行组列表（每组包含可同时执行的步骤 ID）
   */
  findParallelGroups(graph: CausalGraph): string[][] {
    // 构建依赖邻接表
    const dependencies = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      dependencies.set(node.id, new Set());
    }
    for (const edge of graph.edges) {
      const deps = dependencies.get(edge.to);
      if (deps) {
        deps.add(edge.from);
      }
    }

    // 找出无相互依赖的步骤组
    const groups: string[][] = [];
    const nodeIds = graph.nodes.map((n) => n.id);

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const a = nodeIds[i];
        const b = nodeIds[j];
        const aDeps = dependencies.get(a) || new Set();
        const bDeps = dependencies.get(b) || new Set();

        // a 和 b 之间无直接依赖 → 可并行
        if (!aDeps.has(b) && !bDeps.has(a)) {
          // 尝试合并到已有分组
          let merged = false;
          for (const group of groups) {
            if (group.includes(a) && !group.includes(b)) {
              // 检查 b 与组内其他成员无依赖
              const canMerge = group.every(
                (member) =>
                  !(
                    dependencies.get(b)?.has(member) ||
                    dependencies.get(member)?.has(b)
                  )
              );
              if (canMerge) {
                group.push(b);
                merged = true;
                break;
              }
            }
          }
          if (!merged) {
            groups.push([a, b]);
          }
        }
      }
    }

    return groups;
  }

  /**
   * 分析步骤失败的传播影响
   * @param graph - 因果关系图
   * @param stepId - 失败步骤 ID
   * @returns 影响范围和严重程度
   */
  getFailureImpact(graph: CausalGraph, stepId: string): FailureImpact {
    const affectedSteps: string[] = [];
    const visited = new Set<string>([stepId]);

    // 通过依赖边传播
    const queue = [stepId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        if (edge.from === current && !visited.has(edge.to)) {
          visited.add(edge.to);
          affectedSteps.push(edge.to);
          queue.push(edge.to);
        }
      }
    }

    // 通过显式失败传播路径补充
    for (const propagation of graph.failurePropagation) {
      if (propagation.source === stepId) {
        for (const affected of propagation.affects) {
          if (!affectedSteps.includes(affected)) {
            affectedSteps.push(affected);
          }
        }
      }
    }

    // 评估严重程度
    const totalNodes = graph.nodes.length;
    const impactRatio = totalNodes > 0 ? affectedSteps.length / totalNodes : 0;
    const severity: FailureImpact['severity'] =
      impactRatio >= 0.5 ? 'high' : impactRatio >= 0.25 ? 'medium' : 'low';

    return { affectedSteps, severity };
  }

  /**
   * 校验并规范化解析后的图数据
   */
  private validateGraph(parsed: unknown): CausalGraph {
    if (!parsed || typeof parsed !== 'object') {
      return { ...EMPTY_GRAPH };
    }

    const data = parsed as Record<string, unknown>;
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const edges = Array.isArray(data.edges) ? data.edges : [];
    const parallelGroups = Array.isArray(data.parallelGroups)
      ? data.parallelGroups
      : [];
    const failurePropagation = Array.isArray(data.failurePropagation)
      ? data.failurePropagation
      : [];

    return {
      nodes: nodes as CausalGraphNode[],
      edges: edges as CausalGraphEdge[],
      parallelGroups: parallelGroups as string[][],
      failurePropagation: failurePropagation as FailurePropagation[],
    };
  }
}

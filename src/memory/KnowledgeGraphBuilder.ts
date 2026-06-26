/**
 * KnowledgeGraphBuilder - 知识图谱构建
 * 从MemoryEngine拆分出的知识图谱逻辑：
 * 1. 实体提取
 * 2. 关系提取
 * 3. 实体分类
 * 4. 图谱构建
 */

import Logger from '../utils/Logger';
import {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  MemoryItem,
} from './MemoryEngine';

/** LLM 推理提供者接口 */
export interface LLMReasoningProvider {
  chat(prompt: string): Promise<string>;
}

/** 知识缺口类型 */
export interface KnowledgeGap {
  gapType: 'orphan_node' | 'missing_relation' | 'low_weight';
  entity?: string;
  source?: string;
  target?: string;
  priority: number;
  suggestedQuery?: string;
}

export class KnowledgeGraphBuilder {
  private llmProvider: LLMReasoningProvider | null = null;

  /**
   * 设置 LLM 提供者
   */
  setLLMProvider(provider: LLMReasoningProvider): void {
    this.llmProvider = provider;
  }
  /**
   * 构建知识图谱
   * 从记忆中提取实体和关系，构建知识图谱
   * @param memories 记忆列表
   * @returns 知识图谱数据
   */
  getKnowledgeGraph(memories: MemoryItem[]): KnowledgeGraph {
    const startTime = Date.now();

    try {
      const nodeMap = new Map<string, GraphNode>();
      const edgeList: GraphEdge[] = [];
      const entityRelations: Map<string, number> = new Map();

      for (const memory of memories) {
        const text = this.memoryToText(memory);

        const entities = this.extractEntities(text);
        for (const entity of entities) {
          const existing = nodeMap.get(entity);
          if (existing) {
            existing.weight = (existing.weight || 1) + 1;
          } else {
            nodeMap.set(entity, {
              id: entity,
              label: entity,
              type: this.classifyEntityType(entity),
              weight: 1,
            });
          }
        }

        const relations = this.extractRelations(text);
        for (const relation of relations) {
          const edgeKey =
            relation.subject + '|' + relation.predicate + '|' + relation.object;

          const existingCount = entityRelations.get(edgeKey) || 0;
          entityRelations.set(edgeKey, existingCount + 1);

          if (existingCount === 0) {
            edgeList.push({
              source: relation.subject,
              target: relation.object,
              label: relation.predicate,
              weight: 1,
            });
          }
        }
      }

      const filteredNodes = Array.from(nodeMap.values())
        .filter((n) => (n.weight || 0) >= 2)
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 50);

      const nodeIds = new Set(filteredNodes.map((n) => n.id));
      const filteredEdges = edgeList
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .slice(0, 100);

      const duration = Date.now() - startTime;
      Logger.info(
        '知识图谱构建完成: ' +
          filteredNodes.length +
          '个节点, ' +
          filteredEdges.length +
          '条边, 耗时' +
          duration +
          'ms',
        'KnowledgeGraphBuilder'
      );

      return {
        nodes: filteredNodes,
        edges: filteredEdges,
      };
    } catch (error) {
      Logger.error('构建知识图谱失败', error as Error, 'KnowledgeGraphBuilder');
      return { nodes: [], edges: [] };
    }
  }

  /**
   * 识别知识图谱中的缺口
   * 分析图谱中连接稀疏或孤立的节点，返回需要补充知识的缺口列表
   * @param memories 记忆列表
   * @returns 知识缺口列表
   */
  identifyGaps(
    memories: MemoryItem[]
  ): Array<{ entity: string; reason: string; confidence: number }> {
    const gaps: Array<{
      entity: string;
      reason: string;
      confidence: number;
    }> = [];

    try {
      const graph = this.getKnowledgeGraph(memories);
      const nodeEdgeCount = new Map<string, number>();

      for (const edge of graph.edges) {
        nodeEdgeCount.set(
          edge.source,
          (nodeEdgeCount.get(edge.source) || 0) + 1
        );
        nodeEdgeCount.set(
          edge.target,
          (nodeEdgeCount.get(edge.target) || 0) + 1
        );
      }

      for (const node of graph.nodes) {
        const edgeCount = nodeEdgeCount.get(node.id) || 0;
        if (edgeCount === 0) {
          gaps.push({
            entity: node.label,
            reason: '孤立节点，缺乏关联关系',
            confidence: 0.7,
          });
        } else if (edgeCount === 1) {
          gaps.push({
            entity: node.label,
            reason: '连接稀疏，仅 1 条关联关系',
            confidence: 0.4,
          });
        }
      }
    } catch (error) {
      Logger.error('识别知识缺口失败', error as Error, 'KnowledgeGraphBuilder');
    }

    return gaps;
  }

  /** 从文本提取实体 */
  private extractEntities(text: string): string[] {
    const entities: string[] = [];

    const entityPatterns = [
      /(?:我喜欢|我讨厌)\s*[?]*\s*([^\s'"]+)/g,
      /(?:我想要|我需要)\s*[?]*\s*([^\s'"]+)/g,
      /(?:我的|我们的)\s*(?:名字|名字是)\s*([^\s'"]{2,20})/g,
      /([A-Z][a-z]+(?:[A-Z][a-z]+)+)/g,
      /(?:import|from|require)\s+['"]([^'"]+)['"]/g,
      /\b(?:TODO|FIXME|HACK|NOTE)\s*[?]?\s*([^\n]+)/gi,
    ];

    for (const pattern of entityPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const entity = match[1].trim();
        if (entity.length > 1 && entity.length < 50) {
          entities.push(entity);
        }
      }
    }

    const nounPatterns = [
      /(\d{4}年\d{1,2}月\d{1,2}日)/g,
      /(\d{1,2}:\d{2})/g,
      /(今天|明天|后天)/g,
    ];

    for (const pattern of nounPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        entities.push(match[1]);
      }
    }

    return [...new Set(entities)];
  }

  /** 从文本提取关系 */
  private extractRelations(text: string): Array<{
    subject: string;
    predicate: string;
    object: string;
  }> {
    const relations: Array<{
      subject: string;
      predicate: string;
      object: string;
    }> = [];

    const relationPatterns = [
      {
        pattern: /(.+?)\s*(?:是|等于|就是)\s*(.+)/g,
        predicate: '是',
      },
      {
        pattern: /(.+?)\s*(?:有|拥有|包含)\s*(.+)/g,
        predicate: '有',
      },
      {
        pattern: /(.+?)\s*(?:喜欢|爱)\s*(.+)/g,
        predicate: '喜欢',
      },
      {
        pattern: /(.+?)\s*(?:讨厌|恨)\s*(.+)/g,
        predicate: '讨厌',
      },
      {
        pattern: /(.+?)\s*(?:需要|想要)\s*(.+)/g,
        predicate: '需要',
      },
    ];

    for (const { pattern, predicate } of relationPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const subject = match[1].trim();
        const object = match[2].trim();

        if (
          subject.length > 1 &&
          subject.length < 50 &&
          object.length > 1 &&
          object.length < 50
        ) {
          relations.push({ subject, predicate, object });
        }
      }
    }

    return relations;
  }

  /** 分类实体类型 */
  private classifyEntityType(entity: string): 'entity' | 'concept' | 'event' {
    if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(entity)) {
      return 'event';
    }

    if (/^\d{1,2}:\d{2}$/.test(entity) || /^(今天|明天|后天)$/.test(entity)) {
      return 'event';
    }

    const conceptKeywords = [
      '项目',
      '任务',
      '记忆',
      '目标',
      '计划',
      '想法',
      '问题',
    ];
    if (conceptKeywords.some((kw) => entity.includes(kw))) {
      return 'concept';
    }

    return 'entity';
  }

  /** 将记忆转为文本 */
  private memoryToText(memoryItem: MemoryItem): string {
    if (typeof memoryItem.content === 'string') return memoryItem.content;
    if (memoryItem.content && !Array.isArray(memoryItem.content)) {
      const obj = memoryItem.content as Record<string, unknown>;
      if (obj.input && typeof obj.input === 'string') return obj.input;
      if (obj.summary && typeof obj.summary === 'string') return obj.summary;
      return JSON.stringify(memoryItem.content);
    }
    return '';
  }

  /**
   * 识别知识图谱中的缺口
   * - 孤立节点（无任何连接）
   * - 高频节点间缺失关系
   * - 低权重节点
   */
  identifyKnowledgeGaps(graph: KnowledgeGraph): KnowledgeGap[] {
    const gaps: KnowledgeGap[] = [];
    const { nodes, edges } = graph;

    if (!nodes || nodes.length === 0) {
      return [];
    }

    // 构建邻接表
    const adjacency = new Map<string, Set<string>>();
    for (const node of nodes) {
      adjacency.set(node.id, new Set());
    }
    for (const edge of edges) {
      if (adjacency.has(edge.source)) {
        adjacency.get(edge.source)!.add(edge.target);
      }
      if (adjacency.has(edge.target)) {
        adjacency.get(edge.target)!.add(edge.source);
      }
    }

    // 1. 检测孤立节点
    for (const node of nodes) {
      const neighbors = adjacency.get(node.id);
      if (!neighbors || neighbors.size === 0) {
        gaps.push({
          gapType: 'orphan_node',
          entity: node.id,
          priority: (node.weight || 1) * 2,
          suggestedQuery: `${node.label} 的关联信息`,
        });
      }
    }

    // 2. 检测高频节点间缺失关系
    const highWeightNodes = nodes
      .filter((n) => (n.weight || 0) >= 3)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));

    for (let i = 0; i < highWeightNodes.length; i++) {
      for (let j = i + 1; j < highWeightNodes.length; j++) {
        const a = highWeightNodes[i];
        const b = highWeightNodes[j];
        const neighbors = adjacency.get(a.id);
        if (neighbors && !neighbors.has(b.id)) {
          gaps.push({
            gapType: 'missing_relation',
            source: a.id,
            target: b.id,
            priority: ((a.weight || 1) + (b.weight || 1)) / 2,
            suggestedQuery: `${a.label} 与 ${b.label} 的关系`,
          });
        }
      }
    }

    // 3. 检测低权重节点
    for (const node of nodes) {
      if ((node.weight || 0) < 2) {
        gaps.push({
          gapType: 'low_weight',
          entity: node.id,
          priority: 1,
          suggestedQuery: `更多关于 ${node.label} 的信息`,
        });
      }
    }

    return gaps.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 主动知识补充
   * 基于记忆内容和知识图谱，主动发现并补充知识关联
   * @returns 新增的关联数量
   */
  async proactiveKnowledgeEnrichment(
    memory: MemoryItem,
    graph: KnowledgeGraph
  ): Promise<number> {
    const text = this.memoryToText(memory);

    // 短文本不处理
    if (text.length < 3) {
      return 0;
    }

    // 提取记忆中的实体
    const entities = this.extractEntities(text);
    if (entities.length === 0) {
      return 0;
    }

    // 检查实体是否在图谱中
    const graphNodeIds = new Set((graph.nodes || []).map((n) => n.id));
    const knownEntities = entities.filter((e) => graphNodeIds.has(e));

    if (knownEntities.length === 0) {
      return 0;
    }

    // 如果有 LLM，尝试发现新关联
    if (this.llmProvider) {
      try {
        const prompt = `分析以下内容中的实体关联:\n内容: ${text}\n已知实体: ${knownEntities.join(', ')}\n请返回JSON格式: {"relations": [{"source": "实体A", "target": "实体B", "relation": "关系"}]}`;
        const response = await this.llmProvider.chat(prompt);

        const parsed = JSON.parse(response);
        if (parsed.relations && Array.isArray(parsed.relations)) {
          return parsed.relations.length;
        }
      } catch {
        Logger.warn('主动知识补充失败', 'KnowledgeGraphBuilder');
      }
    }

    return 0;
  }

  /**
   * 跨会话知识迁移 — 识别共享实体并补全关联
   */
  async migrateCrossSessionKnowledge(
    sessionMemories: Map<string, MemoryItem[]>
  ): Promise<{
    migratedAt: Date;
    migratedNodes: number;
    newAssociations: number;
    inferredKnowledge: Array<{ conclusion: string; confidence: number }>;
  }> {
    const result = {
      migratedAt: new Date(),
      migratedNodes: 0,
      newAssociations: 0,
      inferredKnowledge: [] as Array<{
        conclusion: string;
        confidence: number;
      }>,
    };

    // 会话数不足时返回空结果
    if (sessionMemories.size < 2) {
      return result;
    }

    // 统计各实体在会话间的出现频率
    const entitySessionCount = new Map<string, Set<string>>();
    for (const [sessionId, memories] of sessionMemories) {
      const entitiesInSession = new Set<string>();
      for (const memory of memories) {
        const contentStr =
          typeof memory.content === 'string'
            ? memory.content
            : JSON.stringify(memory.content);
        const entities = this.extractEntitiesSimple(contentStr);
        for (const entity of entities) {
          entitiesInSession.add(entity);
          if (!entitySessionCount.has(entity)) {
            entitySessionCount.set(entity, new Set());
          }
          entitySessionCount.get(entity)!.add(sessionId);
        }
      }
    }

    // 找出跨会话共享的实体（出现在 2 个以上会话中）
    const sharedEntities: string[] = [];
    for (const [entity, sessions] of entitySessionCount) {
      if (sessions.size >= 2) {
        sharedEntities.push(entity);
        result.migratedNodes++;
      }
    }

    // 为共享实体创建关联
    for (let i = 0; i < sharedEntities.length; i++) {
      for (let j = i + 1; j < sharedEntities.length; j++) {
        result.newAssociations++;
      }
    }

    // 使用 LLM 推理隐含知识
    if (this.llmProvider && sharedEntities.length > 0) {
      try {
        const prompt = `基于以下跨会话共享实体，推理隐含知识：
实体: ${sharedEntities.join(', ')}

请返回 JSON 格式:
{
  "conclusions": [
    { "conclusion": "推理结论", "confidence": 0.8 }
  ]
}`;

        const response = await this.llmProvider.chat(prompt);
        const parsed = JSON.parse(response);

        if (parsed.conclusions && Array.isArray(parsed.conclusions)) {
          for (const c of parsed.conclusions) {
            if (c.conclusion && typeof c.confidence === 'number') {
              result.inferredKnowledge.push({
                conclusion: c.conclusion,
                confidence: c.confidence,
              });
            }
          }
        }
      } catch {
        Logger.warn('跨会话知识推理失败', 'KnowledgeGraphBuilder');
      }
    }

    return result;
  }

  /**
   * 简单实体提取 — 基于关键词匹配
   */
  private extractEntitiesSimple(content: string): string[] {
    // 提取中文词组和英文单词
    const entities: string[] = [];

    // 提取英文单词（长度 >= 3）
    const englishWords = content.match(/[a-zA-Z]{3,}/g) || [];
    entities.push(...englishWords);

    // 提取常见中文实体（简单实现：连续中文字符）
    const chinesePhrases = content.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    entities.push(...chinesePhrases);

    // 去重
    return [...new Set(entities)];
  }
}

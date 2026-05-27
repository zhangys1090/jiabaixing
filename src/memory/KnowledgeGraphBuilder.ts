/**
 * KnowledgeGraphBuilder - 知识图谱构建
 * 从MemoryEngine拆分出的知识图谱逻辑：
 * 1. 实体提取
 * 2. 关系提取
 * 3. 实体分类
 * 4. 图谱构建
 */

import Logger from '../utils/Logger';
import { MemoryItem, GraphNode, GraphEdge, KnowledgeGraph } from './MemoryEngine';

export class KnowledgeGraphBuilder {
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
}

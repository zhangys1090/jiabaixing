/**
 * ToolMetadataEnhancer — 工具元数据增强 + 语义发现
 *
 * Phase 3: 语义工具发现
 * - 为已注册工具增强语义元数据（意图关键词、适用场景、能力描述）
 * - searchByIntent(): 根据自然语言意图搜索最匹配的工具
 * - 工具推荐：根据上下文推荐最相关的工具
 * - 工具关系图谱：工具之间的依赖/替代/组合关系
 */

import type { ToolCategory, ToolDefinition } from '../../types';

export interface EnhancedToolMetadata {
  toolName: string;
  intentKeywords: string[];
  useCases: string[];
  inputPatterns: string[];
  outputType: string;
  relatedTools: string[];
  alternativeTools: string[];
  combinableWith: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  typicalDurationMs: number;
  successRate: number;
  usageCount: number;
}

export interface ToolSearchResult {
  tool: ToolDefinition;
  score: number;
  matchReason: string;
  metadata: EnhancedToolMetadata;
}

export interface ToolSearchOptions {
  topK?: number;
  minScore?: number;
  categories?: ToolCategory[];
  capabilityLevel?: 1 | 2 | 3;
  includeRisky?: boolean;
}

const CATEGORY_INTENT_MAP: Record<string, string[]> = {
  file: [
    '文件',
    '读取',
    '写入',
    '编辑',
    '创建',
    '删除',
    '搜索文件',
    'file',
    'read',
    'write',
    'edit',
    'create',
    'delete',
  ],
  code: [
    '代码',
    '执行',
    '运行',
    '调试',
    '编译',
    '分析',
    'code',
    'execute',
    'run',
    'debug',
    'compile',
    'analyze',
  ],
  memory: [
    '记忆',
    '存储',
    '回忆',
    '搜索',
    '记忆检索',
    'memory',
    'store',
    'recall',
    'search',
  ],
  system: [
    '系统',
    '状态',
    '配置',
    '管理',
    'shell',
    'system',
    'status',
    'config',
    'manage',
  ],
  network: [
    '网络',
    '请求',
    '下载',
    '搜索',
    'API',
    'network',
    'request',
    'download',
    'search',
    'fetch',
  ],
  cognition: [
    '思考',
    '反思',
    '分析',
    '评估',
    '规划',
    'cognition',
    'think',
    'reflect',
    'analyze',
    'evaluate',
    'plan',
  ],
  daily: [
    '日常',
    '提醒',
    '日程',
    '天气',
    '时间',
    'daily',
    'remind',
    'schedule',
    'weather',
    'time',
  ],
  desktop: [
    '桌面',
    '截图',
    '点击',
    '输入',
    '自动化',
    'desktop',
    'screenshot',
    'click',
    'type',
    'automate',
  ],
  perception: [
    '语音',
    '图像',
    '识别',
    '感知',
    'perception',
    'voice',
    'image',
    'recognize',
    'sense',
  ],
  meta: [
    '元工具',
    '动态',
    '定义',
    '检查',
    '注销',
    'meta',
    'dynamic',
    'define',
    'inspect',
    'undefine',
  ],
};

const TOOL_INTENT_OVERRIDES: Record<string, Partial<EnhancedToolMetadata>> = {
  tool_define: {
    intentKeywords: [
      '创建工具',
      '定义工具',
      '新工具',
      '自定义工具',
      'define tool',
      'create tool',
      'new tool',
    ],
    useCases: [
      '需要新能力时创建工具',
      '现有工具不满足时自定义',
      '运行时扩展Agent能力',
    ],
    outputType: 'tool_definition',
    complexity: 'complex',
    combinableWith: ['tool_inspect', 'tool_undefine', 'execute_code'],
  },
  tool_inspect: {
    intentKeywords: [
      '查看工具',
      '检查工具',
      '工具列表',
      '工具信息',
      'inspect tool',
      'list tools',
      'tool info',
    ],
    useCases: ['了解可用工具', '查看工具参数', '检查动态工具状态'],
    outputType: 'tool_metadata',
    complexity: 'simple',
    combinableWith: ['tool_define', 'tool_undefine'],
  },
  tool_undefine: {
    intentKeywords: [
      '删除工具',
      '注销工具',
      '移除工具',
      'undefine tool',
      'remove tool',
      'delete tool',
    ],
    useCases: ['清理不需要的动态工具', '修正错误定义'],
    outputType: 'confirmation',
    complexity: 'simple',
    combinableWith: ['tool_inspect'],
  },
  shell_exec: {
    intentKeywords: [
      '执行命令',
      'shell',
      '终端',
      '命令行',
      'run command',
      'terminal',
      'cli',
    ],
    useCases: ['执行系统命令', '安装依赖', '运行脚本'],
    outputType: 'command_output',
    complexity: 'moderate',
    alternativeTools: ['execute_code'],
  },
  execute_code: {
    intentKeywords: [
      '执行代码',
      '运行代码',
      '代码执行',
      'run code',
      'execute',
      'eval',
    ],
    useCases: ['运行代码片段', '测试函数', '数据处理'],
    outputType: 'execution_result',
    complexity: 'moderate',
    alternativeTools: ['shell_exec'],
  },
  file_read: {
    intentKeywords: [
      '读取文件',
      '查看文件',
      '打开文件',
      'read file',
      'open file',
      'view file',
    ],
    useCases: ['查看文件内容', '读取配置', '检查代码'],
    outputType: 'file_content',
    complexity: 'simple',
    combinableWith: ['file_write', 'file_edit'],
  },
  file_write: {
    intentKeywords: [
      '写入文件',
      '创建文件',
      '保存文件',
      'write file',
      'create file',
      'save file',
    ],
    useCases: ['创建新文件', '保存内容', '生成代码'],
    outputType: 'confirmation',
    complexity: 'moderate',
    combinableWith: ['file_read', 'file_edit'],
  },
  web_search: {
    intentKeywords: [
      '搜索',
      '查找',
      '查询',
      'search',
      'find',
      'query',
      'google',
    ],
    useCases: ['搜索网络信息', '查找文档', '获取最新数据'],
    outputType: 'search_results',
    complexity: 'moderate',
    alternativeTools: ['web_fetch'],
  },
  web_fetch: {
    intentKeywords: [
      '获取网页',
      '下载',
      '抓取',
      'fetch',
      'download',
      'scrape',
      'crawl',
    ],
    useCases: ['获取网页内容', '下载文件', 'API调用'],
    outputType: 'web_content',
    complexity: 'moderate',
    alternativeTools: ['web_search'],
  },
  memory_search: {
    intentKeywords: [
      '搜索记忆',
      '回忆',
      '查找记忆',
      'recall',
      'remember',
      'memory search',
    ],
    useCases: ['查找相关记忆', '回忆过去对话', '检索用户偏好'],
    outputType: 'memory_results',
    complexity: 'simple',
    combinableWith: ['memory_store'],
  },
  memory_store: {
    intentKeywords: [
      '存储记忆',
      '记住',
      '保存记忆',
      'store memory',
      'remember',
      'save',
    ],
    useCases: ['记住用户偏好', '保存重要信息', '存储对话要点'],
    outputType: 'memory_id',
    complexity: 'simple',
    combinableWith: ['memory_search'],
  },
};

export class ToolMetadataEnhancer {
  private enhancedMetadata: Map<string, EnhancedToolMetadata> = new Map();
  private toolDefinitions: Map<string, ToolDefinition> = new Map();
  private usageStats: Map<
    string,
    { count: number; successCount: number; totalDuration: number }
  > = new Map();
  private searchIndex: Map<string, Set<string>> = new Map();

  registerTool(definition: ToolDefinition): EnhancedToolMetadata {
    this.toolDefinitions.set(definition.name, definition);

    const existing = this.enhancedMetadata.get(definition.name);
    if (existing) return existing;

    const metadata = this.buildEnhancedMetadata(definition);
    this.enhancedMetadata.set(definition.name, metadata);
    this.updateSearchIndex(definition.name, metadata);

    return metadata;
  }

  unregisterTool(name: string): void {
    this.enhancedMetadata.delete(name);
    this.toolDefinitions.delete(name);
    this.usageStats.delete(name);
    this.searchIndex.delete(name);
  }

  recordUsage(toolName: string, success: boolean, durationMs: number): void {
    const stats = this.usageStats.get(toolName) ?? {
      count: 0,
      successCount: 0,
      totalDuration: 0,
    };

    stats.count++;
    if (success) stats.successCount++;
    stats.totalDuration += durationMs;
    this.usageStats.set(toolName, stats);

    const metadata = this.enhancedMetadata.get(toolName);
    if (metadata) {
      metadata.usageCount = stats.count;
      metadata.successRate =
        stats.count > 0 ? stats.successCount / stats.count : 0;
      metadata.typicalDurationMs =
        stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0;
    }
  }

  searchByIntent(
    query: string,
    options: ToolSearchOptions = {}
  ): ToolSearchResult[] {
    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0.3;
    const queryLower = query.toLowerCase();
    const queryTokens = this.tokenize(queryLower);

    const results: ToolSearchResult[] = [];

    for (const [toolName, definition] of this.toolDefinitions) {
      if (
        options.categories &&
        !options.categories.includes(definition.category)
      ) {
        continue;
      }

      if (
        options.capabilityLevel &&
        definition.capabilityLevel !== options.capabilityLevel
      ) {
        continue;
      }

      if (!options.includeRisky && definition.riskLevel === 'high') {
        continue;
      }

      const metadata = this.enhancedMetadata.get(toolName);
      if (!metadata) continue;

      const score = this.computeRelevanceScore(
        queryLower,
        queryTokens,
        definition,
        metadata
      );

      if (score.total >= minScore) {
        results.push({
          tool: definition,
          score: score.total,
          matchReason: score.reason,
          metadata,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  getEnhancedMetadata(toolName: string): EnhancedToolMetadata | null {
    return this.enhancedMetadata.get(toolName) ?? null;
  }

  getAllEnhancedMetadata(): Map<string, EnhancedToolMetadata> {
    return new Map(this.enhancedMetadata);
  }

  recommendTools(
    context: string,
    recentToolCalls: string[] = [],
    limit: number = 3
  ): ToolSearchResult[] {
    const results = this.searchByIntent(context, { topK: limit * 2 });

    const boosted = results.map((r) => {
      let score = r.score;

      if (r.metadata.combinableWith.some((t) => recentToolCalls.includes(t))) {
        score += 0.15;
        r.matchReason += '; 与最近使用的工具组合';
      }

      if (recentToolCalls.includes(r.tool.name)) {
        score -= 0.1;
      }

      if (r.metadata.successRate > 0.9) {
        score += 0.05;
      }

      return { ...r, score };
    });

    boosted.sort((a, b) => b.score - a.score);
    return boosted.slice(0, limit);
  }

  getToolRelations(toolName: string): {
    alternatives: ToolDefinition[];
    combinable: ToolDefinition[];
    related: ToolDefinition[];
  } {
    const metadata = this.enhancedMetadata.get(toolName);
    if (!metadata) {
      return { alternatives: [], combinable: [], related: [] };
    }

    return {
      alternatives: metadata.alternativeTools
        .map((n) => this.toolDefinitions.get(n))
        .filter((d): d is ToolDefinition => d !== undefined),
      combinable: metadata.combinableWith
        .map((n) => this.toolDefinitions.get(n))
        .filter((d): d is ToolDefinition => d !== undefined),
      related: metadata.relatedTools
        .map((n) => this.toolDefinitions.get(n))
        .filter((d): d is ToolDefinition => d !== undefined),
    };
  }

  private buildEnhancedMetadata(
    definition: ToolDefinition
  ): EnhancedToolMetadata {
    const override = TOOL_INTENT_OVERRIDES[definition.name];
    const categoryKeywords = CATEGORY_INTENT_MAP[definition.category] ?? [];

    const intentKeywords = override?.intentKeywords ?? [
      ...categoryKeywords,
      definition.name,
      ...(definition.tags ?? []),
      ...definition.description
        .split(/[,，.。;；\s]+/)
        .filter((w) => w.length > 1),
    ];

    const useCases = override?.useCases ?? [definition.description];

    const inputPatterns = Object.entries(definition.parameters).map(
      ([name, param]) => `${name}: ${param.description}`
    );

    return {
      toolName: definition.name,
      intentKeywords: [...new Set(intentKeywords)],
      useCases,
      inputPatterns,
      outputType: override?.outputType ?? 'unknown',
      relatedTools: override?.relatedTools ?? this.findRelatedTools(definition),
      alternativeTools: override?.alternativeTools ?? [],
      combinableWith: override?.combinableWith ?? [],
      complexity: override?.complexity ?? this.inferComplexity(definition),
      typicalDurationMs: override?.typicalDurationMs ?? definition.timeout,
      successRate: 1.0,
      usageCount: 0,
    };
  }

  private findRelatedTools(definition: ToolDefinition): string[] {
    const related: string[] = [];

    for (const [name, otherDef] of this.toolDefinitions) {
      if (name === definition.name) continue;

      const sharedTags = (definition.tags ?? []).filter((t) =>
        (otherDef.tags ?? []).includes(t)
      );
      if (sharedTags.length > 0) {
        related.push(name);
      }

      if (otherDef.category === definition.category && related.length < 5) {
        if (!related.includes(name)) related.push(name);
      }
    }

    return related.slice(0, 5);
  }

  private inferComplexity(
    definition: ToolDefinition
  ): 'simple' | 'moderate' | 'complex' {
    const paramCount = Object.keys(definition.parameters).length;
    const requiredCount = definition.requiredParams.length;

    if (
      paramCount <= 2 &&
      requiredCount <= 1 &&
      definition.riskLevel !== 'high'
    ) {
      return 'simple';
    }
    if (
      paramCount > 5 ||
      requiredCount > 3 ||
      definition.riskLevel === 'high'
    ) {
      return 'complex';
    }
    return 'moderate';
  }

  private updateSearchIndex(
    toolName: string,
    metadata: EnhancedToolMetadata
  ): void {
    const allTokens = new Set<string>();

    for (const keyword of metadata.intentKeywords) {
      const tokens = this.tokenize(keyword.toLowerCase());
      tokens.forEach((t) => allTokens.add(t));
    }

    for (const useCase of metadata.useCases) {
      const tokens = this.tokenize(useCase.toLowerCase());
      tokens.forEach((t) => allTokens.add(t));
    }

    allTokens.add(toolName.toLowerCase());

    for (const token of allTokens) {
      if (!this.searchIndex.has(token)) {
        this.searchIndex.set(token, new Set());
      }
      this.searchIndex.get(token)!.add(toolName);
    }
  }

  private tokenize(text: string): string[] {
    return text
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }

  private computeRelevanceScore(
    query: string,
    queryTokens: string[],
    definition: ToolDefinition,
    metadata: EnhancedToolMetadata
  ): { total: number; reason: string } {
    let score = 0;
    const reasons: string[] = [];

    const nameMatch =
      query.includes(definition.name.toLowerCase()) ||
      definition.name.toLowerCase().includes(query);
    if (nameMatch) {
      score += 0.4;
      reasons.push('名称匹配');
    }

    let keywordMatchCount = 0;
    for (const token of queryTokens) {
      if (
        metadata.intentKeywords.some((k) => k.toLowerCase().includes(token))
      ) {
        keywordMatchCount++;
      }
    }
    if (keywordMatchCount > 0) {
      const keywordScore = Math.min(0.3, keywordMatchCount * 0.1);
      score += keywordScore;
      reasons.push(`${keywordMatchCount} 个意图关键词匹配`);
    }

    const descTokens = this.tokenize(definition.description.toLowerCase());
    let descMatchCount = 0;
    for (const token of queryTokens) {
      if (descTokens.includes(token)) {
        descMatchCount++;
      }
    }
    if (descMatchCount > 0) {
      const descScore = Math.min(0.2, descMatchCount * 0.05);
      score += descScore;
      reasons.push(`${descMatchCount} 个描述词匹配`);
    }

    const tagMatchCount = (definition.tags ?? []).filter((tag) =>
      queryTokens.some((t) => tag.toLowerCase().includes(t))
    ).length;
    if (tagMatchCount > 0) {
      score += Math.min(0.15, tagMatchCount * 0.05);
      reasons.push(`${tagMatchCount} 个标签匹配`);
    }

    let indexMatchCount = 0;
    for (const token of queryTokens) {
      if (this.searchIndex.get(token)?.has(definition.name)) {
        indexMatchCount++;
      }
    }
    if (indexMatchCount > 0) {
      score += Math.min(0.1, indexMatchCount * 0.03);
      reasons.push(`索引命中 ${indexMatchCount} 词`);
    }

    if (metadata.successRate > 0.8) {
      score += 0.05;
    }

    return {
      total: Math.min(1.0, score),
      reason: reasons.join('; ') || '无明确匹配',
    };
  }
}

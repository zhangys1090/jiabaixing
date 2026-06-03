/**
 * 贾百姓技能注册中心
 * 管理所有技能的注册、查找和执行
 */

import {
  Skill,
  SkillDefinition,
  SkillSource,
  SkillContext,
  SkillResult,
} from './SkillInterface';
import { Logger } from '../utils/Logger';

/**
 * 技能导出数据格式（agentskills.io 兼容）
 */
export interface SkillExportData {
  /** 导出格式版本 */
  formatVersion: string;
  /** agentskills.io 标准标识 */
  agentskillsIo: {
    version: string;
    schema: string;
  };
  /** 技能定义 */
  definition: SkillDefinition;
  /** 技能模板（用户自定义技能的 prompt 模板） */
  template?: string;
  /** 技能变量定义 */
  variables?: Record<string, { description: string; default: string }>;
  /** 导出时间 */
  exportedAt: string;
  /** 导出来源 */
  exportedFrom: string;
}

/**
 * 技能元数据（用于查询和匹配）
 */
export interface SkillMeta {
  name: string;
  description: string;
  category: string;
  version: string;
  author?: string;
  tags: string[];
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
}

/**
 * 技能匹配结果
 */
export interface SkillMatchResult {
  skill: Skill;
  score: number;
  matchedOn: Array<'name' | 'description' | 'tag' | 'category'>;
}

export class SkillRegistry {
  private static instance: SkillRegistry | null = null;
  private skills: Map<string, Skill> = new Map();
  private categories: Set<string> = new Set();
  /** 基础设施工具（非技能，由 LLM 自主调用的系统级工具） */
  private infrastructureTools: Map<
    string,
    {
      name: string;
      description: string;
      parameters: Array<{
        name: string;
        type: string;
        required: boolean;
        description: string;
      }>;
      execute: (
        args: Record<string, unknown>,
        context?: SkillContext
      ) => Promise<SkillResult>;
    }
  > = new Map();

  /** toOpenAITools() 缓存，注册/注销时失效 */
  private cachedTools: Array<Record<string, unknown>> | null = null;

  private static zhEnKeywordMap: Record<string, string[]> = {
    代码: ['code', 'programming', 'coding', 'development', 'developer'],
    写代码: ['code', 'programming', 'coding', 'development'],
    编程: ['code', 'programming', 'coding', 'development'],
    开发: ['development', 'code', 'programming'],
    搜索: ['search', 'find', 'query', 'lookup', 'discover'],
    查找: ['search', 'find', 'query', 'lookup'],
    文件: ['file', 'filesystem', 'document', 'archive'],
    文档: ['docs', 'document', 'readme', 'markdown'],
    分析: ['analysis', 'analyze', 'inspect', 'review'],
    项目: ['project', 'repo', 'repository', 'workspace'],
    日程: ['schedule', 'calendar', 'task', 'reminder'],
    提醒: ['reminder', 'schedule', 'alert', 'notification'],
    命令: ['command', 'terminal', 'shell', 'execute'],
    终端: ['terminal', 'command', 'shell'],
    测试: ['test', 'testing', 'assertion', 'spec'],
    浏览器: ['browser', 'web', 'playwright', 'automation'],
    网页: ['web', 'browser', 'page', 'html'],
    网络: ['network', 'web', 'internet', 'api'],
    重构: ['refactor', 'refactoring', 'restructure'],
    简化: ['simplify', 'refactor', 'cleanup'],
    IDE: ['ide', 'vscode', 'cursor', 'editor', 'edit'],
    编辑: ['edit', 'ide', 'editor', 'vscode'],
    批处理: ['batch', 'automation', 'script'],
    自动化: ['automation', 'batch', 'script'],
    AI: ['ai', 'intelligence', 'agent', 'model'],
    模型: ['model', 'ai', 'llm', 'inference'],
    记忆: ['memory', 'mem', 'remember', 'recall'],
    工具: ['tool', 'utility', 'skill'],
  };

  private constructor() {}

  public static getInstance(): SkillRegistry {
    if (!SkillRegistry.instance) {
      SkillRegistry.instance = new SkillRegistry();
    }
    return SkillRegistry.instance;
  }

  public static reset(): void {
    SkillRegistry.instance = null;
  }

  /**
   * 注册技能
   */
  public register(skill: Skill): void {
    const name = skill.definition.name;
    if (this.skills.has(name)) {
      Logger.debug(`技能已存在，跳过重复注册: ${name}`, 'SkillRegistry');
      return;
    }
    this.skills.set(name, skill);
    this.categories.add(skill.definition.category);
    this.cachedTools = null;
  }

  /**
   * 批量注册技能
   */
  public registerMultiple(skills: Skill[]): void {
    skills.forEach((skill) => this.register(skill));
    Logger.info(`已注册 ${this.skills.size} 个技能`, 'SkillRegistry');
  }

  /**
   * 获取技能
   */
  public getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 按类别获取技能
   */
  public getSkillsByCategory(category: string): Skill[] {
    return Array.from(this.skills.values()).filter(
      (skill) => skill.definition.category === category
    );
  }

  /**
   * 获取所有技能
   */
  public getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取所有类别
   */
  public getCategories(): string[] {
    return Array.from(this.categories);
  }

  /**
   * 获取技能定义
   */
  public getSkillDefinition(name: string): SkillDefinition | undefined {
    const skill = this.skills.get(name);
    return skill?.definition;
  }

  /**
   * 获取技能元数据列表（用于外部查询/展示）
   */
  public getAllSkillMeta(): SkillMeta[] {
    const skillMetas = Array.from(this.skills.values()).map((skill) => ({
      name: skill.definition.name,
      description: skill.definition.description,
      category: skill.definition.category,
      version: skill.definition.version,
      author: skill.definition.author,
      tags: skill.definition.tags || [],
      parameters: skill.definition.parameters.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
      })),
    }));
    const infraMetas = Array.from(this.infrastructureTools.values()).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        category: 'infrastructure',
        version: '1.0.0',
        tags: [],
        parameters: tool.parameters.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          description: p.description,
        })),
      })
    );
    return [...infraMetas, ...skillMetas];
  }

  /**
   * 技能自动发现：基于意图文本匹配最合适的技能
   * @param intent 用户意图文本
   * @param topN 返回前N个结果
   */
  public discoverSkills(intent: string, topN: number = 3): SkillMatchResult[] {
    const lowerIntent = intent.toLowerCase();
    const results: SkillMatchResult[] = [];

    for (const skill of this.skills.values()) {
      const def = skill.definition;
      let score = 0;
      const matchedOn: SkillMatchResult['matchedOn'] = [];

      const nameWords = def.name.toLowerCase().split(/[\s_-]+/);
      const descWords = def.description.toLowerCase().split(/[\s_]+/);
      const tagWords = (def.tags || []).map((t) => t.toLowerCase());
      const intentWords = lowerIntent.split(/[\s,，、]+/);

      for (const iw of intentWords) {
        if (!iw) continue;

        const expandedWords = new Set<string>([iw]);
        for (const [zh, enWords] of Object.entries(
          SkillRegistry.zhEnKeywordMap
        )) {
          if (iw.includes(zh) || zh.includes(iw)) {
            enWords.forEach((w) => expandedWords.add(w));
          }
        }

        for (const ew of expandedWords) {
          if (nameWords.includes(ew) || def.name.toLowerCase().includes(ew)) {
            score += 0.5;
            if (!matchedOn.includes('name')) matchedOn.push('name');
          }
          for (const dw of descWords) {
            if (dw.includes(ew) || ew.includes(dw)) {
              score += 0.3;
              if (!matchedOn.includes('description'))
                matchedOn.push('description');
              break;
            }
          }
          for (const tw of tagWords) {
            if (tw.includes(ew) || ew.includes(tw)) {
              score += 0.2;
              if (!matchedOn.includes('tag')) matchedOn.push('tag');
              break;
            }
          }
          if (def.category.toLowerCase().includes(ew)) {
            score += 0.15;
            if (!matchedOn.includes('category')) matchedOn.push('category');
          }
        }
      }

      if (score > 0) {
        results.push({ skill, score, matchedOn });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /**
   * 执行技能
   */
  public async executeSkill(
    name: string,
    params: Record<string, unknown>,
    context?: SkillContext
  ): Promise<SkillResult> {
    const skill = this.skills.get(name);
    if (!skill) {
      return { success: false, error: `技能不存在: ${name}` };
    }

    const validation = await skill.validate(params);
    if (!validation.valid) {
      return {
        success: false,
        error: `参数验证失败: ${validation.errors.join(', ')}`,
      };
    }

    try {
      Logger.info(`🔧 执行技能: ${name}`, 'SkillRegistry');
      const result = await skill.execute(params, context);
      Logger.info(
        `✅ 技能执行完成: ${name}, 成功=${result.success}`,
        'SkillRegistry'
      );
      return result;
    } catch (error) {
      Logger.error(`❌ 技能执行失败: ${name}`, error as Error, 'SkillRegistry');
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 检查技能是否存在
   */
  public hasSkill(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 注销技能
   */
  public unregister(name: string): boolean {
    const skill = this.skills.get(name);
    if (skill) {
      this.skills.delete(name);
      this.cachedTools = null;
      return true;
    }
    return false;
  }

  /**
   * 获取已注册技能数量
   */
  public getSkillCount(): number {
    return this.skills.size;
  }

  /**
   * 注册基础设施工具
   * 这些是 LLM 自主调用的系统级工具（记忆、情绪、反思等），并非技能
   */
  public registerInfrastructureTool(tool: {
    name: string;
    description: string;
    parameters: Array<{
      name: string;
      type: string;
      required: boolean;
      description: string;
    }>;
    execute: (
      args: Record<string, unknown>,
      context?: SkillContext
    ) => Promise<SkillResult>;
  }): void {
    this.infrastructureTools.set(tool.name, tool);
    this.cachedTools = null;
  }

  /**
   * 将所有技能 + 基础设施工具转换为 OpenAI Function Calling 工具格式
   */
  public toOpenAITools(): Array<Record<string, unknown>> {
    if (this.cachedTools) return this.cachedTools;

    const tools: Array<Record<string, unknown>> = [];

    // 基础设施工具（排在前，LLM 优先看到）
    for (const tool of this.infrastructureTools.values()) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const param of tool.parameters) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
        };
        if (param.required) {
          required.push(param.name);
        }
      }
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties,
            required,
          },
        },
      });
    }

    // 技能工具
    for (const skill of this.skills.values()) {
      const def = skill.definition;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const param of def.parameters) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
        };
        if (param.required) {
          required.push(param.name);
        }
      }
      tools.push({
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: {
            type: 'object',
            properties,
            required,
          },
        },
      });
    }
    this.cachedTools = tools;
    return tools;
  }

  /**
   * 执行 LLM 返回的 tool call（优先匹配基础设施工具）
   */
  public async executeToolCall(
    toolCall: {
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    },
    context?: SkillContext
  ): Promise<SkillResult> {
    const toolName = toolCall.function.name;

    // 优先匹配基础设施工具
    const infraTool = this.infrastructureTools.get(toolName);
    if (infraTool) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }
      Logger.info(
        `🧠 LLM 调用了基础设施工具: ${toolName} | 参数: ${JSON.stringify(args)}`,
        'SkillRegistry'
      );
      return await infraTool.execute(args, context);
    }

    // 再匹配技能工具
    const skill = this.skills.get(toolName);
    if (!skill) {
      return { success: false, error: `工具不存在: ${toolName}` };
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }
    const validation = await skill.validate(args);
    if (!validation.valid) {
      return {
        success: false,
        error: `参数验证失败: ${validation.errors.join(', ')}`,
      };
    }
    Logger.info(
      `🔧 LLM 自主选择技能: ${toolName} | 参数: ${JSON.stringify(args)}`,
      'SkillRegistry'
    );
    return await skill.execute(args, context);
  }

  /**
   * 将技能导出为 JSON 字符串（agentskills.io 兼容格式）
   * @param name - 技能名称
   * @returns 导出的 JSON 字符串，技能不存在时返回 null
   */
  exportSkill(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) {
      Logger.warn(`导出技能失败：技能不存在: ${name}`, 'SkillRegistry');
      return null;
    }

    const exportData: SkillExportData = {
      formatVersion: '1.0.0',
      agentskillsIo: {
        version: '1.0.0',
        schema: 'https://agentskills.io/schemas/skill-export-v1.json',
      },
      definition: {
        ...skill.definition,
        source: skill.definition.source || 'builtin',
        license: skill.definition.license || 'MIT',
        compatibility: skill.definition.compatibility || '>=5.0',
      },
      exportedAt: new Date().toISOString(),
      exportedFrom: 'jiabaixing',
    };

    try {
      const jsonStr = JSON.stringify(exportData, null, 2);
      Logger.info(`📤 技能已导出: ${name}`, 'SkillRegistry');
      return jsonStr;
    } catch (error) {
      Logger.error(
        `导出技能序列化失败: ${name}`,
        error as Error,
        'SkillRegistry'
      );
      return null;
    }
  }

  /**
   * 从 JSON 字符串导入技能
   * @param jsonString - 符合 SkillExportData 格式的 JSON 字符串
   * @returns 导入是否成功
   */
  importSkill(jsonString: string): boolean {
    let data: SkillExportData;
    try {
      data = JSON.parse(jsonString) as SkillExportData;
    } catch (error) {
      Logger.error(
        '导入技能失败：JSON 解析错误',
        error as Error,
        'SkillRegistry'
      );
      return false;
    }

    if (!data.definition || !data.definition.name) {
      Logger.warn(
        '导入技能失败：缺少 definition 或 name 字段',
        'SkillRegistry'
      );
      return false;
    }

    const name = data.definition.name;
    if (this.skills.has(name)) {
      Logger.warn(`导入技能失败：技能已存在: ${name}`, 'SkillRegistry');
      return false;
    }

    // 标记来源为 hub
    const enrichedDefinition: SkillDefinition = {
      ...data.definition,
      source: 'hub' as SkillSource,
      hubId: data.definition.hubId || data.agentskillsIo?.schema,
      hubUrl: data.definition.hubUrl,
    };

    // 创建导入技能的 Skill 实现
    const importedSkill: Skill = {
      definition: enrichedDefinition,
      async execute(
        params: Record<string, unknown>,
        context?: SkillContext
      ): Promise<SkillResult> {
        // 如果有模板和 LLM 可用，则渲染模板
        if (data.template) {
          let rendered = data.template;
          if (data.variables) {
            for (const [key, varDef] of Object.entries(data.variables)) {
              const value =
                params[key] != null ? String(params[key]) : varDef.default;
              rendered = rendered.replaceAll(`{{${key}}}`, value);
            }
          }
          return { success: true, output: rendered };
        }
        return {
          success: true,
          output: `导入技能 ${enrichedDefinition.name} 执行成功`,
          metadata: { params, context },
        };
      },
      async validate(
        params: Record<string, unknown>
      ): Promise<{ valid: boolean; errors: string[] }> {
        const errors: string[] = [];
        for (const param of enrichedDefinition.parameters) {
          if (
            param.required &&
            (params[param.name] === undefined || params[param.name] === null)
          ) {
            errors.push(`缺少必填参数: ${param.name}`);
          }
        }
        return { valid: errors.length === 0, errors };
      },
    };

    this.register(importedSkill);
    Logger.info(
      `📥 技能已导入: ${name} (来源: ${enrichedDefinition.source}, 许可证: ${enrichedDefinition.license || 'MIT'})`,
      'SkillRegistry'
    );
    return true;
  }

  /**
   * 导出所有用户/进化生成的技能
   * @returns 包含所有可导出技能的 JSON 字符串
   */
  exportAllSkills(): string {
    const exportableSkills = Array.from(this.skills.values()).filter(
      (skill) => {
        const source = skill.definition.source;
        return source === 'user' || source === 'evolution' || source === 'hub';
      }
    );

    const exportList: SkillExportData[] = exportableSkills.map((skill) => ({
      formatVersion: '1.0.0',
      agentskillsIo: {
        version: '1.0.0',
        schema: 'https://agentskills.io/schemas/skill-export-v1.json',
      },
      definition: {
        ...skill.definition,
        source: skill.definition.source || 'user',
        license: skill.definition.license || 'MIT',
        compatibility: skill.definition.compatibility || '>=5.0',
      },
      exportedAt: new Date().toISOString(),
      exportedFrom: 'jiabaixing',
    }));

    try {
      const jsonStr = JSON.stringify(exportList, null, 2);
      Logger.info(`📤 批量导出技能: ${exportList.length} 个`, 'SkillRegistry');
      return jsonStr;
    } catch (error) {
      Logger.error('批量导出技能序列化失败', error as Error, 'SkillRegistry');
      return '[]';
    }
  }

  /**
   * 搜索远程技能市场（目前使用本地模拟数据，预留远程 API 扩展）
   * @param keyword - 搜索关键词
   * @returns 匹配的技能定义列表
   */
  async searchHub(keyword: string): Promise<SkillDefinition[]> {
    Logger.info(`🔍 搜索技能市场: "${keyword}"`, 'SkillRegistry');

    // 本地模拟数据 — 后续替换为远程 API 调用
    const mockHubSkills: SkillDefinition[] = [
      {
        name: 'code_review',
        description: '自动代码审查，检测潜在问题和改进建议',
        category: 'development',
        parameters: [
          {
            name: 'code',
            type: 'string',
            required: true,
            description: '待审查的代码',
          },
          {
            name: 'language',
            type: 'string',
            required: false,
            description: '编程语言',
          },
        ],
        version: '1.2.0',
        author: 'hub-contributor',
        tags: ['code', 'review', 'quality'],
        source: 'hub',
        hubId: 'code-review-v1',
        hubUrl: 'https://agentskills.io/skills/code-review-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
      {
        name: 'api_doc_generator',
        description: '根据 API 路由自动生成 OpenAPI 文档',
        category: 'development',
        parameters: [
          {
            name: 'routes',
            type: 'string',
            required: true,
            description: 'API 路由文件路径',
          },
          {
            name: 'format',
            type: 'string',
            required: false,
            description: '输出格式 (yaml/json)',
          },
        ],
        version: '2.0.1',
        author: 'hub-contributor',
        tags: ['api', 'documentation', 'openapi'],
        source: 'hub',
        hubId: 'api-doc-gen-v2',
        hubUrl: 'https://agentskills.io/skills/api-doc-gen-v2',
        license: 'Apache-2.0',
        compatibility: '>=5.0',
      },
      {
        name: 'data_analyzer',
        description: '数据分析技能，支持 CSV/JSON 数据的统计分析与可视化建议',
        category: 'data',
        parameters: [
          {
            name: 'data',
            type: 'string',
            required: true,
            description: '数据内容或文件路径',
          },
          {
            name: 'analysis_type',
            type: 'string',
            required: false,
            description: '分析类型 (summary/trend/comparison)',
          },
        ],
        version: '1.0.0',
        author: 'hub-contributor',
        tags: ['data', 'analysis', 'visualization'],
        source: 'hub',
        hubId: 'data-analyzer-v1',
        hubUrl: 'https://agentskills.io/skills/data-analyzer-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
      {
        name: 'security_scanner',
        description: '安全扫描技能，检测代码中的常见安全漏洞',
        category: 'security',
        parameters: [
          {
            name: 'target',
            type: 'string',
            required: true,
            description: '扫描目标路径',
          },
          {
            name: 'severity',
            type: 'string',
            required: false,
            description: '最低严重级别 (low/medium/high/critical)',
          },
        ],
        version: '1.1.0',
        author: 'hub-contributor',
        tags: ['security', 'scan', 'vulnerability'],
        source: 'hub',
        hubId: 'security-scanner-v1',
        hubUrl: 'https://agentskills.io/skills/security-scanner-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
      {
        name: 'i18n_helper',
        description: '国际化辅助技能，自动提取和翻译多语言文本',
        category: 'development',
        parameters: [
          {
            name: 'source_path',
            type: 'string',
            required: true,
            description: '源文件路径',
          },
          {
            name: 'target_lang',
            type: 'string',
            required: true,
            description: '目标语言',
          },
        ],
        version: '1.0.0',
        author: 'hub-contributor',
        tags: ['i18n', 'translation', 'localization'],
        source: 'hub',
        hubId: 'i18n-helper-v1',
        hubUrl: 'https://agentskills.io/skills/i18n-helper-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
    ];

    const lowerKeyword = keyword.toLowerCase();
    const results = mockHubSkills.filter((skill) => {
      const nameMatch = skill.name.toLowerCase().includes(lowerKeyword);
      const descMatch = skill.description.toLowerCase().includes(lowerKeyword);
      const tagMatch = (skill.tags || []).some((tag) =>
        tag.toLowerCase().includes(lowerKeyword)
      );
      const categoryMatch = skill.category.toLowerCase().includes(lowerKeyword);
      return nameMatch || descMatch || tagMatch || categoryMatch;
    });

    Logger.info(
      `🔍 技能市场搜索结果: "${keyword}" → ${results.length} 个匹配`,
      'SkillRegistry'
    );
    return results;
  }

  /**
   * 从技能市场安装技能（目前使用本地模拟，预留远程 API 扩展）
   * @param hubId - 技能在市场的唯一ID
   * @returns 安装是否成功
   */
  async installFromHub(hubId: string): Promise<boolean> {
    Logger.info(`📥 从技能市场安装: ${hubId}`, 'SkillRegistry');

    // 本地模拟 — 后续替换为远程 API 调用
    const mockHubSkills: SkillDefinition[] = [
      {
        name: 'code_review',
        description: '自动代码审查，检测潜在问题和改进建议',
        category: 'development',
        parameters: [
          {
            name: 'code',
            type: 'string',
            required: true,
            description: '待审查的代码',
          },
          {
            name: 'language',
            type: 'string',
            required: false,
            description: '编程语言',
          },
        ],
        version: '1.2.0',
        author: 'hub-contributor',
        tags: ['code', 'review', 'quality'],
        source: 'hub',
        hubId: 'code-review-v1',
        hubUrl: 'https://agentskills.io/skills/code-review-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
      {
        name: 'api_doc_generator',
        description: '根据 API 路由自动生成 OpenAPI 文档',
        category: 'development',
        parameters: [
          {
            name: 'routes',
            type: 'string',
            required: true,
            description: 'API 路由文件路径',
          },
          {
            name: 'format',
            type: 'string',
            required: false,
            description: '输出格式 (yaml/json)',
          },
        ],
        version: '2.0.1',
        author: 'hub-contributor',
        tags: ['api', 'documentation', 'openapi'],
        source: 'hub',
        hubId: 'api-doc-gen-v2',
        hubUrl: 'https://agentskills.io/skills/api-doc-gen-v2',
        license: 'Apache-2.0',
        compatibility: '>=5.0',
      },
      {
        name: 'data_analyzer',
        description: '数据分析技能，支持 CSV/JSON 数据的统计分析与可视化建议',
        category: 'data',
        parameters: [
          {
            name: 'data',
            type: 'string',
            required: true,
            description: '数据内容或文件路径',
          },
          {
            name: 'analysis_type',
            type: 'string',
            required: false,
            description: '分析类型 (summary/trend/comparison)',
          },
        ],
        version: '1.0.0',
        author: 'hub-contributor',
        tags: ['data', 'analysis', 'visualization'],
        source: 'hub',
        hubId: 'data-analyzer-v1',
        hubUrl: 'https://agentskills.io/skills/data-analyzer-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
      {
        name: 'security_scanner',
        description: '安全扫描技能，检测代码中的常见安全漏洞',
        category: 'security',
        parameters: [
          {
            name: 'target',
            type: 'string',
            required: true,
            description: '扫描目标路径',
          },
          {
            name: 'severity',
            type: 'string',
            required: false,
            description: '最低严重级别 (low/medium/high/critical)',
          },
        ],
        version: '1.1.0',
        author: 'hub-contributor',
        tags: ['security', 'scan', 'vulnerability'],
        source: 'hub',
        hubId: 'security-scanner-v1',
        hubUrl: 'https://agentskills.io/skills/security-scanner-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
      {
        name: 'i18n_helper',
        description: '国际化辅助技能，自动提取和翻译多语言文本',
        category: 'development',
        parameters: [
          {
            name: 'source_path',
            type: 'string',
            required: true,
            description: '源文件路径',
          },
          {
            name: 'target_lang',
            type: 'string',
            required: true,
            description: '目标语言',
          },
        ],
        version: '1.0.0',
        author: 'hub-contributor',
        tags: ['i18n', 'translation', 'localization'],
        source: 'hub',
        hubId: 'i18n-helper-v1',
        hubUrl: 'https://agentskills.io/skills/i18n-helper-v1',
        license: 'MIT',
        compatibility: '>=5.0',
      },
    ];

    const hubSkill = mockHubSkills.find((s) => s.hubId === hubId);
    if (!hubSkill) {
      Logger.warn(`技能市场安装失败：未找到技能: ${hubId}`, 'SkillRegistry');
      return false;
    }

    // 检查是否已安装
    if (this.skills.has(hubSkill.name)) {
      Logger.warn(
        `技能市场安装失败：技能已存在: ${hubSkill.name}`,
        'SkillRegistry'
      );
      return false;
    }

    // 创建 hub 技能的 Skill 实现
    const installedSkill: Skill = {
      definition: { ...hubSkill, source: 'hub' },
      async execute(
        params: Record<string, unknown>,
        context?: SkillContext
      ): Promise<SkillResult> {
        return {
          success: true,
          output: `技能市场技能 ${hubSkill.name} 执行成功`,
          metadata: { params, context, hubId: hubSkill.hubId },
        };
      },
      async validate(
        params: Record<string, unknown>
      ): Promise<{ valid: boolean; errors: string[] }> {
        const errors: string[] = [];
        for (const param of hubSkill.parameters) {
          if (
            param.required &&
            (params[param.name] === undefined || params[param.name] === null)
          ) {
            errors.push(`缺少必填参数: ${param.name}`);
          }
        }
        return { valid: errors.length === 0, errors };
      },
    };

    this.register(installedSkill);
    Logger.info(
      `✅ 技能市场安装成功: ${hubSkill.name} (hubId: ${hubId}, 版本: ${hubSkill.version})`,
      'SkillRegistry'
    );
    return true;
  }
}

/**
 * 贾百姓技能注册中心
 * 管理所有技能的注册、查找和执行
 */

import {
  Skill,
  SkillDefinition,
  SkillContext,
  SkillResult,
} from './SkillInterface';
import { Logger } from '../utils/Logger';

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
    return Array.from(this.skills.values()).map((skill) => ({
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
}

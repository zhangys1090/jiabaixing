/**
 * Prompt模板引擎
 * 支持YAML格式模板、变量注入、条件渲染
 */

import { Logger } from '../utils/Logger';

export interface PromptTemplate {
  id: string;
  version: string;
  variables: TemplateVariable[];
  sections: TemplateSection[];
  metadata?: Record<string, unknown>;
}

export interface TemplateVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface TemplateSection {
  type: 'system' | 'user' | 'assistant' | 'memory' | 'tool' | 'context';
  condition?: string;
  content: string;
  priority?: number;
}

export interface RenderContext {
  variables: Record<string, unknown>;
  memories?: Array<{ content: string; timestamp: string; relevance: number }>;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  context?: Record<string, unknown>;
  maxTokens?: number;
}

export interface RenderedPrompt {
  system: string;
  user?: string;
  context?: string;
  totalTokens: number;
  sections: string[];
}

export class PromptTemplateEngine {
  private templates: Map<string, PromptTemplate> = new Map();
  private templateCache: Map<string, string> = new Map();
  private readonly MAX_CACHE_SIZE = 100;

  constructor() {
    this.initializeDefaultTemplates();
  }

  private initializeDefaultTemplates(): void {
    this.registerTemplate({
      id: 'base_persona',
      version: '2.0',
      variables: [
        { name: 'name', type: 'string', required: true },
        { name: 'role', type: 'string', required: true },
        { name: 'style', type: 'string', default: '专业、温和、有同理心' },
        { name: 'currentScene', type: 'string', default: '日常对话' },
      ],
      sections: [
        {
          type: 'system',
          content: `你是{{name}}，一位{{role}}。

你的说话风格：{{style}}

当前场景：{{currentScene}}

核心原则：
1. 记住用户告诉你的每一件事，在后续对话中自然引用
2. 主动关心用户的状态和需求
3. 用自然、亲切的方式交流，避免机械回复
4. 在适当的时候主动提供帮助和建议`,
          priority: 100,
        },
      ],
    });

    this.registerTemplate({
      id: 'memory_context',
      version: '1.0',
      variables: [
        { name: 'memories', type: 'array', required: true },
        { name: 'maxMemories', type: 'number', default: 5 },
      ],
      sections: [
        {
          type: 'memory',
          condition: '{{memories.length > 0}}',
          content: `【相关记忆】
{{#each memories}}
{{#if @first}}最近{{/if}}- {{this.content}}（{{this.timestamp}}，相关度：{{this.relevance}}）
{{/each}}`,
          priority: 80,
        },
      ],
    });

    this.registerTemplate({
      id: 'tool_calling',
      version: '1.0',
      variables: [
        { name: 'tools', type: 'array', required: true },
        { name: 'userRequest', type: 'string', required: true },
      ],
      sections: [
        {
          type: 'system',
          content: `你是一个智能助手，可以使用以下工具来帮助用户：

{{#each tools}}
### {{this.name}}
{{this.description}}
参数：{{json this.parameters}}
{{/each}}

当需要使用工具时，请按以下格式回复：
\`\`\`tool
{
  "name": "工具名称",
  "parameters": { ... }
}
\`\`\`

如果不使用工具，直接回复用户。`,
          priority: 90,
        },
        {
          type: 'user',
          content: '{{userRequest}}',
          priority: 50,
        },
      ],
    });

    this.registerTemplate({
      id: 'react_agent',
      version: '1.0',
      variables: [
        { name: 'tools', type: 'array', required: false },
        { name: 'task', type: 'string', required: true },
      ],
      sections: [
        {
          type: 'system',
          content: `你是一个智能代理，使用ReAct框架解决问题。

格式：
思考：分析当前情况，决定下一步
行动：[工具名] 参数
观察：工具返回结果
...（重复直到完成）
答案：最终答案

可用工具：
{{#each tools}}
- {{this.name}}: {{this.description}}
{{/each}}

如果工具列表为空，直接给出答案。`,
          priority: 100,
        },
        {
          type: 'user',
          content: '任务：{{task}}',
          priority: 50,
        },
      ],
    });

    this.registerTemplate({
      id: 'vision_analysis',
      version: '1.0',
      variables: [
        { name: 'imageDescription', type: 'string', required: true },
        { name: 'question', type: 'string', required: false },
      ],
      sections: [
        {
          type: 'system',
          content: `你是一个视觉分析助手。用户会提供图像的描述或分析结果，你需要：
1. 理解图像内容
2. 回答用户关于图像的问题
3. 提供有价值的见解`,
          priority: 100,
        },
        {
          type: 'user',
          content: `图像信息：{{imageDescription}}
{{#if question}}
问题：{{question}}
{{/if}}`,
          priority: 50,
        },
      ],
    });

    Logger.info(
      `✅ PromptTemplateEngine 初始化完成，已加载 ${this.templates.size} 个模板`,
      'PromptTemplateEngine'
    );
  }

  public registerTemplate(template: PromptTemplate): void {
    this.templates.set(template.id, template);
    Logger.debug(
      `📝 注册模板: ${template.id} v${template.version}`,
      'PromptTemplateEngine'
    );
  }

  public getTemplate(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  public render(templateId: string, context: RenderContext): RenderedPrompt {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`模板 ${templateId} 不存在`);
    }

    const sections: string[] = [];
    let systemContent = '';
    let userContent = '';
    let contextContent = '';

    const sortedSections = [...template.sections].sort(
      (a, b) => (b.priority || 0) - (a.priority || 0)
    );

    for (const section of sortedSections) {
      if (
        section.condition &&
        !this.evaluateCondition(section.condition, context)
      ) {
        continue;
      }

      const renderedContent = this.renderContent(section.content, context);

      switch (section.type) {
        case 'system':
          systemContent += (systemContent ? '\n\n' : '') + renderedContent;
          break;
        case 'user':
          userContent += (userContent ? '\n\n' : '') + renderedContent;
          break;
        case 'memory':
        case 'context':
          contextContent += (contextContent ? '\n\n' : '') + renderedContent;
          break;
        default:
          sections.push(renderedContent);
      }
    }

    const totalTokens = this.estimateTokens(
      systemContent + userContent + contextContent
    );

    return {
      system: systemContent,
      user: userContent || undefined,
      context: contextContent || undefined,
      totalTokens,
      sections,
    };
  }

  public renderToString(templateId: string, context: RenderContext): string {
    const rendered = this.render(templateId, context);
    let result = rendered.system;

    if (rendered.context) {
      result += '\n\n' + rendered.context;
    }

    if (rendered.user) {
      result += '\n\n用户：' + rendered.user;
    }

    return result;
  }

  private renderContent(content: string, context: RenderContext): string {
    let result = content;

    result = this.renderVariables(result, context.variables);
    result = this.renderConditionals(result, context);
    result = this.renderLoops(result, context);

    return result.trim();
  }

  private renderVariables(
    content: string,
    variables: Record<string, unknown>
  ): string {
    return content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = variables[varName];
      if (value === undefined) {
        Logger.warn(`⚠️ 变量 ${varName} 未定义`, 'PromptTemplateEngine');
        return match;
      }
      return String(value);
    });
  }

  private renderConditionals(content: string, context: RenderContext): string {
    const ifPattern = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

    return content.replace(ifPattern, (match, condition, body) => {
      const value = context.variables[condition];
      if (value) {
        return body.trim();
      }
      return '';
    });
  }

  private renderLoops(content: string, context: RenderContext): string {
    const eachPattern = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

    return content.replace(eachPattern, (match, arrayName, template) => {
      const array = context.variables[arrayName] as unknown[];
      if (!Array.isArray(array)) {
        return '';
      }

      return array
        .map((item, index) => {
          let itemContent = template;

          if (typeof item === 'object' && item !== null) {
            itemContent = itemContent.replace(
              /\{\{this\.(\w+)\}\}/g,
              (_: string, prop: string) =>
                String((item as Record<string, unknown>)[prop] || '')
            );
          } else {
            itemContent = itemContent.replace(/\{\{this\}\}/g, String(item));
          }

          itemContent = itemContent.replace(
            /\{\{@first\}\}/g,
            index === 0 ? '✨ ' : ''
          );
          itemContent = itemContent.replace(
            /\{\{@index\}\}/g,
            String(index + 1)
          );

          return itemContent;
        })
        .join('\n');
    });
  }

  private evaluateCondition(
    condition: string,
    context: RenderContext
  ): boolean {
    const cleanCondition = condition.replace(/\{\{|\}\}/g, '').trim();

    const comparisonMatch = cleanCondition.match(
      /(\w+)\s*(>|<|>=|<=|===|!==)\s*(\d+)/
    );
    if (comparisonMatch) {
      const [, varName, operator, valueStr] = comparisonMatch;
      const varValue = context.variables[varName];
      const compareValue = parseInt(valueStr, 10);

      switch (operator) {
        case '>':
          return (varValue as number) > compareValue;
        case '<':
          return (varValue as number) < compareValue;
        case '>=':
          return (varValue as number) >= compareValue;
        case '<=':
          return (varValue as number) <= compareValue;
        case '===':
          return varValue === compareValue;
        case '!==':
          return varValue !== compareValue;
      }
    }

    const lengthMatch = cleanCondition.match(
      /(\w+)\.length\s*(>|<|>=|<=|===)\s*(\d+)/
    );
    if (lengthMatch) {
      const [, varName, operator, valueStr] = lengthMatch;
      const array = context.variables[varName];
      const length = Array.isArray(array) ? array.length : 0;
      const compareValue = parseInt(valueStr, 10);

      switch (operator) {
        case '>':
          return length > compareValue;
        case '<':
          return length < compareValue;
        case '>=':
          return length >= compareValue;
        case '<=':
          return length <= compareValue;
        case '===':
          return length === compareValue;
      }
    }

    const truthyMatch = cleanCondition.match(/^(\w+)$/);
    if (truthyMatch) {
      const varName = truthyMatch[1];
      return Boolean(context.variables[varName]);
    }

    return false;
  }

  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const otherChars = text.length - chineseChars - englishWords * 2;

    return Math.ceil(chineseChars * 1.5 + englishWords + otherChars * 0.5);
  }

  public listTemplates(): string[] {
    return Array.from(this.templates.keys());
  }

  public clearCache(): void {
    this.templateCache.clear();
    Logger.debug('🧹 模板缓存已清空', 'PromptTemplateEngine');
  }
}

export const promptTemplateEngine = new PromptTemplateEngine();

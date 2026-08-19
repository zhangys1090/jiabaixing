/**
 * Harness Meta Tool: tool_inspect - 检查已注册工具的详细信息
 *
 * 可查看工具定义、参数、使用统计、动态工具的剩余TTL等。
 */
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';
import type { ToolRegistry } from '../registry/ToolRegistry';

export interface ToolInspectDeps {
  toolRegistry: ToolRegistry;
}

export const TOOL_INSPECT_DEF: ToolDefinition = {
  name: 'tool_inspect',
  description:
    '检查已注册工具的详细信息。可查看工具定义、参数、使用统计、动态工具的剩余TTL等。适用场景：了解可用工具能力、调试工具调用、查看动态工具状态。不适用：执行工具（请直接调用工具）。',
  category: ToolCategory.SYSTEM,
  parameters: {
    name: {
      type: 'string',
      description: '要检查的工具名称。不传则列出所有已注册工具概览。',
    },
    include_code: {
      type: 'boolean',
      description: '是否包含动态工具的源代码（仅对动态工具有效）',
      default: false,
    },
    filter: {
      type: 'string',
      description:
        '过滤方式：all(全部) | dynamic(仅动态) | static(仅静态) | category:xxx(按分类)',
      default: 'all',
    },
  },
  requiredParams: [],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
  tags: ['meta', 'dynamic', 'introspection'],
};

export function createToolInspectExecutor(deps: ToolInspectDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const name = params.name ? String(params.name).trim() : '';
    const filter = String(params.filter || 'all').trim().toLowerCase();

    if (name) {
      const tool = deps.toolRegistry ? deps.toolRegistry.get(name) : null;
      if (!tool) {
        return {
          success: false,
          output: null,
          error: `工具不存在: ${name}`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const def = tool.definition as ToolDefinition;
      const isDynamic = def.tags?.includes('dynamic') ?? false;

      let result = `工具: ${def.name}\n`;
      result += `描述: ${def.description}\n`;
      result += `分类: ${def.category}\n`;
      result += `风险等级: ${def.riskLevel}\n`;
      result += `幂等: ${def.idempotent}\n`;
      result += `超时: ${def.timeout}ms\n`;
      result += `标签: ${def.tags?.join(', ') || '无'}\n`;
      result += `参数:\n`;
      for (const [pName, pDef] of Object.entries(def.parameters)) {
        result += `  - ${pName} (${pDef.type}): ${pDef.description}${pDef.default !== undefined ? ` [默认: ${pDef.default}]` : ''}\n`;
      }
      result += `必填: ${def.requiredParams.join(', ') || '无'}\n`;
      result += `权限: ${def.requiredPermissions.join(', ') || '无'}\n`;
      result += `类型: ${isDynamic ? '动态工具' : '系统内置'}\n`;

      return {
        success: true,
        output: result,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    if (!deps.toolRegistry) {
      return {
        success: false,
        output: null,
        error: 'ToolRegistry 不可用',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    let tools = deps.toolRegistry.getAll();

    if (filter === 'dynamic') {
      tools = tools.filter((t) => t.definition.tags?.includes('dynamic'));
    } else if (filter === 'static') {
      tools = tools.filter((t) => !t.definition.tags?.includes('dynamic'));
    } else if (filter.startsWith('category:')) {
      const cat = filter.replace('category:', '');
      tools = tools.filter((t) => t.definition.category === cat);
    }

    const dynamicCount = tools.filter((t) =>
      t.definition.tags?.includes('dynamic')
    ).length;
    const staticCount = tools.length - dynamicCount;

    let result = `工具注册表概览\n`;
    result += `总计: ${tools.length} 个工具 (内置: ${staticCount}, 动态: ${dynamicCount})\n`;
    result += `过滤: ${filter}\n\n`;

    const byCategory = new Map<string, typeof tools>();
    for (const tool of tools) {
      const cat = tool.definition.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(tool);
    }

    for (const [cat, catTools] of byCategory) {
      result += `[${cat}] (${catTools.length})\n`;
      for (const tool of catTools) {
        const isDyn = tool.definition.tags?.includes('dynamic') ? '*' : ' ';
        const desc = tool.definition.description;
        result += `  ${isDyn} ${tool.definition.name} - ${desc.substring(0, 60)}${desc.length > 60 ? '...' : ''}\n`;
      }
      result += '\n';
    }

    return {
      success: true,
      output: result,
      duration: Date.now() - startTime,
      validated: false,
    };
  };
}

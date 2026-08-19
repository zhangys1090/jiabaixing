/**
 * Harness Meta Tool: tool_define - 运行时动态定义新工具
 *
 * Agent 可以在对话中创造新工具来扩展自身能力。
 * 动态工具在沙箱中执行，有 TTL 自动过期。
 */
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import type { ToolRegistry } from '../registry/ToolRegistry';

const DYNAMIC_TOOL_PREFIX = 'dyn_';
const MAX_DYNAMIC_TOOLS = 50;

const FORBIDDEN_CODE_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'shutdown',
  'format',
  'del /s /q C:',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'child_process',
  'require(',
  'import ',
  'process.exit',
  'fs.unlink',
  'fs.rmdir',
];

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{2,39}$/;

export interface ToolDefineDeps {
  toolRegistry: ToolRegistry;
}

export const TOOL_DEFINE_DEF: ToolDefinition = {
  name: 'tool_define',
  description:
    '运行时动态定义新工具。Agent可以在对话中创造新工具来扩展自身能力。定义的工具在沙箱中执行，有TTL自动过期。适用场景：现有工具无法满足需求时创建专用工具、组合多个操作为单一工具、临时数据处理工具。不适用：系统内置工具已能完成的任务。',
  category: ToolCategory.SYSTEM,
  parameters: {
    name: {
      type: 'string',
      description:
        '工具名称（小写字母开头，仅含小写字母/数字/下划线，3-40字符）。会自动添加 dyn_ 前缀。',
    },
    description: {
      type: 'string',
      description: '工具功能描述（清晰说明适用和不适用场景）',
    },
    parameters_schema: {
      type: 'object',
      description:
        '工具参数定义，格式为 { param_name: { type: "string|number|boolean|array|object", description: "参数说明", default: "默认值(可选)" } }',
    },
    required_params: {
      type: 'array',
      description: '必填参数名列表',
      items: { type: 'string', description: '参数名' },
    },
    code: {
      type: 'string',
      description:
        '工具执行代码（JavaScript）。接收 params 对象，必须 return 结果。可用 console.log 输出。禁止 require/import/process/child_process。',
    },
    ttl_minutes: {
      type: 'number',
      description: '工具存活时间（分钟），默认30分钟，最大120分钟',
      default: 30,
    },
  },
  requiredParams: ['name', 'description', 'code'],
  requiredPermissions: [Permission.CODE_EXECUTE, Permission.SYSTEM_ADMIN],
  riskLevel: 'high',
  idempotent: false,
  timeout: 15000,
  tags: ['meta', 'dynamic', 'self-modifying'],
};

function containsForbiddenCode(code: string): string | null {
  const lower = code.toLowerCase();
  for (const pattern of FORBIDDEN_CODE_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

function createSandboxedExecutor(
  code: string,
  toolName: string
): (params: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult> {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    try {
      const logs: string[] = [];
      const sandboxConsole = {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        info: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      };
      const asyncFn = new Function(
        'console',
        'params',
        `"use strict";\n${code}`
      );
      const result = await asyncFn(sandboxConsole, params);
      const output =
        result !== undefined
          ? typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2)
          : logs.length > 0
            ? logs.join('\n')
            : '(无输出)';
      return {
        success: true,
        output,
        duration: Date.now() - startTime,
        validated: false,
        metadata: {
          toolName,
          sandboxed: true,
          logs: logs.length > 0 ? logs.slice(0, 10) : undefined,
        },
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: null,
        error: `动态工具 ${toolName} 执行失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

interface DynamicToolInfo {
  definition: ToolDefinition;
  code: string;
  createdAt: number;
  expiresAt: number;
  ttlMinutes: number;
  createdBy: string;
  invocationCount: number;
}

export function createToolDefineExecutor(deps: ToolDefineDeps) {
  const dynamicTools = new Map<string, DynamicToolInfo>();
  const ttlTimers = new Map<string, NodeJS.Timeout>();

  function cleanupExpired(): void {
    const now = Date.now();
    for (const [name, info] of dynamicTools) {
      if (info.expiresAt && info.expiresAt <= now) {
        forceUndefine(name);
      }
    }
  }

  function forceUndefine(name: string): void {
    const info = dynamicTools.get(name);
    if (!info) return;
    if (ttlTimers.has(name)) {
      clearTimeout(ttlTimers.get(name)!);
      ttlTimers.delete(name);
    }
    if (deps.toolRegistry) {
      deps.toolRegistry.unregister(name);
    }
    dynamicTools.delete(name);
    Logger.info(`动态工具已过期/清理: ${name}`, 'ToolDefine');
  }

  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const rawName = String(params.name || '').trim().toLowerCase();
    const description = String(params.description || '').trim();
    const code = String(params.code || '').trim();
    const parametersSchema =
      (params.parameters_schema as Record<string, unknown>) || {};
    const requiredParams = (params.required_params as string[]) || [];
    const ttlMinutes = Math.min(
      Math.max(Number(params.ttl_minutes) || 30, 1),
      120
    );

    if (!rawName) {
      return {
        success: false,
        output: null,
        error: '工具名称不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    if (!TOOL_NAME_REGEX.test(rawName)) {
      return {
        success: false,
        output: null,
        error: `工具名称格式无效: "${rawName}"。要求：小写字母开头，仅含小写字母/数字/下划线，3-40字符`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    const fullName = DYNAMIC_TOOL_PREFIX + rawName;

    if (!description) {
      return {
        success: false,
        output: null,
        error: '工具描述不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    if (!code) {
      return {
        success: false,
        output: null,
        error: '工具执行代码不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    const forbiddenPattern = containsForbiddenCode(code);
    if (forbiddenPattern) {
      return {
        success: false,
        output: null,
        error: `代码包含禁止的模式: "${forbiddenPattern}"。动态工具禁止使用 require/import/process/child_process 等系统调用`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    cleanupExpired();

    if (dynamicTools.size >= MAX_DYNAMIC_TOOLS) {
      return {
        success: false,
        output: null,
        error: `动态工具数量已达上限 (${MAX_DYNAMIC_TOOLS})。请先使用 tool_undefine 清理不需要的工具`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    if (deps.toolRegistry && deps.toolRegistry.has(fullName)) {
      return {
        success: false,
        output: null,
        error: `工具已存在: ${fullName}。请先使用 tool_undefine 注销旧工具`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    try {
      new Function('console', 'params', `"use strict";\n${code}`);
    } catch (syntaxErr: unknown) {
      return {
        success: false,
        output: null,
        error: `代码语法错误: ${(syntaxErr as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    const executor = createSandboxedExecutor(code, fullName);
    const definition: ToolDefinition = {
      name: fullName,
      description: `[动态工具] ${description}`,
      category: ToolCategory.SYSTEM,
      parameters: parametersSchema as Record<string, import('../../types').ToolParameterDef>,
      requiredParams,
      requiredPermissions: [Permission.CODE_EXECUTE],
      riskLevel: 'high',
      idempotent: false,
      timeout: 15000,
      tags: ['dynamic', 'user-defined'],
    };

    if (deps.toolRegistry) {
      deps.toolRegistry.register(definition, executor);
    }

    const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
    const ttlTimer = setTimeout(() => forceUndefine(fullName), ttlMinutes * 60 * 1000);
    if (ttlTimer.unref) ttlTimer.unref();
    ttlTimers.set(fullName, ttlTimer);

    dynamicTools.set(fullName, {
      definition,
      code,
      createdAt: Date.now(),
      expiresAt,
      ttlMinutes,
      createdBy: context?.userId || 'unknown',
      invocationCount: 0,
    });

    Logger.info(
      `动态工具已定义: ${fullName} (TTL=${ttlMinutes}min)`,
      'ToolDefine'
    );

    return {
      success: true,
      output: `动态工具 "${fullName}" 已成功定义。\n\n描述: ${description}\n参数: ${Object.keys(parametersSchema).join(', ') || '无'}\n必填: ${requiredParams.join(', ') || '无'}\nTTL: ${ttlMinutes} 分钟\n过期时间: ${new Date(expiresAt).toLocaleString()}\n\n现在可以通过调用 ${fullName} 来使用此工具。`,
      duration: Date.now() - startTime,
      validated: false,
      metadata: {
        toolName: fullName,
        isDynamic: true,
        expiresAt,
        ttlMinutes,
      },
    };
  };
}

/**
 * Harness Tool: code_generate - 生成代码
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { scanGeneratedCode } from './codeShared';

export const CODE_GENERATE_DEF: ToolDefinition = {
  name: 'code_generate',
  description:
    '根据需求描述生成代码。适用场景：用户需要新建函数、类、模块、脚本等代码。不适用：修改已有代码（用 incremental_edit）、分析代码（用 code_analyze）。',
  category: ToolCategory.CODE,
  parameters: {
    requirements: {
      type: 'string',
      description:
        '代码需求描述，如"实现一个快速排序函数"、"创建 Express 路由处理器"',
    },
    language: {
      type: 'string',
      description: '目标编程语言，如 typescript、python、java',
    },
    framework: {
      type: 'string',
      description: '目标框架，如 react、express、nestjs',
    },
    complexity: {
      type: 'string',
      description:
        '代码复杂度: simple=简单函数, medium=中等模块, complex=复杂系统',
      enum: ['simple', 'medium', 'complex'],
      default: 'medium',
    },
  },
  requiredParams: ['requirements', 'language'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'medium',
  idempotent: false,
  timeout: 30000,
  requiresConfirmation: true,
};

/** code_generate 依赖接口 */
export interface CodeGenerateDeps {
  generateCode?: (params: {
    requirements: string;
    language: string;
    framework?: string;
    complexity?: string;
  }) => Promise<{
    code: string;
    language: string;
    explanation?: string;
  }>;
}

/** 创建 code_generate 执行器 */
export function createCodeGenerateExecutor(deps: CodeGenerateDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const requirements = String(params.requirements || '');
    const language = String(params.language || 'typescript');
    const framework = params.framework as string | undefined;
    const complexity = (params.complexity as string) || 'medium';

    if (!deps.generateCode) {
      // 审计 P2-9：原先在此返回 success:true 的 TODO 模板（假成功 / 静默降级）。
      // 代码生成已由 Python 真后端承接，TS harness 不再伪造成功结果。
      return {
        success: false,
        output: '',
        error:
          'code_generate 不可用：代码生成已由 Python 真后端承接，TS harness 未注入 generateCode 实现。',
        duration: 0,
        validated: false,
        metadata: { language, fallback: false },
      };
    }

    try {
      const result = await deps.generateCode({
        requirements,
        language,
        framework,
        complexity,
      });

      const output = result.explanation
        ? `${result.explanation}\n\n\`\`\`${result.language}\n${result.code}\n\`\`\``
        : `\`\`\`${result.language}\n${result.code}\n\`\`\``;

      // D3: 生成物安全扫描（与 code_fix 共用中间件）
      const scan = scanGeneratedCode(result.code);
      if (scan.warnings.length > 0) {
        Logger.warn(
          `🔍 D3: code_generate 安全扫描告警: ${scan.warnings.join('; ')}`,
          'CodeGenerate'
        );
      }

      return {
        success: true,
        output,
        duration: 0,
        validated: false,
        metadata: {
          language: result.language,
          codeLength: result.code.length,
          securityWarnings: scan.warnings,
          secretHits: scan.secrets,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: `代码生成失败: ${(error as Error).message}`,
        error: (error as Error).message,
        duration: 0,
        validated: false,
      };
    }
  };
}

function generateCodeTemplate(
  requirements: string,
  language: string,
  framework?: string,
  complexity?: string
): string {
  const name = extractIdentifierName(requirements);
  const lang = language.toLowerCase();

  if (['typescript', 'ts', 'javascript', 'js'].includes(lang)) {
    return generateTsTemplate(name, requirements, framework, complexity);
  }

  if (['python', 'py'].includes(lang)) {
    return generatePyTemplate(name, requirements, complexity);
  }

  return generateGenericTemplate(name, requirements, language);
}

function extractIdentifierName(requirements: string): string {
  const match = requirements.match(
    /(?:实现|创建|编写|生成|开发|implement|create|build|write)\s+(?:一个\s+)?(\S+)/
  );
  if (match) {
    let name = match[1];
    name = name.replace(/[的之]/g, '');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const words = requirements.split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function generateTsTemplate(
  name: string,
  requirements: string,
  framework?: string,
  complexity?: string
): string {
  const isComplex = complexity === 'complex';
  const className = toPascalCase(name);

  if (isComplex) {
    return `/**
 * ${requirements}
 */
export class ${className} {
  private _initialized: boolean = false;

  constructor() {
    this._initialized = true;
  }

  /**
   * 初始化
   */
  public async initialize(): Promise<void> {
    // TODO: 实现初始化逻辑
  }

  /**
   * 执行核心逻辑
   * @param input - 输入参数
   * @returns 处理结果
   */
  public async execute(input: unknown): Promise<unknown> {
    // TODO: 实现核心逻辑
    return input;
  }

  /**
   * 清理资源
   */
  public async dispose(): Promise<void> {
    this._initialized = false;
  }
}

export default ${className};`;
  }

  const fnName = toCamelCase(name);
  const fw = framework ? ` // ${framework}` : '';
  return `/**
 * ${requirements}
 * @param input - 输入参数
 * @returns 处理结果
 */
export async function ${fnName}(input: unknown): Promise<unknown> {
  // TODO: 实现逻辑${fw}
  return input;
}

export default ${fnName};`;
}

function generatePyTemplate(
  name: string,
  requirements: string,
  complexity?: string
): string {
  const isComplex = complexity === 'complex';
  const className = toPascalCase(name);

  if (isComplex) {
    return `"""${requirements}"""


class ${className}:
    """${requirements}"""

    def __init__(self) -> None:
        self._initialized: bool = False

    async def initialize(self) -> None:
        """初始化"""
        self._initialized = True

    async def execute(self, input_data: object) -> object:
        """执行核心逻辑

        Args:
            input_data: 输入参数

        Returns:
            处理结果
        """
        # TODO: 实现核心逻辑
        return input_data

    async def dispose(self) -> None:
        """清理资源"""
        self._initialized = False
`;
  }

  const fnName = toSnakeCase(name);
  return `"""${requirements}"""


async def ${fnName}(input_data: object) -> object:
    """${requirements}

    Args:
        input_data: 输入参数

    Returns:
        处理结果
    """
    # TODO: 实现逻辑
    return input_data
`;
}

function generateGenericTemplate(
  name: string,
  requirements: string,
  language: string
): string {
  const fnName = toCamelCase(name);
  return `// ${requirements}
// Language: ${language}

function ${fnName}(input) {
  // TODO: 实现逻辑
  return input;
}
`;
}

function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Harness Layer 2: Tools - 工具注册表
 *
 * 声明式工具注册 + Schema 验证 + 权限检查
 * 替代 SkillRegistry 的基础设施工具注册功能
 */

import { Logger } from '../../../utils/Logger';
import { perf } from '../../../monitoring/PerformanceMonitor';
import { ToolCategory } from '../../types';
import type {
  ToolDefinition,
  ToolParameterDef,
  ToolResult,
  ToolContext,
  RegisteredTool,
  RiskLevel,
  StructuredToolOutput,
} from '../../types';

/** OpenAI Function Calling 工具格式 */
interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/** 发现的工具描述 */
export interface DiscoveredTool {
  name: string;
  command: string;
  description: string;
  version?: string;
  category: ToolCategory;
  parameters: Array<{
    name: string;
    description: string;
    required: boolean;
    type: 'string' | 'number' | 'boolean';
  }>;
  examples: string[];
  riskLevel: RiskLevel;
  lastDiscovered: number;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  /** toOpenAITools() 缓存 */
  private cachedOpenAITools: OpenAIToolDef[] | null = null;

  /**
   * 注册工具
   */
  register(
    definition: ToolDefinition,
    execute: (
      params: Record<string, unknown>,
      context: ToolContext
    ) => Promise<ToolResult>
  ): void {
    if (this.tools.has(definition.name)) {
      Logger.debug(
        `工具已存在，跳过重复注册: ${definition.name}`,
        'ToolRegistry'
      );
      return;
    }

    this.tools.set(definition.name, { definition, execute });
    this.cachedOpenAITools = null;

    Logger.info(
      `🔧 注册工具: ${definition.name} [${definition.category}] 风险=${definition.riskLevel}`,
      'ToolRegistry'
    );
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.cachedOpenAITools = null;
      Logger.info(`🔧 注销工具: ${name}`, 'ToolRegistry');
    }
    return removed;
  }

  /**
   * 获取已注册工具
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册工具
   */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 按分类获取工具
   */
  getByCategory(category: ToolCategory): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.category === category
    );
  }

  /**
   * 按风险等级获取工具
   */
  getByRiskLevel(riskLevel: RiskLevel): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.definition.riskLevel === riskLevel
    );
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 执行工具调用
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `工具不存在: ${name}`,
        duration: 0,
        validated: false,
      };
    }

    const startTime = Date.now();
    try {
      Logger.info(
        `🧠 执行工具: ${name} | 风险=${tool.definition.riskLevel}`,
        'ToolRegistry'
      );

      // 超时控制
      const result = await perf.measure(
        `tool.${name}`,
        () =>
          Promise.race([
            tool.execute(params, context),
            this.createTimeoutPromise(tool.definition.timeout, name),
          ]),
        'tool'
      );

      const finalResult: ToolResult = {
        ...result,
        duration: Date.now() - startTime,
        validated: result.validated ?? false,
      };

      // Harness Engineering: 输出标准化 + Hashline 锚点
      this.standardizeToolResult(finalResult, name);

      this.reliabilityTracker.recordCall(
        name,
        finalResult.success,
        finalResult.duration,
        finalResult.error
      );

      return finalResult;
    } catch (err) {
      const errorResult: ToolResult = {
        success: false,
        output: null,
        error: (err as Error).message,
        duration: Date.now() - startTime,
        validated: false,
      };

      // 错误结果也做标准化
      this.standardizeToolResult(errorResult, name);

      this.reliabilityTracker.recordCall(
        name,
        false,
        errorResult.duration,
        errorResult.error
      );

      return errorResult;
    }
  }

  /**
   * 执行 LLM 返回的 tool call
   */
  async executeToolCall(
    toolCall: {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    },
    context: ToolContext
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    return this.execute(toolName, args, context);
  }

  /**
   * 转换为 OpenAI Function Calling 工具格式
   * 进化闭环：按综合评分排序（成功率 × 进化权重），权重差异注入 description
   */
  toOpenAITools(): OpenAIToolDef[] {
    if (this.cachedOpenAITools) return this.cachedOpenAITools;

    const tools: OpenAIToolDef[] = [];

    const categoryOrder: ToolCategory[] = [
      ToolCategory.COGNITION,
      ToolCategory.MEMORY,
      ToolCategory.DAILY,
      ToolCategory.NETWORK,
      ToolCategory.SYSTEM,
      ToolCategory.FILE,
      ToolCategory.CODE,
      ToolCategory.DESKTOP,
    ];

    const sorted = Array.from(this.tools.values()).sort((a, b) => {
      const ai = categoryOrder.indexOf(a.definition.category);
      const bi = categoryOrder.indexOf(b.definition.category);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);

      const scoreA = this.reliabilityTracker.getCompositeScore(
        a.definition.name
      );
      const scoreB = this.reliabilityTracker.getCompositeScore(
        b.definition.name
      );
      return scoreB - scoreA;
    });

    const avgCompositeScore =
      sorted.length > 0
        ? sorted.reduce(
            (sum, t) =>
              sum +
              this.reliabilityTracker.getCompositeScore(t.definition.name),
            0
          ) / sorted.length
        : 1.0;

    for (const tool of sorted) {
      const properties: Record<string, unknown> = {};
      for (const [paramName, paramDef] of Object.entries(
        tool.definition.parameters
      )) {
        properties[paramName] = this.parameterDefToOpenAI(paramDef);
      }

      const compositeScore = this.reliabilityTracker.getCompositeScore(
        tool.definition.name
      );
      const evolutionWeight = this.reliabilityTracker.getEvolutionWeight(
        tool.definition.name
      );
      let description = tool.definition.description;

      if (evolutionWeight !== 1.0 || compositeScore < avgCompositeScore * 0.8) {
        if (evolutionWeight > 1.0) {
          description += ` [推荐:进化权重${evolutionWeight.toFixed(2)}]`;
        } else if (evolutionWeight < 1.0) {
          description += ` [慎用:进化权重${evolutionWeight.toFixed(2)}]`;
        }
        if (compositeScore < 0.5) {
          description += ` [低可靠度:${(compositeScore * 100).toFixed(0)}%]`;
        }
      }

      tools.push({
        type: 'function',
        function: {
          name: tool.definition.name,
          description,
          parameters: {
            type: 'object',
            properties,
            required: tool.definition.requiredParams,
          },
        },
      });
    }

    this.cachedOpenAITools = tools;
    return tools;
  }

  /**
   * 将 ToolParameterDef 转换为 OpenAI Schema 格式
   */
  private parameterDefToOpenAI(
    param: ToolParameterDef
  ): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };

    if (param.enum) {
      schema.enum = param.enum;
    }

    if (param.default !== undefined) {
      schema.default = param.default;
    }

    if (param.type === 'array' && param.items) {
      schema.items = this.parameterDefToOpenAI(param.items);
    }

    if (param.type === 'object' && param.properties) {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(param.properties)) {
        props[key] = this.parameterDefToOpenAI(val);
      }
      schema.properties = props;
    }

    return schema;
  }

  /**
   * 创建超时 Promise
   */
  private createTimeoutPromise(
    timeoutMs: number,
    toolName: string
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`工具执行超时: ${toolName} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  /**
   * 清除缓存（注册/注销后自动调用，也可手动调用）
   */
  invalidateCache(): void {
    this.cachedOpenAITools = null;
  }

  private reliabilityTracker = new ToolReliabilityTracker();

  /**
   * 获取工具可靠性追踪器
   */
  getReliabilityTracker(): ToolReliabilityTracker {
    return this.reliabilityTracker;
  }

  // ==================== Harness Engineering: 输出标准化 ====================

  /**
   * 标准化工具执行结果
   * 借鉴 Hashline 格式：为输出添加行号+内容哈希锚点
   * 让 LLM 能精确引用工具输出的特定行/段
   *
   * @param result - 工具执行结果（会被原地修改）
   * @param toolName - 工具名称（用于判断输出类型）
   */
  private standardizeToolResult(result: ToolResult, toolName: string): void {
    // 如果工具已经提供了 structuredOutput，跳过自动标准化
    if (result.structuredOutput) return;

    const output = result.output;

    // 生成内容哈希锚点
    result.contentHash = this.computeContentHash(output);

    // 根据工具类型和输出内容推断结构化类型
    const structuredType = this.inferOutputType(toolName, output);

    // 将 output 转为字符串
    const contentStr = this.outputToString(output);
    if (!contentStr) {
      result.structuredOutput = {
        type: result.success ? 'text' : 'error',
        content: result.success ? '(无输出)' : (result.error || '未知错误'),
      };
      return;
    }

    // 生成带锚点的行内容（Hashline 格式）
    const lines = contentStr.split('\n');
    const anchoredLines = lines.slice(0, 200).map((line, index) => ({
      line: index + 1,
      hash: this.computeLineHash(line),
      content: line,
    }));

    // 生成摘要（前5行 + 总行数）
    const summaryLines = lines.slice(0, 5);
    const summary = summaryLines.join('\n') +
      (lines.length > 5 ? `\n... (共${lines.length}行)` : '');

    // 截断信息
    const truncation = contentStr.length > 50000 ? {
      truncated: true,
      originalLength: contentStr.length,
      truncatedLength: 50000,
    } : undefined;

    result.structuredOutput = {
      type: structuredType,
      content: contentStr.length > 50000
        ? contentStr.substring(0, 50000) + '\n... (内容已截断)'
        : contentStr,
      summary,
      anchoredLines,
      totalLines: lines.length,
      truncation,
      schemaType: this.inferSchemaType(toolName),
    };
  }

  /**
   * 推断输出类型
   */
  private inferOutputType(
    toolName: string,
    output: unknown
  ): StructuredToolOutput['type'] {
    if (!output) return 'text';

    // 文件类工具 → file_content
    if (toolName.startsWith('file_')) return 'file_content';

    // 列表类工具 → list
    if (Array.isArray(output)) return 'list';

    // JSON 对象 → json
    if (typeof output === 'object' && output !== null) {
      try {
        JSON.stringify(output);
        return 'json';
      } catch {
        return 'text';
      }
    }

    return 'text';
  }

  /**
   * 推断输出 schema 类型名
   */
  private inferSchemaType(toolName: string): string {
    const schemaMap: Record<string, string> = {
      file_read: 'FileContent',
      file_list: 'DirectoryListing',
      file_search: 'SearchResults',
      file_grep: 'GrepMatches',
      web_fetch: 'WebPageContent',
      web_search: 'SearchResults',
      memory_store: 'MemoryStoreResult',
      memory_search: 'MemorySearchResults',
      memory_recall: 'MemoryRecallResults',
      code_analyze: 'CodeAnalysisResult',
      code_review: 'CodeReviewResult',
      code_generate: 'GeneratedCode',
      code_fix: 'CodeFixResult',
      shell_exec: 'ShellOutput',
      desktop_screenshot: 'ScreenshotInfo',
      desktop_automate: 'AutomationResult',
    };
    return schemaMap[toolName] || 'ToolOutput';
  }

  /**
   * 将 output 转为字符串
   */
  private outputToString(output: unknown): string {
    if (output === null || output === undefined) return '';
    if (typeof output === 'string') return output;
    if (typeof output === 'number' || typeof output === 'boolean') {
      return String(output);
    }
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }

  /**
   * 计算内容哈希（用于锚点标识）
   * 使用简单的 DJB2 哈希算法
   */
  private computeContentHash(output: unknown): string {
    const str = this.outputToString(output);
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 计算单行内容的哈希（Hashline 格式）
   */
  private computeLineHash(line: string): string {
    let hash = 5381;
    for (let i = 0; i < line.length; i++) {
      hash = ((hash << 5) + hash + line.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(16).substring(0, 8);
  }

  // ==================== Harness Engineering: 自动工具发现 ====================

  /** 已发现的系统工具缓存 */
  private discoveredTools: Map<string, DiscoveredTool> = new Map();
  /** 是否已执行过工具发现 */
  private discoveryCompleted = false;

  /**
   * 扫描系统中可用的 CLI 工具
   * 借鉴 CLI-Anything 的思路：检测已安装软件，生成标准化工具描述
   *
   * @param force - 是否强制重新扫描
   * @returns 发现的工具列表
   */
  async discoverSystemTools(force = false): Promise<DiscoveredTool[]> {
    if (this.discoveryCompleted && !force) {
      return Array.from(this.discoveredTools.values());
    }

    Logger.info('🔍 开始自动工具发现...', 'ToolRegistry');
    const startTime = Date.now();

    try {
      // 常见开发工具列表（跨平台）
      const toolCandidates = [
        { command: 'git', name: 'git', desc: '版本控制工具' },
        { command: 'npm', name: 'npm', desc: 'Node.js 包管理器' },
        { command: 'node', name: 'node', desc: 'Node.js 运行时' },
        { command: 'python3', name: 'python3', desc: 'Python 解释器' },
        { command: 'python', name: 'python', desc: 'Python 解释器' },
        { command: 'pip', name: 'pip', desc: 'Python 包管理器' },
        { command: 'docker', name: 'docker', desc: '容器运行时' },
        { command: 'docker-compose', name: 'docker-compose', desc: 'Docker 编排工具' },
        { command: 'curl', name: 'curl', desc: 'HTTP 请求工具' },
        { command: 'wget', name: 'wget', desc: '文件下载工具' },
        { command: 'grep', name: 'grep', desc: '文本搜索工具' },
        { command: 'find', name: 'find', desc: '文件查找工具' },
        { command: 'ls', name: 'ls', desc: '目录列出工具' },
        { command: 'cat', name: 'cat', desc: '文件内容查看' },
        { command: 'code', name: 'vscode', desc: 'VS Code 编辑器' },
        { command: 'java', name: 'java', desc: 'Java 运行时' },
        { command: 'mvn', name: 'maven', desc: 'Maven 构建工具' },
        { command: 'gradle', name: 'gradle', desc: 'Gradle 构建工具' },
        { command: 'go', name: 'go', desc: 'Go 工具链' },
        { command: 'rustc', name: 'rust', desc: 'Rust 编译器' },
        { command: 'cargo', name: 'cargo', desc: 'Rust 包管理器' },
        { command: 'make', name: 'make', desc: 'Make 构建工具' },
        { command: 'cmake', name: 'cmake', desc: 'CMake 构建系统' },
        { command: 'ssh', name: 'ssh', desc: 'SSH 远程连接' },
        { command: 'scp', name: 'scp', desc: 'SCP 文件传输' },
        { command: 'rsync', name: 'rsync', desc: '文件同步工具' },
        { command: 'tar', name: 'tar', desc: '归档压缩工具' },
        { command: 'unzip', name: 'unzip', desc: 'ZIP 解压工具' },
        { command: 'openssl', name: 'openssl', desc: '加密/证书工具' },
        { command: 'jq', name: 'jq', desc: 'JSON 处理工具' },
        { command: 'yq', name: 'yq', desc: 'YAML 处理工具' },
        { command: 'sed', name: 'sed', desc: '流编辑器' },
        { command: 'awk', name: 'awk', desc: '文本处理语言' },
        { command: 'wc', name: 'wc', desc: '字数统计工具' },
        { command: 'sort', name: 'sort', desc: '排序工具' },
        { command: 'head', name: 'head', desc: '查看文件头部' },
        { command: 'tail', name: 'tail', desc: '查看文件尾部' },
        { command: 'less', name: 'less', desc: '分页查看器' },
        { command: 'top', name: 'top', desc: '进程监控器' },
        { command: 'ps', name: 'ps', desc: '进程状态查看' },
        { command: 'netstat', name: 'netstat', desc: '网络状态查看' },
        { command: 'ping', name: 'ping', desc: '网络连通性测试' },
        { command: 'nslookup', name: 'nslookup', desc: 'DNS 查询工具' },
        { command: 'whois', name: 'whois', desc: '域名信息查询' },
        { command: 'ffmpeg', name: 'ffmpeg', desc: '音视频处理工具' },
        { command: 'imagemagick', name: 'imagemagick', desc: '图像处理工具' },
        { command: 'pandoc', name: 'pandoc', desc: '文档格式转换' },
        { command: 'sqlite3', name: 'sqlite3', desc: 'SQLite 数据库客户端' },
        { command: 'redis-cli', name: 'redis-cli', desc: 'Redis 客户端' },
        { command: 'mysql', name: 'mysql', desc: 'MySQL 客户端' },
        { command: 'pg_dump', name: 'pg_dump', desc: 'PostgreSQL 备份工具' },
      ];

      // 并发检测哪些工具可用
      const detectionResults = await Promise.allSettled(
        toolCandidates.map((candidate) =>
          this.detectToolAvailability(candidate)
        )
      );

      const discovered: DiscoveredTool[] = [];
      for (const result of detectionResults) {
        if (result.status === 'fulfilled' && result.value) {
          this.discoveredTools.set(result.value.name, result.value);
          discovered.push(result.value);
        }
      }

      this.discoveryCompleted = true;
      Logger.info(
        `✅ 工具发现完成: ${discovered.length} 个可用工具 (${Date.now() - startTime}ms)`,
        'ToolRegistry'
      );

      return discovered;
    } catch (error) {
      Logger.error(
        '工具发现失败',
        error as Error,
        'ToolRegistry'
      );
      return [];
    }
  }

  /**
   * 检测单个工具是否可用
   */
  private async detectToolAvailability(candidate: {
    command: string;
    name: string;
    desc: string;
  }): Promise<DiscoveredTool | null> {
    try {
      const { execSync } = await import('child_process');

      // 尝试获取版本信息
      let version: string | undefined;
      try {
        const versionOutput = execSync(`${candidate.command} --version`, {
          timeout: 3000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        version = versionOutput.split('\n')[0].substring(0, 100);
      } catch {
        // 无法获取版本，但工具可能仍可用
      }

      // 确定风险等级和类别
      const dangerousCommands = new Set([
        'rm', 'dd', 'mkfs', 'shutdown', 'reboot',
        'chmod', 'chown', 'sudo', 'su',
      ]);
      const networkCommands = new Set([
        'curl', 'wget', 'ssh', 'scp', 'rsync',
        'nslookup', 'whois', 'ping', 'netstat',
      ]);

      const riskLevel: RiskLevel = dangerousCommands.has(candidate.command)
        ? 'critical'
        : networkCommands.has(candidate.command)
        ? 'medium'
        : 'low';

      const category = networkCommands.has(candidate.command)
        ? ToolCategory.NETWORK
        : candidate.command === 'git'
        ? ToolCategory.CODE
        : ToolCategory.SYSTEM;

      return {
        name: candidate.name,
        command: candidate.command,
        description: candidate.desc,
        version,
        category,
        parameters: this.inferParameters(candidate.command),
        examples: this.generateExamples(candidate.command),
        riskLevel,
        lastDiscovered: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 根据命令名推断常用参数
   */
  private inferParameters(command: string): Array<{
    name: string;
    description: string;
    required: boolean;
    type: 'string' | 'number' | 'boolean';
  }> {
    const commonParams = [
      { name: 'args', description: `${command} 命令参数`, required: true, type: 'string' as const },
    ];

    const paramMap: Record<string, Array<{
      name: string;
      description: string;
      required: boolean;
      type: 'string' | 'number' | 'boolean';
    }>> = {
      git: [
        { name: 'args', description: 'Git 命令参数', required: true, type: 'string' },
      ],
      npm: [
        { name: 'args', description: 'NPM 命令参数', required: true, type: 'string' },
      ],
      docker: [
        { name: 'args', description: 'Docker 命令参数', required: true, type: 'string' },
      ],
      curl: [
        { name: 'url', description: '请求 URL', required: true, type: 'string' },
        { name: 'method', description: 'HTTP 方法 (GET/POST/PUT/DELETE)', required: false, type: 'string' },
        { name: 'data', description: '请求数据', required: false, type: 'string' },
      ],
      grep: [
        { name: 'pattern', description: '搜索模式', required: true, type: 'string' },
        { name: 'path', description: '搜索路径', required: false, type: 'string' },
      ],
      find: [
        { name: 'path', description: '搜索路径', required: false, type: 'string' },
        { name: 'name', description: '文件名模式', required: false, type: 'string' },
      ],
      python: [
        { name: 'script', description: 'Python 脚本路径', required: true, type: 'string' },
        { name: 'args', description: '脚本参数', required: false, type: 'string' },
      ],
      node: [
        { name: 'script', description: 'JS 脚本路径', required: true, type: 'string' },
        { name: 'args', description: '脚本参数', required: false, type: 'string' },
      ],
    };

    return paramMap[command] || commonParams;
  }

  /**
   * 生成示例用法
   */
  private generateExamples(command: string): string[] {
    const exampleMap: Record<string, string[]> = {
      git: ['git status', 'git log -10', 'git diff HEAD~1'],
      npm: ['npm list --depth=0', 'npm run build', 'npm install <package>'],
      docker: ['docker ps', 'docker images', 'docker run -d <image>'],
      curl: ['curl https://example.com', 'curl -X POST https://api.example.com/data'],
      grep: ['grep "pattern" file.txt', 'grep -r "pattern" ./src'],
      find: ['find . -name "*.ts"', 'find . -type f -mtime -7'],
      python: ['python script.py', 'python -m pip list'],
      node: ['node server.js', 'node --version'],
      cat: ['cat file.txt'],
      ls: ['ls -la', 'ls src/'],
      wc: ['wc -l file.txt', 'wc -w file.txt'],
    };

    return exampleMap[command] || [`${command} --help`];
  }

  /**
   * 将发现的工具注册到 ToolRegistry
   *
   * @param toolNames - 要注册的工具名称（空则全部注册）
   * @returns 成功注册的数量
   */
  async registerDiscoveredTools(toolNames?: string[]): Promise<number> {
    const discovered = await this.discoverSystemTools();
    const toRegister = toolNames
      ? discovered.filter((t) => toolNames.includes(t.name))
      : discovered;

    let registeredCount = 0;

    for (const tool of toRegister) {
      if (this.tools.has(tool.name)) continue;

      const toolDef: ToolDefinition = {
        name: tool.name,
        description: `[系统CLI] ${tool.description}` +
          (tool.version ? ` (v${tool.version})` : '') +
          `\n\n通过 shell_exec 调用 ${tool.command} 命令。\n` +
          `示例: ${tool.examples.slice(0, 2).join(' | ')}`,
        category: tool.category,
        parameters: {
          args: {
            type: 'string',
            description: `${tool.command} 命令参数`,
          },
        },
        requiredParams: ['args'],
        requiredPermissions: [],
        riskLevel: tool.riskLevel,
        idempotent: false,
        timeout: 30000,
      };

      const command = tool.command;

      this.register(toolDef, async (_params: Record<string, unknown>, _context: ToolContext) => {
        const args = _params.args || '';

        const { execSync } = await import('child_process');
        try {
          const output = execSync(`${command} ${String(args)}`, {
            timeout: 30000,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          });

          return {
            success: true,
            output: output.trim().substring(0, 10000),
            duration: 0,
            validated: true,
          };
        } catch (execError) {
          return {
            success: false,
            output: null,
            error: `${command} 执行失败: ${(execError as Error).message}`,
            duration: 0,
            validated: false,
          };
        }
      });

      registeredCount++;
    }

    if (registeredCount > 0) {
      Logger.info(
        `📦 自动注册了 ${registeredCount} 个系统工具`,
        'ToolRegistry'
      );
    }

    return registeredCount;
  }

  /**
   * 获取所有已发现的工具
   */
  getDiscoveredTools(): DiscoveredTool[] {
    return Array.from(this.discoveredTools.values());
  }
}

export class ToolReliabilityTracker {
  private stats: Map<
    string,
    {
      calls: number;
      successes: number;
      totalDuration: number;
      lastError?: string;
    }
  > = new Map();
  private evolutionWeights: Map<string, number> = new Map();

  /**
   * 应用进化引擎产出的技能权重调整
   * 权重影响工具推荐排序：权重越高越优先推荐
   */
  applyEvolutionWeights(weights: Record<string, number>): void {
    for (const [toolName, weight] of Object.entries(weights)) {
      this.evolutionWeights.set(toolName, weight);
    }
    Logger.info(
      `🔧 进化权重已应用: ${Object.keys(weights).join(', ') || '(无变更)'}`,
      'ToolReliabilityTracker'
    );
  }

  /**
   * 获取所有进化权重（用于外部消费）
   */
  getEvolutionWeights(): Map<string, number> {
    return new Map(this.evolutionWeights);
  }

  /**
   * 获取工具的进化权重（用于推荐排序）
   */
  getEvolutionWeight(toolName: string): number {
    return this.evolutionWeights.get(toolName) ?? 1.0;
  }

  /**
   * 获取综合评分（成功率 × 进化权重）
   */
  getCompositeScore(toolName: string): number {
    const successRate = this.getSuccessRate(toolName);
    const weight = this.getEvolutionWeight(toolName);
    return successRate * weight;
  }

  /**
   * 记录工具调用结果
   * @param toolName - 工具名称
   * @param success - 是否成功
   * @param duration - 执行时长(ms)
   * @param error - 错误信息
   */
  recordCall(
    toolName: string,
    success: boolean,
    duration: number,
    error?: string
  ): void {
    const existing = this.stats.get(toolName);
    if (existing) {
      existing.calls++;
      if (success) existing.successes++;
      existing.totalDuration += duration;
      if (error) existing.lastError = error;
    } else {
      this.stats.set(toolName, {
        calls: 1,
        successes: success ? 1 : 0,
        totalDuration: duration,
        lastError: error,
      });
    }
  }

  /**
   * 获取工具成功率
   * @param toolName - 工具名称
   * @returns 成功率 (0-1)
   */
  getSuccessRate(toolName: string): number {
    const stat = this.stats.get(toolName);
    if (!stat || stat.calls === 0) return 1.0; // 新工具默认满分，不惩罚未调用过的工具
    return stat.successes / stat.calls;
  }

  /**
   * 获取工具平均执行时长
   * @param toolName - 工具名称
   * @returns 平均时长(ms)
   */
  getAverageDuration(toolName: string): number {
    const stat = this.stats.get(toolName);
    if (!stat || stat.calls === 0) return 0;
    return stat.totalDuration / stat.calls;
  }

  /**
   * 获取不可靠工具列表（成功率低于阈值）
   * @param threshold - 成功率阈值，默认0.9
   * @returns 不可靠工具名称列表
   */
  getUnreliableTools(threshold: number = 0.9): string[] {
    const unreliable: string[] = [];
    for (const [toolName, stat] of this.stats) {
      if (stat.calls > 0 && stat.successes / stat.calls < threshold) {
        unreliable.push(toolName);
      }
    }
    return unreliable;
  }

  /**
   * 获取单个工具统计信息
   * @param toolName - 工具名称
   * @returns 统计信息或null
   */
  getStats(toolName: string): {
    calls: number;
    successes: number;
    successRate: number;
    avgDuration: number;
    lastError?: string;
  } | null {
    const stat = this.stats.get(toolName);
    if (!stat) return null;
    return {
      calls: stat.calls,
      successes: stat.successes,
      successRate: stat.calls > 0 ? stat.successes / stat.calls : 0,
      avgDuration: stat.calls > 0 ? stat.totalDuration / stat.calls : 0,
      lastError: stat.lastError,
    };
  }

  /**
   * 获取所有工具统计信息
   * @returns 所有工具统计信息映射
   */
  getAllStats(): Map<
    string,
    {
      calls: number;
      successes: number;
      successRate: number;
      avgDuration: number;
      lastError?: string;
    }
  > {
    const result = new Map<
      string,
      {
        calls: number;
        successes: number;
        successRate: number;
        avgDuration: number;
        lastError?: string;
      }
    >();
    for (const [toolName, stat] of this.stats) {
      result.set(toolName, {
        calls: stat.calls,
        successes: stat.successes,
        successRate: stat.calls > 0 ? stat.successes / stat.calls : 0,
        avgDuration: stat.calls > 0 ? stat.totalDuration / stat.calls : 0,
        lastError: stat.lastError,
      });
    }
    return result;
  }

  /**
   * 重置所有统计信息
   */
  reset(): void {
    this.stats.clear();
  }
}

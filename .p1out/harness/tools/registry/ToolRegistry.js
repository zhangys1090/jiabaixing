"use strict";
/**
 * Harness Layer 2: Tools - 工具注册表
 *
 * 声明式工具注册 + Schema 验证 + 权限检查
 * 替代 SkillRegistry 的基础设施工具注册功能
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolReliabilityTracker = exports.ToolRegistry = void 0;
const PerformanceMonitor_1 = require("../../../monitoring/PerformanceMonitor");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
class ToolRegistry {
    constructor() {
        this.tools = new Map();
        /** toOpenAITools() 缓存 */
        this.cachedOpenAITools = null;
        /** Schema 验证器（P0-1: 参数校验接入执行链路） */
        this.schemaValidator = new SchemaValidator();
        /** 权限守卫（P0-2: 权限检查接入执行链路） */
        this.permissionGuard = new PermissionGuard();
        /** 是否启用执行前置校验（默认 true，生产环境可按需关闭） */
        this.enablePreChecks = true;
        this.reliabilityTracker = new ToolReliabilityTracker();
        // ==================== Harness Engineering: 自动工具发现 ====================
        /** 已发现的系统工具缓存 */
        this.discoveredTools = new Map();
        /** 是否已执行过工具发现 */
        this.discoveryCompleted = false;
    }
    /**
     * 注册工具
     */
    register(definition, execute) {
        if (this.tools.has(definition.name)) {
            Logger_1.Logger.debug(`工具已存在，跳过重复注册: ${definition.name}`, 'ToolRegistry');
            return;
        }
        this.tools.set(definition.name, { definition, execute });
        this.cachedOpenAITools = null;
        Logger_1.Logger.info(`🔧 注册工具: ${definition.name} [${definition.category}] 风险=${definition.riskLevel}`, 'ToolRegistry');
    }
    /**
     * 注销工具
     */
    unregister(name) {
        const removed = this.tools.delete(name);
        if (removed) {
            this.cachedOpenAITools = null;
            Logger_1.Logger.info(`🔧 注销工具: ${name}`, 'ToolRegistry');
        }
        return removed;
    }
    /**
     * 获取已注册工具
     */
    get(name) {
        return this.tools.get(name);
    }
    /**
     * 获取所有已注册工具
     */
    getAll() {
        return Array.from(this.tools.values());
    }
    /**
     * 获取所有已注册工具名称列表
     */
    getRegisteredToolNames() {
        return Array.from(this.tools.keys());
    }
    /**
     * 按分类获取工具
     */
    getByCategory(category) {
        return Array.from(this.tools.values()).filter((t) => t.definition.category === category);
    }
    /**
     * 按风险等级获取工具
     */
    getByRiskLevel(riskLevel) {
        return Array.from(this.tools.values()).filter((t) => t.definition.riskLevel === riskLevel);
    }
    /**
     * 按语义标签过滤工具
     */
    getByTags(tags) {
        if (tags.length === 0)
            return [];
        const tagSet = new Set(tags.map((t) => t.toLowerCase()));
        return Array.from(this.tools.values()).filter((t) => t.definition.tags?.some((tag) => tagSet.has(tag.toLowerCase())));
    }
    /**
     * 按场景过滤工具
     */
    getByScene(scene) {
        const s = scene.toLowerCase();
        return Array.from(this.tools.values()).filter((t) => t.definition.scenes?.some((sc) => sc.toLowerCase() === s) ?? false);
    }
    /**
     * 按能力等级过滤（渐进式披露）
     * @param maxLevel 最大暴露等级 (1-3)
     */
    getByCapabilityLevel(maxLevel) {
        return Array.from(this.tools.values()).filter((t) => (t.definition.capabilityLevel ?? 1) <= maxLevel);
    }
    /**
     * 多条件组合过滤：标签 + 场景 + 能力等级
     * 返回的交集满足所有非空条件
     */
    filterBy({ tags, scene, maxCapabilityLevel, excludeCategories, }) {
        let results = Array.from(this.tools.values());
        if (tags && tags.length > 0) {
            const tagSet = new Set(tags.map((t) => t.toLowerCase()));
            results = results.filter((t) => t.definition.tags?.some((tag) => tagSet.has(tag.toLowerCase())));
        }
        if (scene) {
            const s = scene.toLowerCase();
            results = results.filter((t) => t.definition.scenes?.some((sc) => sc.toLowerCase() === s) ?? false);
        }
        if (maxCapabilityLevel) {
            results = results.filter((t) => (t.definition.capabilityLevel ?? 1) <= maxCapabilityLevel);
        }
        if (excludeCategories && excludeCategories.length > 0) {
            const catSet = new Set(excludeCategories);
            results = results.filter((t) => !catSet.has(t.definition.category));
        }
        return results;
    }
    /**
     * 检查工具是否存在
     */
    has(name) {
        return this.tools.has(name);
    }
    /**
     * 获取已注册工具数量
     */
    get size() {
        return this.tools.size;
    }
    /**
     * 执行工具调用
     */
    async execute(name, params, context) {
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
        // P0-1: Schema 参数验证 — 前置拦截非法/缺失参数
        if (this.enablePreChecks) {
            const schemaResult = this.schemaValidator.validate(params, tool.definition.parameters, tool.definition.requiredParams);
            if (!schemaResult.valid) {
                Logger_1.Logger.warn(`🛡️ Schema 验证拒绝: ${name} — ${schemaResult.errors.join('; ')}`, 'ToolRegistry');
                return {
                    success: false,
                    output: null,
                    error: `参数验证失败: ${schemaResult.errors.join('; ')}`,
                    duration: Date.now() - startTime,
                    validated: false,
                    metadata: { schemaErrors: schemaResult.errors },
                };
            }
        }
        // P0-2: 权限检查 — 前置拦截无权限调用
        if (this.enablePreChecks &&
            tool.definition.requiredPermissions.length > 0) {
            const permResult = this.permissionGuard.check(name, tool.definition.requiredPermissions, tool.definition.riskLevel, context);
            if (!permResult.allowed) {
                Logger_1.Logger.warn(`🚫 权限拒绝: ${name} — ${permResult.reason}`, 'ToolRegistry');
                return {
                    success: false,
                    output: null,
                    error: permResult.reason || `权限不足: ${name}`,
                    duration: Date.now() - startTime,
                    validated: false,
                    metadata: {
                        missingPermissions: permResult.missing,
                        policy: permResult.policy,
                    },
                };
            }
        }
        try {
            Logger_1.Logger.info(`🧠 执行工具: ${name} | 风险=${tool.definition.riskLevel}`, 'ToolRegistry');
            // 超时控制 — 使用 AbortController 确保超时定时器可清理
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => {
                abortController.abort();
            }, tool.definition.timeout);
            try {
                const result = await PerformanceMonitor_1.perf.measure(`tool.${name}`, () => tool.execute(params, context), 'tool');
                clearTimeout(timeoutId);
                const finalResult = {
                    ...result,
                    duration: Date.now() - startTime,
                    validated: result.validated ?? false,
                };
                this.standardizeToolResult(finalResult, name);
                this.reliabilityTracker.recordCall(name, finalResult.success, finalResult.duration, finalResult.error);
                return finalResult;
            }
            catch (execErr) {
                clearTimeout(timeoutId);
                if (abortController.signal.aborted) {
                    const timeoutResult = {
                        success: false,
                        output: null,
                        error: `工具执行超时: ${name} (${tool.definition.timeout}ms)`,
                        duration: Date.now() - startTime,
                        validated: false,
                    };
                    this.standardizeToolResult(timeoutResult, name);
                    this.reliabilityTracker.recordCall(name, false, timeoutResult.duration, timeoutResult.error);
                    return timeoutResult;
                }
                throw execErr;
            }
        }
        catch (err) {
            const errorResult = {
                success: false,
                output: null,
                error: err.message,
                duration: Date.now() - startTime,
                validated: false,
            };
            // 错误结果也做标准化
            this.standardizeToolResult(errorResult, name);
            this.reliabilityTracker.recordCall(name, false, errorResult.duration, errorResult.error);
            return errorResult;
        }
    }
    /**
     * 执行 LLM 返回的 tool call
     */
    async executeToolCall(toolCall, context) {
        const toolName = toolCall.function.name;
        let args = {};
        const rawArgs = toolCall.function.arguments;
        try {
            args = JSON.parse(rawArgs);
        }
        catch (parseError) {
            Logger_1.Logger.warn(`⚠️ 工具调用参数JSON解析失败: ${toolName} — ${parseError.message}`, 'ToolRegistry');
            args = this.recoverToolCallArgs(rawArgs, toolName);
        }
        return this.execute(toolName, args, context);
    }
    /**
     * 尝试从格式异常的 tool_call arguments 中恢复参数
     *
     * 常见 LLM 输出问题：
     * - 单引号代替双引号
     * - 尾逗号
     * - 无引号键名
     * - 值中含未转义换行
     */
    recoverToolCallArgs(rawArgs, toolName) {
        if (!rawArgs || typeof rawArgs !== 'string') {
            return {};
        }
        let fixed = rawArgs;
        fixed = fixed.replace(/,\s*([}\]])/g, '$1');
        fixed = fixed.replace(/'/g, '"');
        fixed = fixed.replace(/(\w+)\s*:/g, '"$1":');
        fixed = fixed.replace(/\n/g, '\\n');
        try {
            return JSON.parse(fixed);
        }
        catch {
            Logger_1.Logger.warn(`⚠️ 工具参数恢复也失败: ${toolName}，使用空参数`, 'ToolRegistry');
            return {};
        }
    }
    /**
     * 转换为 OpenAI Function Calling 工具格式
     * 进化闭环：按综合评分排序（成功率 × 进化权重），权重差异注入 description
     */
    toOpenAITools() {
        if (this.cachedOpenAITools)
            return this.cachedOpenAITools;
        const tools = [];
        const categoryOrder = [
            types_1.ToolCategory.COGNITION,
            types_1.ToolCategory.MEMORY,
            types_1.ToolCategory.DAILY,
            types_1.ToolCategory.NETWORK,
            types_1.ToolCategory.SYSTEM,
            types_1.ToolCategory.FILE,
            types_1.ToolCategory.CODE,
            types_1.ToolCategory.DESKTOP,
        ];
        const sorted = Array.from(this.tools.values()).sort((a, b) => {
            const ai = categoryOrder.indexOf(a.definition.category);
            const bi = categoryOrder.indexOf(b.definition.category);
            if (ai !== bi)
                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            const scoreA = this.reliabilityTracker.getCompositeScore(a.definition.name);
            const scoreB = this.reliabilityTracker.getCompositeScore(b.definition.name);
            return scoreB - scoreA;
        });
        const avgCompositeScore = sorted.length > 0
            ? sorted.reduce((sum, t) => sum +
                this.reliabilityTracker.getCompositeScore(t.definition.name), 0) / sorted.length
            : 1.0;
        for (const tool of sorted) {
            const properties = {};
            for (const [paramName, paramDef] of Object.entries(tool.definition.parameters)) {
                properties[paramName] = this.parameterDefToOpenAI(paramDef);
            }
            const compositeScore = this.reliabilityTracker.getCompositeScore(tool.definition.name);
            const evolutionWeight = this.reliabilityTracker.getEvolutionWeight(tool.definition.name);
            let description = tool.definition.description;
            if (evolutionWeight !== 1.0 || compositeScore < avgCompositeScore * 0.8) {
                if (evolutionWeight > 1.0) {
                    description += ` [推荐:进化权重${evolutionWeight.toFixed(2)}]`;
                }
                else if (evolutionWeight < 1.0) {
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
    parameterDefToOpenAI(param) {
        const schema = {
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
            const props = {};
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
    createTimeoutPromise(timeoutMs, toolName) {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`工具执行超时: ${toolName} (${timeoutMs}ms)`));
            }, timeoutMs);
        });
    }
    /**
     * 清除缓存（注册/注销后自动调用，也可手动调用）
     */
    invalidateCache() {
        this.cachedOpenAITools = null;
    }
    /**
     * 获取工具可靠性追踪器
     */
    getReliabilityTracker() {
        return this.reliabilityTracker;
    }
    /**
     * 获取 Schema 验证器
     */
    getSchemaValidator() {
        return this.schemaValidator;
    }
    /**
     * 获取权限守卫
     */
    getPermissionGuard() {
        return this.permissionGuard;
    }
    /**
     * 注入外部 SchemaValidator（覆盖默认实例）
     */
    setSchemaValidator(validator) {
        this.schemaValidator = validator;
    }
    /**
     * 注入外部 PermissionGuard（覆盖默认实例）
     */
    setPermissionGuard(guard) {
        this.permissionGuard = guard;
    }
    /**
     * 启用/禁用执行前置校验（Schema + Permission）
     * 生产环境调试时可临时关闭
     */
    setPreChecksEnabled(enabled) {
        this.enablePreChecks = enabled;
        Logger_1.Logger.info(`🛡️ 执行前置校验: ${enabled ? '已启用' : '已禁用'}`, 'ToolRegistry');
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
    standardizeToolResult(result, toolName) {
        // 如果工具已经提供了 structuredOutput，跳过自动标准化
        if (result.structuredOutput)
            return;
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
                content: result.success ? '(无输出)' : result.error || '未知错误',
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
        const truncation = contentStr.length > 50000
            ? {
                truncated: true,
                originalLength: contentStr.length,
                truncatedLength: 50000,
            }
            : undefined;
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
    inferOutputType(toolName, output) {
        if (!output)
            return 'text';
        // 文件类工具 → file_content
        if (toolName.startsWith('file_'))
            return 'file_content';
        // 列表类工具 → list
        if (Array.isArray(output))
            return 'list';
        // JSON 对象 → json
        if (typeof output === 'object' && output !== null) {
            try {
                JSON.stringify(output);
                return 'json';
            }
            catch {
                return 'text';
            }
        }
        return 'text';
    }
    /**
     * 推断输出 schema 类型名
     */
    inferSchemaType(toolName) {
        const schemaMap = {
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
    outputToString(output) {
        if (output === null || output === undefined)
            return '';
        if (typeof output === 'string')
            return output;
        if (typeof output === 'number' || typeof output === 'boolean') {
            return String(output);
        }
        try {
            return JSON.stringify(output, null, 2);
        }
        catch {
            return String(output);
        }
    }
    /**
     * 计算内容哈希（用于锚点标识）
     * 使用简单的 DJB2 哈希算法
     */
    computeContentHash(output) {
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
    computeLineHash(line) {
        let hash = 5381;
        for (let i = 0; i < line.length; i++) {
            hash = ((hash << 5) + hash + line.charCodeAt(i)) & 0xffffffff;
        }
        return (hash >>> 0).toString(16).substring(0, 8);
    }
    /**
     * 扫描系统中可用的 CLI 工具
     * 借鉴 CLI-Anything 的思路：检测已安装软件，生成标准化工具描述
     *
     * @param force - 是否强制重新扫描
     * @returns 发现的工具列表
     */
    async discoverSystemTools(force = false) {
        if (this.discoveryCompleted && !force) {
            return Array.from(this.discoveredTools.values());
        }
        Logger_1.Logger.info('🔍 开始自动工具发现...', 'ToolRegistry');
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
                {
                    command: 'docker-compose',
                    name: 'docker-compose',
                    desc: 'Docker 编排工具',
                },
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
            const detectionResults = await Promise.allSettled(toolCandidates.map((candidate) => this.detectToolAvailability(candidate)));
            const discovered = [];
            for (const result of detectionResults) {
                if (result.status === 'fulfilled' && result.value) {
                    this.discoveredTools.set(result.value.name, result.value);
                    discovered.push(result.value);
                }
            }
            this.discoveryCompleted = true;
            Logger_1.Logger.info(`✅ 工具发现完成: ${discovered.length} 个可用工具 (${Date.now() - startTime}ms)`, 'ToolRegistry');
            return discovered;
        }
        catch (error) {
            Logger_1.Logger.error('工具发现失败', error, 'ToolRegistry');
            return [];
        }
    }
    /**
     * 检测单个工具是否可用
     */
    async detectToolAvailability(candidate) {
        try {
            const { execSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
            // 尝试获取版本信息
            let version;
            try {
                const versionOutput = execSync(`${candidate.command} --version`, {
                    timeout: 3000,
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'ignore'],
                }).trim();
                version = versionOutput.split('\n')[0].substring(0, 100);
            }
            catch {
                // 无法获取版本，但工具可能仍可用
            }
            // 确定风险等级和类别
            const dangerousCommands = new Set([
                'rm',
                'dd',
                'mkfs',
                'shutdown',
                'reboot',
                'chmod',
                'chown',
                'sudo',
                'su',
            ]);
            const networkCommands = new Set([
                'curl',
                'wget',
                'ssh',
                'scp',
                'rsync',
                'nslookup',
                'whois',
                'ping',
                'netstat',
            ]);
            const riskLevel = dangerousCommands.has(candidate.command)
                ? 'critical'
                : networkCommands.has(candidate.command)
                    ? 'medium'
                    : 'low';
            const category = networkCommands.has(candidate.command)
                ? types_1.ToolCategory.NETWORK
                : candidate.command === 'git'
                    ? types_1.ToolCategory.CODE
                    : types_1.ToolCategory.SYSTEM;
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
        }
        catch {
            return null;
        }
    }
    /**
     * 根据命令名推断常用参数
     */
    inferParameters(command) {
        const commonParams = [
            {
                name: 'args',
                description: `${command} 命令参数`,
                required: true,
                type: 'string',
            },
        ];
        const paramMap = {
            git: [
                {
                    name: 'args',
                    description: 'Git 命令参数',
                    required: true,
                    type: 'string',
                },
            ],
            npm: [
                {
                    name: 'args',
                    description: 'NPM 命令参数',
                    required: true,
                    type: 'string',
                },
            ],
            docker: [
                {
                    name: 'args',
                    description: 'Docker 命令参数',
                    required: true,
                    type: 'string',
                },
            ],
            curl: [
                {
                    name: 'url',
                    description: '请求 URL',
                    required: true,
                    type: 'string',
                },
                {
                    name: 'method',
                    description: 'HTTP 方法 (GET/POST/PUT/DELETE)',
                    required: false,
                    type: 'string',
                },
                {
                    name: 'data',
                    description: '请求数据',
                    required: false,
                    type: 'string',
                },
            ],
            grep: [
                {
                    name: 'pattern',
                    description: '搜索模式',
                    required: true,
                    type: 'string',
                },
                {
                    name: 'path',
                    description: '搜索路径',
                    required: false,
                    type: 'string',
                },
            ],
            find: [
                {
                    name: 'path',
                    description: '搜索路径',
                    required: false,
                    type: 'string',
                },
                {
                    name: 'name',
                    description: '文件名模式',
                    required: false,
                    type: 'string',
                },
            ],
            python: [
                {
                    name: 'script',
                    description: 'Python 脚本路径',
                    required: true,
                    type: 'string',
                },
                {
                    name: 'args',
                    description: '脚本参数',
                    required: false,
                    type: 'string',
                },
            ],
            node: [
                {
                    name: 'script',
                    description: 'JS 脚本路径',
                    required: true,
                    type: 'string',
                },
                {
                    name: 'args',
                    description: '脚本参数',
                    required: false,
                    type: 'string',
                },
            ],
        };
        return paramMap[command] || commonParams;
    }
    /**
     * 生成示例用法
     */
    generateExamples(command) {
        const exampleMap = {
            git: ['git status', 'git log -10', 'git diff HEAD~1'],
            npm: ['npm list --depth=0', 'npm run build', 'npm install <package>'],
            docker: ['docker ps', 'docker images', 'docker run -d <image>'],
            curl: [
                'curl https://example.com',
                'curl -X POST https://api.example.com/data',
            ],
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
    async registerDiscoveredTools(toolNames) {
        const discovered = await this.discoverSystemTools();
        const toRegister = toolNames
            ? discovered.filter((t) => toolNames.includes(t.name))
            : discovered;
        let registeredCount = 0;
        for (const tool of toRegister) {
            if (this.tools.has(tool.name))
                continue;
            const toolDef = {
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
            this.register(toolDef, async (_params, _context) => {
                const args = _params.args || '';
                const { execSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
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
                }
                catch (execError) {
                    return {
                        success: false,
                        output: null,
                        error: `${command} 执行失败: ${execError.message}`,
                        duration: 0,
                        validated: false,
                    };
                }
            });
            registeredCount++;
        }
        if (registeredCount > 0) {
            Logger_1.Logger.info(`📦 自动注册了 ${registeredCount} 个系统工具`, 'ToolRegistry');
        }
        return registeredCount;
    }
    /**
     * 获取所有已发现的工具
     */
    getDiscoveredTools() {
        return Array.from(this.discoveredTools.values());
    }
}
exports.ToolRegistry = ToolRegistry;
class ToolReliabilityTracker {
    constructor() {
        this.stats = new Map();
        this.MAX_STATS = 5000;
        this.evolutionWeights = new Map();
        this.MAX_EVOLUTION_WEIGHTS = 500;
    }
    /**
     * 应用进化引擎产出的技能权重调整
     * 权重影响工具推荐排序：权重越高越优先推荐
     */
    applyEvolutionWeights(weights) {
        for (const [toolName, weight] of Object.entries(weights)) {
            this.evolutionWeights.set(toolName, weight);
        }
        if (this.evolutionWeights.size > this.MAX_EVOLUTION_WEIGHTS) {
            const keysIter = this.evolutionWeights.keys();
            while (this.evolutionWeights.size > this.MAX_EVOLUTION_WEIGHTS) {
                this.evolutionWeights.delete(keysIter.next().value);
            }
        }
        Logger_1.Logger.info(`🔧 进化权重已应用: ${Object.keys(weights).join(', ') || '(无变更)'}`, 'ToolReliabilityTracker');
    }
    /**
     * 获取所有进化权重（用于外部消费）
     */
    getEvolutionWeights() {
        return new Map(this.evolutionWeights);
    }
    /**
     * 获取工具的进化权重（用于推荐排序）
     */
    getEvolutionWeight(toolName) {
        return this.evolutionWeights.get(toolName) ?? 1.0;
    }
    /**
     * 获取综合评分（成功率 × 进化权重）
     */
    getCompositeScore(toolName) {
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
    recordCall(toolName, success, duration, error) {
        const existing = this.stats.get(toolName);
        if (existing) {
            existing.calls++;
            if (success)
                existing.successes++;
            existing.totalDuration += duration;
            if (error)
                existing.lastError = error;
        }
        else {
            if (this.stats.size >= this.MAX_STATS) {
                const oldestKey = this.stats.keys().next().value;
                this.stats.delete(oldestKey);
            }
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
    getSuccessRate(toolName) {
        const stat = this.stats.get(toolName);
        if (!stat || stat.calls === 0)
            return 1.0; // 新工具默认满分，不惩罚未调用过的工具
        return stat.successes / stat.calls;
    }
    /**
     * 获取工具平均执行时长
     * @param toolName - 工具名称
     * @returns 平均时长(ms)
     */
    getAverageDuration(toolName) {
        const stat = this.stats.get(toolName);
        if (!stat || stat.calls === 0)
            return 0;
        return stat.totalDuration / stat.calls;
    }
    /**
     * 获取不可靠工具列表（成功率低于阈值）
     * @param threshold - 成功率阈值，默认0.9
     * @returns 不可靠工具名称列表
     */
    getUnreliableTools(threshold = 0.9) {
        const unreliable = [];
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
    getStats(toolName) {
        const stat = this.stats.get(toolName);
        if (!stat)
            return null;
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
    getAllStats() {
        const result = new Map();
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
    reset() {
        this.stats.clear();
    }
}
exports.ToolReliabilityTracker = ToolReliabilityTracker;

"use strict";
/**
 * 贾百姓技能注册中心
 * 管理所有技能的注册、查找和执行
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillRegistry = void 0;
const Logger_1 = require("../utils/Logger");
class SkillRegistry {
    constructor() {
        this.skills = new Map();
        this.categories = new Set();
        /** 基础设施工具（非技能，由 LLM 自主调用的系统级工具） */
        this.infrastructureTools = new Map();
        /** toOpenAITools() 缓存，注册/注销时失效 */
        this.cachedTools = null;
        /**
         * 轨迹数据（用于技能提取）
         */
        this.extractTrajectories = new Map();
        this.MAX_EXTRACT_TRAJECTORIES = 5000;
    }
    static getInstance() {
        if (!SkillRegistry.instance) {
            SkillRegistry.instance = new SkillRegistry();
        }
        return SkillRegistry.instance;
    }
    /** 重置单例（仅供测试使用） */
    static resetInstance() {
        SkillRegistry.instance = null;
    }
    static reset() {
        SkillRegistry.instance = null;
    }
    /**
     * 注册技能
     */
    register(skill) {
        const name = skill.definition.name;
        if (this.skills.has(name)) {
            Logger_1.Logger.debug(`技能已存在，跳过重复注册: ${name}`, 'SkillRegistry');
            return;
        }
        this.skills.set(name, skill);
        this.categories.add(skill.definition.category);
        this.cachedTools = null;
    }
    /**
     * 批量注册技能
     */
    registerMultiple(skills) {
        skills.forEach((skill) => this.register(skill));
        Logger_1.Logger.info(`已注册 ${this.skills.size} 个技能`, 'SkillRegistry');
    }
    /**
     * 获取技能
     */
    getSkill(name) {
        return this.skills.get(name);
    }
    /**
     * 按类别获取技能
     */
    getSkillsByCategory(category) {
        return Array.from(this.skills.values()).filter((skill) => skill.definition.category === category);
    }
    /**
     * 获取所有技能
     */
    getAllSkills() {
        return Array.from(this.skills.values());
    }
    /**
     * 获取所有类别
     */
    getCategories() {
        return Array.from(this.categories);
    }
    /**
     * 获取技能定义
     */
    getSkillDefinition(name) {
        const skill = this.skills.get(name);
        return skill?.definition;
    }
    /**
     * 获取技能元数据列表（用于外部查询/展示）
     */
    getAllSkillMeta() {
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
        const infraMetas = Array.from(this.infrastructureTools.values()).map((tool) => ({
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
        }));
        return [...infraMetas, ...skillMetas];
    }
    /**
     * 技能自动发现：基于意图文本匹配最合适的技能
     * @param intent 用户意图文本
     * @param topN 返回前N个结果
     */
    discoverSkills(intent, topN = 3) {
        const lowerIntent = intent.toLowerCase();
        const results = [];
        for (const skill of this.skills.values()) {
            const def = skill.definition;
            let score = 0;
            const matchedOn = [];
            const nameWords = def.name.toLowerCase().split(/[\s_-]+/);
            const descWords = def.description.toLowerCase().split(/[\s_]+/);
            const tagWords = (def.tags || []).map((t) => t.toLowerCase());
            const intentWords = lowerIntent.split(/[\s,，、]+/);
            for (const iw of intentWords) {
                if (!iw)
                    continue;
                const expandedWords = new Set([iw]);
                for (const [zh, enWords] of Object.entries(SkillRegistry.zhEnKeywordMap)) {
                    if (iw.includes(zh) || zh.includes(iw)) {
                        enWords.forEach((w) => expandedWords.add(w));
                    }
                }
                for (const ew of expandedWords) {
                    if (nameWords.includes(ew) || def.name.toLowerCase().includes(ew)) {
                        score += 0.5;
                        if (!matchedOn.includes('name'))
                            matchedOn.push('name');
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
                            if (!matchedOn.includes('tag'))
                                matchedOn.push('tag');
                            break;
                        }
                    }
                    if (def.category.toLowerCase().includes(ew)) {
                        score += 0.15;
                        if (!matchedOn.includes('category'))
                            matchedOn.push('category');
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
    async executeSkill(name, params, context) {
        const skill = this.skills.get(name);
        if (!skill) {
            return { success: false, error: `技能不存在: ${name}` };
        }
        // ── 执行前置中间件链 ──
        let actualParams = params;
        try {
            const { getSkillMiddleware } = require('./SkillMiddleware');
            const middleware = getSkillMiddleware();
            const beforeResult = await middleware.runBefore({
                skillName: name,
                params,
                context,
                traceId: context?.traceId,
                userId: context?.userId,
            });
            if (!beforeResult.proceed) {
                return (beforeResult.result || {
                    success: false,
                    error: beforeResult.reason || '被中间件拦截',
                });
            }
            if (beforeResult.params) {
                actualParams = beforeResult.params;
            }
        }
        catch (err) {
            Logger_1.Logger.warn(`Skill 中间件执行失败，继续执行 Skill: ${err.message}`, 'SkillRegistry');
        }
        const validation = await skill.validate(actualParams);
        if (!validation.valid) {
            return {
                success: false,
                error: `参数验证失败: ${validation.errors.join(', ')}`,
            };
        }
        const startTime = Date.now();
        try {
            Logger_1.Logger.info(`🔧 执行技能: ${name}`, 'SkillRegistry');
            const result = await skill.execute(actualParams, context);
            const duration = Date.now() - startTime;
            Logger_1.Logger.info(`✅ 技能执行完成: ${name}, 成功=${result.success}`, 'SkillRegistry');
            // ── 执行后置中间件链 ──
            try {
                const { getSkillMiddleware } = require('./SkillMiddleware');
                const middleware = getSkillMiddleware();
                await middleware.runAfter({
                    skillName: name,
                    params: actualParams,
                    context,
                    result,
                    duration,
                    traceId: context?.traceId,
                    userId: context?.userId,
                });
            }
            catch (err) {
                Logger_1.Logger.warn(`Skill 后置中间件执行失败: ${err.message}`, 'SkillRegistry');
            }
            return result;
        }
        catch (error) {
            const duration = Date.now() - startTime;
            Logger_1.Logger.error(`❌ 技能执行失败: ${name}`, error, 'SkillRegistry');
            // 执行后置中间件（即使失败也执行）
            try {
                const { getSkillMiddleware } = require('./SkillMiddleware');
                const middleware = getSkillMiddleware();
                await middleware.runAfter({
                    skillName: name,
                    params: actualParams,
                    context,
                    result: { success: false, error: error.message },
                    duration,
                    traceId: context?.traceId,
                    userId: context?.userId,
                });
            }
            catch (err) {
                Logger_1.Logger.debug(`技能执行后处理失败（非关键）: ${err?.message}`, 'SkillRegistry');
            }
            return {
                success: false,
                error: error.message,
            };
        }
    }
    /**
     * 检查技能是否存在
     */
    hasSkill(name) {
        return this.skills.has(name);
    }
    /**
     * 注销技能
     */
    unregister(name) {
        const skill = this.skills.get(name);
        if (skill) {
            this.skills.delete(name);
            this.cachedTools = null;
            // 清理进化技能的轨迹签名，允许重新提取
            if (skill.definition.source === 'evolution') {
                this.extractTrajectories.clear();
            }
            return true;
        }
        return false;
    }
    /**
     * 获取已注册技能数量
     */
    getSkillCount() {
        return this.skills.size;
    }
    /**
     * 注册基础设施工具
     * 这些是 LLM 自主调用的系统级工具（记忆、情绪、反思等），并非技能
     */
    registerInfrastructureTool(tool) {
        this.infrastructureTools.set(tool.name, tool);
        this.cachedTools = null;
    }
    /**
     * 将所有技能 + 基础设施工具转换为 OpenAI Function Calling 工具格式
     */
    toOpenAITools() {
        if (this.cachedTools)
            return this.cachedTools;
        const tools = [];
        // 基础设施工具（排在前，LLM 优先看到）
        for (const tool of this.infrastructureTools.values()) {
            const properties = {};
            const required = [];
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
            const properties = {};
            const required = [];
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
    async executeToolCall(toolCall, context) {
        const toolName = toolCall.function.name;
        // 优先匹配基础设施工具
        const infraTool = this.infrastructureTools.get(toolName);
        if (infraTool) {
            let args = {};
            try {
                args = JSON.parse(toolCall.function.arguments);
            }
            catch (err) {
                Logger_1.Logger.debug(`基础设施工具参数解析失败: ${err?.message}`, 'SkillRegistry');
                args = {};
            }
            Logger_1.Logger.info(`🧠 LLM 调用了基础设施工具: ${toolName} | 参数: ${JSON.stringify(args)}`, 'SkillRegistry');
            return await infraTool.execute(args, context);
        }
        // 再匹配技能工具
        const skill = this.skills.get(toolName);
        if (!skill) {
            return { success: false, error: `工具不存在: ${toolName}` };
        }
        let args = {};
        try {
            args = JSON.parse(toolCall.function.arguments);
        }
        catch (err) {
            Logger_1.Logger.debug(`技能工具参数解析失败: ${err?.message}`, 'SkillRegistry');
            args = {};
        }
        const validation = await skill.validate(args);
        if (!validation.valid) {
            return {
                success: false,
                error: `参数验证失败: ${validation.errors.join(', ')}`,
            };
        }
        Logger_1.Logger.info(`🔧 LLM 自主选择技能: ${toolName} | 参数: ${JSON.stringify(args)}`, 'SkillRegistry');
        return await skill.execute(args, context);
    }
    /**
     * 将技能导出为 JSON 字符串（agentskills.io 兼容格式）
     * @param name - 技能名称
     * @returns 导出的 JSON 字符串，技能不存在时返回 null
     */
    exportSkill(name) {
        const skill = this.skills.get(name);
        if (!skill) {
            Logger_1.Logger.warn(`导出技能失败：技能不存在: ${name}`, 'SkillRegistry');
            return null;
        }
        const exportData = {
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
            Logger_1.Logger.info(`📤 技能已导出: ${name}`, 'SkillRegistry');
            return jsonStr;
        }
        catch (error) {
            Logger_1.Logger.error(`导出技能序列化失败: ${name}`, error, 'SkillRegistry');
            return null;
        }
    }
    /**
     * 从 JSON 字符串导入技能
     * @param jsonString - 符合 SkillExportData 格式的 JSON 字符串
     * @returns 导入是否成功
     */
    importSkill(jsonString) {
        let data;
        try {
            data = JSON.parse(jsonString);
        }
        catch (error) {
            Logger_1.Logger.error('导入技能失败：JSON 解析错误', error, 'SkillRegistry');
            return false;
        }
        if (!data.definition || !data.definition.name) {
            Logger_1.Logger.warn('导入技能失败：缺少 definition 或 name 字段', 'SkillRegistry');
            return false;
        }
        const name = data.definition.name;
        if (this.skills.has(name)) {
            Logger_1.Logger.warn(`导入技能失败：技能已存在: ${name}`, 'SkillRegistry');
            return false;
        }
        // 标记来源为 hub
        const enrichedDefinition = {
            ...data.definition,
            source: 'hub',
            hubId: data.definition.hubId || data.agentskillsIo?.schema,
            hubUrl: data.definition.hubUrl,
        };
        // 创建导入技能的 Skill 实现
        const importedSkill = {
            definition: enrichedDefinition,
            async execute(params, context) {
                // 如果有模板和 LLM 可用，则渲染模板
                if (data.template) {
                    let rendered = data.template;
                    if (data.variables) {
                        for (const [key, varDef] of Object.entries(data.variables)) {
                            const value = params[key] != null ? String(params[key]) : varDef.default;
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
            async validate(params) {
                const errors = [];
                for (const param of enrichedDefinition.parameters) {
                    if (param.required &&
                        (params[param.name] === undefined || params[param.name] === null)) {
                        errors.push(`缺少必填参数: ${param.name}`);
                    }
                }
                return { valid: errors.length === 0, errors };
            },
        };
        this.register(importedSkill);
        Logger_1.Logger.info(`📥 技能已导入: ${name} (来源: ${enrichedDefinition.source}, 许可证: ${enrichedDefinition.license || 'MIT'})`, 'SkillRegistry');
        return true;
    }
    /**
     * 导出所有用户/进化生成的技能
     * @returns 包含所有可导出技能的 JSON 字符串
     */
    exportAllSkills() {
        const exportableSkills = Array.from(this.skills.values()).filter((skill) => {
            const source = skill.definition.source;
            return source === 'user' || source === 'evolution' || source === 'hub';
        });
        const exportList = exportableSkills.map((skill) => ({
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
            Logger_1.Logger.info(`📤 批量导出技能: ${exportList.length} 个`, 'SkillRegistry');
            return jsonStr;
        }
        catch (error) {
            Logger_1.Logger.error('批量导出技能序列化失败', error, 'SkillRegistry');
            return '[]';
        }
    }
    /**
     * 搜索远程技能市场（目前使用本地模拟数据，预留远程 API 扩展）
     * @param keyword - 搜索关键词
     * @returns 匹配的技能定义列表
     */
    async searchHub(keyword) {
        Logger_1.Logger.info(`🔍 搜索技能市场: "${keyword}"`, 'SkillRegistry');
        // 本地模拟数据 — 后续替换为远程 API 调用
        const mockHubSkills = [
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
            const tagMatch = (skill.tags || []).some((tag) => tag.toLowerCase().includes(lowerKeyword));
            const categoryMatch = skill.category.toLowerCase().includes(lowerKeyword);
            return nameMatch || descMatch || tagMatch || categoryMatch;
        });
        Logger_1.Logger.info(`🔍 技能市场搜索结果: "${keyword}" → ${results.length} 个匹配`, 'SkillRegistry');
        return results;
    }
    /**
     * 从技能市场安装技能（目前使用本地模拟，预留远程 API 扩展）
     * @param hubId - 技能在市场的唯一ID
     * @returns 安装是否成功
     */
    async installFromHub(hubId) {
        Logger_1.Logger.info(`📥 从技能市场安装: ${hubId}`, 'SkillRegistry');
        // 本地模拟 — 后续替换为远程 API 调用
        const mockHubSkills = [
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
            Logger_1.Logger.warn(`技能市场安装失败：未找到技能: ${hubId}`, 'SkillRegistry');
            return false;
        }
        // 检查是否已安装
        if (this.skills.has(hubSkill.name)) {
            Logger_1.Logger.warn(`技能市场安装失败：技能已存在: ${hubSkill.name}`, 'SkillRegistry');
            return false;
        }
        // 创建 hub 技能的 Skill 实现
        const installedSkill = {
            definition: { ...hubSkill, source: 'hub' },
            async execute(params, context) {
                return {
                    success: true,
                    output: `技能市场技能 ${hubSkill.name} 执行成功`,
                    metadata: { params, context, hubId: hubSkill.hubId },
                };
            },
            async validate(params) {
                const errors = [];
                for (const param of hubSkill.parameters) {
                    if (param.required &&
                        (params[param.name] === undefined || params[param.name] === null)) {
                        errors.push(`缺少必填参数: ${param.name}`);
                    }
                }
                return { valid: errors.length === 0, errors };
            },
        };
        this.register(installedSkill);
        Logger_1.Logger.info(`✅ 技能市场安装成功: ${hubSkill.name} (hubId: ${hubId}, 版本: ${hubSkill.version})`, 'SkillRegistry');
        return true;
    }
    /**
     * 从高质量轨迹中提取并注册技能
     * @param trajectory - 轨迹数据
     * @returns 技能名称，提取失败返回 null
     */
    async extractAndRegisterSkill(trajectory) {
        const { input, intent, toolSequence, qualityScore } = trajectory;
        // 质量阈值检查
        if (qualityScore < 0.7) {
            return null;
        }
        // 至少 2 个成功步骤
        const successfulSteps = toolSequence.filter((s) => s.success);
        if (successfulSteps.length < 2) {
            return null;
        }
        // 不允许有失败步骤
        if (toolSequence.some((s) => !s.success)) {
            return null;
        }
        // 生成工具序列签名（包含意图），用于去重
        const signature = `${intent}:${toolSequence.map((s) => s.toolName).join('->')}`;
        if (this.extractTrajectories.has(signature)) {
            return null;
        }
        if (this.extractTrajectories.size >= this.MAX_EXTRACT_TRAJECTORIES) {
            const oldestKey = this.extractTrajectories.keys().next().value;
            this.extractTrajectories.delete(oldestKey);
        }
        this.extractTrajectories.set(signature, intent);
        // 生成技能名称
        const skillName = `auto_${intent}_${Date.now().toString(36)}`;
        // 提取标签
        const tags = new Set();
        for (const step of toolSequence) {
            const parts = step.toolName.split('_');
            tags.add(parts[parts.length - 1]);
            if (step.toolName.includes('search'))
                tags.add('search');
            if (step.toolName.includes('weather'))
                tags.add('weather');
        }
        // 从输入中提取关键词作为标签
        if (input.includes('天气'))
            tags.add('weather');
        if (input.includes('代码') || input.includes('code'))
            tags.add('code');
        if (input.includes('文件') || input.includes('file'))
            tags.add('file');
        // 泛化参数并生成执行步骤
        const stepsContent = toolSequence
            .map((step, idx) => {
            const generalizedArgs = this.generalizeArgs(step.args);
            return `${idx + 1}. 调用 ${step.toolName}(${JSON.stringify(generalizedArgs)})${step.output ? ` → ${step.output}` : ''}`;
        })
            .join('\n');
        const sections = [
            {
                title: '执行步骤',
                content: stepsContent,
            },
            {
                title: '技能描述',
                content: `从轨迹自动提取的技能，意图: ${intent}，输入: ${input}`,
            },
        ];
        // 创建技能
        const extractedSkill = {
            definition: {
                name: skillName,
                description: `自动提取技能: ${intent}`,
                category: 'auto_extracted',
                parameters: [],
                version: '1.0.0',
                tags: Array.from(tags),
                source: 'evolution',
            },
            sections,
            async execute(params, context) {
                return {
                    success: true,
                    output: `自动提取技能 ${skillName} 执行完成`,
                    metadata: { source: 'auto_extracted', params, context },
                };
            },
            async validate() {
                return { valid: true, errors: [] };
            },
        };
        this.register(extractedSkill);
        Logger_1.Logger.info(`🧬 自动提取技能: ${skillName} (意图: ${intent}, 质量: ${qualityScore})`, 'SkillRegistry');
        return skillName;
    }
    /**
     * 泛化参数值（将路径/URL 替换为占位符）
     */
    generalizeArgs(args) {
        const result = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === 'string') {
                // 路径泛化
                if (key === 'path' || /^(\/|\\|\w:[\\/])/.test(value)) {
                    result[key] = '<path>';
                }
                // URL 泛化
                else if (key === 'url' || /^https?:\/\//.test(value)) {
                    result[key] = '<url>';
                }
                else {
                    result[key] = value;
                }
            }
            else {
                result[key] = value;
            }
        }
        return result;
    }
    /**
     * 生成相关技能提示词
     * @param query - 查询文本
     * @returns 提示词字符串，无匹配时返回空字符串
     */
    findRelevantSkillsPrompt(query) {
        const matches = this.discoverSkills(query, 3);
        if (matches.length === 0) {
            return '';
        }
        const skillLines = matches
            .map((m) => `- ${m.skill.definition.name}: ${m.skill.definition.description} (匹配度: ${(m.score * 100).toFixed(0)}%)`)
            .join('\n');
        return `相关技能参考:\n${skillLines}`;
    }
    /** 渐进式披露：返回技能摘要列表 */
    getSkillSummaries() {
        const result = [];
        for (const skill of this.skills.values()) {
            const summary = skill.summary || skill.definition.description || '';
            const sectionCount = skill.sections?.length || 0;
            const charCount = summary.length;
            result.push({
                name: skill.definition.name,
                summary,
                sectionCount,
                charCount,
            });
        }
        return result;
    }
    /** 渐进式披露：按需展开技能的特定章节 */
    expandSkillSection(skillName, sectionTitle) {
        const skill = this.skills.get(skillName);
        if (!skill || !skill.sections)
            return null;
        const section = skill.sections.find((s) => s.title === sectionTitle);
        return section ? { title: section.title, content: section.content } : null;
    }
    /** 渐进式披露：生成 token 优化的上下文注入文本 */
    generateSummaryContext() {
        if (this.skills.size === 0)
            return '';
        const lines = [];
        for (const skill of this.skills.values()) {
            const summary = skill.summary || skill.definition.description || '';
            lines.push(`- ${skill.definition.name}: ${summary}`);
        }
        return lines.join('\n');
    }
}
exports.SkillRegistry = SkillRegistry;
SkillRegistry.instance = null;
SkillRegistry.zhEnKeywordMap = {
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

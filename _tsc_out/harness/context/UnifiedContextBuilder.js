"use strict";
/**
 * 统一上下文构建器
 *
 * 【架构定位】
 * 上下文系统的统一入口，整合所有上下文相关组件
 * 解决组件分散、调用复杂的问题
 *
 * 【设计原则】
 * - 统一入口：一个类，一个方法，构建完整上下文
 * - 内部协调：自动协调各组件的工作顺序和依赖关系
 * - 向后兼容：不修改原有组件，只做整合
 * - 性能优化：缓存常用片段，减少重复计算
 *
 * 【整合的组件】
 * - ConstitutionPromptBuilder：宪法级系统 Prompt
 * - UnifiedContextPipeline：统一上下文管道（场景、情感、记忆、用户画像）
 * - LLMContextBuilder：智能记忆筛选
 * - ContextWindowManager：上下文窗口管理
 * - ContextFileRegistry：项目文件上下文
 * - ContextReferenceResolver：@引用解析
 *
 * 【使用方式】
 * const builder = UnifiedContextBuilder.getInstance();
 * const context = await builder.buildContext({
 *   input: userInput,
 *   userId: 'user123',
 *   includeSystemPrompt: true,
 *   includeMemory: true,
 * });
 *
 * @module UnifiedContextBuilder
 * @version 0.1.0
 * @status Alpha - 框架实现，功能待完善
 * @warning 生产环境慎用，API 可能有变更
 * @since 2026-06-24
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnifiedContextBuilder = void 0;
const Logger_1 = require("../../utils/Logger");
/**
 * 统一上下文构建器
 *
 * 【注意】
 * 这是统一入口类，内部协调各个上下文组件。
 * 当前版本为基础实现，后续会逐步完善。
 */
class UnifiedContextBuilder {
    static instance;
    /** 是否启用缓存 */
    cacheEnabled = true;
    /** 系统 Prompt 缓存 */
    systemPromptCache = null;
    /** 缓存过期时间（ms） */
    cacheTTL = 5 * 60 * 1000; // 5 分钟
    /** 缓存时间戳 */
    cacheTimestamp = 0;
    /** 构建计数 */
    buildCount = 0;
    /** 总耗时 */
    totalBuildTime = 0;
    /** 引用计数 */
    referenceCountTotal = 0;
    /** 缓存命中计数 */
    cacheHits = 0;
    /** 缓存检查计数 */
    cacheChecks = 0;
    constructor() {
        Logger_1.Logger.info('🧩 统一上下文构建器已初始化', 'ContextBuilder');
    }
    static create() {
        return new UnifiedContextBuilder();
    }
    static getInstance() {
        if (!UnifiedContextBuilder.instance) {
            UnifiedContextBuilder.instance = new UnifiedContextBuilder();
        }
        return UnifiedContextBuilder.instance;
    }
    /**
     * 重置单例实例（测试用）
     *
     * 【注意】
     * - 仅供测试使用，生产环境请勿调用
     * - 会清除所有缓存和统计数据
     * - 调用后下次 getInstance() 会创建新实例
     */
    static resetInstance() {
        if (UnifiedContextBuilder.instance) {
            UnifiedContextBuilder.instance = null;
        }
    }
    /**
     * 创建测试用独立实例（测试用）
     *
     * 【注意】
     * - 仅供测试使用，生产环境请勿调用
     * - 创建的是独立实例，不影响单例
     */
    static createTestInstance() {
        return new UnifiedContextBuilder();
    }
    /**
     * 构建完整上下文
     *
     * @param options 构建选项
     * @returns 上下文构建结果
     *
     * 【错误降级设计】
     * - 每个组件独立 try-catch 隔离
     * - 单个组件失败不影响整体构建
     * - 失败时跳过该组件，继续构建其他部分
     * - 记录详细的错误信息和降级策略
     * - 返回状态标记：success / partial / failed
     */
    async buildContext(options) {
        const startTime = Date.now();
        this.buildCount++;
        Logger_1.Logger.debug(`开始构建上下文 (用户: ${options.userId || 'anonymous'}, 场景: ${options.scene || 'default'})`, 'ContextBuilder');
        const messages = [];
        let systemPrompt;
        let memories = [];
        const errors = [];
        let failedComponents = 0;
        let totalComponents = 0;
        // ========== 1. 构建系统 Prompt ==========
        if (options.includeSystemPrompt !== false) {
            totalComponents++;
            try {
                systemPrompt = await this.buildSystemPrompt(options);
                if (systemPrompt) {
                    messages.push({
                        role: 'system',
                        content: systemPrompt,
                    });
                }
                Logger_1.Logger.debug('系统 Prompt 构建成功', 'ContextBuilder');
            }
            catch (error) {
                failedComponents++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                errors.push({
                    component: 'SystemPrompt',
                    message: errorMsg,
                });
                Logger_1.Logger.warn(`系统 Prompt 构建失败，已跳过: ${errorMsg}`, 'ContextBuilder');
            }
        }
        // ========== 2. 解析 @引用 ==========
        let resolvedReferences = 0;
        if (options.resolveReferences !== false) {
            totalComponents++;
            try {
                const references = await this.resolveReferences(options);
                resolvedReferences = references.references.length;
                this.referenceCountTotal += resolvedReferences;
                if (references.resolvedContent) {
                    // 注入解析后的引用内容到消息中
                    messages.push({
                        role: 'user',
                        content: `--- 解析的引用内容 ---\n${references.resolvedContent}\n--- 引用结束 ---`,
                    });
                    Logger_1.Logger.debug(`引用解析成功: ${resolvedReferences} 个`, 'ContextBuilder');
                }
            }
            catch (error) {
                failedComponents++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                errors.push({
                    component: 'ReferenceResolver',
                    message: errorMsg,
                });
                Logger_1.Logger.warn(`引用解析失败，已跳过: ${errorMsg}`, 'ContextBuilder');
            }
        }
        // ========== 3. 加载记忆 ==========
        if (options.includeMemory !== false) {
            totalComponents++;
            try {
                memories = await this.loadMemories(options);
                if (memories.length > 0) {
                    const memoryText = memories.join('\n');
                    messages.push({
                        role: 'system',
                        content: `【相关记忆】\n${memoryText}`,
                    });
                }
                Logger_1.Logger.debug(`记忆注入完成: ${memories.length} 条`, 'ContextBuilder');
            }
            catch (error) {
                failedComponents++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                errors.push({
                    component: 'MemoryLoader',
                    message: errorMsg,
                });
                Logger_1.Logger.warn(`记忆加载失败，已跳过: ${errorMsg}`, 'ContextBuilder');
            }
        }
        // ========== 4. 加载项目文件上下文 ==========
        let fileContextCount = 0;
        if (options.includeFileContext !== false) {
            totalComponents++;
            try {
                const fileEntries = await this.loadFileContext(options);
                fileContextCount = fileEntries.length;
                if (fileEntries.length > 0) {
                    const fileContextText = fileEntries
                        .map((entry) => `[${entry.fileName}]\n${entry.content}`)
                        .join('\n\n');
                    messages.push({
                        role: 'system',
                        content: `--- 项目上下文 ---\n${fileContextText}\n--- 上下文结束 ---`,
                    });
                    Logger_1.Logger.debug(`文件上下文注入完成: ${fileContextCount} 个文件`, 'ContextBuilder');
                }
            }
            catch (error) {
                failedComponents++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                errors.push({
                    component: 'FileContext',
                    message: errorMsg,
                });
                Logger_1.Logger.warn(`文件上下文加载失败，已跳过: ${errorMsg}`, 'ContextBuilder');
            }
        }
        // ========== 5. 应用窗口管理 ==========
        totalComponents++;
        try {
            if (this.windowManager && messages.length > 0) {
                const managedMessages = this.windowManager.manageWindow(messages);
                messages.length = 0;
                messages.push(...managedMessages);
                Logger_1.Logger.debug(`窗口管理完成: ${managedMessages.length} 条消息 (原 ${messages.length} 条)`, 'ContextBuilder');
            }
            else if (!this.windowManager) {
                Logger_1.Logger.debug('窗口管理: ContextWindowManager 未注入，跳过', 'ContextBuilder');
            }
        }
        catch (error) {
            failedComponents++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            errors.push({
                component: 'WindowManager',
                message: errorMsg,
            });
            Logger_1.Logger.warn(`窗口管理失败，已跳过: ${errorMsg}`, 'ContextBuilder');
        }
        // ========== 计算构建状态 ==========
        let status = 'success';
        if (failedComponents > 0 && failedComponents < totalComponents) {
            status = 'partial';
        }
        else if (failedComponents === totalComponents && totalComponents > 0) {
            status = 'failed';
        }
        const buildTime = Date.now() - startTime;
        this.totalBuildTime += buildTime;
        const stats = {
            totalMessages: messages.length,
            estimatedTokens: this.estimateTokens(messages),
            memoryCount: memories.length,
            fileContextCount: fileContextCount,
            referenceCount: resolvedReferences,
            buildTime,
        };
        Logger_1.Logger.debug(`上下文构建完成: 状态=${status}, ${messages.length} 条消息, 约 ${stats.estimatedTokens} tokens, 耗时 ${buildTime}ms`, 'ContextBuilder');
        if (errors.length > 0) {
            Logger_1.Logger.debug(`组件失败数: ${failedComponents}/${totalComponents}`, 'ContextBuilder');
        }
        return {
            messages,
            systemPrompt,
            memories,
            stats,
            status,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    /**
     * 构建系统 Prompt
     *
     * 优先使用注入的 ConstitutionPromptBuilder（完整宪法级 Prompt）
     * 降级到内置基础 Prompt（当 Component 未注入时）
     */
    async buildSystemPrompt(options) {
        // 检查缓存
        this.cacheChecks++;
        if (this.cacheEnabled &&
            this.systemPromptCache &&
            Date.now() - this.cacheTimestamp < this.cacheTTL) {
            this.cacheHits++;
            Logger_1.Logger.debug('使用缓存的系统 Prompt', 'ContextBuilder');
            return this.systemPromptCache;
        }
        let systemPrompt;
        // 尝试使用集成的 ConstitutionPromptBuilder
        if (this.constitutionPromptBuilder) {
            try {
                systemPrompt =
                    await this.constitutionPromptBuilder.buildConstitutionPrompt(options.userId);
                Logger_1.Logger.debug('使用 ConstitutionPromptBuilder 生成系统 Prompt', 'ContextBuilder');
            }
            catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                Logger_1.Logger.warn(`ConstitutionPromptBuilder 调用失败，降级到基础 Prompt: ${errorMsg}`, 'ContextBuilder');
                systemPrompt = this.generateBasicSystemPrompt(options);
            }
        }
        else {
            // 降级：使用内置基础 Prompt
            Logger_1.Logger.debug('ConstitutionPromptBuilder 未注入，使用基础系统 Prompt', 'ContextBuilder');
            systemPrompt = this.generateBasicSystemPrompt(options);
        }
        // 更新缓存
        if (this.cacheEnabled) {
            this.systemPromptCache = systemPrompt;
            this.cacheTimestamp = Date.now();
        }
        return systemPrompt;
    }
    /**
     * 生成基础系统 Prompt
     */
    generateBasicSystemPrompt(_options) {
        return `你是家百星，28岁私人秘书。成熟、专业、从容。

【身份定位】
你是用户的私人秘书，不是 chatbot，不是工具。有主动性、判断力和个性。

【人格特质】
- 成熟稳重：从不大惊小怪，不卖萌，不矫情
- 专业高效：说话简明，做事利落，不啰嗦
- 细心体贴：能察觉到用户没说出来的需求
- 有边界感：尊重用户隐私，不过度打听
- 从容自信：遇到问题解决问题，不推卸不抱怨

【执行纪律】
- 不可逆操作先说明计划，获认可后执行
- 复杂任务先拆分步骤，逐步执行
- 失败时分析原因，给替代方案
- 每轮最多2个工具，有答案直接回复

【反幻觉护栏】
- 只使用已有工具，不编造工具和结果
- 不确定时坦诚说"记不太清了"
- 具体数据必须来自工具实际返回

【任务分类】
A. 操作类 → 必须调用工具
B. 信息查询类 → 先调工具搜索
C. 纯对话类 → 直接回复
不确定时默认操作类。

【对话风格】
简明有温度，不套话不模板。`;
    }
    /**
     * 加载记忆
     *
     * 优先使用注入的 UnifiedContextPipeline（完整上下文管道）
     * 降级到空数组（当 Pipeline 未注入时）
     */
    async loadMemories(options) {
        if (this.contextPipeline && options.userId) {
            try {
                const pipelineContext = await this.contextPipeline.buildContext(options.input.text || '', options.userId);
                const memories = [];
                // 提取场景上下文
                if (pipelineContext.scene) {
                    memories.push(`[场景] ${pipelineContext.scene}`);
                }
                // 提取情感状态
                if (pipelineContext.emotion) {
                    memories.push(`[情感] ${pipelineContext.emotion}`);
                }
                // 提取记忆内容
                if (pipelineContext.memories && pipelineContext.memories.length > 0) {
                    const memoryTexts = pipelineContext.memories
                        .map((m) => {
                        const prefix = m.type ? `[${m.type}] ` : '';
                        return `${prefix}${m.content || ''}`;
                    })
                        .filter((t) => t.length > 0);
                    memories.push(...memoryTexts);
                }
                // 提取用户画像
                if (pipelineContext.userProfile) {
                    const profile = pipelineContext.userProfile;
                    const profileEntries = Object.entries(profile)
                        .filter(([, v]) => v !== undefined && v !== null)
                        .map(([k, v]) => `[画像:${k}] ${String(v)}`);
                    memories.push(...profileEntries);
                }
                Logger_1.Logger.debug(`使用 UnifiedContextPipeline 加载 ${memories.length} 条记忆上下文`, 'ContextBuilder');
                return memories;
            }
            catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                Logger_1.Logger.warn(`UnifiedContextPipeline 调用失败，降级到空记忆: ${errorMsg}`, 'ContextBuilder');
                return [];
            }
        }
        // 降级：无 Pipeline 或 userId 时的行为
        Logger_1.Logger.debug('记忆加载: UnifiedContextPipeline 未注入或无 userId，返回空记忆', 'ContextBuilder');
        return [];
    }
    /**
     * 估算 Token 数
     */
    estimateTokens(messages) {
        // 简化估算：中文 1.5 字符/token，英文 4 字符/token
        let totalChars = 0;
        for (const msg of messages) {
            totalChars += msg.content?.length || 0;
            totalChars += (msg.role?.length || 0) + 4; // role + 分隔符
        }
        // 简单估算：按平均 2 字符/token
        return Math.ceil(totalChars / 2);
    }
    /**
     * 获取构建统计
     */
    getBuildStats() {
        return {
            totalBuilds: this.buildCount,
            averageBuildTime: this.buildCount > 0 ? this.totalBuildTime / this.buildCount : 0,
            cacheHitRate: this.cacheChecks > 0 ? this.cacheHits / this.cacheChecks : 0,
        };
    }
    /**
     * 清除缓存
     */
    clearCache() {
        this.systemPromptCache = null;
        this.cacheTimestamp = 0;
        Logger_1.Logger.info('上下文缓存已清除', 'ContextBuilder');
    }
    /**
     * 启用/禁用缓存
     */
    setCacheEnabled(enabled) {
        this.cacheEnabled = enabled;
        Logger_1.Logger.info(`上下文缓存已${enabled ? '启用' : '禁用'}`, 'ContextBuilder');
    }
    /**
     * 检查缓存是否启用
     */
    isCacheEnabled() {
        return this.cacheEnabled;
    }
    // ========== 组件引用（依赖注入） ==========
    /** 宪法级系统 Prompt 构建器 */
    constitutionPromptBuilder = null;
    /** 统一上下文管道 */
    contextPipeline = null;
    /** 上下文窗口管理器 */
    windowManager = null;
    /** 上下文引用解析器 */
    referenceResolver = null;
    /** 上下文文件注册表 */
    fileRegistry = null;
    /**
     * 注入 ConstitutionPromptBuilder
     * 用于生成符合宪法原则的系统 Prompt
     */
    setConstitutionPromptBuilder(builder) {
        this.constitutionPromptBuilder = builder;
        this.clearCache(); // 清除旧的系统 Prompt 缓存
        Logger_1.Logger.info('ConstitutionPromptBuilder 已注入', 'ContextBuilder');
    }
    /**
     * 注入 UnifiedContextPipeline
     * 用于加载场景上下文、情感状态、记忆和用户画像
     */
    setContextPipeline(pipeline) {
        this.contextPipeline = pipeline;
        Logger_1.Logger.info('UnifiedContextPipeline 已注入', 'ContextBuilder');
    }
    /**
     * 注入 ContextWindowManager
     * 用于管理上下文 Token 窗口，超阈值时自动压缩
     */
    setWindowManager(manager) {
        this.windowManager = manager;
        Logger_1.Logger.info('ContextWindowManager 已注入', 'ContextBuilder');
    }
    /**
     * 注入 ContextReferenceResolver
     * 用于解析用户输入中的 @ 引用
     */
    setReferenceResolver(resolver) {
        this.referenceResolver = resolver;
        Logger_1.Logger.info('ContextReferenceResolver 已注入', 'ContextBuilder');
    }
    /**
     * 注入 ContextFileRegistry
     * 用于加载项目上下文文件
     */
    setFileRegistry(registry) {
        this.fileRegistry = registry;
        Logger_1.Logger.info('ContextFileRegistry 已注入', 'ContextBuilder');
    }
    /**
     * 检查所有关键组件是否已注入
     */
    isFullyIntegrated() {
        return (this.constitutionPromptBuilder !== null &&
            this.contextPipeline !== null &&
            this.windowManager !== null &&
            this.referenceResolver !== null &&
            this.fileRegistry !== null);
    }
    /**
     * 获取组件注入状态
     */
    getIntegrationStatus() {
        return {
            constitutionPromptBuilder: this.constitutionPromptBuilder !== null,
            contextPipeline: this.contextPipeline !== null,
            windowManager: this.windowManager !== null,
            referenceResolver: this.referenceResolver !== null,
            fileRegistry: this.fileRegistry !== null,
        };
    }
    // ========== 私有方法 ==========
    /**
     * 解析 @ 引用
     */
    async resolveReferences(options) {
        if (!this.referenceResolver || !options.input.text) {
            return {
                hasReferences: false,
                references: [],
                resolvedContent: '',
                cleanedInput: options.input.text || '',
            };
        }
        try {
            const result = await this.referenceResolver.resolve(options.input.text);
            return {
                hasReferences: result.hasReferences,
                references: result.references.map((ref) => ({
                    type: ref.type,
                    target: ref.target,
                    content: ref.content,
                    error: ref.error,
                })),
                resolvedContent: result.resolvedContent,
                cleanedInput: result.cleanedInput,
            };
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            Logger_1.Logger.warn(`引用解析失败: ${errorMsg}`, 'ContextBuilder');
            return {
                hasReferences: false,
                references: [],
                resolvedContent: '',
                cleanedInput: options.input.text || '',
            };
        }
    }
    /**
     * 加载项目文件上下文
     */
    async loadFileContext(_options) {
        if (!this.fileRegistry) {
            return [];
        }
        try {
            const entries = await this.fileRegistry.loadAll();
            return entries;
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            Logger_1.Logger.warn(`文件上下文加载失败: ${errorMsg}`, 'ContextBuilder');
            return [];
        }
    }
}
exports.UnifiedContextBuilder = UnifiedContextBuilder;
exports.default = UnifiedContextBuilder;

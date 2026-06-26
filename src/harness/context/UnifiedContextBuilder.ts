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

import { Logger } from '../../utils/Logger';
import type { ChatMessage, UserInput } from '../types';
import type { ConstitutionPromptBuilder } from '../../core/ConstitutionPromptBuilder';
import type {
  UnifiedContextPipeline,
  UnifiedContext,
} from '../../core/UnifiedContextPipeline';
import type { ContextWindowManager } from './ContextWindowManager';

// ========== 常量定义 ==========

/**
 * 上下文构建选项
 */
export interface ContextBuildOptions {
  /** 用户输入 */
  input: UserInput;
  /** 用户 ID */
  userId?: string;
  /** 是否包含系统 Prompt */
  includeSystemPrompt?: boolean;
  /** 是否包含记忆 */
  includeMemory?: boolean;
  /** 是否包含项目文件上下文 */
  includeFileContext?: boolean;
  /** 是否解析 @引用 */
  resolveReferences?: boolean;
  /** 最大 Token 预算 */
  maxTokens?: number;
  /** 场景类型 */
  scene?: string;
}

/**
 * 上下文构建状态
 */
export type ContextBuildStatus = 'success' | 'partial' | 'failed';

/**
 * 上下文构建结果
 */
export interface ContextBuildResult {
  /** 完整的消息列表 */
  messages: ChatMessage[];
  /** 系统 Prompt */
  systemPrompt?: string;
  /** 记忆内容 */
  memories?: string[];
  /** 上下文统计 */
  stats: ContextStats;
  /** 构建状态 */
  status: ContextBuildStatus;
  /** 错误详情（如果有） */
  errors?: Array<{
    component: string;
    message: string;
  }>;
}

/**
 * 上下文统计
 */
export interface ContextStats {
  /** 总消息数 */
  totalMessages: number;
  /** 估算 Token 数 */
  estimatedTokens: number;
  /** 记忆数量 */
  memoryCount: number;
  /** 文件上下文数量 */
  fileContextCount: number;
  /** 引用解析数 */
  referenceCount: number;
  /** 构建耗时（ms） */
  buildTime: number;
}

/**
 * 统一上下文构建器
 *
 * 【注意】
 * 这是统一入口类，内部协调各个上下文组件。
 * 当前版本为基础实现，后续会逐步完善。
 */
export class UnifiedContextBuilder {
  private static instance: UnifiedContextBuilder;

  /** 是否启用缓存 */
  private cacheEnabled = true;

  /** 系统 Prompt 缓存 */
  private systemPromptCache: string | null = null;

  /** 缓存过期时间（ms） */
  private readonly cacheTTL = 5 * 60 * 1000; // 5 分钟

  /** 缓存时间戳 */
  private cacheTimestamp = 0;

  /** 构建计数 */
  private buildCount = 0;

  /** 总耗时 */
  private totalBuildTime = 0;

  private constructor() {
    Logger.info('🧩 统一上下文构建器已初始化', 'ContextBuilder');
  }

  static getInstance(): UnifiedContextBuilder {
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
  static resetInstance(): void {
    if (UnifiedContextBuilder.instance) {
      UnifiedContextBuilder.instance = null as any;
    }
  }

  /**
   * 创建测试用独立实例（测试用）
   *
   * 【注意】
   * - 仅供测试使用，生产环境请勿调用
   * - 创建的是独立实例，不影响单例
   */
  static createTestInstance(): UnifiedContextBuilder {
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
  async buildContext(
    options: ContextBuildOptions
  ): Promise<ContextBuildResult> {
    const startTime = Date.now();
    this.buildCount++;

    Logger.debug(
      `开始构建上下文 (用户: ${options.userId || 'anonymous'}, 场景: ${options.scene || 'default'})`,
      'ContextBuilder'
    );

    const messages: ChatMessage[] = [];
    let systemPrompt: string | undefined;
    let memories: string[] = [];
    const errors: Array<{ component: string; message: string }> = [];
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
        Logger.debug('系统 Prompt 构建成功', 'ContextBuilder');
      } catch (error) {
        failedComponents++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          component: 'SystemPrompt',
          message: errorMsg,
        });
        Logger.warn(
          `系统 Prompt 构建失败，已跳过: ${errorMsg}`,
          'ContextBuilder'
        );
      }
    }

    // ========== 2. 解析 @引用 ==========
    if (options.resolveReferences !== false) {
      totalComponents++;
      try {
        // TODO: 集成 ContextReferenceResolver
        // const references = await this.resolveReferences(options);
        Logger.debug('引用解析: 功能待实现', 'ContextBuilder');
      } catch (error) {
        failedComponents++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          component: 'ReferenceResolver',
          message: errorMsg,
        });
        Logger.warn(`引用解析失败，已跳过: ${errorMsg}`, 'ContextBuilder');
      }
    }

    // ========== 3. 加载记忆 ==========
    if (options.includeMemory !== false) {
      totalComponents++;
      try {
        memories = await this.loadMemories(options);
        // TODO: 将记忆注入到上下文中
        Logger.debug(`记忆加载完成: ${memories.length} 条`, 'ContextBuilder');
      } catch (error) {
        failedComponents++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          component: 'MemoryLoader',
          message: errorMsg,
        });
        Logger.warn(`记忆加载失败，已跳过: ${errorMsg}`, 'ContextBuilder');
      }
    }

    // ========== 4. 加载项目文件上下文 ==========
    if (options.includeFileContext !== false) {
      totalComponents++;
      try {
        // TODO: 集成 ContextFileRegistry
        // const fileContext = await this.loadFileContext(options);
        Logger.debug('文件上下文: 功能待实现', 'ContextBuilder');
      } catch (error) {
        failedComponents++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          component: 'FileContext',
          message: errorMsg,
        });
        Logger.warn(
          `文件上下文加载失败，已跳过: ${errorMsg}`,
          'ContextBuilder'
        );
      }
    }

    // ========== 5. 应用窗口管理 ==========
    totalComponents++;
    try {
      if (this.windowManager && messages.length > 0) {
        const managedMessages = this.windowManager.manageWindow(messages);
        messages.length = 0;
        messages.push(...managedMessages);
        Logger.debug(
          `窗口管理完成: ${managedMessages.length} 条消息 (原 ${messages.length} 条)`,
          'ContextBuilder'
        );
      } else if (!this.windowManager) {
        Logger.debug(
          '窗口管理: ContextWindowManager 未注入，跳过',
          'ContextBuilder'
        );
      }
    } catch (error) {
      failedComponents++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({
        component: 'WindowManager',
        message: errorMsg,
      });
      Logger.warn(`窗口管理失败，已跳过: ${errorMsg}`, 'ContextBuilder');
    }

    // ========== 计算构建状态 ==========
    let status: ContextBuildStatus = 'success';
    if (failedComponents > 0 && failedComponents < totalComponents) {
      status = 'partial';
    } else if (failedComponents === totalComponents && totalComponents > 0) {
      status = 'failed';
    }

    const buildTime = Date.now() - startTime;
    this.totalBuildTime += buildTime;

    const stats: ContextStats = {
      totalMessages: messages.length,
      estimatedTokens: this.estimateTokens(messages),
      memoryCount: memories.length,
      fileContextCount: 0, // TODO: 实际统计
      referenceCount: 0, // TODO: 实际统计
      buildTime,
    };

    Logger.debug(
      `上下文构建完成: 状态=${status}, ${messages.length} 条消息, 约 ${stats.estimatedTokens} tokens, 耗时 ${buildTime}ms`,
      'ContextBuilder'
    );

    if (errors.length > 0) {
      Logger.debug(
        `组件失败数: ${failedComponents}/${totalComponents}`,
        'ContextBuilder'
      );
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
  private async buildSystemPrompt(
    options: ContextBuildOptions
  ): Promise<string> {
    // 检查缓存
    if (
      this.cacheEnabled &&
      this.systemPromptCache &&
      Date.now() - this.cacheTimestamp < this.cacheTTL
    ) {
      Logger.debug('使用缓存的系统 Prompt', 'ContextBuilder');
      return this.systemPromptCache;
    }

    let systemPrompt: string;

    // 尝试使用集成的 ConstitutionPromptBuilder
    if (this.constitutionPromptBuilder) {
      try {
        systemPrompt =
          await this.constitutionPromptBuilder.buildConstitutionPrompt(
            options.userId
          );
        Logger.debug(
          '使用 ConstitutionPromptBuilder 生成系统 Prompt',
          'ContextBuilder'
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.warn(
          `ConstitutionPromptBuilder 调用失败，降级到基础 Prompt: ${errorMsg}`,
          'ContextBuilder'
        );
        systemPrompt = this.generateBasicSystemPrompt(options);
      }
    } else {
      // 降级：使用内置基础 Prompt
      Logger.debug(
        'ConstitutionPromptBuilder 未注入，使用基础系统 Prompt',
        'ContextBuilder'
      );
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
  private generateBasicSystemPrompt(_options: ContextBuildOptions): string {
    // 简化实现，后续替换为 ConstitutionPromptBuilder
    return `你是家百星（Jiabaixing），一个智能助手。

## 核心原则
- 保持专业、友好、高效的沟通风格
- 优先使用工具来获取准确信息
- 遇到不确定的问题，诚实说明而不是编造
- 保护用户隐私和数据安全

## 能力范围
- 代码开发与调试
- 文件操作与管理
- 网络搜索与信息获取
- 系统命令执行
- 多模态内容理解

## 行为准则
- 仔细思考后再行动
- 每一步都要验证结果
- 出错时及时调整策略
- 从错误中学习改进`;
  }

  /**
   * 加载记忆
   *
   * 优先使用注入的 UnifiedContextPipeline（完整上下文管道）
   * 降级到空数组（当 Pipeline 未注入时）
   */
  private async loadMemories(options: ContextBuildOptions): Promise<string[]> {
    if (this.contextPipeline && options.userId) {
      try {
        const pipelineContext: UnifiedContext =
          await this.contextPipeline.buildContext(
            options.input.text || '',
            options.userId
          );

        const memories: string[] = [];

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
            .map(
              (m: {
                content?: string;
                type?: string;
                relevanceScore?: number;
              }) => {
                const prefix = m.type ? `[${m.type}] ` : '';
                return `${prefix}${m.content || ''}`;
              }
            )
            .filter((t: string) => t.length > 0);
          memories.push(...memoryTexts);
        }

        // 提取用户画像
        if (pipelineContext.userProfile) {
          const profile = pipelineContext.userProfile as Record<
            string,
            unknown
          >;
          const profileEntries = Object.entries(profile)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `[画像:${k}] ${String(v)}`);
          memories.push(...profileEntries);
        }

        Logger.debug(
          `使用 UnifiedContextPipeline 加载 ${memories.length} 条记忆上下文`,
          'ContextBuilder'
        );

        return memories;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.warn(
          `UnifiedContextPipeline 调用失败，降级到空记忆: ${errorMsg}`,
          'ContextBuilder'
        );
        return [];
      }
    }

    // 降级：无 Pipeline 或 userId 时的行为
    Logger.debug(
      '记忆加载: UnifiedContextPipeline 未注入或无 userId，返回空记忆',
      'ContextBuilder'
    );

    return [];
  }

  /**
   * 估算 Token 数
   */
  private estimateTokens(messages: ChatMessage[]): number {
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
  getBuildStats(): {
    totalBuilds: number;
    averageBuildTime: number;
    cacheHitRate: number;
  } {
    return {
      totalBuilds: this.buildCount,
      averageBuildTime:
        this.buildCount > 0 ? this.totalBuildTime / this.buildCount : 0,
      cacheHitRate: 0, // TODO: 实际统计
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.systemPromptCache = null;
    this.cacheTimestamp = 0;
    Logger.info('上下文缓存已清除', 'ContextBuilder');
  }

  /**
   * 启用/禁用缓存
   */
  setCacheEnabled(enabled: boolean): void {
    this.cacheEnabled = enabled;
    Logger.info(`上下文缓存已${enabled ? '启用' : '禁用'}`, 'ContextBuilder');
  }

  /**
   * 检查缓存是否启用
   */
  isCacheEnabled(): boolean {
    return this.cacheEnabled;
  }

  // ========== 组件引用（依赖注入） ==========

  /** 宪法级系统 Prompt 构建器 */
  private constitutionPromptBuilder: ConstitutionPromptBuilder | null = null;

  /** 统一上下文管道 */
  private contextPipeline: UnifiedContextPipeline | null = null;

  /** 上下文窗口管理器 */
  private windowManager: ContextWindowManager | null = null;

  /**
   * 注入 ConstitutionPromptBuilder
   * 用于生成符合宪法原则的系统 Prompt
   */
  setConstitutionPromptBuilder(builder: ConstitutionPromptBuilder): void {
    this.constitutionPromptBuilder = builder;
    this.clearCache(); // 清除旧的系统 Prompt 缓存
    Logger.info('ConstitutionPromptBuilder 已注入', 'ContextBuilder');
  }

  /**
   * 注入 UnifiedContextPipeline
   * 用于加载场景上下文、情感状态、记忆和用户画像
   */
  setContextPipeline(pipeline: UnifiedContextPipeline): void {
    this.contextPipeline = pipeline;
    Logger.info('UnifiedContextPipeline 已注入', 'ContextBuilder');
  }

  /**
   * 注入 ContextWindowManager
   * 用于管理上下文 Token 窗口，超阈值时自动压缩
   */
  setWindowManager(manager: ContextWindowManager): void {
    this.windowManager = manager;
    Logger.info('ContextWindowManager 已注入', 'ContextBuilder');
  }

  /**
   * 检查所有关键组件是否已注入
   */
  isFullyIntegrated(): boolean {
    return (
      this.constitutionPromptBuilder !== null &&
      this.contextPipeline !== null &&
      this.windowManager !== null
    );
  }

  /**
   * 获取组件注入状态
   */
  getIntegrationStatus(): Record<string, boolean> {
    return {
      constitutionPromptBuilder: this.constitutionPromptBuilder !== null,
      contextPipeline: this.contextPipeline !== null,
      windowManager: this.windowManager !== null,
    };
  }
}

export default UnifiedContextBuilder;

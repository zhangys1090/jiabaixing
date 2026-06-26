/**
 * 上下文管理器适配器 - 兼容层
 *
 * 【架构定位】
 * 临时兼容层，用于平滑迁移 ContextManager → UnifiedContextPipeline + ConstitutionPromptBuilder
 *
 * 设计原则：
 * - 接口签名与 ContextManager 完全兼容
 * - 对于 UCP 已覆盖的功能，委托给 UCP
 * - 不支持的功能暂时保留原实现或添加优雅降级
 * - 确保调用方不需要修改代码就能切换
 *
 * @deprecated 这是临时兼容层，最终应直接使用 UnifiedContextPipeline
 * 迁移状态：V5.0 引入，V6.0 移除
 *
 * 替代方案：
 * - AI 上下文构建 → UnifiedContextPipeline
 * - 系统 Prompt 构建 → ConstitutionPromptBuilder
 * - 记忆智能筛选 → LLMContextBuilder
 * - 上下文窗口管理 → ContextWindowManager
 * - @引用解析 → ContextReferenceResolver
 * - 项目文件上下文 → ContextFileRegistry
 */

import { Logger } from '../../utils/Logger';
import type { ChatMessage, UserInput } from '../types';

// 临时类型定义，后续应从统一类型导入
interface ContextManagerDeps {
  constitutionalBuilder?: {
    buildConstitutionPrompt(userId?: string): Promise<string>;
  };
  memoryInjector?: {
    autoRetrieveMemories(input: string, userId?: string): Promise<string[]>;
  };
  [key: string]: unknown;
}

export class ContextManagerAdapter {
  private deps: ContextManagerDeps;
  private totalBudget: number;

  /** 内部的 ContextManager 实例，用于不支持的功能降级 */
  private _legacyManager: unknown | null = null;

  constructor(deps: ContextManagerDeps, totalBudget: number = 8000) {
    this.deps = deps;
    this.totalBudget = totalBudget;

    Logger.warn(
      '⚠️ [ContextManagerAdapter] 使用兼容层 ContextManagerAdapter，建议尽快迁移到 UnifiedContextPipeline',
      'ContextAdapter'
    );
  }

  /**
   * 构建上下文
   *
   * 兼容方法：内部委托给新的上下文构建系统
   * 注意：这是简化实现，完整功能请使用 UnifiedContextPipeline
   *
   * @param input 用户输入
   * @returns 消息列表
   */
  async buildContext(_input: UserInput): Promise<ChatMessage[]> {
    // TODO: 完整实现应委托给 UnifiedContextPipeline + ConstitutionPromptBuilder
    // 目前先返回空数组作为占位，实际使用时需要完整实现

    Logger.debug(
      `[ContextManagerAdapter] buildContext 被调用（兼容层）`,
      'ContextAdapter'
    );

    // 临时实现：返回空数组
    // 实际实现需要：
    // 1. 调用 ConstitutionPromptBuilder 构建系统 Prompt
    // 2. 调用 UnifiedContextPipeline 构建 AI 上下文
    // 3. 组合成 ChatMessage[] 格式返回

    return [];
  }

  /**
   * 构建宪法 Prompt
   *
   * 兼容方法：委托给 ConstitutionPromptBuilder
   */
  async buildConstitutionPrompt(userId?: string): Promise<string> {
    if (this.deps.constitutionalBuilder) {
      return this.deps.constitutionalBuilder.buildConstitutionPrompt(userId);
    }

    Logger.warn(
      '[ContextManagerAdapter] constitutionalBuilder 未提供，返回空字符串',
      'ContextAdapter'
    );

    return '';
  }

  /**
   * 自动检索记忆
   *
   * 兼容方法：委托给记忆注入器
   */
  async autoRetrieveMemories(
    input: string,
    userId?: string
  ): Promise<string[]> {
    if (this.deps.memoryInjector) {
      return this.deps.memoryInjector.autoRetrieveMemories(input, userId);
    }

    Logger.warn(
      '[ContextManagerAdapter] memoryInjector 未提供，返回空数组',
      'ContextAdapter'
    );

    return [];
  }

  /**
   * 获取动态上下文
   *
   * 兼容方法：暂不支持，返回空字符串
   */
  getDynamicContext(): string {
    return '';
  }

  /**
   * 获取最近历史
   *
   * 兼容方法：暂不支持，返回空数组
   */
  getRecentHistory(_limit: number): ChatMessage[] {
    return [];
  }

  /**
   * 获取所有历史
   *
   * 兼容方法：暂不支持，返回空数组
   */
  getAllHistory(): ChatMessage[] {
    return [];
  }

  /**
   * 构建人格摘要
   *
   * 兼容方法：暂不支持，返回空字符串
   */
  buildPersonaSummary(): string {
    return '';
  }

  /**
   * 从输入识别场景
   *
   * 兼容方法：暂不支持，返回默认场景
   */
  recognizeSceneFromInput(_input: string): string {
    return 'default';
  }

  /**
   * 获取环境上下文
   *
   * 兼容方法：暂不支持，返回空字符串
   */
  getEnvironmentContext(): string {
    return '';
  }

  /**
   * 获取 Prompt 示例
   *
   * 兼容方法：暂不支持，返回空数组
   */
  getPromptExamples(): Array<{
    trigger: string;
    correction: string;
    example: string;
    frequency: number;
  }> {
    return [];
  }

  /**
   * 获取上下文条目
   *
   * 兼容方法：暂不支持，返回空数组
   */
  getEntries(): Array<{
    id: string;
    content: string;
    priority: number;
    source: string;
  }> {
    return [];
  }

  /**
   * 获取 Token 分配
   *
   * 兼容方法：暂不支持，返回默认分配
   */
  getAllocation(): {
    system: number;
    history: number;
    memory: number;
    tools: number;
    response: number;
    total: number;
  } {
    return {
      system: 2000,
      history: 3000,
      memory: 1000,
      tools: 1000,
      response: 1000,
      total: this.totalBudget,
    };
  }
}

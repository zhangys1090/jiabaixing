/**
 * CodeProvider — 代码服务
 *
 * 从 LLMProvider 提取，负责代码分析和生成相关功能。
 * 包含 analyzeCode、devGenerateCode、generateModificationPlan、generateModifiedFileContent。
 * 保持与原 LLMProvider 中这些方法相同的逻辑（含重试机制）。
 */

import { injectPreferences } from '../memory/PreferenceInjector';
import { Logger } from '../utils/Logger';
import { Model } from './ModelInterface';
import { getPromptTemplate } from '../llm/prompt-templates';

/** 连接错误关键词列表（与 LLMProvider 保持一致） */
const CONNECTION_ERRORS = [
  'econnrefused',
  'econnreset',
  'enetunreach',
  'connection refused',
  'connect econnrefused',
  'network error',
  'network timeout',
  'fetch failed',
  'abort',
  '超时',
];

export class CodeProvider {
  private model: Model;
  private modelName: string;
  private maxRetries: number = 2;
  private baseRetryInterval: number = 1000;

  constructor(model: Model, modelName: string) {
    this.model = model;
    this.modelName = modelName;
  }

  /**
   * 带重试的操作执行器
   * @param operation - 要执行的操作
   * @param operationName - 操作名称（用于日志）
   * @param maxRetries - 最大重试次数
   * @returns 操作结果
   * @throws {Error} 当所有重试均失败时抛出
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = this.maxRetries
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const errorMsg = lastError.message.toLowerCase();

        const isConnectionError = CONNECTION_ERRORS.some((e) =>
          errorMsg.includes(e)
        );

        const isAuthError =
          errorMsg.includes('401') ||
          errorMsg.includes('invalid') ||
          errorMsg.includes('authentication');

        if (isConnectionError || isAuthError) {
          Logger.warn(
            `🚫 ${operationName} ${isAuthError ? '认证失败' : '连接错误'}，跳过重试: ${lastError.message}`,
            'CodeProvider'
          );
          break;
        }

        if (attempt < maxRetries) {
          const delay = this.baseRetryInterval * Math.pow(2, attempt - 1);
          Logger.warn(
            `${operationName} 第${attempt}次失败，${delay}ms后重试: ${lastError.message}`,
            'CodeProvider'
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const errorMessage = lastError
      ? `${operationName}失败: ${lastError.message}`
      : `${operationName}失败，请检查 LLM 服务是否运行`;

    throw new Error(errorMessage);
  }

  /**
   * 分析代码
   * @param filePath - 文件路径
   * @param content - 文件内容
   * @param userQuery - 用户问题
   * @returns 分析结果文本
   * @throws {Error} 当 LLM 服务不可用或未返回内容时抛出
   */
  async analyzeCode(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(getPromptTemplate('analyzeCode'));

    const humanPrompt = `用户问题：${userQuery}
文件路径：${filePath}
文件内容：
\`\`\`
${content}
\`\`\`
请分析并给出专业、温柔的回答。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.7,
        maxTokens: 2048,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM分析代码');
    } catch (error) {
      Logger.error(`⚠️ LLM分析失败`, error as Error, 'CodeProvider');
      throw error;
    }
  }

  /**
   * 开发副驾专用：专业代码生成（无人设，无"亲爱的主人"等强制称呼）
   * 使用专业开发者 system prompt，直接生成可执行代码
   * @param userRequest - 用户需求
   * @param filePath - 目标文件路径（可选）
   * @param existingContent - 现有文件内容（可选）
   * @returns 生成的代码
   * @throws {Error} 当 LLM 服务不可用或未返回内容时抛出
   */
  async devGenerateCode(
    userRequest: string,
    filePath?: string,
    existingContent?: string
  ): Promise<string> {
    const systemPrompt = getPromptTemplate('devGenerateCode');

    const fileContext = filePath ? `\n目标文件路径：${filePath}` : '';
    const existingCodeContext = existingContent
      ? `\n\n当前文件内容：\n${existingContent}`
      : '\n（新文件，当前不存在）';

    const humanPrompt = `用户需求：${userRequest}${fileContext}${existingCodeContext}\n\n请生成代码。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt,
        temperature: 0.3,
        maxTokens: 4096,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, '开发副驾代码生成');
    } catch (error) {
      Logger.error('开发副驾代码生成失败', error as Error, 'CodeProvider');
      throw error;
    }
  }

  /**
   * 生成修改计划
   * @param filePath - 文件路径
   * @param content - 当前文件内容
   * @param userQuery - 用户需求
   * @returns 修改计划文本
   * @throws {Error} 当 LLM 服务不可用或未返回内容时抛出
   */
  async generateModificationPlan(
    filePath: string,
    content: string,
    userQuery: string
  ): Promise<string> {
    const systemPrompt = injectPreferences(
      getPromptTemplate('generateModificationPlan')
    );

    const humanPrompt = `用户需求：${userQuery}
文件路径：${filePath}
当前文件内容：
\`\`\`
${content}
\`\`\`
请给出修改方案。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.7,
        maxTokens: 2048,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM生成修改方案');
    } catch (error) {
      Logger.error(`⚠️ LLM生成修改方案失败`, error as Error, 'CodeProvider');
      throw error;
    }
  }

  /**
   * 生成修改后的文件内容
   * @param filePath - 文件路径
   * @param currentContent - 当前文件内容
   * @param userRequest - 用户需求
   * @param fileExists - 文件是否存在
   * @returns 修改后的完整文件内容
   * @throws {Error} 当 LLM 服务不可用或未返回内容时抛出
   */
  async generateModifiedFileContent(
    filePath: string,
    currentContent: string,
    userRequest: string,
    fileExists: boolean
  ): Promise<string> {
    const rawPrompt = getPromptTemplate('generateModifiedFileContent');
    const systemPrompt = injectPreferences(
      rawPrompt.replace('{{fileState}}', fileExists ? '' : '（文件当前不存在）')
    );

    const humanPrompt = `用户需求：${userRequest}
文件路径：${filePath}
当前文件内容：${fileExists ? currentContent : '（文件不存在）'}
请给出修改后的完整文件内容。`;

    const operation = async () => {
      const response = await this.model.generate({
        prompt: humanPrompt,
        systemPrompt: systemPrompt,
        temperature: 0.7,
        maxTokens: 4096,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.text) {
        throw new Error('模型未返回内容');
      }

      return response.text;
    };

    try {
      return await this.executeWithRetry(operation, 'LLM生成修改文件内容');
    } catch (error) {
      Logger.error(`⚠️ 生成修改文件内容失败`, error as Error, 'CodeProvider');
      throw error;
    }
  }
}

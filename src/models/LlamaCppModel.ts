/**
 * llama.cpp 模型实现
 * 通过 llama.cpp 本地 server 模式调用 GGUF 模型，替代 Ollama
 * 支持 HTTP 兼容接口（兼容 OpenAI /server 端点）
 */

import * as http from 'http';
import { Logger } from '../utils/Logger';
import { Model, ModelConfig, ModelInput, ModelOutput } from './ModelInterface';

/**
 * llama.cpp 模型类
 */
export class LlamaCppModel implements Model {
  private config: ModelConfig;
  private initialized: boolean = false;
  private verifiedModelName: string | null = null;

  /**
   * 构造函数
   * @param config 模型配置
   */
  constructor(config: Partial<ModelConfig> = {}) {
    this.config = {
      name:
        config.name ||
        process.env.LLAMA_CPP_MODEL_NAME ||
        'qwen2.5-3b-instruct',
      baseUrl:
        config.baseUrl || process.env.LLAMA_CPP_URL || 'http://localhost:8080',
      timeout: config.timeout || 30000,
      maxTokens: config.maxTokens || 4096,
      temperature: config.temperature || 0.7,
      topP: config.topP || 0.9,
      frequencyPenalty: config.frequencyPenalty || 0,
      presencePenalty: config.presencePenalty || 0,
    };
  }

  /**
   * 验证模型名称：通过 /v1/models 端点获取已加载模型
   */
  private async verifyModel(): Promise<string> {
    if (this.verifiedModelName) {
      return this.verifiedModelName;
    }

    try {
      const models = (await this.fetchJson(
        `${this.config.baseUrl}/v1/models`
      )) as Record<string, unknown>;
      if (models && Array.isArray(models.data)) {
        const names = (models.data as Array<Record<string, unknown>>).map(
          (m) => m.id as string
        );
        if (names.includes(this.config.name)) {
          this.verifiedModelName = this.config.name;
          return this.config.name;
        }
        const baseName = this.config.name.split(':')[0];
        const prefixMatch = names.find((n: string) => n.includes(baseName));
        if (prefixMatch) {
          Logger.info(
            `🔍 llama.cpp 模型名称已校正: ${this.config.name} -> ${prefixMatch}`,
            'LlamaCppModel'
          );
          this.verifiedModelName = prefixMatch;
          return prefixMatch;
        }
      }
    } catch (error) {
      Logger.warn(
        `⚠️ llama.cpp 模型名称验证失败，将使用原始名称: ${(error as Error).message}`,
        'LlamaCppModel'
      );
    }

    this.verifiedModelName = this.config.name;
    return this.config.name;
  }

  /**
   * 初始化模型
   */
  public async initialize(): Promise<void> {
    try {
      const health = await this.fetchJson(`${this.config.baseUrl}/health`);
      if (health && typeof health === 'object') {
        const status = (health as Record<string, unknown>).status as string;
        if (status === 'ok' || status === 'loading') {
          this.initialized = true;
          Logger.info(
            `✅ llama.cpp 模型 ${this.config.name} 初始化成功`,
            'LlamaCppModel'
          );
          return;
        }
      }
      // 如果 health 端点不可用，尝试 /v1/models
      await this.fetchJson(`${this.config.baseUrl}/v1/models`);
      this.initialized = true;
      Logger.info(
        `✅ llama.cpp 模型 ${this.config.name} 初始化成功（兼容模式）`,
        'LlamaCppModel'
      );
    } catch (error) {
      Logger.warn(
        `⚠️ llama.cpp 模型 ${this.config.name} 初始化失败: ${(error as Error).message}`,
        'LlamaCppModel'
      );
      this.initialized = false;
    }
  }

  /**
   * 生成文本 - 使用 OpenAI 兼容的 /v1/chat/completions 端点
   */
  public async generate(input: ModelInput): Promise<ModelOutput> {
    this.ensureInitialized();

    try {
      const modelName = await this.verifyModel();
      const messages: Array<{ role: string; content: string }> = [];

      if (input.systemPrompt) {
        messages.push({ role: 'system', content: input.systemPrompt });
      }
      messages.push({ role: 'user', content: input.prompt || '' });
      const body = {
        model: modelName,
        messages,
        stream: false,
        temperature: input.temperature ?? this.config.temperature,
        max_tokens: input.maxTokens ?? this.config.maxTokens,
        top_p: input.topP ?? this.config.topP,
        frequency_penalty:
          input.frequencyPenalty ?? this.config.frequencyPenalty,
        presence_penalty: input.presencePenalty ?? this.config.presencePenalty,
        stop: input.stop,
      };

      const response = await this.fetchJson(
        `${this.config.baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      if (response && typeof response === 'object') {
        const choices = (response as Record<string, unknown>).choices as
          | Array<Record<string, unknown>>
          | undefined;
        if (choices && choices.length > 0) {
          const message = choices[0].message as
            | Record<string, unknown>
            | undefined;
          const content = message?.content as string | undefined;
          return {
            text: content || '',
            finishReason: 'stop',
          };
        }
      }

      throw new Error('llama.cpp 未返回有效内容');
    } catch (error) {
      Logger.error('❌ llama.cpp 生成失败:', error as Error);
      return {
        text: '',
        error: (error as Error).message,
      };
    }
  }

  /**
   * 流式生成文本
   */
  public async *stream(input: ModelInput): AsyncGenerator<string> {
    this.ensureInitialized();

    try {
      const modelName = await this.verifyModel();
      const messages: Array<{ role: string; content: string }> = [];

      if (input.systemPrompt) {
        messages.push({ role: 'system', content: input.systemPrompt });
      }
      messages.push({ role: 'user', content: input.prompt || '' });

      const body = {
        model: modelName,
        messages,
        stream: true,
        temperature: input.temperature ?? this.config.temperature,
        max_tokens: input.maxTokens ?? this.config.maxTokens,
      };

      // 使用原生 http 模块进行 SSE 流式读取
      const result = await new Promise<string>((resolve, reject) => {
        const url = new URL(`${this.config.baseUrl}/v1/chat/completions`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(JSON.stringify(body)),
            },
            timeout: this.config.timeout,
          },
          (res) => {
            let buffer = '';
            let fullText = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              buffer += chunk;
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                  const data = trimmed.slice(6);
                  if (data === '[DONE]') {
                    resolve(fullText);
                    return;
                  }
                  try {
                    const parsed = JSON.parse(data) as Record<string, unknown>;
                    const choices = parsed.choices as
                      | Array<Record<string, unknown>>
                      | undefined;
                    if (choices && choices[0]) {
                      const delta = choices[0].delta as
                        | Record<string, unknown>
                        | undefined;
                      const content = delta?.content as string | undefined;
                      if (content) {
                        fullText += content;
                      }
                    }
                  } catch {
                    // 忽略非 JSON 行
                  }
                }
              }
            });
            res.on('end', () => resolve(fullText));
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('请求超时'));
        });
        req.write(JSON.stringify(body));
        req.end();
      });

      // 将完整文本逐字符 yield 以模拟流式
      for (const char of result) {
        yield char;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      Logger.error('❌ llama.cpp 流式生成失败:', error as Error);
      throw error;
    }
  }

  /**
   * 获取模型名称
   */
  public getName(): string {
    return this.config.name;
  }

  /**
   * 获取模型信息
   */
  public async getModelInfo(): Promise<Record<string, unknown>> {
    this.ensureInitialized();

    try {
      const health = await this.fetchJson(`${this.config.baseUrl}/health`);
      return {
        name: this.config.name,
        baseUrl: this.config.baseUrl,
        health,
        initialized: this.initialized,
      };
    } catch (error) {
      Logger.error('❌ 获取 llama.cpp 模型信息失败:', error as Error);
      throw error;
    }
  }

  /**
   * 关闭模型
   */
  public async shutdown(): Promise<void> {
    if (this.initialized) {
      Logger.info(
        `🔌 关闭 llama.cpp 模型 ${this.config.name}`,
        'LlamaCppModel'
      );
      this.initialized = false;
    }
  }

  /**
   * 确保模型已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('模型未初始化！请先调用 initialize 方法。');
    }
  }

  /**
   * 封装 HTTP GET 请求（返回 JSON）
   */
  private async fetchJson(
    url: string,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    const timeout = this.config.timeout;

    return new Promise<unknown>((resolve, reject) => {
      const urlObj = new URL(url);
      const method = (options?.method as string) || 'GET';

      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method,
          headers: options?._headers as http.OutgoingHttpHeaders | undefined,
          timeout,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            if (!res.statusCode || res.statusCode >= 400) {
              reject(
                new Error(
                  `HTTP ${res.statusCode}: ${res.statusMessage || 'Unknown'}`
                )
              );
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('JSON 解析失败'));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      if (options?.body) {
        req.write(options.body as string);
      }
      req.end();
    });
  }
}

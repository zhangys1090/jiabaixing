/**
 * 批处理引擎
 *
 * 并行运行多个 prompt，生成结构化轨迹数据
 * 设计参考: Hermes Agent 批处理系统
 */

import { Logger } from '../../utils/Logger';

export interface BatchConfig {
  /** 最大并发数 */
  concurrency: number;
  /** 单个任务超时（毫秒） */
  timeout: number;
  /** 输出格式 */
  outputFormat?: 'sharegpt' | 'jsonl' | 'raw';
  /** 部分失败时是否继续 */
  continueOnError?: boolean;
}

export interface BatchPrompt {
  /** 唯一标识 */
  id: string;
  /** 提示文本 */
  text: string;
  /** 系统提示（可选） */
  systemPrompt?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

export interface BatchItemResult {
  /** 对应 prompt 的 ID */
  id: string;
  /** 响应文本 */
  response: string;
  /** 是否成功 */
  success: boolean;
  /** 执行耗时（毫秒） */
  duration: number;
  /** 错误信息 */
  error?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

export interface ShareGPTConversation {
  conversations: Array<{ from: 'human' | 'gpt'; value: string }>;
}

export class BatchProcessor {
  private config: Required<BatchConfig>;

  constructor(config: BatchConfig) {
    this.config = {
      concurrency: config.concurrency || 3,
      timeout: config.timeout || 30000,
      outputFormat: config.outputFormat || 'sharegpt',
      continueOnError: config.continueOnError ?? true,
    };
  }

  /**
   * 并行运行批处理
   * @param prompts - 待处理的 prompt 列表
   * @param executor - 单个 prompt 的执行函数
   * @returns 所有 prompt 的执行结果
   */
  async run(
    prompts: BatchPrompt[],
    executor: (prompt: BatchPrompt) => Promise<BatchItemResult>
  ): Promise<BatchItemResult[]> {
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return [];
    }

    const results: BatchItemResult[] = [];
    const queue = [...prompts];
    let running = 0;

    Logger.info(
      `批处理启动: ${prompts.length} 个任务, 并发数 ${this.config.concurrency}`,
      'BatchProcessor'
    );

    return new Promise((resolve) => {
      const tryNext = () => {
        if (queue.length === 0 && running === 0) {
          const successCount = results.filter((r) => r.success).length;
          Logger.info(
            `批处理完成: ${successCount}/${results.length} 成功`,
            'BatchProcessor'
          );
          resolve(results);
          return;
        }

        while (running < this.config.concurrency && queue.length > 0) {
          const prompt = queue.shift()!;
          running++;

          // 带超时的执行，超时后清理定时器
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<BatchItemResult>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('执行超时')),
              this.config.timeout
            );
          });

          const executeWithTimeout = Promise.race([
            executor(prompt).finally(() => {
              if (timeoutId !== undefined) clearTimeout(timeoutId);
            }),
            timeoutPromise,
          ]);

          executeWithTimeout
            .then((result) => {
              results.push(result);
            })
            .catch((err) => {
              if (timeoutId !== undefined) clearTimeout(timeoutId);
              const errorMessage = (err as Error).message;
              Logger.warn(
                `任务 ${prompt.id} 失败: ${errorMessage}`,
                'BatchProcessor'
              );
              results.push({
                id: prompt.id,
                response: '',
                success: false,
                duration: 0,
                error: errorMessage,
              });
            })
            .finally(() => {
              running--;
              tryNext();
            });
        }
      };

      tryNext();
    });
  }

  /**
   * 转换为 ShareGPT 格式
   * @param results - 批处理结果列表
   * @returns ShareGPT 对话格式数据
   */
  toShareGPT(results: BatchItemResult[]): ShareGPTConversation {
    return {
      conversations: results.flatMap((r) => [
        { from: 'human' as const, value: r.id },
        { from: 'gpt' as const, value: r.response },
      ]),
    };
  }

  /**
   * 转换为 JSONL 格式
   * @param results - 批处理结果列表
   * @returns JSONL 格式字符串
   */
  toJSONL(results: BatchItemResult[]): string {
    return results
      .map((r) =>
        JSON.stringify({ id: r.id, response: r.response, success: r.success })
      )
      .join('\n');
  }

  /**
   * 获取配置
   * @returns 只读的完整配置
   */
  getConfig(): Readonly<Required<BatchConfig>> {
    return { ...this.config };
  }
}

/**
 * WebSocket 重试处理模块
 * 从 websocket.ts 提取，专门处理重试逻辑
 */

import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../utils/Logger';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: Error): boolean {
  const msg = error.message || '';
  const retryablePatterns = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'socket hang up',
    'network',
    'timeout',
    '超时',
    '429',
    '503',
    '502',
    'rate limit',
    'temporarily',
  ];
  return retryablePatterns.some((p) =>
    msg.toLowerCase().includes(p.toLowerCase())
  );
}

/**
 * 重试选项
 */
export interface RetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
  onSuccess?: () => void;
  onFailure?: (error: Error, attempted: boolean) => void;
}

/**
 * 重试状态
 */
export interface RetryState {
  attempt: number;
  lastError: Error | null;
  isAborted: boolean;
}

/**
 * 执行带重试的异步操作
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const state: RetryState = {
    attempt: 0,
    lastError: null,
    isAborted: false,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (state.isAborted) {
      Logger.info('🛑 任务已取消，停止重试', 'WsRetry');
      break;
    }

    try {
      const result = await operation();

      if (attempt > 0) {
        Logger.info(`✅ 重试成功 (attempt=${attempt})`, 'WsRetry');
        options.onSuccess?.();
      }

      return result;
    } catch (error) {
      state.lastError = error as Error;
      state.attempt = attempt;

      const canRetry =
        isRetryableError(state.lastError) && attempt < maxRetries;

      Logger.warn(
        `❌ 处理失败 (attempt=${attempt}/${maxRetries}, retryable=${canRetry}): ${state.lastError.message}`,
        'WsRetry'
      );

      if (!canRetry) {
        options.onFailure?.(state.lastError, attempt > 0);
        throw state.lastError;
      }

      // 等待后重试
      options.onRetry?.(attempt, state.lastError);

      await new Promise<void>((resolve) =>
        setTimeout(resolve, retryDelayMs * attempt)
      );
    }
  }

  // 如果循环正常结束但被取消，抛出最后错误
  if (state.lastError) {
    options.onFailure?.(state.lastError, state.attempt > 0);
    throw state.lastError;
  }

  throw new Error('重试操作异常结束');
}

/**
 * 检查是否应该重试
 */
export function shouldRetry(
  error: Error,
  attempt: number,
  maxRetries: number
): boolean {
  return isRetryableError(error) && attempt < maxRetries;
}

/**
 * 生成重试消息
 */
export function getRetryMessage(error: Error): string {
  if (isRetryableError(error)) {
    return `抱歉，网络连接出现问题，已重试${MAX_RETRIES}次仍失败。\n\n请检查：\n1. 网络连接是否正常\n2. LLM 服务是否可用\n3. 稍后再试`;
  }

  const errorMsg = error.message;

  if (
    errorMsg.includes('API') ||
    errorMsg.includes('401') ||
    errorMsg.includes('认证')
  ) {
    return `抱歉，LLM API 认证失败。\n\n请检查 .env 文件中的 API Key 配置：\n- DEEPSEEK_API_KEY 或 OPENAI_API_KEY\n\n配置文件路径: c:\\zy\\jiabaixing\\.env`;
  }

  if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
    return `抱歉，无法连接到 LLM 服务。\n\n请检查：\n1. 如果使用 DeepSeek API，确认网络连接正常\n2. 如果使用本地模型，请启动 Ollama 服务（ollama serve）`;
  }

  return '抱歉，处理出错了，请稍后重试。';
}

/**
 * 发送重试事件到 EventBus
 */
export function emitRetryEvent(traceId: string, attempt: number): void {
  EventBus.emit('agent_execution_update', {
    traceId,
    phase: 'retrying',
    status: 'in_progress',
    message: `处理遇到问题，正在重试（第${attempt}次）...`,
    attempt,
    timestamp: new Date().toISOString(),
  });
}

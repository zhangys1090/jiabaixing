/**
 * WebSocket 输入处理器
 * 从 index.ts 提取，专门处理用户输入的核心逻辑
 *
 * 包含：LLM 服务检查、超时控制、错误友好化、重试+熔断
 */

import * as WebSocket from 'ws';
import { JiabaixingCore, ProcessInputResult } from '../../core/JiabaixingCore';
import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { Logger } from '../../utils/Logger';
import { WsCircuitBreaker } from './WsRateLimit';
import * as WsRetry from './WsRetry';
import { WsTaskManager } from './WsTaskManager';

/** 处理超时阈值（毫秒） */
const PROCESSING_TIMEOUT_MS = 120000;

/**
 * 处理用户输入（带重试+熔断）
 */
export async function processInputWithRetry(
  input: string,
  userId: string,
  traceId: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null,
  clientIp: string,
  taskMeta: ReturnType<WsTaskManager['createTaskMeta']>
): Promise<void> {
  const circuitBreaker = new WsCircuitBreaker('llm_processing');

  try {
    await processInputOnce(input, userId, traceId, ws, core, taskMeta);
    circuitBreaker.recordSuccess();
  } catch (error) {
    circuitBreaker.recordFailure();

    const lastError = error as Error;

    if (WsRetry.isRetryableError(lastError)) {
      const response = WsRetry.getRetryMessage(lastError);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'response_ready',
            data: { response, traceId },
          })
        );
      }
    }

    throw lastError;
  }
}

/**
 * 处理单次输入（核心逻辑）
 */
export async function processInputOnce(
  input: string,
  userId: string,
  traceId: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null,
  taskMeta: ReturnType<WsTaskManager['createTaskMeta']>
): Promise<void> {
  if (!core) {
    throw new Error('核心系统未初始化');
  }

  const llm = core.getLLM();
  if (!llm || !llm.isServiceAvailable()) {
    Logger.warn('⚠️ LLM 服务不可用，返回配置提示', 'WsProcessor');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'response_ready',
          data: {
            response: `抱歉，LLM 服务暂时不可用。\n\n请检查以下配置：\n1. 确认 .env 文件中的 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 已正确设置\n2. 如果使用本地模型，请确认 Ollama 服务已启动\n3. 检查网络连接是否正常\n\n配置文件路径: c:\\zy\\jiabaixing\\.env`,
            traceId,
          },
        })
      );
    }
    return;
  }

  const harness = core.getHarness();
  if (harness) {
    taskMeta.loopController = { abort: () => harness.abortCurrentLoop() };
  }

  try {
    const timeoutId = setTimeout(() => {
      if (!taskMeta.aborted && ws.readyState === WebSocket.OPEN) {
        Logger.warn(
          `⚠️ 处理超时 (${PROCESSING_TIMEOUT_MS}ms): traceId=${traceId}`,
          'WsProcessor'
        );
        ws.send(
          JSON.stringify({
            type: 'response_ready',
            data: {
              response: `抱歉，处理时间过长，已自动终止。\n\n可能的原因：\n1. LLM 服务响应缓慢\n2. 任务过于复杂\n3. 网络连接不稳定\n\n请稍后重试，或简化您的请求。`,
              traceId,
              success: false,
              timeout: true,
            },
          })
        );
        taskMeta.aborted = true;
        if (taskMeta.loopController) {
          taskMeta.loopController.abort();
        }
      }
    }, PROCESSING_TIMEOUT_MS);

    Logger.info(
      `🚀 开始处理输入 [${traceId}]: "${input.substring(0, 50)}..."`,
      'WsProcessor'
    );

    const result: ProcessInputResult = await core.processInput(
      input,
      userId,
      traceId
    );

    clearTimeout(timeoutId);

    if (taskMeta.aborted) {
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      Logger.info(
        `✅ 处理完成, traceId: ${result.traceId}（响应由 streamResponse + eventBusSetup 统一广播）`,
        'WsProcessor'
      );

      // 流式推送由 JiabaixingCore.streamResponse 通过 EventBus 广播
      // 但流式推送是异步的（setTimeout 分块），存在事件丢失风险
      // 发送 response_ready 作为安全兜底：前端已实现去重逻辑
      // 如果 stream_start 已到达（hasRespondedOnceRef=true），前端会跳过 response_ready
      // 如果流式事件丢失，response_ready 确保用户能看到响应
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'response_ready',
              data: {
                response: result.response,
                traceId: result.traceId || traceId,
                success: true,
              },
            })
          );
        }
      }, 500);

      // 记录交互数据到进化编排器，积累真实用户数据
      try {
        const orchestrator = EvolutionOrchestrator.getInstance();
        orchestrator.recordInteraction({
          traceId: result.traceId || traceId,
          input,
          response: result.response,
          success: true,
          qualityScore:
            ((result as unknown as Record<string, unknown>)
              .quality as number) || 0.7,
          executionDuration: 0,
          toolCalls: [],
          scene: 'websocket',
          userId,
        });
      } catch {
        Logger.debug('进化数据记录失败(WS)', 'WsProcessor');
      }
    }
  } catch (error) {
    Logger.error('❌ processInputOnce 执行失败', error as Error, 'WsProcessor');

    if (ws.readyState === WebSocket.OPEN) {
      const errorMsg = (error as Error).message;
      const userFriendlyMessage = friendlyErrorMessage(errorMsg);

      ws.send(
        JSON.stringify({
          type: 'response_ready',
          data: {
            response: userFriendlyMessage,
            traceId,
            success: false,
            error: errorMsg,
          },
        })
      );
    }

    throw error;
  }
}

/**
 * 将技术错误信息转换为用户友好的提示
 */
function friendlyErrorMessage(errorMsg: string): string {
  if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
    return `抱歉，无法连接到 AI 服务。\n\n请检查：\n1. 网络连接是否正常\n2. API Key 是否正确配置\n3. LLM 服务是否可用`;
  }
  if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
    return `抱歉，AI 服务响应超时。\n\n可能原因：\n1. 服务器负载过高\n2. 网络延迟\n3. 请求队列拥堵\n\n请稍后重试。`;
  }
  if (
    errorMsg.includes('API') ||
    errorMsg.includes('401') ||
    errorMsg.includes('认证')
  ) {
    return `抱歉，API 认证失败。\n\n请检查 .env 文件中的 API Key 配置是否正确。`;
  }
  return `抱歉，处理过程中出现了错误：${errorMsg}`;
}

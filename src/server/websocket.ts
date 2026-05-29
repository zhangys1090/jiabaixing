/**
 * WebSocket 连接处理与输入处理
 * P0: 集成限流和熔断机制
 * P1: 自动重试 + 用户取消
 */

import * as WebSocket from 'ws';

import { JiabaixingCore, ProcessInputResult } from '../core/JiabaixingCore';
import { Logger } from '../utils/Logger';
import { SecurityPolicyEngine } from '../security/SecurityPolicyEngine';
import { EventBus } from '../shared/EventBus';
import { SYSTEM_CONSTANTS } from '../shared/contracts';

type WSServer = WebSocket.Server;

// LRU风格去重缓存（带容量限制）
class DedupCache {
  private cache: Map<string, number>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  has(traceId: string): boolean {
    return this.cache.has(traceId);
  }

  add(traceId: string): void {
    // 如果已存在，先删除以更新"最后访问时间"（用Map的插入顺序模拟）
    if (this.cache.has(traceId)) {
      this.cache.delete(traceId);
    }
    // 如果达到容量上限，删除最早的
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(traceId, Date.now());
  }

  delete(traceId: string): void {
    this.cache.delete(traceId);
  }
}

const processedResponses = new DedupCache(
  SYSTEM_CONSTANTS.MAX_DEDUP_CACHE_SIZE
);
function checkAndMarkResponse(traceId: string): boolean {
  if (processedResponses.has(traceId)) {
    return true;
  }
  processedResponses.add(traceId);

  setTimeout(
    () => {
      processedResponses.delete(traceId);
    },
    5 * 60 * 1000
  );

  return false;
}

interface ActiveTask {
  aborted: boolean;
  loopController?: { abort(): void };
  clientIp: string;
  createdAt: number;
}
const activeTasks = new Map<string, ActiveTask>();

function isRetryableError(error: Error): boolean {
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

// 活跃任务自动清理定时器
let activeTaskCleanupInterval: NodeJS.Timeout | null = null;

export function setupWebSocket(
  wss: WSServer | null,
  core: JiabaixingCore | null
): void {
  // 启动活跃任务自动清理定时器
  if (activeTaskCleanupInterval === null) {
    activeTaskCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [traceId, task] of activeTasks.entries()) {
        if (now - task.createdAt > SYSTEM_CONSTANTS.ACTIVE_TASK_TIMEOUT_MS) {
          if (!task.aborted && task.loopController) {
            try {
              task.loopController.abort();
            } catch (e) {
              // 忽略
            }
          }
          activeTasks.delete(traceId);
          Logger.debug(
            `🗑️ 自动清理超时活跃任务: traceId=${traceId}`,
            'WebSocket'
          );
        }
      }
    }, 60 * 1000); // 每分钟检查一次
  }

  wss?.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    Logger.info(`💖 新客户端连接: ${clientIp}`, 'WebSocket');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'user_input' || data.type === 'command') {
          const input =
            data.payload?.input ||
            data.payload?.text ||
            data.payload?.message ||
            data.data?.input ||
            data.data?.text ||
            data.data?.message ||
            data.input ||
            data.text ||
            data.message ||
            '';
          const userId =
            data.payload?.userId ||
            data.payload?.userid ||
            data.data?.userId ||
            data.userId ||
            'anonymous';

          if (!input) {
            ws.send(
              JSON.stringify({
                type: 'error',
                data: { message: '缺少输入内容' },
              })
            );
            return;
          }

          if (input.length > SYSTEM_CONSTANTS.MAX_INPUT_LENGTH) {
            ws.send(
              JSON.stringify({
                type: 'error',
                data: {
                  message: `消息过长（${input.length}字），请控制在${SYSTEM_CONSTANTS.MAX_INPUT_LENGTH}字以内`,
                },
              })
            );
            return;
          }

          const policyEngine = SecurityPolicyEngine.getInstance();
          const rateLimitResult = policyEngine.checkSlidingWindowRateLimit(
            `ws:${userId}:${clientIp}`,
            30,
            10000
          );
          if (!rateLimitResult.allowed) {
            Logger.warn(
              `⚠️ WebSocket限流: userId=${userId} ip=${clientIp}`,
              'WebSocket'
            );
            ws.send(
              JSON.stringify({
                type: 'error',
                data: {
                  message: `请求过于频繁，请${Math.ceil(rateLimitResult.resetIn / 1000)}秒后再试`,
                  code: 'rate_limit_exceeded',
                  retryAfter: rateLimitResult.resetIn,
                },
              })
            );
            return;
          }

          const llmBreaker = policyEngine.getCircuitBreaker('llm_processing');
          if (!llmBreaker.canExecute()) {
            Logger.warn(
              `⚠️ LLM熔断器开启，拒绝请求: userId=${userId}`,
              'WebSocket'
            );
            ws.send(
              JSON.stringify({
                type: 'error',
                data: {
                  message: '服务暂时不可用，请稍后再试',
                  code: 'circuit_open',
                },
              })
            );
            return;
          }

          const traceId = Logger.generateTraceId();
          Logger.info(
            `📩 WebSocket收到: ${String(input).substring(0, 50)}${String(input).length > 50 ? '...' : ''}`,
            'WebSocket'
          );

          processInputWithRetry(
            input as string,
            userId,
            traceId,
            ws,
            core,
            clientIp
          ).catch((err: Error) => {
            Logger.error('❌ 处理输入失败（重试耗尽）', err, 'WebSocket');
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  data: { message: err.message, traceId },
                })
              );
            }
          });
        } else if (data.type === 'cancel_task') {
          const taskTraceId = data.traceId as string | undefined;
          if (taskTraceId && activeTasks.has(taskTraceId)) {
            const task = activeTasks.get(taskTraceId)!;
            task.aborted = true;
            if (task.loopController) {
              task.loopController.abort();
            }
            activeTasks.delete(taskTraceId);
            Logger.info(`🛑 用户取消任务: traceId=${taskTraceId}`, 'WebSocket');
            void EventBus.emit('agent_execution_update', {
              traceId: taskTraceId,
              phase: 'cancelled',
              status: 'aborted',
              message: '用户已取消任务',
              timestamp: new Date().toISOString(),
            });
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'task_cancelled',
                  data: { traceId: taskTraceId, message: '任务已取消' },
                })
              );
            }
          } else {
            Logger.info(
              `🛑 取消任务未找到: traceId=${taskTraceId}`,
              'WebSocket'
            );
          }
        } else if (data.type === 'get_status') {
          ws.send(
            JSON.stringify({
              type: 'status',
              data: {
                status: 'running',
                model: process.env.MODEL_NAME || 'qwen2.5:3b',
                uptime: process.uptime(),
                clients: wss?.clients.size || 0,
              },
            })
          );
        } else if (data.type === 'clarification_response') {
          Logger.info(`💬 收到澄清回答: ${data.response}`, 'WebSocket');
        } else if (data.type === 'execution_confirm') {
          Logger.info(
            `✅ 收到执行确认: ${data.confirmed ? '确认' : '取消'}`,
            'WebSocket'
          );
        } else if (data.type === 'automation_task_toggle') {
          Logger.info(
            `⚡ 自动化任务切换: ${data.taskId} -> ${data.enabled ? '启用' : '禁用'}`,
            'WebSocket'
          );
        } else if (data.type === 'automation_task_create') {
          Logger.info(
            `⚡ 自动化任务创建: ${JSON.stringify(data.task)}`,
            'WebSocket'
          );
        } else if (data.type === 'automation_trigger_execute') {
          Logger.info(
            `⚡ 自动化触发执行: ${JSON.stringify(data.trigger)}`,
            'WebSocket'
          );
        } else {
          Logger.info(`📨 WebSocket收到未知类型: ${data.type}`, 'WebSocket');
        }
      } catch (error) {
        Logger.error('❌ 解析WebSocket消息失败', error as Error, 'WebSocket');
      }
    });

    ws.on('close', () => {
      Logger.info(`👋 客户端断开: ${clientIp}`, 'WebSocket');
      // 清理该用户的所有活跃任务
      for (const [traceId, task] of activeTasks.entries()) {
        if (task.clientIp === clientIp) {
          if (!task.aborted && task.loopController) {
            try {
              task.loopController.abort();
            } catch (e) {
              // 忽略
            }
          }
          activeTasks.delete(traceId);
          Logger.debug(
            `🗑️ 清理客户端断开关联任务: traceId=${traceId}`,
            'WebSocket'
          );
        }
      }
    });

    ws.send(
      JSON.stringify({
        type: 'connected',
        data: {
          message: '💖 已连接到家百星智能助手',
          model: process.env.LLM_MODEL || 'deepseek-chat',
          status: 'running',
          timestamp: new Date().toISOString(),
        },
      })
    );
  });
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

async function processInputWithRetry(
  input: string,
  userId: string,
  traceId: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null,
  clientIp: string
): Promise<void> {
  if (checkAndMarkResponse(traceId)) {
    Logger.info(`⚠️ traceId ${traceId} 已处理，跳过重复请求`, 'WebSocket');
    return;
  }

  const taskHandle: ActiveTask = {
    aborted: false,
    loopController: undefined,
    clientIp,
    createdAt: Date.now(),
  };
  activeTasks.set(traceId, taskHandle);

  if (ws.readyState === 1) {
    ws.send(
      JSON.stringify({
        type: 'processing_status',
        data: {
          status: 'processing',
          message: '收到消息，正在处理中...',
          traceId,
        },
      })
    );
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (taskHandle.aborted) {
      Logger.info(`🛑 任务已取消，停止重试: traceId=${traceId}`, 'WebSocket');
      return;
    }

    try {
      if (attempt > 0) {
        Logger.info(
          `🔄 第 ${attempt} 次重试, traceId: ${traceId}`,
          'WebSocket'
        );
        void EventBus.emit('agent_execution_update', {
          traceId,
          phase: 'retrying',
          status: 'in_progress',
          message: `处理遇到问题，正在重试（第${attempt}次）...`,
          attempt,
          timestamp: new Date().toISOString(),
        });

        await new Promise<void>((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt)
        );

        if (taskHandle.aborted) {
          return;
        }
      }

      await processInputOnce(input, userId, traceId, ws, core, taskHandle);

      activeTasks.delete(traceId);
      return;
    } catch (error) {
      lastError = error as Error;

      if (taskHandle.aborted) {
        activeTasks.delete(traceId);
        return;
      }

      const canRetry = isRetryableError(lastError) && attempt < MAX_RETRIES;
      Logger.warn(
        `❌ 处理失败 (attempt=${attempt}/${MAX_RETRIES}, retryable=${canRetry}): ${lastError.message}`,
        'WebSocket'
      );

      if (!canRetry) {
        break;
      }
    }
  }

  activeTasks.delete(traceId);

  const policyEngine = SecurityPolicyEngine.getInstance();
  policyEngine.getCircuitBreaker('llm_processing').recordFailure();

  if (ws.readyState === 1 && lastError) {
    const errorMsg = lastError.message;
    let response = `抱歉，处理出错了：${errorMsg}`;

    if (isRetryableError(lastError)) {
      response = `抱歉，网络连接出现问题，已重试${MAX_RETRIES}次仍失败。\n\n请检查：\n1. 网络连接是否正常\n2. LLM 服务是否可用\n3. 稍后再试`;
    } else if (
      errorMsg.includes('API') ||
      errorMsg.includes('401') ||
      errorMsg.includes('认证')
    ) {
      response = `抱歉，LLM API 认证失败。\n\n请检查 .env 文件中的 API Key 配置：\n- DEEPSEEK_API_KEY 或 OPENAI_API_KEY\n\n配置文件路径: c:\\zy\\jiabaixing\\.env`;
    } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
      response = `抱歉，无法连接到 LLM 服务。\n\n请检查：\n1. 如果使用 DeepSeek API，确认网络连接正常\n2. 如果使用本地模型，请启动 Ollama 服务（ollama serve）`;
    }

    ws.send(
      JSON.stringify({
        type: 'response_ready',
        data: {
          response,
          traceId,
        },
      })
    );
  }
}

async function processInputOnce(
  input: string,
  userId: string,
  traceId: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null,
  taskHandle: { aborted: boolean; loopController?: { abort(): void } }
): Promise<void> {
  if (!core) {
    throw new Error('核心系统未初始化');
  }

  const llm = core.getLLM();
  if (!llm || !llm.isServiceAvailable()) {
    Logger.warn('⚠️ LLM 服务不可用，返回配置提示', 'WebSocket');
    if (ws.readyState === 1) {
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
    taskHandle.loopController = { abort: () => harness.abortCurrentLoop() };
  }

  try {
    const PROCESSING_TIMEOUT_MS = 120000;
    const timeoutId = setTimeout(() => {
      if (!taskHandle.aborted && ws.readyState === 1) {
        Logger.warn(
          `⚠️ 处理超时 (${PROCESSING_TIMEOUT_MS}ms): traceId=${traceId}`,
          'WebSocket'
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
        taskHandle.aborted = true;
        if (taskHandle.loopController) {
          taskHandle.loopController.abort();
        }
      }
    }, PROCESSING_TIMEOUT_MS);

    Logger.info(
      `🚀 开始处理输入 [${traceId}]: "${input.substring(0, 50)}..."`,
      'WebSocket'
    );

    const result: ProcessInputResult = await core.processInput(
      input,
      userId,
      traceId
    );

    clearTimeout(timeoutId);

    if (taskHandle.aborted) {
      return;
    }

    const policyEngine = SecurityPolicyEngine.getInstance();
    policyEngine.getCircuitBreaker('llm_processing').recordSuccess();

    if (ws.readyState === 1) {
      Logger.info(
        `✅ 处理完成, traceId: ${result.traceId}（响应由 EventBus → eventBusSetup 统一广播）`,
        'WebSocket'
      );
    }
  } catch (error) {
    Logger.error('❌ processInputOnce 执行失败', error as Error, 'WebSocket');

    if (ws.readyState === 1) {
      const errorMsg = (error as Error).message;
      let userFriendlyMessage = `抱歉，处理过程中出现了错误：${errorMsg}`;

      if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
        userFriendlyMessage = `抱歉，无法连接到 AI 服务。\n\n请检查：\n1. 网络连接是否正常\n2. API Key 是否正确配置\n3. LLM 服务是否可用`;
      } else if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
        userFriendlyMessage = `抱歉，AI 服务响应超时。\n\n可能原因：\n1. 服务器负载过高\n2. 网络延迟\n3. 请求队列拥堵\n\n请稍后重试。`;
      } else if (
        errorMsg.includes('API') ||
        errorMsg.includes('401') ||
        errorMsg.includes('认证')
      ) {
        userFriendlyMessage = `抱歉，API 认证失败。\n\n请检查 .env 文件中的 API Key 配置是否正确。`;
      }

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

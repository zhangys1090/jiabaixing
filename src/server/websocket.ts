/**
 * WebSocket 连接处理与输入处理
 * P0: 集成限流和熔断机制
 * P1: 自动重试 + 用户取消
 */

import * as WebSocket from 'ws';

import { JiabaixingCore, ProcessInputResult } from '../core/JiabaixingCore';
import { SecurityPolicyEngine } from '../security/SecurityPolicyEngine';
import { EventBus } from '../shared/EventBus';
import { SYSTEM_CONSTANTS } from '../shared/contracts';
import { Logger } from '../utils/Logger';
import { getPythonBridge, isPythonBackend } from './bootstrap';

type WSServer = WebSocket.Server;

/** 音频流会话缓冲区（用于 audio_chunk/audio_end 实时语音识别） */
interface AudioStreamSession {
  chunks: string[];
  format: string;
  startedAt: number;
}
const audioStreamBuffers = new Map<string, AudioStreamSession>();

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

const MAX_WS_CONNECTIONS = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export function setupWebSocket(
  wss: WSServer | null,
  core: JiabaixingCore | null
): void {
  if (!wss) return;

  if (activeTaskCleanupInterval === null) {
    activeTaskCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [traceId, task] of activeTasks.entries()) {
        if (now - task.createdAt > SYSTEM_CONSTANTS.ACTIVE_TASK_TIMEOUT_MS) {
          if (!task.aborted && task.loopController) {
            try {
              task.loopController.abort();
            } catch {
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
    }, 60 * 1000);
  }

  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      const ext = client as WebSocket.WebSocket & { isAlive?: boolean };
      if (!ext.isAlive) {
        ext.terminate();
        continue;
      }
      ext.isAlive = false;
      ext.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, req) => {
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      Logger.warn(
        `⚠️ WebSocket 连接数超限 (${wss.clients.size}/${MAX_WS_CONNECTIONS})，拒绝新连接`,
        'WebSocket'
      );
      ws.close(1013, 'Server busy: max connections reached');
      return;
    }

    const clientIp = req.socket.remoteAddress || 'unknown';
    Logger.info(`💖 新客户端连接: ${clientIp} (在线: ${wss.clients.size})`, 'WebSocket');

    const ext = ws as WebSocket.WebSocket & { isAlive?: boolean };
    ext.isAlive = true;
    ws.on('pong', () => { ext.isAlive = true; });

    ws.on('message', async (message) => {
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
          void EventBus.emit('clarification_response', data);
        } else if (data.type === 'execution_confirm') {
          Logger.info(
            `✅ 收到执行确认: ${data.confirmed ? '确认' : '取消'}`,
            'WebSocket'
          );
          void EventBus.emit('execution_confirm', data);
        } else if (data.type === 'automation_task_toggle') {
          Logger.info(
            `⚡ 自动化任务切换: ${data.taskId} -> ${data.enabled ? '启用' : '禁用'}`,
            'WebSocket'
          );
          if (core?.getScenarioScheduler()) {
            const scheduler = core.getScenarioScheduler()!;
            if (data.enabled) scheduler.toggleTask?.(data.taskId, true);
            else scheduler.toggleTask?.(data.taskId, false);
          }
          void EventBus.emit('automation_task_toggle', data);
        } else if (data.type === 'automation_task_create') {
          Logger.info(
            `⚡ 自动化任务创建: ${JSON.stringify(data.task)}`,
            'WebSocket'
          );
          if (core?.getScenarioScheduler()) {
            core.getScenarioScheduler()!.addTask(data.task);
          }
          void EventBus.emit('automation_task_create', data);
        } else if (data.type === 'automation_trigger_execute') {
          Logger.info(
            `⚡ 自动化触发执行: ${JSON.stringify(data.trigger)}`,
            'WebSocket'
          );
          void EventBus.emit('automation_trigger_execute', data);
        } else if (data.type === 'audio_chunk') {
          // 实时音频流块 — 累积到会话缓冲区
          try {
            const sessionId = data.sessionId as string | undefined;
            const chunk = data.chunk as string | undefined;
            const format = (data.format as string) || 'webm';
            if (!chunk) return;

            const sid = sessionId || `audio_${clientIp}_${Date.now()}`;
            if (!audioStreamBuffers.has(sid)) {
              audioStreamBuffers.set(sid, {
                chunks: [],
                format,
                startedAt: Date.now(),
              });
            }
            audioStreamBuffers.get(sid)!.chunks.push(chunk);
          } catch {
            // 静默处理音频块错误
          }
        } else if (data.type === 'audio_end') {
          // 音频流结束 — 合并缓冲区，送入语音识别
          try {
            const sessionId = data.sessionId as string | undefined;
            const sid = sessionId || '';
            if (sid && audioStreamBuffers.has(sid)) {
              const session = audioStreamBuffers.get(sid)!;
              audioStreamBuffers.delete(sid);

              // 将 base64 音频块合并为 Buffer
              const audioBuffers: Buffer[] = [];
              for (const chunk of session.chunks) {
                audioBuffers.push(Buffer.from(chunk, 'base64'));
              }
              const fullAudio = Buffer.concat(audioBuffers);

              // 发送 ASR 识别结果
              try {
                const { SpeechRecognizer } =
                  await import('../multimodal/SpeechRecognizer');
                const recognizer = new SpeechRecognizer();
                await recognizer.initialize();

                // SpeechRecognizer 只有 recognize(buffer) 接口
                const result = await recognizer.recognize(fullAudio);

                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'asr_result',
                      data: {
                        text: result.text,
                        confidence: result.confidence,
                        language: result.language || 'zh-CN',
                        duration: result.duration || 0,
                        sessionId: sid,
                      },
                    })
                  );
                }

                // 将识别文本作为用户输入处理
                if (result.text) {
                  const traceId = Logger.generateTraceId();
                  processInputWithRetry(
                    result.text,
                    'voice_user',
                    traceId,
                    ws,
                    core,
                    clientIp
                  ).catch((err: Error) => {
                    Logger.error('❌ 语音输入处理失败', err, 'WebSocket');
                  });
                }
              } catch (asrErr) {
                Logger.error('❌ ASR识别失败', asrErr as Error, 'WebSocket');
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'error',
                      data: { message: '语音识别失败', sessionId: sid },
                    })
                  );
                }
              }
            }
          } catch (audioErr) {
            Logger.error('❌ 音频流处理失败', audioErr as Error, 'WebSocket');
          }
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
            } catch {
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
          model: process.env.LLM_MODEL || 'deepseek-v4-flash',
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

export async function processInputOnce(
  input: string,
  userId: string,
  traceId: string,
  ws: WebSocket.WebSocket,
  core: JiabaixingCore | null,
  taskHandle: { aborted: boolean; loopController?: { abort(): void } }
): Promise<void> {
  // WS 通道直接处理聊天消息：转发到 Python 后端并以流式事件回推，
  // 与 HTTP /api/process 互斥（前端仅在 WS 断开时回退 HTTP），保证单次生成只走一条路径。
  if (isPythonBackend()) {
    const bridge = getPythonBridge()!;

    const PROCESSING_TIMEOUT_MS = 120000;
    const timeoutId = setTimeout(() => {
      if (!taskHandle.aborted && ws.readyState === 1) {
        Logger.warn(
          `Python Agent 处理超时 (${PROCESSING_TIMEOUT_MS}ms): traceId=${traceId}`,
          'WebSocket'
        );
        ws.send(
          JSON.stringify({
            type: 'response_ready',
            data: {
              response: '抱歉，处理时间过长，已自动终止。请稍后重试。',
              traceId,
              success: false,
              timeout: true,
            },
          })
        );
        taskHandle.aborted = true;
      }
    }, PROCESSING_TIMEOUT_MS);

    try {
      Logger.info(
        `[Python] 开始流式处理 [${traceId}]: "${input.substring(0, 50)}..."`,
        'WebSocket'
      );

      const contentBuffer: string[] = [];

      for await (const event of bridge.processInputStream(
        input,
        userId,
        traceId
      )) {
        if (taskHandle.aborted || ws.readyState !== 1) break;

        const eventTraceId = event.trace_id || traceId;

        switch (event.type) {
          case 'stream_start':
            ws.send(
              JSON.stringify({
                type: 'stream_start',
                data: { traceId: eventTraceId },
              })
            );
            break;

          case 'stream_chunk':
            if (event.content) {
              contentBuffer.push(event.content);
              ws.send(
                JSON.stringify({
                  type: 'stream_chunk',
                  data: { traceId: eventTraceId, chunk: event.content },
                })
              );
            }
            break;

          case 'stream_done': {
            const fullText = event.content || contentBuffer.join('');
            ws.send(
              JSON.stringify({
                type: 'stream_done',
                data: { traceId: eventTraceId, fullText },
              })
            );
            ws.send(
              JSON.stringify({
                type: 'response_ready',
                data: {
                  response: fullText,
                  traceId: eventTraceId,
                  success: true,
                },
              })
            );
            break;
          }

          case 'thinking':
          case 'tool_start':
          case 'tool_end':
          case 'progress':
            ws.send(
              JSON.stringify({
                type: event.type,
                data: {
                  traceId: eventTraceId,
                  content: event.content,
                  toolName: event.tool_name,
                  toolArgs: event.tool_args,
                  success: event.success,
                  resultSummary: event.result_summary,
                  durationMs: event.duration_ms,
                  phase: event.phase,
                  stepsCompleted: event.steps_completed,
                  stepsTotal: event.steps_total,
                  message: event.message,
                },
              })
            );
            break;

          case 'error':
            ws.send(
              JSON.stringify({
                type: 'response_ready',
                data: {
                  response: event.content || '处理失败',
                  traceId: eventTraceId,
                  success: false,
                  error: event.raw_error || event.content,
                },
              })
            );
            break;

          case 'task_cancelled':
            ws.send(
              JSON.stringify({
                type: 'response_ready',
                data: {
                  response: event.content || '任务已取消',
                  traceId: eventTraceId,
                  success: false,
                  cancelled: true,
                },
              })
            );
            break;
        }
      }

      clearTimeout(timeoutId);

      if (taskHandle.aborted) return;

      const policyEngine = SecurityPolicyEngine.getInstance();
      policyEngine.getCircuitBreaker('llm_processing').recordSuccess();

      Logger.info(`[Python] 流式处理完成, traceId: ${traceId}`, 'WebSocket');
    } catch (error) {
      clearTimeout(timeoutId);
      Logger.error(
        '[Python] processInputOnce 流式执行失败',
        error as Error,
        'WebSocket'
      );
      if (ws.readyState === 1 && !taskHandle.aborted) {
        ws.send(
          JSON.stringify({
            type: 'response_ready',
            data: {
              response: `处理失败: ${(error as Error).message}`,
              traceId,
              success: false,
            },
          })
        );
      }
      throw error;
    }
    return;
  }

  // ── TS 本地路径 ──
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

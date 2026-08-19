/**
 * D2 认知信号回灌转发器 (P2 第4轮)。
 *
 * TS 侧认知工具 (emotion_detect / self_reflect / scene_analyze) 完成后,
 * ToolRegistry 经 EventBus.emit('cognition_result', { ..., sessionId }) 发出结构化结果。
 * 本模块订阅该事件, 经 PythonAgentBridge 转发到 Python POST /v1/cognition/signal,
 * 由 Python ReAct 循环在每轮 LLM 调用前把会话级认知信号注入上下文 (元认知回灌)。
 *
 * 设计要点:
 *  - 仅当 payload 携带 sessionId 时才转发 (否则无法归属到 Python 会话, 诚实丢弃)。
 *  - 转发失败静默降级 (记录 debug), 不阻断主链路。
 *  - 幂等注册: 多次调用 registerCognitionForwarder 仅生效一次。
 */
import { EventBus } from '../../shared/EventBus';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { Logger } from '../../utils/Logger';

interface CognitionResultPayload {
  sessionId?: string | null;
  tool?: string;
  category?: string;
  success?: boolean;
  durationMs?: number;
  outputPreview?: string | null;
  error?: string | null;
  timestamp?: string;
}

let registered = false;

export function registerCognitionForwarder(): void {
  if (registered) return;
  registered = true;

  EventBus.on('cognition_result', (payload: unknown) => {
    const p = payload as CognitionResultPayload;
    const sessionId = p?.sessionId;
    if (!sessionId) return; // 无会话归属 → 不转发 (诚实降级)

    const bridge = getActivePythonBridge();
    if (
      !bridge ||
      typeof (bridge as { sendCognitionSignal?: unknown }).sendCognitionSignal !==
        'function'
    ) {
      return;
    }
    (bridge as {
      sendCognitionSignal: (
        s: string,
        pl: Record<string, unknown>
      ) => Promise<unknown>;
    })
      .sendCognitionSignal(sessionId, {
        tool: p.tool,
        category: p.category,
        success: p.success,
        durationMs: p.durationMs,
        outputPreview: p.outputPreview,
        error: p.error,
        timestamp: p.timestamp,
      })
      .catch((err: unknown) => {
        // 转发失败静默降级, 仅 debug 记录 (不阻断认知工具主链路)
        Logger.debug(
          `⚠️ D2: 认知信号转发 Python 失败 (${sessionId}): ${(err as Error)?.message}`,
          'CognitionForwarder'
        );
      });
  });
}

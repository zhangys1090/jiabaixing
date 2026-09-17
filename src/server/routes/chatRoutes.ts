/**
 * /api/chat 对话 API 路由
 * 提供 POST /api/chat 端点，接收用户消息并返回 AI 回复
 *
 * Layer 1 收口：bridge 调用注入 traceId/goalId/snapshotId，
 * 确保 TS→Python 跨进程调用有完整审计链。
 */

import { Request, Response, Router } from 'express';
import { DecisionGuard } from '../../authority/DecisionGuard';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';
import { getPythonBridge, isPythonBackend } from '../bootstrap';

const router = Router();

let _core: JiabaixingCore | null = null;

/**
 * 设置核心实例引用（由 main.ts 在初始化时调用）
 */
export function setChatCore(core: JiabaixingCore): void {
  _core = core;
}

function getCore(): JiabaixingCore {
  if (!_core) {
    throw new Error(
      'chatRoutes: 核心实例未注入，请在 main.ts 中调用 setChatCore()'
    );
  }
  return _core;
}

// POST /api/chat — 发送对话消息
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message, conversation_id } = req.body as {
      message?: string;
      conversation_id?: string;
    };

    if (
      !message ||
      typeof message !== 'string' ||
      message.trim().length === 0
    ) {
      res.status(400).json({
        success: false,
        error: '消息不能为空',
      });
      return;
    }

    const userId = conversation_id || 'default';
    const input = message.trim();

    Logger.info(
      `[Chat API] 收到消息: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`,
      'ChatRoute'
    );

    const responseConversationId = conversation_id || userId;

    if (isPythonBackend()) {
      const bridge = getPythonBridge()!;
      const traceId = Logger.generateTraceId();

      const guard = DecisionGuard.getInstance();
      const { decision, snapshot, goalId } = await guard.guardAction({
        action: { type: 'message', payload: { input } },
        description: `Chat: ${input.substring(0, 60)}`,
        executionDomain: 'orchestrator',
        proposerId: 'chat_route',
        confidence: 0.8,
        reasoning: 'User chat message',
      });
      const authorityMeta = guard.extractAuthorityMeta(
        decision,
        snapshot,
        goalId
      );

      const result = await bridge.processInput(
        input,
        userId,
        traceId,
        undefined,
        authorityMeta
      );
      res.json({
        success: true,
        response: result.response,
        conversation_id: responseConversationId,
        trace_id: result.traceId || traceId,
        authorityMeta,
        backend: 'python',
      });
      return;
    }

    const core = getCore();
    const result = await core.processInput(input, userId);

    res.json({
      success: true,
      response: result.response,
      conversation_id: responseConversationId,
      trace_id: result.traceId,
      backend: 'typescript',
    });
  } catch (error) {
    Logger.error('[Chat API] 处理失败', error as Error, 'ChatRoute');
    res.status(500).json({
      success: false,
      error: '对话处理失败',
      details: (error as Error).message,
    });
  }
});

export default router;

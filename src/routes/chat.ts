/**
 * /api/chat 对话 API 路由
 * 提供 POST /api/chat 端点，接收用户消息并返回 AI 回复
 */

import { Router, Request, Response } from 'express';
import { JiabaixingCore } from '../core/JiabaixingCore';
import { Logger } from '../utils/Logger';

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

    const core = getCore();
    const result = await core.processInput(input, userId);

    // 返回 conversation_id 以便前端保持同一对话
    const responseConversationId = conversation_id || userId;

    res.json({
      success: true,
      response: result.response,
      conversation_id: responseConversationId,
      trace_id: result.traceId,
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

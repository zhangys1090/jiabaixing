/**
 * OpenAI 兼容 API 路由
 *
 * 提供 /v1/chat/completions 和 /v1/models 端点，
 * 使 jiabaixing 可作为 OpenAI 兼容服务被外部调用。
 */

import express from 'express';

export interface OpenAICompatibleModelInfo {
  id: string;
  name: string;
  priority: number;
}

export interface OpenAICompatibleRouterOptions {
  processInput: (
    input: string
  ) => Promise<{ response: string; traceId: string }>;
  getAvailableModels: () => OpenAICompatibleModelInfo[];
}

/**
 * 创建 OpenAI 兼容路由
 * @param options - 路由配置
 * @returns Express Router
 */
export function createOpenAICompatibleRouter(
  options: OpenAICompatibleRouterOptions
): express.Router {
  const router = express.Router();

  router.post('/v1/chat/completions', async (req, res) => {
    try {
      const { messages } = req.body ?? {};

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'messages 不能为空',
            type: 'invalid_request_error',
            code: 'messages_empty',
          },
        });
      }

      const userMessage = messages.find(
        (m: { role: string; content?: string }) => m.role === 'user'
      );

      if (!userMessage) {
        return res.status(400).json({
          error: {
            message: 'messages 中必须包含至少一条 user 消息',
            type: 'invalid_request_error',
            code: 'no_user_message',
          },
        });
      }

      const input =
        typeof userMessage.content === 'string'
          ? userMessage.content
          : Array.isArray(userMessage.content)
            ? userMessage.content
                .map((c: { text?: string; type?: string }) =>
                  typeof c === 'string' ? c : (c.text ?? '')
                )
                .join('')
            : '';

      const { response, traceId } = await options.processInput(input);

      return res.json({
        id: `chatcmpl-${traceId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.body.model ?? 'jiabaixing',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: response,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    } catch (err) {
      return res.status(500).json({
        error: {
          message: (err as Error).message,
          type: 'internal_error',
        },
      });
    }
  });

  router.get('/v1/models', (_req, res) => {
    const models = options.getAvailableModels();
    return res.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'jiabaixing',
      })),
    });
  });

  return router;
}

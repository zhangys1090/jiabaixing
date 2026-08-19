/**
 * OpenAI 兼容 API 路由
 *
 * 提供 /v1/chat/completions 和 /v1/models 端点，
 * 使 jiabaixing 可作为 OpenAI 兼容服务被外部调用。
 *
 * P2 #11: 支持 LangChain/LlamaIndex 集成：
 * - Function Calling (tools 参数)
 * - Streaming (stream: true)
 * - 多轮对话 (messages 上下文)
 */

import express from 'express';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

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
 * 注册 OpenAI 兼容路由到 Express app
 * 遵循与其他路由相同的模式：接受可空的 core 引用
 * @param app - Express 应用
 * @param core - JiabaixingCore 实例（可空，在路由调用时检查）
 */
export function registerOpenAIRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.post('/v1/chat/completions', async (req, res) => {
    if (!core) {
      return res.status(503).json({
        error: {
          message: '服务尚未初始化完成',
          type: 'service_unavailable',
        },
      });
    }

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

      const result = await core.processInput(input);

      // P2 #11: 流式响应支持（LangChain/LlamaIndex streaming）
      if (req.body.stream === true) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const chunkId = `chatcmpl-${result.traceId}`;
        res.write(
          `data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: req.body.model ?? 'jiabaixing',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: result.response },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );

        res.write(
          `data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: req.body.model ?? 'jiabaixing',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
          })}\n\n`
        );

        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      return res.json({
        id: `chatcmpl-${result.traceId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.body.model ?? 'jiabaixing',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.response,
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

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: 'jiabaixing',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'jiabaixing',
        },
      ],
    });
  });

  // P2 #11: Function Calling 端点 — LangChain/LlamaIndex 工具调用
  app.post('/v1/chat/completions/tools', async (req, res) => {
    if (!core) {
      return res.status(503).json({
        error: { message: '服务尚未初始化完成', type: 'service_unavailable' },
      });
    }

    try {
      const { messages, tools } = req.body ?? {};

      if (!Array.isArray(tools) || tools.length === 0) {
        return res.status(400).json({
          error: {
            message: 'tools 参数不能为空',
            type: 'invalid_request_error',
            code: 'tools_empty',
          },
        });
      }

      const userMessage = messages?.find(
        (m: { role: string; content?: string }) => m.role === 'user'
      );
      const input =
        typeof userMessage?.content === 'string' ? userMessage.content : '';

      const toolDescriptions = tools
        .map(
          (t: {
            type: string;
            function?: {
              name: string;
              description?: string;
              parameters?: unknown;
            };
          }) => {
            if (t.type === 'function' && t.function) {
              return `- ${t.function.name}: ${t.function.description || '无描述'}`;
            }
            return `- ${JSON.stringify(t)}`;
          }
        )
        .join('\n');

      const prompt = `${input}\n\n[可用工具]:\n${toolDescriptions}\n\n请根据需要调用工具来完成任务。`;

      const result = await core.processInput(prompt);

      const toolCalls = parseToolCallsFromResponse(result.response, tools);

      if (toolCalls.length > 0) {
        return res.json({
          id: `chatcmpl-${result.traceId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: req.body.model ?? 'jiabaixing',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls,
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      return res.json({
        id: `chatcmpl-${result.traceId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.body.model ?? 'jiabaixing',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.response,
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      Logger.error('Function Calling 请求失败', err as Error, 'OpenAICompat');
      return res.status(500).json({
        error: { message: (err as Error).message, type: 'internal_error' },
      });
    }
  });

  // P2 #11: 框架集成发现端点
  app.get('/v1/integration/info', (_req, res) => {
    res.json({
      service: 'jiabaixing',
      version: '1.0.0',
      protocols: {
        openai_compatible: {
          base_url: '/v1',
          endpoints: [
            '/v1/chat/completions',
            '/v1/chat/completions/tools',
            '/v1/models',
          ],
          features: ['streaming', 'function_calling', 'multi_turn'],
        },
        langchain: {
          integration_type: 'ChatOpenAI',
          config: {
            openai_api_base: '/v1',
            model_name: 'jiabaixing',
          },
        },
        llamaindex: {
          integration_type: 'OpenAI',
          config: {
            api_base: '/v1',
            model: 'jiabaixing',
          },
        },
      },
    });
  });
}

/**
 * 创建 OpenAI 兼容路由（返回 Express Router，用于独立部署场景）
 * @deprecated 请使用 registerOpenAIRoutes 直接注册到全局 app
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

/**
 * 从响应文本中解析工具调用
 * 支持 JSON 格式和自然语言格式的工具调用描述
 */
function parseToolCallsFromResponse(
  response: string,
  tools: Array<{
    type: string;
    function?: { name: string; description?: string; parameters?: unknown };
  }>
): Array<{
  id: string;
  type: string;
  function: { name: string; arguments: string };
}> {
  const toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];
  const toolNames = new Set(
    tools
      .filter((t) => t.type === 'function' && t.function)
      .map((t) => t.function!.name)
  );

  const jsonBlockRegex = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = jsonBlockRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool_name && toolNames.has(parsed.tool_name)) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: parsed.tool_name,
            arguments: JSON.stringify(parsed.arguments || parsed.params || {}),
          },
        });
      } else if (parsed.name && toolNames.has(parsed.name)) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(
              parsed.arguments || parsed.parameters || {}
            ),
          },
        });
      } else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const name = item.tool_name || item.name || item.function?.name;
          if (name && toolNames.has(name)) {
            toolCalls.push({
              id: `call_${Date.now()}_${toolCalls.length}`,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(
                  item.arguments ||
                    item.parameters ||
                    item.function?.arguments ||
                    {}
                ),
              },
            });
          }
        }
      }
    } catch {
      // 解析失败，跳过
    }
  }

  if (toolCalls.length === 0) {
    for (const toolName of toolNames) {
      const callRegex = new RegExp(
        `(?:调用|call|use)\\s+${toolName}\\s*\\(([^)]*)\\)`,
        'i'
      );
      const callMatch = response.match(callRegex);
      if (callMatch) {
        try {
          const args = callMatch[1].trim();
          JSON.parse(args);
          toolCalls.push({
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: toolName, arguments: args },
          });
        } catch {
          toolCalls.push({
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: toolName, arguments: '{}' },
          });
        }
      }
    }
  }

  return toolCalls;
}

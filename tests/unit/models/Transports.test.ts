/**
 * Provider 传输层单元测试
 *
 * 测试 ChatCompletionsTransport / AnthropicMessagesTransport / TransportFactory
 * 验证 convert_messages → convert_tools → build_kwargs → normalize_response 数据流
 */

import type { ModelInput } from '../../../src/core/ModelInterface';
import { AnthropicMessagesTransport } from '../../../src/models/transports/AnthropicMessagesTransport';
import type { TransportConfig } from '../../../src/models/transports/BaseTransport';
import { ChatCompletionsTransport } from '../../../src/models/transports/ChatCompletionsTransport';
import { TransportFactory } from '../../../src/models/transports/TransportFactory';

const baseConfig: TransportConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'test-key',
  modelName: 'test-model',
  timeout: 30000,
  maxTokens: 4096,
  temperature: 0.7,
  topP: 0.9,
};

const sampleTools: Array<Record<string, unknown>> = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];

describe('Provider 传输层', () => {
  describe('ChatCompletionsTransport', () => {
    let transport: ChatCompletionsTransport;

    beforeEach(() => {
      transport = new ChatCompletionsTransport(baseConfig);
    });

    it('应该正确标识 providerType', () => {
      expect(transport.providerType).toBe('openai_compatible');
    });

    it('应该从 prompt + systemPrompt 转换消息', () => {
      const input: ModelInput = {
        prompt: '你好',
        systemPrompt: '你是助手',
      };
      const messages = transport.convertMessages(input);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'system',
        content: '你是助手',
      });
      expect(messages[1]).toMatchObject({ role: 'user', content: '你好' });
    });

    it('应该优先使用 messages 数组', () => {
      const input: ModelInput = {
        prompt: 'ignored',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ],
      };
      const messages = transport.convertMessages(input);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'system', content: 'sys' });
    });

    it('应该透传 OpenAI 格式工具定义', () => {
      const tools = transport.convertTools(sampleTools);
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools![0]).toMatchObject({
        type: 'function',
        function: { name: 'get_weather' },
      });
    });

    it('应该对空工具返回 undefined', () => {
      expect(transport.convertTools(undefined)).toBeUndefined();
      expect(transport.convertTools([])).toBeUndefined();
    });

    it('应该构建正确的请求（含 URL/headers/body）', () => {
      const input: ModelInput = { prompt: 'test' };
      const messages = transport.convertMessages(input);
      const tools = transport.convertTools(sampleTools);
      const req = transport.buildRequest(input, messages, tools);

      expect(req.url).toBe('https://api.example.com/chat/completions');
      expect(req.method).toBe('POST');
      expect(req.headers['Authorization']).toBe('Bearer test-key');
      expect(req.headers['Content-Type']).toBe('application/json');
      expect(req.body['model']).toBe('test-model');
      expect(req.body['messages']).toEqual(messages);
      expect(req.body['tools']).toEqual(tools);
      expect(req.body['tool_choice']).toBe('auto');
      expect(req.body['stream']).toBe(false);
    });

    it('应该规范化成功响应', () => {
      const responseText = JSON.stringify({
        choices: [
          {
            message: { content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const result = transport.normalizeResponse({
        status: 200,
        ok: true,
        text: responseText,
      });
      expect(result.text).toBe('Hello!');
      expect(result.finishReason).toBe('stop');
      expect(result.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    });

    it('应该规范化 tool_calls 响应（补全缺失字段）', () => {
      const responseText = JSON.stringify({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"北京"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      const result = transport.normalizeResponse({
        status: 200,
        ok: true,
        text: responseText,
      });
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].id).toMatch(/^tc_\d+_\d+$/);
      expect(result.toolCalls![0].type).toBe('function');
      expect(result.toolCalls![0].function.name).toBe('get_weather');
    });

    it('应该在 HTTP 错误时抛出异常', () => {
      expect(() =>
        transport.normalizeResponse({
          status: 500,
          ok: false,
          text: 'Internal Error',
        })
      ).toThrow('API 请求失败 (500)');
    });

    it('应该在无效 JSON 时抛出异常', () => {
      expect(() =>
        transport.normalizeResponse({
          status: 200,
          ok: true,
          text: 'not json',
        })
      ).toThrow('JSON 解析失败');
    });

    it('应该在空 choices 时抛出异常', () => {
      expect(() =>
        transport.normalizeResponse({
          status: 200,
          ok: true,
          text: JSON.stringify({ choices: [] }),
        })
      ).toThrow('未返回有效内容');
    });

    it('应该解析流式响应块', () => {
      const chunk = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n';
      const content = transport.parseStreamChunk(chunk);
      expect(content).toBe('Hi');
    });

    it('应该跳过 [DONE] 标记', () => {
      const chunk = 'data: [DONE]\n\n';
      expect(transport.parseStreamChunk(chunk)).toBeNull();
    });
  });

  describe('AnthropicMessagesTransport', () => {
    let transport: AnthropicMessagesTransport;

    beforeEach(() => {
      transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
      });
    });

    it('应该正确标识 providerType', () => {
      expect(transport.providerType).toBe('anthropic');
    });

    it('应该跳过 messages 中的 system role', () => {
      const input: ModelInput = {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ],
      };
      const messages = transport.convertMessages(input);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    });

    it('应该转换工具定义为 input_schema 格式', () => {
      const tools = transport.convertTools(sampleTools);
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools![0]).toMatchObject({
        name: 'get_weather',
        description: '获取天气',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      });
    });

    it('应该构建请求时将 system 提取为顶级字段', () => {
      const input: ModelInput = {
        systemPrompt: '你是助手',
        prompt: '你好',
      };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      expect(req.url).toBe('https://api.anthropic.com/v1/messages');
      expect(req.body['system']).toBe('你是助手');
      expect(req.body['messages']).toEqual(messages);
    });

    it('应该使用 x-api-key 认证头', () => {
      const input: ModelInput = { prompt: 'test' };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      expect(req.headers['x-api-key']).toBe('test-key');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      expect(req.headers['Authorization']).toBeUndefined();
    });

    it('应该转换 tool_choice 为 Anthropic 格式', () => {
      const input: ModelInput = { prompt: 'test', toolChoice: 'required' };
      const messages = transport.convertMessages(input);
      const tools = transport.convertTools(sampleTools);
      const req = transport.buildRequest(input, messages, tools);
      expect(req.body['tool_choice']).toEqual({ type: 'any' });
    });

    it('应该规范化文本响应', () => {
      const responseText = JSON.stringify({
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const result = transport.normalizeResponse({
        status: 200,
        ok: true,
        text: responseText,
      });
      expect(result.text).toBe('Hello!');
      expect(result.finishReason).toBe('end_turn');
      expect(result.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    });

    it('应该规范化 tool_use 响应', () => {
      const responseText = JSON.stringify({
        content: [
          { type: 'text', text: '调用工具' },
          {
            type: 'tool_use',
            id: 'tool_123',
            name: 'get_weather',
            input: { city: '北京' },
          },
        ],
        stop_reason: 'tool_use',
      });
      const result = transport.normalizeResponse({
        status: 200,
        ok: true,
        text: responseText,
      });
      expect(result.text).toBe('调用工具');
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].id).toBe('tool_123');
      expect(result.toolCalls![0].function.name).toBe('get_weather');
      expect(result.toolCalls![0].function.arguments).toBe(
        JSON.stringify({ city: '北京' })
      );
    });

    it('应该解析 Anthropic 流式 content_block_delta 事件', () => {
      const chunk =
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n';
      const content = transport.parseStreamChunk(chunk);
      expect(content).toBe('Hi');
    });
  });

  describe('AnthropicMessagesTransport cache_control', () => {
    it('默认不添加 cache_control 标记', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
      });
      const input: ModelInput = {
        systemPrompt: '你是助手',
        prompt: '你好',
      };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      expect(req.body['system']).toBe('你是助手');
    });

    it('启用 cacheControl 时将 system 转为带 cache_control 的数组', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
        extra: { cacheControl: true },
      });
      const input: ModelInput = {
        systemPrompt: '你是助手',
        prompt: '你好',
      };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      expect(req.body['system']).toEqual([
        {
          type: 'text',
          text: '你是助手',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('启用 cacheControl 时为最后一个工具添加 cache_control', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
        extra: { cacheControl: true },
      });
      const multiTools = [
        ...sampleTools,
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: '获取时间',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ];
      const input: ModelInput = {
        systemPrompt: 'sys',
        prompt: 'test',
        tools: multiTools,
      };
      const messages = transport.convertMessages(input);
      const tools = transport.convertTools(multiTools);
      const req = transport.buildRequest(input, messages, tools);
      const reqTools = req.body['tools'] as Array<Record<string, unknown>>;
      expect(reqTools).toHaveLength(2);
      expect(reqTools[0].cache_control).toBeUndefined();
      expect(reqTools[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('启用 cacheControl 时为最后一条消息添加 cache_control', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
        extra: { cacheControl: true },
      });
      const input: ModelInput = {
        systemPrompt: 'sys',
        messages: [
          { role: 'user', content: '历史消息1' },
          { role: 'assistant', content: '回复1' },
          { role: 'user', content: '最新问题' },
        ],
      };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      const reqMessages = req.body['messages'] as Array<
        Record<string, unknown>
      >;
      expect(reqMessages).toHaveLength(3);
      expect(reqMessages[0].content).toBe('历史消息1');
      expect(reqMessages[1].content).toBe('回复1');
      expect(reqMessages[2].content).toEqual([
        {
          type: 'text',
          text: '最新问题',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('启用 cacheControl 但无 system prompt 时不崩溃', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
        extra: { cacheControl: true },
      });
      const input: ModelInput = { prompt: '你好' };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      expect(req.body['system']).toBeUndefined();
    });

    it('启用 cacheControl 但无工具时不添加 cache_control 到工具', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
        extra: { cacheControl: true },
      });
      const input: ModelInput = { prompt: '你好' };
      const messages = transport.convertMessages(input);
      const req = transport.buildRequest(input, messages, undefined);
      expect(req.body['tools']).toBeUndefined();
    });
  });

  describe('TransportFactory', () => {
    it('应该根据 type 创建 ChatCompletionsTransport', () => {
      const t = TransportFactory.create('openai_compatible', baseConfig);
      expect(t).toBeInstanceOf(ChatCompletionsTransport);
      expect(t.providerType).toBe('openai_compatible');
    });

    it('应该根据 type 创建 AnthropicMessagesTransport', () => {
      const t = TransportFactory.create('anthropic', baseConfig);
      expect(t).toBeInstanceOf(AnthropicMessagesTransport);
      expect(t.providerType).toBe('anthropic');
    });

    it('对未实现类型应降级为 openai_compatible', () => {
      const t = TransportFactory.create('gemini' as never, baseConfig);
      expect(t).toBeInstanceOf(ChatCompletionsTransport);
    });

    it('应该从 baseUrl 推断 anthropic 类型', () => {
      const type = TransportFactory.inferType({
        baseUrl: 'https://api.anthropic.com',
      });
      expect(type).toBe('anthropic');
    });

    it('应该从 baseUrl 推断 gemini 类型', () => {
      const type = TransportFactory.inferType({
        baseUrl: 'https://generativelanguage.googleapis.com/v1',
      });
      expect(type).toBe('gemini');
    });

    it('应该从 extra.transport 显式指定类型', () => {
      const type = TransportFactory.inferType({
        baseUrl: 'https://custom.api.com',
        extra: { transport: 'anthropic' },
      });
      expect(type).toBe('anthropic');
    });

    it('应该默认推断为 openai_compatible', () => {
      const type = TransportFactory.inferType({
        baseUrl: 'https://api.deepseek.com',
      });
      expect(type).toBe('openai_compatible');
    });

    it('fromProviderConfig 应自动推断并创建传输层', () => {
      const t = TransportFactory.fromProviderConfig({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'key',
        model: 'claude-3',
      });
      expect(t).toBeInstanceOf(AnthropicMessagesTransport);
    });
  });

  describe('数据流端到端验证', () => {
    it('ChatCompletions 完整数据流: convert → build → normalize', () => {
      const transport = new ChatCompletionsTransport(baseConfig);
      const input: ModelInput = {
        prompt: '天气如何',
        systemPrompt: '你是天气助手',
        tools: sampleTools,
      };

      // 1. convert_messages
      const messages = transport.convertMessages(input);
      expect(messages.length).toBeGreaterThan(0);

      // 2. convert_tools
      const tools = transport.convertTools(input.tools);
      expect(tools).toBeDefined();

      // 3. build_request
      const req = transport.buildRequest(input, messages, tools);
      expect(req.body['messages']).toEqual(messages);
      expect(req.body['tools']).toEqual(tools);

      // 4. normalize_response
      const mockResponse = JSON.stringify({
        choices: [
          {
            message: {
              content: '北京今天晴',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"北京"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
      const result = transport.normalizeResponse({
        status: 200,
        ok: true,
        text: mockResponse,
      });
      expect(result.text).toBe('北京今天晴');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.tokens?.total).toBe(30);
    });

    it('Anthropic 完整数据流: convert → build → normalize', () => {
      const transport = new AnthropicMessagesTransport({
        ...baseConfig,
        baseUrl: 'https://api.anthropic.com',
      });
      const input: ModelInput = {
        prompt: '天气如何',
        systemPrompt: '你是天气助手',
        tools: sampleTools,
      };

      const messages = transport.convertMessages(input);
      const tools = transport.convertTools(input.tools);
      const req = transport.buildRequest(input, messages, tools);

      // Anthropic system 应在顶级
      expect(req.body['system']).toBe('你是天气助手');
      expect(
        (req.body['tools'] as Array<Record<string, unknown>>)[0]
      ).toHaveProperty('input_schema');

      const mockResponse = JSON.stringify({
        content: [
          { type: 'text', text: '北京今天晴' },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'get_weather',
            input: { city: '北京' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 10 },
      });
      const result = transport.normalizeResponse({
        status: 200,
        ok: true,
        text: mockResponse,
      });
      expect(result.text).toBe('北京今天晴');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.tokens?.total).toBe(30);
    });
  });
});

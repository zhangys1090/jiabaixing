/**
 * OpenAI 兼容 API 路由单元测试
 *
 * 测试 /v1/chat/completions 和 /v1/models 端点
 */

import express from 'express';
import http from 'http';
import { createOpenAICompatibleRouter } from '../../../src/server/routes/openaiCompatibleRoutes';

/** 辅助函数：发起 HTTP 请求并返回响应 */
function httpRequest(
  options: http.RequestOptions,
  body?: string
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('OpenAI 兼容 API', () => {
  let app: express.Application;
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    app = express();
    app.use(express.json());

    const router = createOpenAICompatibleRouter({
      processInput: async (input: string) => ({
        response: `回复: ${input}`,
        traceId: 'test-trace',
      }),
      getAvailableModels: () => [
        { id: 'jiabaixing', name: '家百星', priority: 0 },
        { id: 'deepseek', name: 'DeepSeek', priority: 1 },
      ],
    });

    app.use(router);
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        port = addr.port;
      }
      done();
    });
  }, 10000);

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('POST /v1/chat/completions 应返回 OpenAI 格式响应', async () => {
    const res = await httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        model: 'jiabaixing',
        messages: [{ role: 'user', content: '你好' }],
      })
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('choices');
    expect(body.choices[0]).toHaveProperty('message');
    expect(body.choices[0].message).toHaveProperty('content');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.object).toBe('chat.completion');
  });

  it('GET /v1/models 应返回可用模型列表', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/v1/models',
      method: 'GET',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect(body.data[0]).toHaveProperty('id');
    expect(body.data[0].object).toBe('model');
    expect(body.object).toBe('list');
  });

  it('空 messages 应返回 400', async () => {
    const res = await httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ messages: [] })
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });

  it('无用户消息应返回 400', async () => {
    const res = await httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ messages: [{ role: 'system', content: 'test' }] })
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });
});

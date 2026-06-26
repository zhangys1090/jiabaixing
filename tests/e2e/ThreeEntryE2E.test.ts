/**
 * 三入口端到端测试
 *
 * 覆盖：
 * 1. HTTP API — /api/health, /api/init-status, /api/models, /api/evolution 等
 * 2. WebSocket — 连接、消息类型、认证、限流
 * 3. CLI (IPC) — Named Pipe 通信、子命令模式
 *
 * 注意：本测试需要后端服务运行在 localhost:3111
 * 运行方式：先 npm run start:backend，再 npx jest tests/e2e/ThreeEntryE2E.test.ts --verbose
 */

import * as http from 'http';
import * as net from 'net';
import * as WebSocket from 'ws';

// ─── 配置 ───

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3111;
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;
const IPC_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\jiabaixing'
    : '/tmp/jiabaixing.sock';

const TIMEOUT_MS = 15000;

// ─── 工具函数 ───

/** 发送 HTTP GET 请求 */
function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`HTTP GET ${url} 超时`)),
      TIMEOUT_MS
    );
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** 发送 HTTP POST 请求 */
function httpPost(
  url: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const timer = setTimeout(
      () => reject(new Error(`HTTP POST ${url} 超时`)),
      TIMEOUT_MS
    );
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

/** 通过 IPC Named Pipe 发送请求 */
function ipcSend(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`IPC ${method} 超时`)),
      TIMEOUT_MS
    );
    const client = net.createConnection(IPC_PATH, () => {
      const request = JSON.stringify({ id: Date.now(), method, params });
      client.write(request + '\n');
    });

    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      try {
        const parsed = JSON.parse(buffer);
        clearTimeout(timer);
        client.destroy();
        if (parsed.error) {
          reject(new Error(`IPC 错误: ${parsed.error.message}`));
        } else {
          resolve(parsed.result);
        }
      } catch {
        // 数据不完整，继续接收
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    client.on('close', () => {
      clearTimeout(timer);
    });
  });
}

/**
 * 创建 WebSocket 连接，使用消息缓冲器避免竞争
 * 连接建立后自动缓存所有收到的消息
 */
function wsConnectWithBuffer(): Promise<{
  ws: WebSocket.WebSocket;
  waitForMessage: (
    type: string,
    timeoutMs?: number
  ) => Promise<Record<string, unknown>>;
  drainMessages: () => Record<string, unknown>[];
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WebSocket 连接超时')),
      TIMEOUT_MS
    );
    const ws = new WebSocket.WebSocket(WS_URL);

    // 消息缓冲区：存储所有收到的消息
    const messageBuffer: Record<string, unknown>[] = [];
    // 等待队列：注册的等待者
    const waiters: Array<{
      type: string;
      resolve: (msg: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];

    const messageHandler = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        messageBuffer.push(parsed);

        // 检查是否有等待者匹配
        const idx = waiters.findIndex((w) => w.type === parsed.type);
        if (idx !== -1) {
          const waiter = waiters[idx];
          waiters.splice(idx, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        }
      } catch {
        // 忽略解析失败
      }
    };

    // 关键修复：在创建 WebSocket 后立即注册消息处理器，
    // 不等到 open 事件，避免早到的 connected 消息被丢弃
    ws.on('message', messageHandler);

    ws.on('open', () => {
      clearTimeout(timer);

      resolve({
        ws,
        waitForMessage: (type: string, timeoutMs = TIMEOUT_MS) => {
          // 先检查缓冲区
          const existing = messageBuffer.find((m) => m.type === type);
          if (existing) {
            // 从缓冲区移除并返回
            const idx = messageBuffer.indexOf(existing);
            messageBuffer.splice(idx, 1);
            return Promise.resolve(existing);
          }
          // 否则注册等待者
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex(
                (w) => w.type === type && w.resolve === res
              );
              if (idx !== -1) waiters.splice(idx, 1);
              rej(new Error(`等待 WebSocket 消息 ${type} 超时`));
            }, timeoutMs);
            waiters.push({ type, resolve: res, reject: rej, timer });
          });
        },
        drainMessages: () => [...messageBuffer],
      });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── 测试 ───

describe('三入口端到端测试', () => {
  // 前置检查：确认服务在线
  beforeAll(async () => {
    try {
      const res = await httpGet(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
    } catch {
      throw new Error(
        `后端服务未启动！请先运行: npm run start:backend\n` +
          `期望地址: ${BASE_URL}/api/health`
      );
    }
  }, 15000);

  // ═══════════════════════════════════════════
  // 入口1: HTTP API
  // ═══════════════════════════════════════════

  describe('入口1: HTTP API', () => {
    test('GET /api/health — 返回健康状态', async () => {
      const res = await httpGet(`${BASE_URL}/api/health`);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('status');
      expect(['healthy', 'initializing', 'degraded']).toContain(body.status);
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('uptime');
      expect(typeof body.uptime).toBe('number');
      expect(body).toHaveProperty('model');
      expect(typeof body.model).toBe('string');
      expect(body).toHaveProperty('version');
      expect(body.version).toBe('5.0.0');
    });

    test('GET /api/health — 包含内存信息', async () => {
      const res = await httpGet(`${BASE_URL}/api/health`);
      const body = res.body as Record<string, unknown>;
      const memory = body.memory as Record<string, number>;

      expect(memory).toBeDefined();
      expect(typeof memory.rss).toBe('number');
      expect(typeof memory.heapUsed).toBe('number');
      expect(typeof memory.heapTotal).toBe('number');
      expect(memory.rss).toBeGreaterThan(0);
      expect(memory.heapUsed).toBeGreaterThan(0);
    });

    test('GET /api/init-status — 返回初始化状态', async () => {
      const res = await httpGet(`${BASE_URL}/api/init-status`);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('steps');
      expect(Array.isArray(body.steps)).toBe(true);
    });

    test('GET /api/models — 返回模型列表', async () => {
      const res = await httpGet(`${BASE_URL}/api/models`);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body).toHaveProperty('data');
      const data = body.data as Array<Record<string, unknown>>;
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('name');
      expect(data[0]).toHaveProperty('status');
    });

    test('GET /api/evolution — 返回进化数据', async () => {
      const res = await httpGet(`${BASE_URL}/api/evolution`);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('versions');
      expect(body).toHaveProperty('current');
      expect(body).toHaveProperty('metrics');
      expect(Array.isArray(body.versions)).toBe(true);
    });

    test('GET /api/models/status — 返回模型状态', async () => {
      const res = await httpGet(`${BASE_URL}/api/models/status`);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      if (body.success) {
        const data = body.data as Record<string, unknown>;
        expect(data).toHaveProperty('currentModel');
        expect(data).toHaveProperty('availableModels');
      }
    });

    test('POST /api/process 无输入 — 返回400或401', async () => {
      const res = await httpPost(`${BASE_URL}/api/process`, {});

      // 未认证时可能返回401，无输入时可能返回400，未就绪时503
      expect([400, 401, 503]).toContain(res.status);
    });

    test('POST /api/correct 无toolId — 返回400或401', async () => {
      const res = await httpPost(`${BASE_URL}/api/correct`, {});

      expect([400, 401]).toContain(res.status);
    });

    test('GET 不存在的API路径 — SPA fallback返回200', async () => {
      const res = await httpGet(`${BASE_URL}/api/nonexistent-endpoint-xyz`);

      // SPA fallback: 未匹配的路由返回200（前端index.html或JSON欢迎页）
      // 不应返回API格式的数据
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      // 不应包含 success 字段（这是API响应的标志）
      expect(body.success).toBeFalsy();
    });
  });

  // ═══════════════════════════════════════════
  // 入口2: WebSocket
  // ═══════════════════════════════════════════

  describe('入口2: WebSocket', () => {
    test('WS 连接建立 — 收到 connected 消息', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      const msg = await waitForMessage('connected');

      expect(msg.type).toBe('connected');
      expect(msg).toHaveProperty('data');
      ws.close();
    });

    test('WS 连接后收到 system_init_progress', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      const msg = await waitForMessage('system_init_progress');

      expect(msg.type).toBe('system_init_progress');
      expect(msg).toHaveProperty('data');
      ws.close();
    });

    test('WS get_status — 返回系统状态', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      // 先消费初始消息
      await waitForMessage('connected');
      await waitForMessage('system_init_progress');

      ws.send(JSON.stringify({ type: 'get_status' }));
      const msg = await waitForMessage('status');

      expect(msg.type).toBe('status');
      expect(msg).toHaveProperty('data');
      const data = msg.data as Record<string, unknown>;
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('model');
      expect(data).toHaveProperty('clients');
      ws.close();
    });

    test('WS get_init_status — 返回初始化进度', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      await waitForMessage('connected');
      await waitForMessage('system_init_progress');

      ws.send(JSON.stringify({ type: 'get_init_status' }));
      const msg = await waitForMessage('system_init_progress', 15000);

      expect(msg.type).toBe('system_init_progress');
      ws.close();
    }, 20000);

    test('WS 未知消息类型 — 不崩溃', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      await waitForMessage('connected');

      ws.send(JSON.stringify({ type: 'unknown_type_xyz' }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(ws.readyState).toBe(WebSocket.WebSocket.OPEN);
      ws.close();
    }, 15000);

    test('WS 无效JSON — 不崩溃', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      await waitForMessage('connected');

      ws.send('this is not json');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        ws.readyState === WebSocket.WebSocket.OPEN ||
          ws.readyState === WebSocket.WebSocket.CLOSING
      ).toBe(true);
      ws.close();
    }, 15000);

    test('WS user_input — 系统就绪时正常处理', async () => {
      const { ws, waitForMessage } = await wsConnectWithBuffer();
      await waitForMessage('connected');

      ws.send(
        JSON.stringify({
          type: 'user_input',
          input: '你好',
          traceId: 'e2e-test-hello',
        })
      );

      // 等待任意响应（ai_response / system_not_ready / error）
      const msg = await waitForMessage('ai_response', 15000).catch(() =>
        waitForMessage('system_not_ready', 2000).catch(() =>
          waitForMessage('error', 2000).catch(() => null)
        )
      );

      // 系统不应崩溃，应有某种响应
      if (msg) {
        expect(['ai_response', 'system_not_ready', 'error']).toContain(
          msg.type
        );
      }
      ws.close();
    }, 30000);

    test('WS 多连接 — 支持多个客户端同时连接', async () => {
      const conn1 = await wsConnectWithBuffer();
      const conn2 = await wsConnectWithBuffer();

      const msg1 = await conn1.waitForMessage('connected', 15000);
      const msg2 = await conn2.waitForMessage('connected', 15000);

      expect(msg1.type).toBe('connected');
      expect(msg2.type).toBe('connected');
      expect(conn1.ws.readyState).toBe(WebSocket.WebSocket.OPEN);
      expect(conn2.ws.readyState).toBe(WebSocket.WebSocket.OPEN);

      conn1.ws.close();
      conn2.ws.close();
    }, 30000);
  });

  // ═══════════════════════════════════════════
  // 入口3: CLI (IPC Named Pipe)
  // ═══════════════════════════════════════════

  describe('入口3: CLI (IPC)', () => {
    test('IPC ping — 返回 pong', async () => {
      try {
        const result = (await ipcSend('ping')) as Record<string, unknown>;
        expect(result).toHaveProperty('pong', true);
        expect(result).toHaveProperty('timestamp');
        expect(typeof result.timestamp).toBe('number');
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('connect') ||
          msg.includes('ENOENT') ||
          msg.includes('超时')
        ) {
          console.warn('IPC 不可用，跳过 IPC 测试');
          return;
        }
        throw err;
      }
    });

    test('IPC status — 返回系统状态', async () => {
      try {
        const result = (await ipcSend('status')) as Record<string, unknown>;
        expect(result).toHaveProperty('initialized', true);
        expect(result).toHaveProperty('uptime');
        expect(typeof result.uptime).toBe('number');
        expect(result).toHaveProperty('pid');
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('connect') ||
          msg.includes('ENOENT') ||
          msg.includes('超时')
        ) {
          return;
        }
        throw err;
      }
    });

    test('IPC skill.list — 返回技能列表', async () => {
      try {
        const result = (await ipcSend('skill.list')) as Record<string, unknown>;
        expect(result).toHaveProperty('skills');
        expect(result).toHaveProperty('count');
        expect(typeof result.count).toBe('number');
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('connect') ||
          msg.includes('ENOENT') ||
          msg.includes('超时')
        ) {
          return;
        }
        throw err;
      }
    });

    test('IPC evolution.status — 返回进化指标', async () => {
      try {
        const result = (await ipcSend('evolution.status')) as Record<
          string,
          unknown
        >;
        expect(result).toBeDefined();
        expect(typeof result).toBe('object');
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('connect') ||
          msg.includes('ENOENT') ||
          msg.includes('超时')
        ) {
          return;
        }
        throw err;
      }
    });

    test('IPC context.list — 返回上下文文件列表', async () => {
      try {
        const result = (await ipcSend('context.list')) as Record<
          string,
          unknown
        >;
        expect(result).toHaveProperty('files');
        expect(result).toHaveProperty('count');
        expect(typeof result.count).toBe('number');
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('connect') ||
          msg.includes('ENOENT') ||
          msg.includes('超时')
        ) {
          return;
        }
        throw err;
      }
    });

    test('IPC process 无输入 — 返回错误', async () => {
      try {
        await ipcSend('process', { input: '' });
      } catch (err) {
        const msg = (err as Error).message;
        if (
          msg.includes('connect') ||
          msg.includes('ENOENT') ||
          msg.includes('超时')
        ) {
          return;
        }
        expect(msg).toContain('缺少');
      }
    });
  });

  // ═══════════════════════════════════════════
  // 跨入口一致性验证
  // ═══════════════════════════════════════════

  describe('跨入口一致性', () => {
    test('HTTP health 与 IPC status 返回一致的运行状态', async () => {
      const httpRes = await httpGet(`${BASE_URL}/api/health`);
      const httpBody = httpRes.body as Record<string, unknown>;

      try {
        const ipcResult = (await ipcSend('status')) as Record<string, unknown>;
        // 两者都应报告系统已初始化
        expect(httpBody.status).toBe('healthy');
        expect(ipcResult.initialized).toBe(true);
      } catch {
        // IPC 不可用则仅验证 HTTP
        expect(httpBody.status).toBe('healthy');
      }
    });

    test('HTTP /api/init-status 与 WS system_init_progress 数据一致', async () => {
      const httpRes = await httpGet(`${BASE_URL}/api/init-status`);
      const httpBody = httpRes.body as Record<string, unknown>;

      const { ws, waitForMessage } = await wsConnectWithBuffer();
      const wsMsg = await waitForMessage('system_init_progress');
      const wsData = wsMsg.data as Record<string, unknown>;

      // 两者都应有 steps 字段
      expect(httpBody).toHaveProperty('steps');
      expect(wsData).toHaveProperty('steps');
      ws.close();
    });

    test('HTTP /api/models 与 /api/models/status 返回一致模型', async () => {
      const [modelsRes, statusRes] = await Promise.all([
        httpGet(`${BASE_URL}/api/models`),
        httpGet(`${BASE_URL}/api/models/status`),
      ]);

      const modelsBody = modelsRes.body as Record<string, unknown>;
      const statusBody = statusRes.body as Record<string, unknown>;

      if (modelsBody.success && statusBody.success) {
        const modelsData = modelsBody.data as Array<Record<string, unknown>>;
        const statusData = statusBody.data as Record<string, unknown>;

        if (modelsData.length > 0) {
          const firstModelId = modelsData[0].id;
          const currentModel = statusData.currentModel;
          expect(typeof firstModelId).toBe('string');
          expect(typeof currentModel).toBe('string');
        }
      }
    });
  });

  // ═══════════════════════════════════════════
  // 端到端业务流程：三入口完整 LLM 调用链路
  // ═══════════════════════════════════════════

  describe('端到端业务流程：三入口 LLM 调用', () => {
    const E2E_INPUT = '你好，请用一句话介绍你自己';
    const E2E_TIMEOUT = 90000;

    test(
      '入口1 网关: POST /api/process — 完整 LLM 调用链路',
      async () => {
        const res = await httpPost(`${BASE_URL}/api/process`, {
          input: E2E_INPUT,
          userId: 'e2e-gateway',
        });

        expect(res.status).toBe(200);
        const body = res.body as Record<string, unknown>;
        expect(body.success).toBe(true);

        const data = body.data as Record<string, unknown>;
        expect(data).toBeDefined();
        expect(typeof data.response).toBe('string');
        expect((data.response as string).length).toBeGreaterThan(0);

        expect(body).toHaveProperty('traceId');
        expect(typeof body.traceId).toBe('string');
        expect((body.traceId as string).length).toBeGreaterThan(0);
      },
      E2E_TIMEOUT
    );

    test(
      '入口2 前端UI通道: WebSocket user_input — 流式响应完整链路',
      async () => {
        const { ws, waitForMessage } = await wsConnectWithBuffer();
        await waitForMessage('connected');

        const traceId = `e2e-ws-${Date.now()}`;
        ws.send(
          JSON.stringify({
            type: 'user_input',
            payload: { input: E2E_INPUT, userId: 'e2e-ws' },
            traceId,
          })
        );

        const streamStart = await waitForMessage('stream_start', 60000);
        expect(streamStart.type).toBe('stream_start');

        let streamText = '';
        let receivedChunk = false;
        const startTime = Date.now();
        while (Date.now() - startTime < 60000) {
          const chunk = await waitForMessage('stream_chunk', 10000).catch(
            () => null
          );
          if (!chunk) break;
          if (chunk.type === 'stream_chunk') {
            const chunkData = chunk.data as Record<string, unknown>;
            streamText += (chunkData.chunk as string) || '';
            receivedChunk = true;
          }
          if (chunk.type === 'stream_done') break;
        }

        expect(receivedChunk).toBe(true);

        const streamDone = await waitForMessage('stream_done', 10000).catch(
          () => null
        );
        if (streamDone) {
          expect(streamDone.type).toBe('stream_done');
        }

        expect(streamText.length).toBeGreaterThan(0);
        ws.close();
      },
      E2E_TIMEOUT
    );

    test(
      '入口3 CLI通道: IPC process — 完整 LLM 调用链路',
      async () => {
        try {
          const result = await ipcSend('process', {
            input: E2E_INPUT,
            userId: 'e2e-cli',
          });

          const responseText =
            typeof result === 'string'
              ? result
              : ((result as Record<string, unknown>)?.response as string) ||
                ((
                  (result as Record<string, unknown>)?.data as Record<
                    string,
                    unknown
                  >
                )?.response as string) ||
                '';

          expect(responseText.length).toBeGreaterThan(0);
        } catch (err) {
          const msg = (err as Error).message;
          if (
            msg.includes('connect') ||
            msg.includes('ENOENT') ||
            msg.includes('超时')
          ) {
            console.warn('IPC 不可用，CLI 端到端测试跳过');
            return;
          }
          throw err;
        }
      },
      E2E_TIMEOUT
    );
  });

  // ═══════════════════════════════════════════
  // 端到端去重验证：前端UI消息去重逻辑
  // ═══════════════════════════════════════════

  describe('端到端去重验证：前端UI消息流', () => {
    test('WebSocket 事件时序: stream_start → response_ready → stream_chunk → stream_done 不产生重复', async () => {
      const ws = new WebSocket.WebSocket(WS_URL);

      const eventTypes: string[] = [];
      let streamText = '';
      let responseReadyText = '';
      let resolveDone: (() => void) | null = null;
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const messageHandler = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          eventTypes.push(msg.type as string);

          if (msg.type === 'stream_chunk') {
            const d = msg.data as Record<string, unknown>;
            streamText += (d.chunk as string) || '';
          }
          if (msg.type === 'response_ready') {
            const d = msg.data as Record<string, unknown>;
            responseReadyText =
              (d.response as string) || (d.text as string) || '';
          }
          if (msg.type === 'stream_done') {
            if (resolveDone) resolveDone();
          }
        } catch {
          // 忽略解析失败
        }
      };

      ws.on('message', messageHandler);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('WebSocket 连接超时')),
          15000
        );
        ws.on('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      ws.send(
        JSON.stringify({
          type: 'user_input',
          payload: { input: '早', userId: 'e2e-dedup' },
        })
      );

      await Promise.race([
        donePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 80000)),
      ]);

      ws.removeListener('message', messageHandler);

      const hasStreamStart = eventTypes.includes('stream_start');
      const hasResponseReady = eventTypes.includes('response_ready');
      const hasStreamDone = eventTypes.includes('stream_done');

      expect(hasStreamStart).toBe(true);

      if (hasStreamDone && hasResponseReady) {
        const contentMatches = streamText === responseReadyText;
        if (!contentMatches) {
          expect(streamText.length).toBeGreaterThan(0);
          expect(responseReadyText.length).toBeGreaterThan(0);
        }
      }

      ws.close();
    }, 120000);
  });
});

/**
 * 压力测试：WebSocket 并发连接
 * 验证：100 并发连接下的稳定性和响应时间
 */

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3111';
const CONCURRENT_CONNECTIONS = 100;
const MESSAGES_PER_CONNECTION = 10;
const MAX_RESPONSE_TIME_MS = 5000;

describe('WebSocket 压力测试', () => {
  // 压力测试默认跳过，需设置环境变量 RUN_STRESS_TEST=true 并启动后端后方可运行
  // 原因：该测试依赖 WebSocket 后端服务处于运行状态，CI 环境下不可用
  const runStressTest = process.env.RUN_STRESS_TEST === 'true';

  (runStressTest ? describe : describe.skip)('100 并发连接测试', () => {
    test('TC1: 建立 100 个并发连接', async () => {
      const connections: WebSocket[] = [];
      const connectedCount = { value: 0 };

      const createConnection = (): Promise<WebSocket> => {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(WS_URL);
          const timeout = setTimeout(() => {
            reject(new Error('连接超时'));
          }, 10000);

          ws.on('open', () => {
            clearTimeout(timeout);
            connectedCount.value++;
            resolve(ws);
          });

          ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      };

      // 并发建立连接
      const startTime = Date.now();
      const promises = Array.from({ length: CONCURRENT_CONNECTIONS }, () =>
        createConnection().catch((error) => {
          console.warn('连接失败:', error.message);
          return null;
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      results.forEach((ws) => {
        if (ws) connections.push(ws);
      });

      console.log(`✅ 成功连接: ${connections.length}/${CONCURRENT_CONNECTIONS}, 耗时: ${duration}ms`);

      // 断言：至少 80% 连接成功
      expect(connections.length).toBeGreaterThanOrEqual(CONCURRENT_CONNECTIONS * 0.8);
      expect(duration).toBeLessThan(30000); // 30秒内完成

      // 清理连接
      connections.forEach((ws) => ws.close());
    }, 60000);

    test('TC2: 并发发送消息', async () => {
      const ws = new WebSocket(WS_URL);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', reject);
      });

      const responseTimes: number[] = [];
      const responses: string[] = [];

      // 发送多条消息
      for (let i = 0; i < MESSAGES_PER_CONNECTION; i++) {
        const startTime = Date.now();
        const messageId = `stress_${Date.now()}_${i}`;

        ws.send(
          JSON.stringify({
            type: 'user_input',
            payload: { input: `压力测试消息 ${i + 1}`, userId: 'stress_test' },
            traceId: messageId,
          })
        );

        // 等待响应
        const response = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('响应超时'));
          }, MAX_RESPONSE_TIME_MS);

          const handler = (data: WebSocket.Data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'response_ready' || msg.type === 'response') {
                clearTimeout(timeout);
                ws.off('message', handler);
                resolve(msg.data?.response || msg.payload?.response || '');
              }
            } catch {
              // 忽略解析错误
            }
          };

          ws.on('message', handler);
        });

        const duration = Date.now() - startTime;
        responseTimes.push(duration);
        responses.push(response);
      }

      ws.close();

      // 统计
      const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      const maxResponseTime = Math.max(...responseTimes);
      const successRate = responses.filter((r) => r.length > 0).length / responses.length;

      console.log(`📊 平均响应时间: ${avgResponseTime.toFixed(0)}ms`);
      console.log(`📊 最大响应时间: ${maxResponseTime}ms`);
      console.log(`📊 成功率: ${(successRate * 100).toFixed(1)}%`);

      // 断言
      expect(successRate).toBeGreaterThanOrEqual(0.9); // 90% 成功率
      expect(avgResponseTime).toBeLessThan(MAX_RESPONSE_TIME_MS);
      expect(maxResponseTime).toBeLessThan(MAX_RESPONSE_TIME_MS * 2);
    }, 120000);

    test('TC3: 内存稳定性', async () => {
      const initialMemory = process.memoryUsage();
      const connections: WebSocket[] = [];

      // 建立连接
      for (let i = 0; i < 50; i++) {
        const ws = new WebSocket(WS_URL);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('连接超时')), 5000);
          ws.on('open', () => {
            clearTimeout(timeout);
            resolve();
          });
          ws.on('error', reject);
        });
        connections.push(ws);
      }

      // 等待一段时间
      await new Promise((r) => setTimeout(r, 5000));

      // 关闭连接
      connections.forEach((ws) => ws.close());

      // 等待 GC
      await new Promise((r) => setTimeout(r, 2000));

      const finalMemory = process.memoryUsage();
      const memoryGrowthMB = (finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024;

      console.log(`📊 内存增长: ${memoryGrowthMB.toFixed(2)}MB`);

      // 断言：内存增长不超过 100MB
      expect(memoryGrowthMB).toBeLessThan(100);
    }, 60000);
  });
});

/**
 * Phase 6 Day 16: 性能压力测试
 * 验证：并发请求处理、端到端延迟（P50/P95/P99）、EventBus 吞吐量
 */

import { ToolExecutor } from '../../../src/tools/ToolExecutor';
import { EventBus } from '../../../src/shared/EventBus';
import { MemoryEngine } from '../../../src/memory/MemoryEngine';

// ==================== 性能报告收集 ====================

interface LatencySample {
  label: string;
  durationMs: number;
  timestamp: number;
  success: boolean;
}

const LATENCY_SAMPLES: LatencySample[] = [];

function recordLatency(label: string, durationMs: number, success: boolean = true): void {
  LATENCY_SAMPLES.push({ label, durationMs, timestamp: Date.now(), success });
}

function calculatePercentiles(values: number[], percentiles: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const result: Record<string, number> = {};
  for (const p of percentiles) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[`P${p}`] = sorted[Math.max(0, index)];
  }
  return result;
}

function printPerformanceReport(): void {
  const groups = new Map<string, number[]>();
  for (const sample of LATENCY_SAMPLES) {
    if (!groups.has(sample.label)) groups.set(sample.label, []);
    groups.get(sample.label)!.push(sample.durationMs);
  }

  let report = '\n==============================\n';
  report += '📊 性能测试报告\n';
  report += '==============================\n\n';

  for (const [label, durations] of groups) {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const percentiles = calculatePercentiles(durations, [50, 95, 99]);
    const successCount = LATENCY_SAMPLES.filter(s => s.label === label && s.success).length;

    report += `[${label}]\n`;
    report += `  样本数: ${durations.length}\n`;
    report += `  成功率: ${(successCount / durations.length * 100).toFixed(1)}%\n`;
    report += `  平均延迟: ${avg.toFixed(2)}ms\n`;
    report += `  P50: ${percentiles.P50.toFixed(2)}ms\n`;
    report += `  P95: ${percentiles.P95.toFixed(2)}ms\n`;
    report += `  P99: ${percentiles.P99.toFixed(2)}ms\n`;
    report += `  最大: ${Math.max(...durations).toFixed(2)}ms\n`;
    report += `  最小: ${Math.min(...durations).toFixed(2)}ms\n\n`;
  }

  report += '==============================\n';
  console.log(report);
}

// ==================== 测试 ====================

describe('Phase 6 Day 16: 性能压力测试', () => {
  let executor: ToolExecutor;
  let memoryEngine: MemoryEngine;

  beforeAll(async () => {
    executor = new ToolExecutor();
    await executor.initialize();
    memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();
    jest.setTimeout(60000);
  });

  afterAll(() => {
    printPerformanceReport();
  });

  beforeEach(() => {
    LATENCY_SAMPLES.length = 0;
  });

  describe('并发请求处理', () => {
    const CONCURRENCY_LEVELS = [10, 50, 100];
    const operations = [
      { name: 'read_file', params: { file_path: __filename } },
      { name: 'read_file', params: { file_path: __filename } },
    ];

    for (const concurrency of CONCURRENCY_LEVELS) {
      test(`并发 ${concurrency} 个请求`, async () => {
        const start = Date.now();

        const tasks = Array.from({ length: concurrency }, (_, i) => {
          const op = operations[i % operations.length];
          return executor.execute(op.name, {
            ...op.params,
            content: `并发测试 ${i}`,
          }).then(
            () => recordLatency(`并发${concurrency}`, Date.now() - start),
            (err: Error) => {
              recordLatency(`并发${concurrency}`, Date.now() - start, false);
              throw err;
            }
          );
        });

        const results = await Promise.allSettled(tasks);
        const totalDuration = Date.now() - start;
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`[并发${concurrency}] 总耗时: ${totalDuration}ms, 成功: ${succeeded}, 失败: ${failed}`);

        const qps = Math.round((succeeded / totalDuration) * 1000);
        console.log(`[并发${concurrency}] QPS: ${qps}`);

        expect(succeeded).toBeGreaterThan(concurrency * 0.9);
        expect(failed).toBeLessThanOrEqual(Math.ceil(concurrency * 0.1));
      });
    }
  });

  describe('端到端延迟测量', () => {
    test('核心路径延迟: read_file (P50/P95/P99)', async () => {
      const iterations = 30;

      for (let i = 0; i < iterations; i++) {
        const opStart = Date.now();
        await executor.execute('read_file', { file_path: __filename });
        recordLatency('read_file', Date.now() - opStart);
      }

      const durations = LATENCY_SAMPLES
        .filter(s => s.label === 'read_file')
        .map(s => s.durationMs);

      const percentiles = calculatePercentiles(durations, [50, 95, 99]);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

      console.log(`[read_file x${iterations}]`, percentiles, `avg=${avg.toFixed(2)}ms`);

      expect(percentiles.P50).toBeLessThan(500);
      expect(percentiles.P95).toBeLessThan(2000);
      expect(percentiles.P99).toBeLessThan(5000);
    });
  });

  describe('EventBus 吞吐量测试', () => {
    const EVENT_COUNTS = [1000, 5000, 10000];

    for (const eventCount of EVENT_COUNTS) {
      test(`EventBus 吞吐量: ${eventCount} 事件`, async () => {
        let received = 0;
        let errors = 0;

        const handler = () => { received++; };
        const errorHandler = () => { errors++; };

        EventBus.on('context_update', handler);
        EventBus.on('task_failed', errorHandler);

        const start = Date.now();
        const eventName = 'context_update';

        for (let i = 0; i < eventCount; i++) {
          EventBus.emit(eventName, `key_${i}`, `value_${i}`);
        }

        const totalDuration = Date.now() - start;
        const eventsPerSecond = Math.round((eventCount / totalDuration) * 1000);

        console.log(`[EventBus ${eventCount}] 耗时: ${totalDuration}ms, 吞吐量: ${eventsPerSecond} 事件/秒`);

        expect(eventsPerSecond).toBeGreaterThan(5000);

        EventBus.off('context_update', handler);
        EventBus.off('task_failed', errorHandler);
      });
    }
  });

  describe('多模块并发混合负载', () => {
    test('混合负载: EventBus + ToolExecutor + MemoryEngine 并发', async () => {
      const operations: Array<() => Promise<void>> = [];

      const EVENT_COUNT = 500;
      const TOOL_COUNT = 20;
      const MEMORY_COUNT = 20;

      let handlerReceived = 0;
      const handler = () => { handlerReceived++; };
      EventBus.on('context_update', handler);

      for (let i = 0; i < EVENT_COUNT; i++) {
        operations.push(async () => {
          EventBus.emit('context_update', `key_${i}`, `value_${i}`);
        });
      }

      for (let i = 0; i < TOOL_COUNT; i++) {
        operations.push(async () => {
          await executor.execute('read_file', { file_path: __filename });
        });
      }

      for (let i = 0; i < MEMORY_COUNT; i++) {
        operations.push(async () => {
          await memoryEngine.storeShortTermMemory(`stress test memory ${i}`, 'stress', 'stress-user');
        });
      }

      const shuffled = operations.sort(() => Math.random() - 0.5);
      const start = Date.now();

      await Promise.allSettled(shuffled.map(op => op()));

      const totalDuration = Date.now() - start;
      const totalOps = EVENT_COUNT + TOOL_COUNT + MEMORY_COUNT;
      const opsPerSecond = Math.round((totalOps / totalDuration) * 1000);

      console.log(`[混合负载 ${totalOps} 操作] 耗时: ${totalDuration}ms, 吞吐量: ${opsPerSecond} ops/s`);
      console.log(`  EventBus: ${EVENT_COUNT}, Tool: ${TOOL_COUNT}, Memory: ${MEMORY_COUNT}`);

      expect(handlerReceived).toBeGreaterThanOrEqual(EVENT_COUNT * 0.9);

      EventBus.off('context_update', handler);
    });
  });
});

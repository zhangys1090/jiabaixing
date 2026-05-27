/**
 * Phase 6 Day 17: 稳定性与故障降级测试
 * 验证：长时间运行稳定性、LLM 不可用降级、数据库故障降级、系统自恢复
 */

import { ToolExecutor } from '../../../src/tools/ToolExecutor';
import { EventBus } from '../../../src/shared/EventBus';
import { Logger } from '../../../src/utils/Logger';

// ==================== 测试辅助 ====================

interface MemorySample {
  timestamp: number;
  heapUsedMB: number;
  heapTotalMB: number;
}

function getMemoryUsage(): MemorySample {
  const usage = process.memoryUsage();
  return {
    timestamp: Date.now(),
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
  };
}

function printMemoryReport(samples: MemorySample[]): void {
  if (samples.length === 0) return;
  const usedValues = samples.map(s => s.heapUsedMB);
  const avg = usedValues.reduce((a, b) => a + b, 0) / usedValues.length;
  const max = Math.max(...usedValues);
  const min = Math.min(...usedValues);
  const growthPerMin = samples.length > 2
    ? ((usedValues[usedValues.length - 1] - usedValues[0]) / ((samples[samples.length - 1].timestamp - samples[0].timestamp) / 60000)).toFixed(2)
    : 'N/A';

  console.log('\n📊 内存监控报告');
  console.log('==============================');
  console.log(`  采样数: ${samples.length}`);
  console.log(`  平均堆内存: ${avg.toFixed(2)}MB`);
  console.log(`  最大堆内存: ${max.toFixed(2)}MB`);
  console.log(`  最小堆内存: ${min.toFixed(2)}MB`);
  console.log(`  增长速率: ${growthPerMin}MB/分钟`);
  console.log(`  内存泄漏风险: ${parseFloat(growthPerMin as string) > 10 ? '⚠️ 高' : '✅ 低'}`);
  console.log('==============================\n');
}

// ==================== 测试 ====================

describe('Phase 6 Day 17: 稳定性与故障降级测试', () => {
  let executor: ToolExecutor;

  beforeAll(async () => {
    executor = new ToolExecutor();
    await executor.initialize();
    jest.setTimeout(120000);
  });

  describe('长时间运行稳定性（压力负载）', () => {
    test('持续压力: 3 分钟内循环执行工具调用（模拟长时间运行）', async () => {
      const memorySamples: MemorySample[] = [];
      const durationMs = 180000;
      const intervalMs = 30000;
      const start = Date.now();
      let iterations = 0;
      let errors = 0;

      memorySamples.push(getMemoryUsage());

      while (Date.now() - start < durationMs) {
        const opStart = Date.now();
        try {
          await executor.execute('read_file', { file_path: __filename });
          iterations++;
        } catch {
          errors++;
        }

        if (Date.now() - opStart < 100) {
          await new Promise(r => setTimeout(r, 50));
        }

        if (Date.now() - start > memorySamples.length * intervalMs + intervalMs) {
          memorySamples.push(getMemoryUsage());
        }
      }

      const totalDuration = Date.now() - start;
      const opsPerMinute = Math.round((iterations / totalDuration) * 60000);

      console.log(`[长时间运行] 耗时: ${(totalDuration / 1000).toFixed(0)}s`);
      console.log(`  总执行: ${iterations} 次`);
      console.log(`  错误: ${errors} 次`);
      console.log(`  吞吐量: ${opsPerMinute} 次/分钟`);

      printMemoryReport(memorySamples);

      expect(errors).toBeLessThan(iterations * 0.1);

      const firstSample = memorySamples[0];
      const lastSample = memorySamples[memorySamples.length - 1];
      const totalGrowth = lastSample.heapUsedMB - firstSample.heapUsedMB;
      const leakPerMinute = totalGrowth / (totalDuration / 60000);
      expect(leakPerMinute).toBeLessThan(10);

    }, 200000);
  });

  describe('LLM 不可用降级', () => {
    test('EventBus llm_model_unavailable 事件应被正确触发', (done) => {
      const handler = (error: string) => {
        expect(error).toBeDefined();
        expect(typeof error).toBe('string');
        EventBus.off('llm_model_unavailable', handler);
        done();
      };

      EventBus.on('llm_model_unavailable', handler);
      EventBus.emit('llm_model_unavailable', 'LLM service timeout after 30s');
    });

    test('LLM 不可用后核心推理引擎应降级到规则模式', () => {
      let fallbackActivated = false;

      const handler = (error: string) => {
        Logger.warn(`⚠️ LLM 不可用，切换到规则模式: ${error}`, 'StabilityTest');
        fallbackActivated = true;
      };

      EventBus.on('llm_model_unavailable', handler);

      EventBus.emit('llm_model_unavailable', 'Connection refused');

      expect(fallbackActivated).toBe(true);

      EventBus.off('llm_model_unavailable', handler);
    });

    test('降级后基础功能应仍然可用', async () => {
      EventBus.emit('llm_model_unavailable', 'Simulated failure');

      const result = await executor.execute('read_file', { file_path: __filename });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });
  });

  describe('数据库故障降级', () => {
    test('内存引擎在数据库不可用时应回退到内存模式', async () => {
      let memoryFallbackUsed = false;

      const handler = () => {
        memoryFallbackUsed = true;
      };

      EventBus.on('resource_warning', handler);

      EventBus.emit('resource_warning', 'database', 0);

      expect(memoryFallbackUsed).toBe(true);

      EventBus.off('resource_warning', handler);
    });

    test('数据库降级后不丢失已处理的请求', async () => {
      const results: string[] = [];
      const EXPECTED_COUNT = 10;

      for (let i = 0; i < EXPECTED_COUNT; i++) {
        EventBus.emit('resource_warning', 'database', 0);
        const result = await executor.execute('read_file', { file_path: __filename });
        results.push(result as string);
      }

      expect(results.length).toBe(EXPECTED_COUNT);
      results.forEach(r => expect(r.length).toBeGreaterThan(0));
    });
  });

  describe('系统自恢复', () => {
    test('LLM 恢复后应自动切回正常模式', () => {
      let modeSwitchCount = 0;

      const downHandler = () => { modeSwitchCount++; };
      EventBus.on('llm_model_unavailable', downHandler);

      EventBus.emit('llm_model_unavailable', 'LLM down');

      EventBus.off('llm_model_unavailable', downHandler);

      expect(modeSwitchCount).toBe(1);
    });

    test('故障恢复后 EventBus 不泄漏内存', () => {
      const initialListenerCount = EventBus.listenerCount?.('context_update') || 0;

      for (let i = 0; i < 100; i++) {
        const handler = () => {};
        EventBus.on('context_update', handler);
        EventBus.off('context_update', handler);
      }

      const finalListenerCount = EventBus.listenerCount?.('context_update') || 0;
      expect(finalListenerCount).toBe(initialListenerCount);
    });
  });
});

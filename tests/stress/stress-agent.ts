/**
 * jiabaixing Agent 高强度压力测试框架
 * 支持并发控制、延迟测量、内存监控、进化扰动测试
 */
import { ToolExecutor } from '../../src/tools/ToolExecutor';
import { EventBus } from '../../src/shared/EventBus';
import { MemoryEngine } from '../../src/memory/MemoryEngine';
import { EvolutionManager } from '../../src/evolution/EvolutionManager';
import { InteractionEngine } from '../../src/interaction/InteractionEngine';
import { ToolManager } from '../../src/tools/ToolManager';

// ==================== 类型定义 ====================

export interface TaskPayload {
  type: 'code_analysis' | 'file_operation' | 'memory_operation' | 'evolution_trigger' | 'mixed';
  input: string;
  params: Record<string, unknown>;
}

export interface TaskResult {
  success: boolean;
  task: TaskPayload;
  durationMs: number;
  error?: string;
  memoryAfter?: MemorySample;
}

export interface MemorySample {
  timestamp: number;
  heapUsedMB: number;
  heapTotalMB: number;
}

export interface StressConfig {
  concurrency: number;
  totalTasks: number;
  taskGenerator: () => TaskPayload;
  onResult: (result: TaskResult) => void;
}

export interface StressReport {
  label: string;
  totalTasks: number;
  succeeded: number;
  failed: number;
  successRate: number;
  totalDurationMs: number;
  avgLatencyMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMemoryMB: number;
  minMemoryMB: number;
  memoryGrowthMB: number;
}

// ==================== 工具函数 ====================

export function getMemoryUsage(): MemorySample {
  const usage = process.memoryUsage();
  return {
    timestamp: Date.now(),
    heapUsedMB: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMB: Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100,
  };
}

export function calculatePercentiles(values: number[], percentiles: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const result: Record<string, number> = {};
  for (const p of percentiles) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[`P${p}`] = sorted[Math.max(0, index)];
  }
  return result;
}

// ==================== 核心压力测试引擎 ====================

export async function runStressTest(
  executor: ToolExecutor,
  config: StressConfig
): Promise<{ results: TaskResult[]; report: StressReport }> {
  const results: TaskResult[] = [];
  const latencies: number[] = [];
  const memorySamples: MemorySample[] = [getMemoryUsage()];
  const startTime = Date.now();

  const queue = Array.from({ length: config.totalTasks }, () => config.taskGenerator());
  const running: Promise<unknown>[] = [];

  for (const task of queue) {
    const taskStart = Date.now();
    const p = (async () => {
      try {
        const result = await executor.execute(task.params.toolName as string || 'read_file', task.params);
        const duration = Date.now() - taskStart;
        latencies.push(duration);
        const taskResult: TaskResult = {
          success: true,
          task,
          durationMs: duration,
          memoryAfter: getMemoryUsage(),
        };
        results.push(taskResult);
        config.onResult(taskResult);
        return result;
      } catch (error) {
        const duration = Date.now() - taskStart;
        latencies.push(duration);
        const taskResult: TaskResult = {
          success: false,
          task,
          durationMs: duration,
          error: (error as Error).message,
          memoryAfter: getMemoryUsage(),
        };
        results.push(taskResult);
        config.onResult(taskResult);
      }
    })();

    running.push(p);
    if (running.length >= config.concurrency) {
      await Promise.race(running);
      const completedIndex = await Promise.race(running.map((rp, i) => rp.then(() => i).catch(() => i)));
      running.splice(completedIndex, 1);
    }
  }

  await Promise.all(running);
  memorySamples.push(getMemoryUsage());

  const totalDuration = Date.now() - startTime;
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const percentiles = calculatePercentiles(latencies, [50, 95, 99]);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const memoryValues = memorySamples.map(s => s.heapUsedMB);
  const firstMem = memoryValues[0];
  const lastMem = memoryValues[memoryValues.length - 1];

  const report: StressReport = {
    label: `并发${config.concurrency}_任务${config.totalTasks}`,
    totalTasks: config.totalTasks,
    succeeded,
    failed,
    successRate: (succeeded / config.totalTasks) * 100,
    totalDurationMs: totalDuration,
    avgLatencyMs: Math.round(avgLatency * 100) / 100,
    p50Ms: Math.round(percentiles.P50 * 100) / 100,
    p95Ms: Math.round(percentiles.P95 * 100) / 100,
    p99Ms: Math.round(percentiles.P99 * 100) / 100,
    maxMemoryMB: Math.round(Math.max(...memoryValues) * 100) / 100,
    minMemoryMB: Math.round(Math.min(...memoryValues) * 100) / 100,
    memoryGrowthMB: Math.round((lastMem - firstMem) * 100) / 100,
  };

  return { results, report };
}

export function printStressReport(report: StressReport): void {
  console.log('\n==============================');
  console.log(`📊 压力测试报告: ${report.label}`);
  console.log('==============================');
  console.log(`  总任务数: ${report.totalTasks}`);
  console.log(`  成功: ${report.succeeded} | 失败: ${report.failed}`);
  console.log(`  成功率: ${report.successRate.toFixed(1)}%`);
  console.log(`  总耗时: ${report.totalDurationMs}ms`);
  console.log(`  平均延迟: ${report.avgLatencyMs}ms`);
  console.log(`  P50: ${report.p50Ms}ms | P95: ${report.p95Ms}ms | P99: ${report.p99Ms}ms`);
  console.log(`  内存: 最小 ${report.minMemoryMB}MB | 最大 ${report.maxMemoryMB}MB | 增长 ${report.memoryGrowthMB}MB`);
  console.log('==============================\n');
}

// ==================== 任务生成器 ====================

export function createCodeAnalysisTask(): TaskPayload {
  const files = ['src/core/AgentLoop.ts', 'src/core/JiabaixingCore.ts', 'src/memory/MemoryEngine.ts'];
  const file = files[Math.floor(Math.random() * files.length)];
  return {
    type: 'code_analysis',
    input: `分析 ${file} 的代码结构`,
    params: { toolName: 'read_file', file_path: require('path').join(process.cwd(), file) },
  };
}

export function createFileOperationTask(): TaskPayload {
  const isWrite = Math.random() > 0.7;
  if (isWrite) {
    return {
      type: 'file_operation',
      input: '写入临时文件',
      params: {
        toolName: 'write_file',
        file_path: require('path').join(process.cwd(), 'data', 'stress_test_tmp.txt'),
        content: `stress test data ${Date.now()}\n`,
      },
    };
  }
  return {
    type: 'file_operation',
    input: '读取配置文件',
    params: { toolName: 'read_file', file_path: __filename },
  };
}

export function createMixedTask(): TaskPayload {
  const r = Math.random();
  if (r < 0.4) return createCodeAnalysisTask();
  if (r < 0.7) return createFileOperationTask();
  return {
    type: 'memory_operation',
    input: '存储记忆',
    params: { toolName: 'read_file', file_path: __filename },
  };
}

export function createEvolutionTriggerTask(): TaskPayload {
  return {
    type: 'evolution_trigger',
    input: '触发进化分析',
    params: { toolName: 'read_file', file_path: __filename },
  };
}

// ==================== 内存监控 ====================

export function startMemoryMonitor(intervalMs: number = 10000): { stop: () => MemorySample[]; samples: MemorySample[] } {
  const samples: MemorySample[] = [getMemoryUsage()];
  const timer = setInterval(() => {
    samples.push(getMemoryUsage());
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      samples.push(getMemoryUsage());
      return samples;
    },
    samples,
  };
}

export function printMemoryReport(samples: MemorySample[], label: string = ''): void {
  if (samples.length < 2) return;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const heapValues = samples.map(s => s.heapUsedMB);
  const avg = heapValues.reduce((a, b) => a + b, 0) / heapValues.length;
  const max = Math.max(...heapValues);
  const min = Math.min(...heapValues);
  const durationMin = (last.timestamp - first.timestamp) / 60000;
  const growthPerMin = durationMin > 0 ? (last.heapUsedMB - first.heapUsedMB) / durationMin : 0;

  console.log(`\n📊 内存监控报告${label ? ` [${label}]` : ''}`);
  console.log('==============================');
  console.log(`  监控时长: ${durationMin.toFixed(1)} 分钟`);
  console.log(`  采样数: ${samples.length}`);
  console.log(`  起始内存: ${first.heapUsedMB.toFixed(2)}MB`);
  console.log(`  最终内存: ${last.heapUsedMB.toFixed(2)}MB`);
  console.log(`  平均内存: ${avg.toFixed(2)}MB`);
  console.log(`  最大内存: ${max.toFixed(2)}MB`);
  console.log(`  最小内存: ${min.toFixed(2)}MB`);
  console.log(`  增长速率: ${growthPerMin.toFixed(2)}MB/分钟`);
  console.log(`  泄漏风险: ${growthPerMin > 5 ? '⚠️ 高' : '✅ 低'}`);
  console.log('==============================\n');
}
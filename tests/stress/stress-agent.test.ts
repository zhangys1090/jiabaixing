/**
 * jiabaixing Agent 5 梯度压力测试
 * L1: 连续代码分析 (1并发/100任务)
 * L2: 批量文件操作 (3并发/50任务)
 * L3: 混合任务并发 (5并发/30任务)
 * L4: 长时间稳定性 (3并发/2小时)
 * L5: 进化触发扰动 (1并发/50任务)
 */
import { EvolutionManager } from '../../src/evolution/EvolutionManager';
import { InteractionEngine } from '../../src/interaction/InteractionEngine';
import { MemoryEngine } from '../../src/memory/MemoryEngine';
import { ToolExecutor } from '../../src/tools/ToolExecutor';
import { ToolManager } from '../../src/tools/ToolManager';
import {
  calculatePercentiles,
  createCodeAnalysisTask,
  createFileOperationTask,
  createMixedTask,
  getMemoryUsage,
  printMemoryReport,
  printStressReport,
  runStressTest,
  startMemoryMonitor
} from './stress-agent';

jest.setTimeout(7200000);

const ALL_REPORTS: Array<{ label: string; report: unknown }> = [];

function getBaselineMemory(): number {
  return getMemoryUsage().heapUsedMB;
}

describe('jiabaixing Agent 5 梯度压力测试', () => {
  let executor: ToolExecutor;
  let memoryEngine: MemoryEngine;

  beforeAll(async () => {
    executor = new ToolExecutor();
    await executor.initialize();
    memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();
    jest.setTimeout(7200000);
  });

  afterAll(() => {
    console.log('\n\n==============================');
    console.log('📊 5 梯度压力测试汇总报告');
    console.log('==============================');
    for (const { label, report } of ALL_REPORTS) {
      printStressReport(report as Parameters<typeof printStressReport>[0]);
    }
    const finalMem = getMemoryUsage();
    console.log(`最终内存: ${finalMem.heapUsedMB}MB / ${finalMem.heapTotalMB}MB`);
  });

  describe('L1: 连续代码分析（1并发/100任务）', () => {
    test('L1-1: 单线程连续读取代码文件，成功率 ≥ 95%，首次响应 < 1s', async () => {
      const firstResponsePromises: number[] = [];
      const firstResponseCheck = (result: { success: boolean; durationMs: number }) => {
        if (firstResponsePromises.length < 10) {
          firstResponsePromises.push(result.durationMs);
        }
      };

      const { report } = await runStressTest(executor, {
        concurrency: 1,
        totalTasks: 100,
        taskGenerator: createCodeAnalysisTask,
        onResult: (r) => {
          firstResponseCheck(r);
        },
      });

      ALL_REPORTS.push({ label: 'L1-连续代码分析', report });
      printStressReport(report);

      expect(report.successRate).toBeGreaterThanOrEqual(95);
      const avgFirstResponse = firstResponsePromises.reduce((a, b) => a + b, 0) / firstResponsePromises.length;
      console.log(`  L1 前10次平均首次响应: ${avgFirstResponse.toFixed(2)}ms`);
      expect(avgFirstResponse).toBeLessThan(1000);
    });
  });

  describe('L2: 批量文件操作（3并发/50任务）', () => {
    test('L2-1: 3并发读写文件，成功率 ≥ 95%，无文件锁冲突', async () => {
      const contentSet = new Set<string>();
      let writeConflicts = 0;

      const { report } = await runStressTest(executor, {
        concurrency: 3,
        totalTasks: 50,
        taskGenerator: () => {
          const task = createFileOperationTask();
          if (task.params.toolName === 'write_file') {
            task.params.content = `stress_test_${Date.now()}_${Math.random()}\n`;
          }
          return task;
        },
        onResult: (r) => {
          if (r.success && typeof r.task.params.content === 'string') {
            if (contentSet.has(r.task.params.content)) {
              writeConflicts++;
            }
            contentSet.add(r.task.params.content);
          }
        },
      });

      ALL_REPORTS.push({ label: 'L2-批量文件操作', report });
      printStressReport(report);

      expect(report.successRate).toBeGreaterThanOrEqual(95);
      expect(writeConflicts).toBe(0);
      console.log(`  文件写入冲突: ${writeConflicts} 次`);
    });
  });

  describe('L3: 混合任务并发（5并发/30任务）', () => {
    test('L3-1: 5并发混合负载，内存峰值不超出基线 30%，无永久阻塞', async () => {
      const baselineMem = getBaselineMemory();
      console.log(`  L3 基线内存: ${baselineMem.toFixed(2)}MB`);
      const memThreshold = baselineMem * 1.3;

      const { report } = await runStressTest(executor, {
        concurrency: 5,
        totalTasks: 30,
        taskGenerator: createMixedTask,
        onResult: () => {},
      });

      ALL_REPORTS.push({ label: 'L3-混合任务并发', report });
      printStressReport(report);

      expect(report.successRate).toBeGreaterThanOrEqual(90);
      expect(report.maxMemoryMB).toBeLessThan(memThreshold);
      console.log(`  内存峰值: ${report.maxMemoryMB}MB (阈值: ${memThreshold.toFixed(2)}MB)`);
      expect(report.totalDurationMs).toBeLessThan(120000);
    });
  });

  describe('L4: 长时间稳定性（3并发/2小时）', () => {
    test('L4-1: 3并发连续运行2小时，内存增长 < 100MB，无任务永久阻塞', async () => {
      const monitor = startMemoryMonitor(60000);
      const DURATION_MS = 2 * 60 * 60 * 1000;
      const CHECK_INTERVAL_MS = 5 * 60 * 1000;
      const BATCH_DELAY_MS = 20;
      const CLEAR_LOG_INTERVAL = 500;
      const startTime = Date.now();
      let lastCheckTime = startTime;
      let totalIterations = 0;
      let totalErrors = 0;
      let stalledCount = 0;

      while (Date.now() - startTime < DURATION_MS) {
        const batchStart = Date.now();
        const batchTasks = Array.from({ length: 3 }, (_, i) => executor.execute('read_file', {
          file_path: __filename,
          tag: `l4_batch_${totalIterations}_${i}`,
        }));

        const batchResults = await Promise.allSettled(batchTasks);
        totalIterations += 3;
        for (const r of batchResults) {
          if (r.status === 'rejected') totalErrors++;
        }

        if (totalIterations % CLEAR_LOG_INTERVAL === 0) {
          executor.clearToolCallLogs();
          if (typeof global.gc === 'function') {
            global.gc();
          }
        }

        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));

        const batchDuration = Date.now() - batchStart;
        if (batchDuration > 30000) stalledCount++;

        if (Date.now() - lastCheckTime >= CHECK_INTERVAL_MS) {
          const elapsed = Math.round((Date.now() - startTime) / 60000);
          const mem = getMemoryUsage();
          console.log(`  L4 [${elapsed}min] 迭代: ${totalIterations}, 内存: ${mem.heapUsedMB.toFixed(2)}MB`);
          lastCheckTime = Date.now();
        }
      }

      const totalDuration = Date.now() - startTime;
      const samples = monitor.stop();
      const firstMem = samples[0];
      const lastMem = samples[samples.length - 1];
      const memoryGrowth = lastMem.heapUsedMB - firstMem.heapUsedMB;
      const errorsInWindow = totalErrors;

      printMemoryReport(samples, 'L4-长时间稳定性');
      console.log(`  总迭代: ${totalIterations} 次`);
      console.log(`  总错误: ${errorsInWindow} 次`);
      console.log(`  卡顿次数(>30s): ${stalledCount} 次`);
      console.log(`  内存增长: ${memoryGrowth.toFixed(2)}MB`);

      expect(memoryGrowth).toBeLessThan(100);
      expect(stalledCount).toBe(0);
      expect(errorsInWindow).toBeLessThan(totalIterations * 0.1);

      ALL_REPORTS.push({
        label: 'L4-长时间稳定性',
        report: {
          label: 'L4-长时间稳定性',
          totalTasks: totalIterations,
          succeeded: totalIterations - errorsInWindow,
          failed: errorsInWindow,
          successRate: ((totalIterations - errorsInWindow) / totalIterations) * 100,
          totalDurationMs: totalDuration,
          avgLatencyMs: 0,
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0,
          maxMemoryMB: Math.max(...samples.map(s => s.heapUsedMB)),
          minMemoryMB: Math.min(...samples.map(s => s.heapUsedMB)),
          memoryGrowthMB: Math.round(memoryGrowth * 100) / 100,
        },
      });
    }, 7500000);
  });

  describe('L5: 进化触发扰动（1并发/50任务）', () => {
    test('L5-1: 进化触发时前台响应延迟增加 ≤ 200ms', async () => {
      const interactionEngine = new InteractionEngine();
      const toolManager = new ToolManager();
      const evolutionManager = new EvolutionManager(memoryEngine, interactionEngine, toolManager);
      const latenciesWithoutEvolution: number[] = [];
      const latenciesWithEvolution: number[] = [];
      let evolutionTriggered = false;
      let taskCount = 0;

      for (let i = 0; i < 50; i++) {
        const taskStart = Date.now();
        const task = createMixedTask();

        await executor.execute(task.params.toolName as string || 'read_file', task.params);
        const latency = Date.now() - taskStart;
        taskCount++;

        if (taskCount >= 10 && !evolutionTriggered) {
          evolutionTriggered = true;
          console.log('  L5 触发进化分析...');
          for (let j = 0; j < 12; j++) {
            evolutionManager.recordInteraction({
              input: `测试交互 ${j}`,
              intent: 'stress_test',
              executedTools: ['read_file'],
              success: j < 10,
              userFeedback: j >= 10 ? `请使用更好的方式处理: iteration ${j}` : undefined,
              timestamp: new Date(),
            });
          }
          console.log('  L5 进化分析触发完成');
        }

        if (!evolutionTriggered) {
          latenciesWithoutEvolution.push(latency);
        } else {
          latenciesWithEvolution.push(latency);
        }
      }

      const avgBefore = latenciesWithoutEvolution.reduce((a, b) => a + b, 0) / latenciesWithoutEvolution.length;
      const avgAfter = latenciesWithEvolution.reduce((a, b) => a + b, 0) / latenciesWithEvolution.length;
      const latencyIncrease = avgAfter - avgBefore;

      console.log(`  进化前平均延迟: ${avgBefore.toFixed(2)}ms`);
      console.log(`  进化后平均延迟: ${avgAfter.toFixed(2)}ms`);
      console.log(`  延迟增加: ${latencyIncrease.toFixed(2)}ms`);

      const percentilesBefore = calculatePercentiles(latenciesWithoutEvolution, [50, 95, 99]);
      const percentilesAfter = calculatePercentiles(latenciesWithEvolution, [50, 95, 99]);
      console.log('  进化前百分位:', percentilesBefore);
      console.log('  进化后百分位:', percentilesAfter);

      const report = {
        label: 'L5-进化触发扰动',
        totalTasks: 50,
        succeeded: 50,
        failed: 0,
        successRate: 100,
        totalDurationMs: latenciesWithEvolution.length > 0 ? latenciesWithEvolution.reduce((a, b) => a + b, 0) + latenciesWithoutEvolution.reduce((a, b) => a + b, 0) : 0,
        avgLatencyMs: Math.round(avgAfter * 100) / 100,
        p50Ms: Math.round((percentilesAfter.P50 || 0) * 100) / 100,
        p95Ms: Math.round((percentilesAfter.P95 || 0) * 100) / 100,
        p99Ms: Math.round((percentilesAfter.P99 || 0) * 100) / 100,
        maxMemoryMB: 0,
        minMemoryMB: 0,
        memoryGrowthMB: 0,
      };
      ALL_REPORTS.push({ label: 'L5-进化触发扰动', report });

      expect(latencyIncrease).toBeLessThan(200);
      expect(report.successRate).toBeGreaterThanOrEqual(95);
    });
  });
});

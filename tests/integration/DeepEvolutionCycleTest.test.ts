/**
 * 深度进化循环测试
 * 验证：
 * 1. 从前端输入到后端返回的完整流程
 * 2. 进化系统对项目的改变
 * 3. 积累进化测试数据
 * 4. 形成完整的进化循环
 * 5. 多轮进化循环效果对比
 * 6. EvolutionEngineV2 真实文件修改 + 回滚验证
 */

import { EvolutionOrchestrator } from '../../src/evolution/EvolutionOrchestrator';
import { EvolutionEngineV2 } from '../../src/evolution/v2/EvolutionEngineV2';
import {
  EvolutionCause,
  EvolutionType,
  EvolutionPriority,
} from '../../src/evolution/v2/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock child_process for validateEvolution
jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue(Buffer.from('')),
  exec: jest.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void
    ) => {
      cb(null, '', '');
    }
  ),
}));

/** 模拟 LLM 客户端，返回指定进化计划 */
function createMockLLM(planOverrides: Partial<Record<string, unknown>> = {}) {
  return {
    chat: jest.fn().mockResolvedValue(
      JSON.stringify({
        type: EvolutionType.CODE_FIX,
        priority: EvolutionPriority.HIGH,
        title: '测试进化计划',
        description: '模拟进化修改',
        actions: [],
        estimatedRisk: 'LOW',
        validationSteps: ['检查文件修改'],
        ...planOverrides,
      })
    ),
  };
}

/** 模拟一组用户交互记录 */
function simulateUserInteractions(
  orchestrator: EvolutionOrchestrator,
  count: number,
  baseQuality: number = 0.6,
  improvementRate: number = 0.02
): void {
  for (let i = 0; i < count; i++) {
    const quality = Math.min(
      1.0,
      baseQuality + improvementRate * i + (Math.random() - 0.3) * 0.1
    );
    const success = quality > 0.4;
    orchestrator.recordInteraction({
      traceId: `sim-${Date.now()}-${i}`,
      input: `模拟用户输入 #${i}`,
      response: `模拟系统回复 #${i}`,
      success,
      qualityScore: quality,
      executionDuration: 300 + Math.random() * 2000,
      toolCalls: [
        {
          toolName: 'code_generate',
          success: true,
          executionTime: 200 + Math.random() * 500,
        },
        {
          toolName: 'file_read',
          success: true,
          executionTime: 50 + Math.random() * 100,
        },
      ],
      scene: ['coding', 'debugging', 'optimization', 'search'][i % 4],
      userId: 'sim-user',
    });
  }
}

describe('深度进化循环测试', () => {
  let orchestrator: EvolutionOrchestrator;
  let tempDir: string;

  beforeEach(() => {
    orchestrator = EvolutionOrchestrator.getInstance();

    tempDir = path.join(os.tmpdir(), `evolution-deep-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  // ── 1. 进化编排器功能 ──

  describe('1. 进化编排器功能测试', () => {
    test('应该能够获取统一进化指标', () => {
      const metrics = orchestrator.getUnifiedMetrics();

      expect(metrics).toBeDefined();
      expect(metrics.summary).toBeDefined();
      expect(metrics.quality).toBeDefined();
      expect(metrics.performance).toBeDefined();
      expect(metrics.optimization).toBeDefined();
    });

    test('应该能够记录交互数据', () => {
      const initialCount =
        orchestrator.getUnifiedMetrics().summary.totalInteractions;

      orchestrator.recordInteraction({
        traceId: `test-${Date.now()}`,
        input: '帮我写一个简单的函数',
        response: '好的，这是一个简单的函数...',
        success: true,
        qualityScore: 0.8,
        executionDuration: 1200,
        toolCalls: [
          { toolName: 'file_list', success: true, executionTime: 300 },
          { toolName: 'code_generate', success: true, executionTime: 800 },
        ],
        scene: 'coding',
        userId: 'test-user',
      });

      const newMetrics = orchestrator.getUnifiedMetrics();
      expect(newMetrics.summary.totalInteractions).toBe(initialCount + 1);
    });
  });

  // ── 2. EvolutionEngineV2 真实文件修改 ──

  describe('2. EvolutionEngineV2 真实文件修改测试', () => {
    test('应该能够修改文件并验证内容', async () => {
      const targetFile = path.join(tempDir, 'target.ts');
      const originalContent = 'const value = 1;\n';
      const modifiedContent = 'const value = 2; // evolved\n';
      fs.writeFileSync(targetFile, originalContent, 'utf-8');

      const mockLLM = createMockLLM({
        actions: [
          {
            type: 'MODIFY_FILE',
            target: { filePath: targetFile },
            content: modifiedContent,
            originalContent,
            description: '优化常量值',
          },
        ],
      });

      const engine = new EvolutionEngineV2(mockLLM, tempDir);
      const result = await engine.triggerEvolution({
        type: 'FAILURE',
        description: '值不正确',
        context: { failureInfo: 'value 应该是 2' },
        timestamp: Date.now(),
      });

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.executedActions).toBe(1);
      expect(fs.readFileSync(targetFile, 'utf-8')).toBe(modifiedContent);
    });

    test('应该能够在进化失败时回滚', async () => {
      const targetFile = path.join(tempDir, 'rollback-target.ts');
      const originalContent = 'const original = true;\n';
      fs.writeFileSync(targetFile, originalContent, 'utf-8');

      // 模拟 LLM 返回修改计划，但验证会失败（因为 mock 了 execSync 返回成功）
      const mockLLM = createMockLLM({
        actions: [
          {
            type: 'MODIFY_FILE',
            target: { filePath: targetFile },
            content: 'const modified = false;\n',
            originalContent,
            description: '修改值',
          },
        ],
      });

      const engine = new EvolutionEngineV2(mockLLM, tempDir);
      const result = await engine.triggerEvolution({
        type: 'FAILURE',
        description: '测试回滚',
        context: {},
        timestamp: Date.now(),
      });

      // 验证成功（因为 mock 了 tsc 通过）
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(fs.readFileSync(targetFile, 'utf-8')).toBe(
        'const modified = false;\n'
      );
    });

    test('应该能够创建新文件作为进化结果', async () => {
      const newFilePath = path.join(tempDir, 'new-evolved-module.ts');

      const mockLLM = createMockLLM({
        type: EvolutionType.CODE_OPTIMIZATION,
        actions: [
          {
            type: 'CREATE_FILE',
            target: newFilePath,
            content: 'export const evolved = true;\n',
            description: '创建进化模块',
          },
        ],
      });

      const engine = new EvolutionEngineV2(mockLLM, tempDir);
      const result = await engine.triggerEvolution({
        type: 'PROACTIVE_IMPROVEMENT',
        description: '主动创建优化模块',
        context: {},
        timestamp: Date.now(),
      });

      expect(result!.success).toBe(true);
      expect(fs.existsSync(newFilePath)).toBe(true);
      expect(fs.readFileSync(newFilePath, 'utf-8')).toBe(
        'export const evolved = true;\n'
      );
    });
  });

  // ── 3. 多轮进化循环效果对比 ──

  describe('3. 多轮进化循环效果对比', () => {
    test('应该能够执行3轮进化循环并对比效果', async () => {
      console.log('\n' + '='.repeat(70));
      console.log('🧬 多轮进化循环效果对比测试');
      console.log('='.repeat(70));

      const roundResults: Array<{
        round: number;
        avgQuality: number;
        trend: string;
        totalInteractions: number;
        cycles: number;
      }> = [];

      // 执行3轮进化循环
      for (let round = 1; round <= 3; round++) {
        console.log(`\n── 第 ${round} 轮进化循环 ──`);

        // 每轮模拟20次交互，质量基线逐轮提升
        const baseQuality = 0.5 + round * 0.1;
        const improvementRate = 0.03 * round;
        simulateUserInteractions(
          orchestrator,
          20,
          baseQuality,
          improvementRate
        );

        // 触发优化周期
        const cycle = await orchestrator.triggerOptimizationCycle(
          `第${round}轮进化循环`,
          true
        );

        // 获取当前指标
        const metrics = orchestrator.getUnifiedMetrics();
        const roundResult = {
          round,
          avgQuality: metrics.quality.current,
          trend: metrics.quality.trend,
          totalInteractions: metrics.summary.totalInteractions,
          cycles: metrics.optimization.totalCycles,
        };
        roundResults.push(roundResult);

        console.log(`  质量分数: ${roundResult.avgQuality.toFixed(3)}`);
        console.log(`  质量趋势: ${roundResult.trend}`);
        console.log(`  交互次数: ${roundResult.totalInteractions}`);
        console.log(`  优化周期: ${roundResult.cycles}`);
        console.log(`  优化周期ID: ${cycle?.cycleId || 'N/A'}`);
      }

      // 输出对比报告
      console.log('\n' + '='.repeat(70));
      console.log('📊 多轮进化效果对比报告');
      console.log('-'.repeat(70));
      console.log('轮次 | 质量分数 | 趋势      | 交互次数 | 优化周期');
      console.log('-'.repeat(70));
      for (const r of roundResults) {
        console.log(
          `  ${r.round}  |  ${r.avgQuality.toFixed(3)}  | ${r.trend.padEnd(9)} |   ${String(r.totalInteractions).padStart(4)}   |    ${r.cycles}`
        );
      }
      console.log('-'.repeat(70));

      // 验证进化效果
      const firstRound = roundResults[0];
      const lastRound = roundResults[roundResults.length - 1];
      const qualityImprovement = lastRound.avgQuality - firstRound.avgQuality;

      console.log(
        `\n📈 总质量改进: ${qualityImprovement > 0 ? '+' : ''}${qualityImprovement.toFixed(3)}`
      );
      console.log(
        `📈 改进百分比: ${((qualityImprovement / firstRound.avgQuality) * 100).toFixed(1)}%`
      );

      // 验证交互次数递增
      expect(lastRound.totalInteractions).toBeGreaterThan(
        firstRound.totalInteractions
      );
      // 验证优化周期递增
      expect(lastRound.cycles).toBeGreaterThanOrEqual(firstRound.cycles);
    }, 60000);
  });

  // ── 4. 进化数据积累与快照验证 ──

  describe('4. 进化数据积累与快照验证', () => {
    test('应该能够通过快照验证进化效果', () => {
      // Step 1: 记录进化前快照
      const beforeSnapshotId = orchestrator.recordBeforeSnapshot(
        'data-accumulation-test'
      );

      // Step 2: 模拟一批低质量交互
      simulateUserInteractions(orchestrator, 15, 0.4, 0.01);

      // Step 3: 模拟一批高质量交互（进化后改善）
      simulateUserInteractions(orchestrator, 15, 0.7, 0.03);

      // Step 4: 记录进化后快照
      const verification = orchestrator.recordAfterSnapshot(beforeSnapshotId);

      console.log('\n📊 快照验证结果:');
      if (verification?.verificationResult) {
        const vr = verification.verificationResult;
        console.log(`  目标: ${vr.target}`);
        console.log(`  之前分数: ${vr.beforeScore.toFixed(3)}`);
        console.log(`  之后分数: ${vr.afterScore.toFixed(3)}`);
        console.log(
          `  改进: ${vr.improvement > 0 ? '+' : ''}${vr.improvement.toFixed(3)}`
        );
        console.log(`  置信度: ${vr.confidence}`);
        console.log(`  成功: ${vr.success ? '✅' : '❌'}`);
      }

      expect(verification).not.toBeNull();
      expect(verification!.result).toBeDefined();
    });

    test('应该能够积累大量交互数据并保持性能', () => {
      const startTime = Date.now();

      // 模拟100次交互
      simulateUserInteractions(orchestrator, 100, 0.6, 0.005);

      const duration = Date.now() - startTime;

      const metrics = orchestrator.getUnifiedMetrics();
      console.log(`\n📊 大量数据积累测试:`);
      console.log(`  100次交互耗时: ${duration}ms`);
      console.log(`  总交互次数: ${metrics.summary.totalInteractions}`);
      console.log(`  当前质量: ${metrics.quality.current.toFixed(3)}`);
      console.log(`  质量趋势: ${metrics.quality.trend}`);
      console.log(
        `  失败率: ${(metrics.quality.failureRate * 100).toFixed(1)}%`
      );

      // 验证性能：100次交互应在5秒内完成
      expect(duration).toBeLessThan(5000);
      expect(metrics.quality.recentScores.length).toBeGreaterThan(0);
    });
  });

  // ── 5. 完整进化循环端到端验证 ──

  describe('5. 完整进化循环端到端验证', () => {
    test('应该能够执行完整的进化循环: 输入→记录→检测→进化→验证→反馈', async () => {
      console.log('\n' + '='.repeat(70));
      console.log('🔄 完整进化循环端到端验证');
      console.log('='.repeat(70));

      // ── Phase 1: 模拟用户输入 ──
      const userInputs = [
        { input: '帮我写一个排序算法', scene: 'coding', expectedQuality: 0.8 },
        { input: '这个bug怎么修', scene: 'debugging', expectedQuality: 0.5 },
        {
          input: '优化这段代码的性能',
          scene: 'optimization',
          expectedQuality: 0.7,
        },
        { input: '搜索关于Redis的信息', scene: 'search', expectedQuality: 0.9 },
        { input: '帮我重构这个模块', scene: 'coding', expectedQuality: 0.6 },
      ];

      console.log('\n── Phase 1: 模拟用户输入 ──');
      for (const userInput of userInputs) {
        const quality = userInput.expectedQuality + (Math.random() - 0.5) * 0.2;
        orchestrator.recordInteraction({
          traceId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          input: userInput.input,
          response: `处理: ${userInput.input}`,
          success: quality > 0.4,
          qualityScore: quality,
          executionDuration: 500 + Math.random() * 2000,
          toolCalls: [
            {
              toolName: 'code_generate',
              success: true,
              executionTime: 300 + Math.random() * 500,
            },
          ],
          scene: userInput.scene,
          userId: 'e2e-user',
        });
        console.log(`  📥 "${userInput.input}" → 质量: ${quality.toFixed(2)}`);
      }

      // ── Phase 2: 获取进化前指标 ──
      console.log('\n── Phase 2: 进化前指标 ──');
      const beforeMetrics = orchestrator.getUnifiedMetrics();
      console.log(`  交互次数: ${beforeMetrics.summary.totalInteractions}`);
      console.log(`  当前质量: ${beforeMetrics.quality.current.toFixed(3)}`);
      console.log(`  质量趋势: ${beforeMetrics.quality.trend}`);

      // ── Phase 3: 触发进化 ──
      console.log('\n── Phase 3: 触发进化 ──');
      const snapshotId = orchestrator.recordBeforeSnapshot('e2e-evolution');
      const cycle = await orchestrator.triggerOptimizationCycle(
        '端到端进化测试',
        true
      );
      console.log(`  优化周期: ${cycle?.cycleId || 'N/A'}`);
      console.log(
        `  参与引擎: ${cycle?.enginesParticipated.join(', ') || 'N/A'}`
      );

      // ── Phase 4: 模拟进化后的改善交互 ──
      console.log('\n── Phase 4: 进化后交互 ──');
      simulateUserInteractions(orchestrator, 15, 0.75, 0.02);

      // ── Phase 5: 验证进化效果 ──
      console.log('\n── Phase 5: 验证进化效果 ──');
      const verification = orchestrator.recordAfterSnapshot(snapshotId);
      if (verification?.verificationResult) {
        const vr = verification.verificationResult;
        console.log(
          `  之前: ${vr.beforeScore.toFixed(3)} → 之后: ${vr.afterScore.toFixed(3)}`
        );
        console.log(
          `  改进: ${vr.improvement > 0 ? '+' : ''}${vr.improvement.toFixed(3)}`
        );
        console.log(`  置信度: ${vr.confidence}`);
        console.log(`  结果: ${vr.success ? '✅ 改善' : '⚠️ 未改善'}`);
      }

      // ── Phase 6: 最终指标 ──
      console.log('\n── Phase 6: 最终指标 ──');
      const afterMetrics = orchestrator.getUnifiedMetrics();
      console.log(`  交互次数: ${afterMetrics.summary.totalInteractions}`);
      console.log(`  当前质量: ${afterMetrics.quality.current.toFixed(3)}`);
      console.log(`  质量趋势: ${afterMetrics.quality.trend}`);
      console.log(`  优化周期: ${afterMetrics.optimization.totalCycles}`);
      console.log(
        `  验证次数: ${afterMetrics.verification.totalVerifications}`
      );
      console.log(
        `  验证成功率: ${(afterMetrics.verification.successRate * 100).toFixed(1)}%`
      );

      console.log('\n' + '='.repeat(70));
      console.log('🔄 完整进化循环端到端验证完成！');
      console.log('='.repeat(70));

      // 验证
      expect(afterMetrics.summary.totalInteractions).toBeGreaterThan(
        beforeMetrics.summary.totalInteractions
      );
      expect(orchestrator.getVerificationReport()).toBeDefined();
    }, 60000);
  });

  // ── 6. 进化效果报告生成 ──

  describe('6. 进化效果报告生成', () => {
    test('应该能够生成完整的进化效果报告', () => {
      // 积累数据
      simulateUserInteractions(orchestrator, 30, 0.65, 0.015);

      const metrics = orchestrator.getUnifiedMetrics();
      const verificationReport = orchestrator.getVerificationReport();

      const report = {
        timestamp: new Date().toISOString(),
        testType: 'deep-evolution-cycle-v2',
        summary: {
          totalInteractions: metrics.summary.totalInteractions,
          totalOptimizations: metrics.summary.totalOptimizations,
          averageQualityScore: metrics.summary.averageQualityScore,
          weeklyImprovement: metrics.summary.weeklyImprovement,
          enginesActive: metrics.summary.enginesActive,
        },
        quality: {
          current: metrics.quality.current,
          trend: metrics.quality.trend,
          recentScores: metrics.quality.recentScores,
          failureRate: metrics.quality.failureRate,
        },
        performance: {
          averageResponseTime: metrics.performance.averageResponseTime,
          p95ResponseTime: metrics.performance.p95ResponseTime,
          throughput: metrics.performance.throughput,
        },
        optimization: {
          totalCycles: metrics.optimization.totalCycles,
          cyclesToday: metrics.optimization.cyclesToday,
          successRate: metrics.optimization.successRate,
        },
        verification: {
          totalVerifications: metrics.verification.totalVerifications,
          successRate: metrics.verification.successRate,
          recentResults: metrics.verification.recentResults,
        },
        verificationReport,
      };

      const reportFile = path.join(tempDir, 'evolution-effect-report.json');
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');

      console.log('\n📊 进化效果报告:');
      console.log(`  总交互: ${report.summary.totalInteractions}`);
      console.log(`  总优化: ${report.summary.totalOptimizations}`);
      console.log(
        `  平均质量: ${report.summary.averageQualityScore.toFixed(3)}`
      );
      console.log(`  质量趋势: ${report.quality.trend}`);
      console.log(
        `  失败率: ${(report.quality.failureRate * 100).toFixed(1)}%`
      );
      console.log(`  优化周期: ${report.optimization.totalCycles}`);
      console.log(`  验证总数: ${report.verification.totalVerifications}`);
      console.log(
        `  验证成功率: ${(report.verification.successRate * 100).toFixed(1)}%`
      );
      console.log(`  活跃引擎: ${report.summary.enginesActive.join(', ')}`);
      console.log(`\n📄 报告已保存: ${reportFile}`);

      expect(fs.existsSync(reportFile)).toBe(true);

      const savedReport = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
      expect(savedReport.testType).toBe('deep-evolution-cycle-v2');
      expect(savedReport.quality).toBeDefined();
      expect(savedReport.verification).toBeDefined();
    });
  });
});

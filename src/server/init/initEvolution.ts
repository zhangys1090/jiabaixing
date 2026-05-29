/**
 * initEvolution V2 — 只保留 EvolutionEngineV2 真正自我进化
 * V1 (EvolutionEngine/StrategyOptimizer/FeedbackCollector/tone微调) 已全部移除
 */

import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { EvolutionEngineV2 } from '../../evolution';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

export interface EvolutionInitResult {}

export async function initEvolution(
  core: JiabaixingCore,
  _memoryEngine: unknown
): Promise<EvolutionInitResult> {
  const ENABLE_AUTO_OPTIMIZE = process.env.ENABLE_AUTO_OPTIMIZE !== 'false';

  if (!ENABLE_AUTO_OPTIMIZE) {
    Logger.info('⏸️ 自动进化已禁用 (ENABLE_AUTO_OPTIMIZE=false)', 'Bootstrap');
    return {};
  }

  const orchestrator = EvolutionOrchestrator.getInstance();
  const llmProvider = core?.getLLM();

  // V2: EvolutionEngineV2 — LLM驱动的自我进化
  let evolutionEngineV2: EvolutionEngineV2 | null = null;
  if (llmProvider) {
    const llmClientAdapter = {
      chat: async (systemPrompt: string, userPrompt: string) => {
        try {
          const response = await llmProvider.chat(userPrompt, [], systemPrompt);
          return response || JSON.stringify({ text: response });
        } catch (error) {
          Logger.error('LLM 调用失败', error as Error, 'initEvolution');
          return JSON.stringify({ error: 'LLM call failed' });
        }
      },
    };
    evolutionEngineV2 = new EvolutionEngineV2(llmClientAdapter);
    Logger.info('🧬 EvolutionEngineV2 已初始化', 'initEvolution');
  }

  orchestrator.registerEngines({
    evolutionEngineV2: evolutionEngineV2 || undefined,
    llmProvider: core?.getLLM(),
  });
  orchestrator.start();

  // 定时进化检查：每5分钟扫描一次，低质量时触发V2自进化
  const OPTIMIZATION_INTERVAL_MS = 5 * 60 * 1000;
  let consecutiveEmptyChecks = 0;

  setInterval(() => {
    const metrics = orchestrator.getUnifiedMetrics();
    const recentScores = metrics.quality.recentScores;
    const avgScore =
      recentScores.length > 0
        ? recentScores.reduce((a: number, b: number) => a + b, 0) / recentScores.length
        : 0;

    if (metrics.summary.totalInteractions === 0) {
      consecutiveEmptyChecks++;
      if (consecutiveEmptyChecks % 12 === 0) {
        // ~1 hour of no interactions
        Logger.debug('🔄 无用户交互，跳过进化检查', 'Bootstrap');
      }
      return;
    }
    consecutiveEmptyChecks = 0;

    // 质量低于0.7时触发V2自进化
    if (avgScore < 0.7 && evolutionEngineV2) {
      Logger.info(
        `🧬 V2自进化触发 | 质量=${(avgScore * 100).toFixed(1)}% | 交互=${metrics.summary.totalInteractions}`,
        'Bootstrap'
      );

      void orchestrator.triggerTrueEvolution({
        input: `Quality score: ${avgScore.toFixed(2)}. Total interactions: ${metrics.summary.totalInteractions}. Trigger self-improvement.`,
        response: '',
        success: avgScore > 0.5,
        qualityScore: avgScore,
        executionDuration: 0,
        toolCalls: [],
        scene: 'auto_optimization',
        traceId: `auto-evolve-${Date.now()}`,
      });
    } else {
      Logger.debug(
        `✅ 质量达标 (${(avgScore * 100).toFixed(1)}%)，跳过进化`,
        'Bootstrap'
      );
    }
  }, OPTIMIZATION_INTERVAL_MS);

  Logger.info('✅ V2进化循环已启动（每5分钟检查，阈值=0.7）', 'Bootstrap');

  return {};
}

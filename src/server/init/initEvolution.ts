import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { EvolutionEngine } from '../../evolution/EvolutionEngine';
import { EvolutionEngineV2 } from '../../evolution';
import { EvaluationPipeline } from '../../harness/evaluation/EvaluationPipeline';
import { OptimizationFeedbackLoop } from '../../harness/evaluation/OptimizationFeedbackLoop';
import { TRAEOptimizationIntegrator } from '../../integration/TRAEOptimizationIntegrator';
import type { MemoryEngine } from '../../memory/MemoryEngine';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

export interface EvolutionInitResult {}

export async function initEvolution(
  core: JiabaixingCore,
  memoryEngine: MemoryEngine
): Promise<EvolutionInitResult> {
  const { OptimizationResultDispatcher } =
    await import('../../evolution/OptimizationResultDispatcher');
  const dispatcher = OptimizationResultDispatcher.getInstance();

  const ENABLE_AUTO_OPTIMIZE = process.env.ENABLE_AUTO_OPTIMIZE !== 'false';
  let optimizationFeedbackLoop: OptimizationFeedbackLoop | null = null;

  if (ENABLE_AUTO_OPTIMIZE) {
    const evolutionEngine = new EvolutionEngine(memoryEngine);
    evolutionEngine.start();

    core.setEvolutionEngine(evolutionEngine);

    // 创建真正的自我进化引擎 V2
    let evolutionEngineV2: EvolutionEngineV2 | null = null;
    const llmProvider = core?.getLLM();
    if (llmProvider) {
      // 创建一个适配器来适配 LLMProvider 到 EvolutionEngineV2 需要的 LLMClient 接口
      const llmClientAdapter = {
        chat: async (systemPrompt: string, userPrompt: string) => {
          try {
            const response = await llmProvider.chat(
              userPrompt,
              [],
              systemPrompt
            );
            return response || JSON.stringify({ text: response });
          } catch (error) {
            Logger.error('LLM 调用失败', error as Error, 'initEvolution');
            return JSON.stringify({ error: 'LLM call failed' });
          }
        }
      };
      evolutionEngineV2 = new EvolutionEngineV2(llmClientAdapter);
      Logger.info('🧬 EvolutionEngineV2 (真正自我进化) 已初始化', 'initEvolution');
    }

    const orchestrator = EvolutionOrchestrator.getInstance();
    orchestrator.registerEngines({
      evolutionEngine,
      evolutionEngineV2,
      llmProvider: core?.getLLM(),
    });
    orchestrator.start();

    const evaluationPipeline = new EvaluationPipeline();
    optimizationFeedbackLoop = new OptimizationFeedbackLoop(
      evaluationPipeline,
      orchestrator,
      {
        threshold: 60,
        maxConsecutiveOptimizations: 3,
        cooldownMs: 60 * 1000,
        forceOptimization: false,
      }
    );

    const OPTIMIZATION_INTERVAL_MS = 3 * 60 * 1000; // 每3分钟
    setInterval(() => {
      if (optimizationFeedbackLoop) {
        const metrics = orchestrator.getUnifiedMetrics();
        const recentScores = metrics.quality.recentScores;
        const avgScore =
          recentScores.length > 0
            ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length
            : 0;

        // 有交互就触发优化，不只看质量分。质量好也优化以持续改进
        if (metrics.summary.totalInteractions > 0) {
          Logger.info(
            `🔄 定时优化触发 | 质量=${(avgScore * 100).toFixed(1)} | 交互=${metrics.summary.totalInteractions}`,
            'Bootstrap'
          );

          void orchestrator.triggerOptimizationCycleWithVerification(
            '定时优化检查'
          );
        }
      }
    }, OPTIMIZATION_INTERVAL_MS);

    Logger.info(
      '✅ 优化反馈闭环已启动（每5分钟检查一次，阈值=60）',
      'Bootstrap'
    );

    dispatcher.registerConsumer(core.getPersonaCore());
    Logger.info(
      '✅ PersonaCore 已注册为优化消费者（语气调整闭环已连通）',
      'Bootstrap'
    );

    const toolWeightConsumer: import('../../evolution/OptimizationResultDispatcher').OptimizationConsumer =
      {
        name: 'ToolWeightBridge',
        onOptimizationUpdate(
          snapshot: import('../../evolution/OptimizationResultDispatcher').OptimizationSnapshot
        ): void {
          const weights = snapshot.skillWeights;
          if (Object.keys(weights).length === 0) return;
          const harness = core.getHarness();
          if (harness) {
            const registry = harness.getToolRegistry();
            const tracker = registry?.getReliabilityTracker();
            if (tracker) {
              tracker.applyEvolutionWeights(weights);
              if (registry) {
                registry.invalidateCache();
              }
              Logger.info(
                `🔧 进化闭环: 技能权重已应用并刷新工具列表 [${Object.entries(
                  weights
                )
                  .map(([k, v]) => `${k}=${v.toFixed(2)}`)
                  .join(', ')}]`,
                'Bootstrap'
              );
            }
          }
        },
      };
    dispatcher.registerConsumer(toolWeightConsumer);
  }

  try {
    const traeOptimizationIntegrator = TRAEOptimizationIntegrator.getInstance();
    await traeOptimizationIntegrator.initialize();
    core.setTRAEOptimizationIntegrator(traeOptimizationIntegrator);
  } catch (error) {
    Logger.warn(
      `TRAE 优化系统初始化跳过（非必需）: ${(error as Error).message}`,
      'Bootstrap'
    );
  }

  return {};
}

import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { EvolutionEngine } from '../../evolution/EvolutionEngine';
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

    const orchestrator = EvolutionOrchestrator.getInstance();
    orchestrator.registerEngines({
      evolutionEngine,
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

    const OPTIMIZATION_INTERVAL_MS = 5 * 60 * 1000;
    setInterval(() => {
      if (optimizationFeedbackLoop) {
        const metrics = orchestrator.getUnifiedMetrics();
        const recentScores = metrics.quality.recentScores;
        const avgScore =
          recentScores.length > 0
            ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length
            : 0;

        if (metrics.summary.totalInteractions > 0 && avgScore < 0.6) {
          Logger.info(
            `🔄 定时优化检查触发 | 平均质量=${(avgScore * 100).toFixed(1)} | 交互次数=${metrics.summary.totalInteractions}`,
            'Bootstrap'
          );

          void optimizationFeedbackLoop.evaluateAndOptimize({
            stepParams: [],
            evalInput: {
              userInput: '定时优化检查',
              conversationHistory: [],
              currentOutput: `平均质量评分: ${(avgScore * 100).toFixed(1)}`,
            },
            scorerMetadata: {
              duration: metrics.performance.averageResponseTime,
              retries: 0,
              errors: Math.floor(
                metrics.quality.failureRate * metrics.summary.totalInteractions
              ),
              context: '定时优化检查',
            },
          });
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

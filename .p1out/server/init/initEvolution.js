"use strict";
/**
 * initEvolution V2 — EvolutionEngineV2 自进化 + V1 进化权重同步
 * 闭合 Loop B: 工具可靠性数据 → 进化权重 → ToolReliabilityTracker
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initEvolution = initEvolution;
const EvolutionOrchestrator_1 = require("../../evolution/EvolutionOrchestrator");
const evolution_1 = require("../../evolution");
const Logger_1 = require("../../utils/Logger");
async function initEvolution(core, _memoryEngine) {
    const ENABLE_AUTO_OPTIMIZE = process.env.ENABLE_AUTO_OPTIMIZE !== 'false';
    if (!ENABLE_AUTO_OPTIMIZE) {
        Logger_1.Logger.info('⏸️ 自动进化已禁用 (ENABLE_AUTO_OPTIMIZE=false)', 'Bootstrap');
        return {};
    }
    // ── P2-3 收口（2026-08-03）──────────────────────────────────────
    // python 默认模式下，TS 自进化引擎（EvolutionEngineV2 会直接写文件）禁止启动，
    // 进化执行/数据由 Python 后端经 PythonAgentBridge 接管（/api/evolution/*）。
    // TS 引擎仅作为 AGENT_BACKEND=local 的废弃回退存根保留。
    const isPythonBackend = (process.env.AGENT_BACKEND ?? 'python') === 'python' &&
        !!core?.getPythonBridgeResolver?.();
    // 闭合 Loop B: 定期同步进化权重到 ToolReliabilityTracker。
    // 权重数据始终来自 Python 后端（/v1/evolution/metrics），两种模式下都运行。
    const syncEvolutionWeights = async () => {
        const harness = core?.getHarness();
        if (!harness)
            return;
        const toolRegistry = harness.getToolRegistry();
        if (!toolRegistry)
            return;
        const bridge = core?.getPythonBridgeResolver()?.();
        if (!bridge)
            return;
        try {
            const result = (await bridge.getEvolutionMetrics());
            const weights = result?.tool_weights ?? {};
            if (Object.keys(weights).length > 0) {
                toolRegistry.getReliabilityTracker().applyEvolutionWeights(weights);
                Logger_1.Logger.debug(`🧬 进化权重已同步: ${Object.keys(weights).length} 个工具`, 'initEvolution');
            }
        }
        catch (error) {
            Logger_1.Logger.warn(`进化权重同步失败: ${error.message}`, 'initEvolution');
        }
    };
    if (isPythonBackend) {
        Logger_1.Logger.warn('🧬 TS 进化引擎已弃用（Python 后端模式）：进化执行/数据改由 Python `agent.evolution` 负责，' +
            'TS 不再自写文件。仅保留进化权重同步任务。', 'initEvolution');
        const OPTIMIZATION_INTERVAL_MS = 5 * 60 * 1000;
        const weightSyncTimer = setInterval(() => {
            void syncEvolutionWeights();
        }, OPTIMIZATION_INTERVAL_MS);
        if (weightSyncTimer.unref)
            weightSyncTimer.unref();
        Logger_1.Logger.info('✅ 进化权重同步已启动（Python 后端模式，每5分钟）', 'Bootstrap');
        return {};
    }
    // ── AGENT_BACKEND=local 废弃回退路径：TS 独立进化引擎 ──
    Logger_1.Logger.warn('⚠️ 使用 TS 本地进化引擎（AGENT_BACKEND=local，已废弃，请迁移至 Python 后端）', 'initEvolution');
    const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
    const llmProvider = core?.getLLM();
    // V2: EvolutionEngineV2 — LLM驱动的自我进化（仅 local 模式，会写文件）
    let evolutionEngineV2 = null;
    if (llmProvider) {
        const llmClientAdapter = {
            chat: async (systemPrompt, userPrompt) => {
                try {
                    const response = await llmProvider.chat(userPrompt, [], systemPrompt);
                    return response || JSON.stringify({ text: response });
                }
                catch (error) {
                    Logger_1.Logger.error('LLM 调用失败', error, 'initEvolution');
                    return JSON.stringify({ error: 'LLM call failed' });
                }
            },
        };
        evolutionEngineV2 = new evolution_1.EvolutionEngineV2(llmClientAdapter);
        Logger_1.Logger.info('🧬 EvolutionEngineV2 已初始化（local 回退）', 'initEvolution');
    }
    orchestrator.registerEngines({
        evolutionEngineV2: evolutionEngineV2 || undefined,
        llmProvider: core?.getLLM(),
    });
    orchestrator.start();
    // 定时进化检查：每5分钟扫描一次，低质量时触发V2自进化
    const OPTIMIZATION_INTERVAL_MS = 5 * 60 * 1000;
    let consecutiveEmptyChecks = 0;
    const evolutionCheckTimer = setInterval(() => {
        const metrics = orchestrator.getUnifiedMetrics();
        const recentScores = metrics.quality.recentScores;
        const avgScore = recentScores.length > 0
            ? recentScores.reduce((a, b) => a + b, 0) /
                recentScores.length
            : 0;
        if (metrics.summary.totalInteractions === 0) {
            consecutiveEmptyChecks++;
            if (consecutiveEmptyChecks % 12 === 0) {
                // ~1 hour of no interactions
                Logger_1.Logger.debug('🔄 无用户交互，跳过进化检查', 'Bootstrap');
            }
            return;
        }
        consecutiveEmptyChecks = 0;
        // 闭合 Loop B: 每次检查时同步进化权重
        void syncEvolutionWeights();
        // 质量低于0.7时触发V2自进化
        if (avgScore < 0.7 && evolutionEngineV2) {
            Logger_1.Logger.info(`🧬 V2自进化触发 | 质量=${(avgScore * 100).toFixed(1)}% | 交互=${metrics.summary.totalInteractions}`, 'Bootstrap');
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
        }
        else {
            Logger_1.Logger.debug(`✅ 质量达标 (${(avgScore * 100).toFixed(1)}%)，跳过进化`, 'Bootstrap');
        }
    }, OPTIMIZATION_INTERVAL_MS);
    if (evolutionCheckTimer.unref)
        evolutionCheckTimer.unref();
    Logger_1.Logger.info('✅ V2进化循环已启动（每5分钟检查，阈值=0.7，local 回退）', 'Bootstrap');
    return {};
}

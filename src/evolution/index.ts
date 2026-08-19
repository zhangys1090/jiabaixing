/**
 * Evolution 模块 - 双层进化体系
 *
 * 【架构概述】
 * 家百星采用双层进化体系：
 *
 * 1. V1 - 反馈学习层（轻量、快速、低风险）
 *    - 从交互反馈中学习，优化参数和 Prompt
 *    - 不修改代码，只调整运行时参数
 *    - 实时生效，每次交互都能学习
 *    - 适合：工具权重调整、Prompt 示例积累、用户偏好学习
 *
 * 2. V2 - 自我进化层（重量、深度、高风险）
 *    - 真正的代码级自我修改
 *    - 有完整的规划→验证→执行→回滚流程
 *    - 风险较高，需要谨慎执行
 *    - 适合：代码修复、代码优化、Prompt 深度改进、工具增强、架构变更
 *
 * 【如何选择】
 * - 需要快速、小幅度优化 → 使用 V1
 * - 需要深度、大幅度改进 → 使用 V2
 * - 不确定时 → 优先使用 V1，V1 无法解决时再考虑 V2
 *
 * 【统一入口】
 * 建议通过 EvolutionOrchestrator 统一调用，它会协调 V1 和 V2，防止冲突。
 *
 * 【注意】
 * TypeScript 端的 V1 已标记 deprecated，将在 V6.0 移除。
 * 默认使用 Python 后端时，进化引擎在 Python 端运行。
 *
 * 【P2-3 收口（2026-08-03）】
 * 本模块（含 EvolutionOrchestrator / EvolutionEngineV2）已正式收口为
 * AGENT_BACKEND=local 的废弃回退存根。生产路径（AGENT_BACKEND=python，默认）下，
 * `src/server/init/initEvolution.ts` 不再启动 TS 自进化引擎（避免 TS 直接写文件），
 * 所有进化执行与数据由 Python `agent.evolution` 经 `PythonAgentBridge` 接管
 * （详见 `docs/P2-3_EVOLUTION_LLM_CLOSURE_DESIGN.md`）。请勿在新代码中依赖其运行时行为。
 */

// V2 真正自我进化引擎
export { EvolutionEngineV2 } from './v2/EvolutionEngineV2';
export { EvolutionRollback } from './v2/EvolutionRollback';
export { SelfModificationEngine } from './v2/SelfModificationEngine';
export { EvolutionPlanner } from './v2/EvolutionPlanner';
export * from './v2/types';

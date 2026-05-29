/**
 * Evolution 模块统一导出
 */

export { EvolutionEngine } from './EvolutionEngine';
export { FeedbackCollector, FeedbackRecord } from './FeedbackCollector';
export {
  OptimizationLog,
  PromptExample,
  SkillWeightAdjustment,
  StrategyOptimizer,
  ToneAdjustment,
} from './StrategyOptimizer';

// 新增 V2 真正自我进化引擎
export { EvolutionEngineV2 } from './v2/EvolutionEngineV2';
export { EvolutionRollback } from './v2/EvolutionRollback';
export { SelfModificationEngine } from './v2/SelfModificationEngine';
export { EvolutionPlanner } from './v2/EvolutionPlanner';
export * from './v2/types';

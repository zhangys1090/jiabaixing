/**
 * V1 EvolutionEngine — REMOVED. Stub for type compatibility only.
 * All methods are no-ops. EvolutionOrchestrator routes to V2 directly.
 */

import type { OptimizationLog } from './StrategyOptimizer';

export interface EvolutionMetrics {
  totalFeedback: number;
  totalOptimizations: number;
  successfulOptimizations: number;
  failedOptimizations: number;
  weeklyOptimizationStats?: { successRate: number };
}

export class EvolutionEngine {
  constructor(_memoryEngine?: unknown) {}

  start(): void {}
  stop(): void {}

  collectFeedback(
    _input: string,
    _response: string,
    _result: { success: boolean; intent?: string; toolsUsed?: string[]; error?: string },
    _scene?: string
  ): void {}

  assessQuality(
    _traceId: string,
    _success: boolean,
    _qualityScore: number,
    _duration: number,
    _scene?: string
  ): void {}

  getStrategyOptimizer(): {
    getPromptExamples(): Array<{
      trigger: string;
      correction: string;
      example: string;
      frequency: number;
    }>;
  } {
    return { getPromptExamples: () => [] };
  }

  triggerManualOptimization(_reason: string): OptimizationLog | null {
    return null;
  }

  getInsights(): Array<{ type: string; description: string; confidence: number }> {
    return [];
  }

  getMetrics(): EvolutionMetrics {
    return {
      totalFeedback: 0,
      totalOptimizations: 0,
      successfulOptimizations: 0,
      failedOptimizations: 0,
    };
  }
}

"use strict";
/**
 * V1 OptimizationFeedbackLoop — REMOVED. Stub for type compatibility.
 * V2 evolution uses EvolutionEngineV2 directly via EvolutionOrchestrator.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizationFeedbackLoop = void 0;
class OptimizationFeedbackLoop {
    constructor(_evaluationPipeline, _orchestrator, _config) { }
    async evaluateAndOptimize() {
        return { success: true, message: 'V1 removed — V2 handles evolution' };
    }
}
exports.OptimizationFeedbackLoop = OptimizationFeedbackLoop;

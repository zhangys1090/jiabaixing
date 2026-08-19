"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvolutionPriority = exports.EvolutionType = void 0;
// 进化类型枚举
var EvolutionType;
(function (EvolutionType) {
    EvolutionType["CODE_FIX"] = "CODE_FIX";
    EvolutionType["CODE_OPTIMIZATION"] = "CODE_OPTIMIZATION";
    EvolutionType["PROMPT_IMPROVEMENT"] = "PROMPT_IMPROVEMENT";
    EvolutionType["TOOL_ENHANCEMENT"] = "TOOL_ENHANCEMENT";
    EvolutionType["ARCHITECTURE_CHANGE"] = "ARCHITECTURE_CHANGE";
})(EvolutionType || (exports.EvolutionType = EvolutionType = {}));
// 进化优先级
var EvolutionPriority;
(function (EvolutionPriority) {
    EvolutionPriority["CRITICAL"] = "CRITICAL";
    EvolutionPriority["HIGH"] = "HIGH";
    EvolutionPriority["MEDIUM"] = "MEDIUM";
    EvolutionPriority["LOW"] = "LOW";
})(EvolutionPriority || (exports.EvolutionPriority = EvolutionPriority = {}));

"use strict";
/**
 * Harness Agent Framework - 入口索引
 *
 * 导出六层架构全部组件 + Phase 10 多Agent编排
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QualityScorer = exports.OptimizationFeedbackLoop = exports.GoldenEvalSet = exports.EvaluationPipeline = exports.EvalTrendAnalyzer = exports.EvalGate = exports.AssertionValidator = exports.TaskDispatcher = exports.SubAgentFanout = exports.ResultAggregator = exports.OrchestratorAgent = exports.AgentRegistry = exports.ToolCategory = exports.Permission = exports.PersistenceService = exports.ConstraintsService = exports.VerificationService = exports.StepEvaluator = exports.IndependentEvaluationService = exports.ToolReliabilityTracker = exports.ToolRegistry = exports.SchemaValidator = exports.PermissionGuard = exports.syncToLegacySkillRegistry = exports.registerHarnessTools = exports.AgentHarness = void 0;
var AgentHarness_1 = require("./AgentHarness");
Object.defineProperty(exports, "AgentHarness", { enumerable: true, get: function () { return AgentHarness_1.AgentHarness; } });
var registerHarnessTools_1 = require("./tools/registerHarnessTools");
Object.defineProperty(exports, "registerHarnessTools", { enumerable: true, get: function () { return registerHarnessTools_1.registerHarnessTools; } });
Object.defineProperty(exports, "syncToLegacySkillRegistry", { enumerable: true, get: function () { return registerHarnessTools_1.syncToLegacySkillRegistry; } });
var PermissionGuard_1 = require("./tools/registry/PermissionGuard");
Object.defineProperty(exports, "PermissionGuard", { enumerable: true, get: function () { return PermissionGuard_1.PermissionGuard; } });
var SchemaValidator_1 = require("./tools/registry/SchemaValidator");
Object.defineProperty(exports, "SchemaValidator", { enumerable: true, get: function () { return SchemaValidator_1.SchemaValidator; } });
var ToolRegistry_1 = require("./tools/registry/ToolRegistry");
Object.defineProperty(exports, "ToolRegistry", { enumerable: true, get: function () { return ToolRegistry_1.ToolRegistry; } });
Object.defineProperty(exports, "ToolReliabilityTracker", { enumerable: true, get: function () { return ToolRegistry_1.ToolReliabilityTracker; } });
// 循环层 — 已迁移到 Python 后端（agent/loop/），TS 端循环层组件已删除
var IndependentEvaluationService_1 = require("./evaluation/IndependentEvaluationService");
Object.defineProperty(exports, "IndependentEvaluationService", { enumerable: true, get: function () { return IndependentEvaluationService_1.IndependentEvaluationService; } });
var StepEvaluator_1 = require("./evaluation/StepEvaluator");
Object.defineProperty(exports, "StepEvaluator", { enumerable: true, get: function () { return StepEvaluator_1.StepEvaluator; } });
// 上下文层 — ContextManager/TokenBudgetAllocator 已废弃（V6.0 移除）
// 替代方案：Python 端 HarnessContext（agent/harness/context.py）
// 仍保留内部使用，不再公开导出
// 验证层
var VerificationService_1 = require("./verification/VerificationService");
Object.defineProperty(exports, "VerificationService", { enumerable: true, get: function () { return VerificationService_1.VerificationService; } });
// 约束层
var ConstraintsService_1 = require("./constraints/ConstraintsService");
Object.defineProperty(exports, "ConstraintsService", { enumerable: true, get: function () { return ConstraintsService_1.ConstraintsService; } });
// 持久化层
var PersistenceService_1 = require("./persistence/PersistenceService");
Object.defineProperty(exports, "PersistenceService", { enumerable: true, get: function () { return PersistenceService_1.PersistenceService; } });
var types_1 = require("./types");
Object.defineProperty(exports, "Permission", { enumerable: true, get: function () { return types_1.Permission; } });
Object.defineProperty(exports, "ToolCategory", { enumerable: true, get: function () { return types_1.ToolCategory; } });
// ============ Phase 10: 多Agent编排 ============
var AgentRegistry_1 = require("./orchestration/AgentRegistry");
Object.defineProperty(exports, "AgentRegistry", { enumerable: true, get: function () { return AgentRegistry_1.AgentRegistry; } });
var OrchestratorAgent_1 = require("./orchestration/OrchestratorAgent");
Object.defineProperty(exports, "OrchestratorAgent", { enumerable: true, get: function () { return OrchestratorAgent_1.OrchestratorAgent; } });
var ResultAggregator_1 = require("./orchestration/ResultAggregator");
Object.defineProperty(exports, "ResultAggregator", { enumerable: true, get: function () { return ResultAggregator_1.ResultAggregator; } });
var SubAgentFanout_1 = require("./orchestration/SubAgentFanout");
Object.defineProperty(exports, "SubAgentFanout", { enumerable: true, get: function () { return SubAgentFanout_1.SubAgentFanout; } });
var TaskDispatcher_1 = require("./orchestration/TaskDispatcher");
Object.defineProperty(exports, "TaskDispatcher", { enumerable: true, get: function () { return TaskDispatcher_1.TaskDispatcher; } });
// ============ Phase 11: 自评估与持续优化管道 ============
var AssertionValidator_1 = require("./evaluation/AssertionValidator");
Object.defineProperty(exports, "AssertionValidator", { enumerable: true, get: function () { return AssertionValidator_1.AssertionValidator; } });
var EvalGate_1 = require("./evaluation/EvalGate");
Object.defineProperty(exports, "EvalGate", { enumerable: true, get: function () { return EvalGate_1.EvalGate; } });
var EvalTrendAnalyzer_1 = require("./evaluation/EvalTrendAnalyzer");
Object.defineProperty(exports, "EvalTrendAnalyzer", { enumerable: true, get: function () { return EvalTrendAnalyzer_1.EvalTrendAnalyzer; } });
var EvaluationPipeline_1 = require("./evaluation/EvaluationPipeline");
Object.defineProperty(exports, "EvaluationPipeline", { enumerable: true, get: function () { return EvaluationPipeline_1.EvaluationPipeline; } });
var GoldenEvalSet_1 = require("./evaluation/GoldenEvalSet");
Object.defineProperty(exports, "GoldenEvalSet", { enumerable: true, get: function () { return GoldenEvalSet_1.GoldenEvalSet; } });
var OptimizationFeedbackLoop_1 = require("./evaluation/OptimizationFeedbackLoop");
Object.defineProperty(exports, "OptimizationFeedbackLoop", { enumerable: true, get: function () { return OptimizationFeedbackLoop_1.OptimizationFeedbackLoop; } });
var QualityScorer_1 = require("./evaluation/QualityScorer");
Object.defineProperty(exports, "QualityScorer", { enumerable: true, get: function () { return QualityScorer_1.QualityScorer; } });

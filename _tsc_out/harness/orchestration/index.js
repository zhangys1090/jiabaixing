"use strict";
/**
 * Harness Phase 10: 多Agent编排 — 入口索引
 *
 * 导出所有编排层组件
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskDispatcher = exports.ResultAggregator = exports.OrchestratorAgent = exports.AgentRegistry = exports.A2AProtocolManager = void 0;
var AgentRegistry_1 = require("./AgentRegistry");
Object.defineProperty(exports, "A2AProtocolManager", { enumerable: true, get: function () { return AgentRegistry_1.A2AProtocolManager; } });
Object.defineProperty(exports, "AgentRegistry", { enumerable: true, get: function () { return AgentRegistry_1.AgentRegistry; } });
var OrchestratorAgent_1 = require("./OrchestratorAgent");
Object.defineProperty(exports, "OrchestratorAgent", { enumerable: true, get: function () { return OrchestratorAgent_1.OrchestratorAgent; } });
var ResultAggregator_1 = require("./ResultAggregator");
Object.defineProperty(exports, "ResultAggregator", { enumerable: true, get: function () { return ResultAggregator_1.ResultAggregator; } });
var TaskDispatcher_1 = require("./TaskDispatcher");
Object.defineProperty(exports, "TaskDispatcher", { enumerable: true, get: function () { return TaskDispatcher_1.TaskDispatcher; } });

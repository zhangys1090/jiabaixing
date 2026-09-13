"use strict";
/**
 * Desktop Automation Module - 桌面自动化模块
 * Codex风格 Computer Use 执行Agent
 *
 * 核心架构：
 * - 归一化坐标系统 (NormalizedCoordinates)
 * - MCP 工具服务器 (DesktopMCPServer)
 * - 事件流系统 (DesktopEventStream)
 * - 安全防护系统 (DesktopSafetyGuard)
 * - 技能包系统 (DesktopSkillRegistry)
 * - 执行Agent主循环 (DesktopExecutionAgent)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.executionAgent = exports.DesktopExecutionAgent = exports.skillRegistry = exports.DesktopSkillRegistry = exports.safetyGuard = exports.DesktopSafetyGuard = exports.eventStream = exports.DesktopEventStream = exports.DesktopMCPServer = exports.toPixel = exports.toNormalized = exports.NormalizedCoordinateSystem = exports.NORMALIZED_MAX = exports.coords = exports.WindowManager = exports.SystemInput = exports.StateSnapshotManager = exports.SnapshotTriggerType = exports.SnapshotStatus = exports.ScreenCapture = exports.ElementMatcher = exports.DesktopVisionEngine = exports.UIAControlType = exports.DesktopUIInspector = exports.DesktopDecisionEngine = exports.DesktopAgentLoop = exports.DesktopActionExecutor = exports.DesktopActionAuthority = void 0;
// 基础模块
var DesktopActionAuthority_1 = require("./DesktopActionAuthority");
Object.defineProperty(exports, "DesktopActionAuthority", { enumerable: true, get: function () { return DesktopActionAuthority_1.DesktopActionAuthority; } });
var DesktopActionExecutor_1 = require("./DesktopActionExecutor");
Object.defineProperty(exports, "DesktopActionExecutor", { enumerable: true, get: function () { return DesktopActionExecutor_1.DesktopActionExecutor; } });
var DesktopAgentLoop_1 = require("./DesktopAgentLoop");
Object.defineProperty(exports, "DesktopAgentLoop", { enumerable: true, get: function () { return DesktopAgentLoop_1.DesktopAgentLoop; } });
var DesktopDecisionEngine_1 = require("./DesktopDecisionEngine");
Object.defineProperty(exports, "DesktopDecisionEngine", { enumerable: true, get: function () { return DesktopDecisionEngine_1.DesktopDecisionEngine; } });
var DesktopUIInspector_1 = require("./DesktopUIInspector");
Object.defineProperty(exports, "DesktopUIInspector", { enumerable: true, get: function () { return DesktopUIInspector_1.DesktopUIInspector; } });
Object.defineProperty(exports, "UIAControlType", { enumerable: true, get: function () { return DesktopUIInspector_1.UIAControlType; } });
var DesktopVisionEngine_1 = require("./DesktopVisionEngine");
Object.defineProperty(exports, "DesktopVisionEngine", { enumerable: true, get: function () { return DesktopVisionEngine_1.DesktopVisionEngine; } });
var ElementMatcher_1 = require("./ElementMatcher");
Object.defineProperty(exports, "ElementMatcher", { enumerable: true, get: function () { return ElementMatcher_1.ElementMatcher; } });
var ScreenCapture_1 = require("./ScreenCapture");
Object.defineProperty(exports, "ScreenCapture", { enumerable: true, get: function () { return ScreenCapture_1.ScreenCapture; } });
var StateSnapshotManager_1 = require("./StateSnapshotManager");
Object.defineProperty(exports, "SnapshotStatus", { enumerable: true, get: function () { return StateSnapshotManager_1.SnapshotStatus; } });
Object.defineProperty(exports, "SnapshotTriggerType", { enumerable: true, get: function () { return StateSnapshotManager_1.SnapshotTriggerType; } });
Object.defineProperty(exports, "StateSnapshotManager", { enumerable: true, get: function () { return StateSnapshotManager_1.StateSnapshotManager; } });
var SystemInput_1 = require("./SystemInput");
Object.defineProperty(exports, "SystemInput", { enumerable: true, get: function () { return SystemInput_1.SystemInput; } });
var WindowManager_1 = require("./WindowManager");
Object.defineProperty(exports, "WindowManager", { enumerable: true, get: function () { return WindowManager_1.WindowManager; } });
// ========== Codex风格 Computer Use 新增模块 ==========
/**
 * 归一化坐标系统
 * 参考 UI-TARS 设计，所有坐标统一使用 [0,1000] × [0,1000] 归一化值
 * 内部自动转换为实际像素坐标
 */
var NormalizedCoordinates_1 = require("./NormalizedCoordinates");
Object.defineProperty(exports, "coords", { enumerable: true, get: function () { return NormalizedCoordinates_1.coords; } });
Object.defineProperty(exports, "NORMALIZED_MAX", { enumerable: true, get: function () { return NormalizedCoordinates_1.NORMALIZED_MAX; } });
Object.defineProperty(exports, "NormalizedCoordinateSystem", { enumerable: true, get: function () { return NormalizedCoordinates_1.NormalizedCoordinateSystem; } });
Object.defineProperty(exports, "toNormalized", { enumerable: true, get: function () { return NormalizedCoordinates_1.toNormalized; } });
Object.defineProperty(exports, "toPixel", { enumerable: true, get: function () { return NormalizedCoordinates_1.toPixel; } });
/**
 * 桌面 MCP 服务器
 * 将桌面操作能力封装为标准 MCP (Model Context Protocol) 工具
 * 支持 15+ 标准桌面操作工具
 */
var DesktopMCPServer_1 = require("./DesktopMCPServer");
Object.defineProperty(exports, "DesktopMCPServer", { enumerable: true, get: function () { return DesktopMCPServer_1.DesktopMCPServer; } });
/**
 * 桌面事件流系统
 * 实时推送Agent状态、操作、观察结果，支持前端可视化
 * 参考 UI-TARS Event Stream 设计
 */
var DesktopEventStream_1 = require("./DesktopEventStream");
Object.defineProperty(exports, "DesktopEventStream", { enumerable: true, get: function () { return DesktopEventStream_1.DesktopEventStream; } });
Object.defineProperty(exports, "eventStream", { enumerable: true, get: function () { return DesktopEventStream_1.eventStream; } });
/**
 * 桌面安全防护系统
 * 四层安全防护：事前拦截、事中监控、紧急停止、事后回滚
 * 参考 Codex Computer Use 安全设计
 */
var DesktopSafetyGuard_1 = require("./DesktopSafetyGuard");
Object.defineProperty(exports, "DesktopSafetyGuard", { enumerable: true, get: function () { return DesktopSafetyGuard_1.DesktopSafetyGuard; } });
Object.defineProperty(exports, "safetyGuard", { enumerable: true, get: function () { return DesktopSafetyGuard_1.safetyGuard; } });
/**
 * 桌面技能包系统
 * 预定义复杂任务模板，包含匹配规则、操作步骤、验证点、错误恢复
 */
var DesktopSkillRegistry_1 = require("./DesktopSkillRegistry");
Object.defineProperty(exports, "DesktopSkillRegistry", { enumerable: true, get: function () { return DesktopSkillRegistry_1.DesktopSkillRegistry; } });
Object.defineProperty(exports, "skillRegistry", { enumerable: true, get: function () { return DesktopSkillRegistry_1.skillRegistry; } });
/**
 * 桌面执行Agent (主入口)
 * 整合所有模块，提供统一的任务执行接口
 * 支持：技能匹配、LLM规划、安全检查、事件推送
 */
var DesktopExecutionAgent_1 = require("./DesktopExecutionAgent");
Object.defineProperty(exports, "DesktopExecutionAgent", { enumerable: true, get: function () { return DesktopExecutionAgent_1.DesktopExecutionAgent; } });
Object.defineProperty(exports, "executionAgent", { enumerable: true, get: function () { return DesktopExecutionAgent_1.executionAgent; } });

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

// 基础模块
export {
    AuthorizationDecision,
    AuthorizedExecutionResult, DesktopActionAuthority
} from './DesktopActionAuthority';
export {
    DesktopAction, DesktopActionExecutor, DesktopActionResult,
    DesktopTaskResult
} from './DesktopActionExecutor';
export {
    DesktopAgentConfig, DesktopAgentLoop, DesktopAgentResult
} from './DesktopAgentLoop';
export {
    DecisionAction,
    DecisionExperience,
    DecisionPolicy, DecisionState, DesktopDecisionEngine
} from './DesktopDecisionEngine';
export {
    DesktopUIInspector, ElementQueryResult, UIAControlType, UIElement,
    UIElementNode, UIInspectorConfig
} from './DesktopUIInspector';
export {
    DesktopObservation,
    DesktopVisionConfig, DesktopVisionEngine
} from './DesktopVisionEngine';
export {
    ElementMatcher, MatcherConfig, MatchResult, VisualElement
} from './ElementMatcher';
export {
    ScreenCapture,
    ScreenshotOptions,
    ScreenshotResult
} from './ScreenCapture';
export {
    CustomStateProvider, DesktopStateSnapshot, SnapshotListOptions, SnapshotMetadata, SnapshotRestoreResult, SnapshotStatus, SnapshotTriggerType, StateDiffResult, StateSnapshotManager, StateSnapshotManagerConfig
} from './StateSnapshotManager';
export { InputResult, MousePosition, SystemInput } from './SystemInput';
export { WindowActionResult, WindowInfo, WindowManager } from './WindowManager';

// ========== Codex风格 Computer Use 新增模块 ==========

/**
 * 归一化坐标系统
 * 参考 UI-TARS 设计，所有坐标统一使用 [0,1000] × [0,1000] 归一化值
 * 内部自动转换为实际像素坐标
 */
export {
    coords, NORMALIZED_MAX, NormalizedCoordinateSystem,
    NormalizedPoint, NormalizedRect, PixelPoint, PixelRect, toNormalized, toPixel
} from './NormalizedCoordinates';

/**
 * 桌面 MCP 服务器
 * 将桌面操作能力封装为标准 MCP (Model Context Protocol) 工具
 * 支持 15+ 标准桌面操作工具
 */
export { DesktopMCPServer, MCPTool, MCPToolResult } from './DesktopMCPServer';

/**
 * 桌面事件流系统
 * 实时推送Agent状态、操作、观察结果，支持前端可视化
 * 参考 UI-TARS Event Stream 设计
 */
export {
    DesktopEvent, DesktopEventStream,
    DesktopEventType, eventStream, EventStreamOptions
} from './DesktopEventStream';

/**
 * 桌面安全防护系统
 * 四层安全防护：事前拦截、事中监控、紧急停止、事后回滚
 * 参考 Codex Computer Use 安全设计
 */
export {
    DangerousAction, DesktopSafetyGuard, SafetyConfig, safetyGuard, SafetyLevel
} from './DesktopSafetyGuard';

/**
 * 桌面技能包系统
 * 预定义复杂任务模板，包含匹配规则、操作步骤、验证点、错误恢复
 */
export {
    DesktopSkill, DesktopSkillRegistry, SkillExecutionResult,
    skillRegistry, SkillStep
} from './DesktopSkillRegistry';

/**
 * 桌面执行Agent (主入口)
 * 整合所有模块，提供统一的任务执行接口
 * 支持：技能匹配、LLM规划、安全检查、事件推送
 */
export {
    DesktopExecutionAgent, executionAgent, ExecutionAgentConfig,
    ExecutionResult
} from './DesktopExecutionAgent';

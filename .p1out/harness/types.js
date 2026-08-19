"use strict";
/**
 * Harness Agent Framework - 核心类型定义
 *
 * 基于 Harness Agent Framework 六层架构:
 * Layer 1: Loop（循环层）
 * Layer 2: Tools（工具层）
 * Layer 3: Context（上下文层）
 * Layer 4: Persistence（持久化层）
 * Layer 5: Verification（验证层）
 * Layer 6: Constraints（约束层）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LifecycleEvent = exports.Permission = exports.ToolCategory = exports.LoopState = exports.STEP_STATE_TRANSITIONS = exports.StepState = exports.UnifiedTaskPriority = exports.UnifiedTaskStatus = void 0;
exports.planStepToUnifiedTaskNode = planStepToUnifiedTaskNode;
exports.dagTaskNodeToUnifiedTaskNode = dagTaskNodeToUnifiedTaskNode;
exports.dispatcherTaskNodeToUnifiedTaskNode = dispatcherTaskNodeToUnifiedTaskNode;
exports.unifiedTaskNodeToPlanStep = unifiedTaskNodeToPlanStep;
exports.unifiedTaskNodeToDagTaskNode = unifiedTaskNodeToDagTaskNode;
// ============ Layer 1: Loop（循环层）============
/** 任务状态枚举 - 统一版本 */
var UnifiedTaskStatus;
(function (UnifiedTaskStatus) {
    UnifiedTaskStatus["PENDING"] = "pending";
    UnifiedTaskStatus["RUNNING"] = "running";
    UnifiedTaskStatus["SUCCESS"] = "success";
    UnifiedTaskStatus["FAILED"] = "failed";
    UnifiedTaskStatus["SKIPPED"] = "skipped";
    UnifiedTaskStatus["RETRYING"] = "retrying";
    UnifiedTaskStatus["CANCELLED"] = "cancelled";
})(UnifiedTaskStatus || (exports.UnifiedTaskStatus = UnifiedTaskStatus = {}));
/** 任务优先级枚举 - 统一版本 */
var UnifiedTaskPriority;
(function (UnifiedTaskPriority) {
    UnifiedTaskPriority[UnifiedTaskPriority["LOW"] = 1] = "LOW";
    UnifiedTaskPriority[UnifiedTaskPriority["MEDIUM"] = 5] = "MEDIUM";
    UnifiedTaskPriority[UnifiedTaskPriority["HIGH"] = 8] = "HIGH";
    UnifiedTaskPriority[UnifiedTaskPriority["CRITICAL"] = 10] = "CRITICAL";
})(UnifiedTaskPriority || (exports.UnifiedTaskPriority = UnifiedTaskPriority = {}));
/** E3-3: 步骤级状态机枚举 — 9 个状态 */
var StepState;
(function (StepState) {
    StepState["PENDING"] = "pending";
    StepState["READY"] = "ready";
    StepState["RUNNING"] = "running";
    StepState["WAITING_APPROVAL"] = "waiting_approval";
    StepState["COMPLETED"] = "completed";
    StepState["FAILED"] = "failed";
    StepState["RETRYING"] = "retrying";
    StepState["BLOCKED"] = "blocked";
    StepState["SKIPPED"] = "skipped";
})(StepState || (exports.StepState = StepState = {}));
/** E3-3: 步骤状态合法转换表 */
exports.STEP_STATE_TRANSITIONS = {
    [StepState.PENDING]: [StepState.READY, StepState.BLOCKED, StepState.SKIPPED],
    [StepState.READY]: [
        StepState.RUNNING,
        StepState.WAITING_APPROVAL,
        StepState.SKIPPED,
    ],
    [StepState.RUNNING]: [
        StepState.COMPLETED,
        StepState.FAILED,
        StepState.RETRYING,
        StepState.WAITING_APPROVAL,
    ],
    [StepState.WAITING_APPROVAL]: [StepState.RUNNING, StepState.SKIPPED],
    [StepState.COMPLETED]: [StepState.PENDING],
    [StepState.FAILED]: [StepState.RETRYING, StepState.SKIPPED],
    [StepState.RETRYING]: [
        StepState.RUNNING,
        StepState.FAILED,
        StepState.COMPLETED,
    ],
    [StepState.BLOCKED]: [StepState.READY, StepState.SKIPPED],
    [StepState.SKIPPED]: [StepState.PENDING],
};
/** 循环状态 */
var LoopState;
(function (LoopState) {
    LoopState["PLANNING"] = "planning";
    LoopState["DEBATING"] = "debating";
    LoopState["EXECUTING"] = "executing";
    LoopState["EVALUATING"] = "evaluating";
    LoopState["REPORTING"] = "reporting";
    LoopState["COMPLETED"] = "completed";
    LoopState["FAILED"] = "failed";
    LoopState["ABORTED"] = "aborted";
    LoopState["BUDGET_EXCEEDED"] = "budget_exceeded";
})(LoopState || (exports.LoopState = LoopState = {}));
// ============ Layer 2: Tools（工具层）============
/** 工具分类 */
var ToolCategory;
(function (ToolCategory) {
    ToolCategory["MEMORY"] = "memory";
    ToolCategory["FILE"] = "file";
    ToolCategory["CODE"] = "code";
    ToolCategory["DESKTOP"] = "desktop";
    ToolCategory["COGNITION"] = "cognition";
    ToolCategory["SYSTEM"] = "system";
    ToolCategory["DAILY"] = "daily";
    ToolCategory["NETWORK"] = "network";
    ToolCategory["PERCEPTION"] = "perception";
})(ToolCategory || (exports.ToolCategory = ToolCategory = {}));
/** 权限枚举 */
var Permission;
(function (Permission) {
    Permission["MEMORY_READ"] = "memory:read";
    Permission["MEMORY_WRITE"] = "memory:write";
    Permission["FILE_READ"] = "file:read";
    Permission["FILE_WRITE"] = "file:write";
    Permission["DESKTOP_CONTROL"] = "desktop:control";
    Permission["NETWORK_ACCESS"] = "network:access";
    Permission["CODE_EXECUTE"] = "code:execute";
    Permission["SYSTEM_ADMIN"] = "system:admin";
})(Permission || (exports.Permission = Permission = {}));
// ============ Layer 6: Constraints（约束层）============
/** 生命周期事件 */
var LifecycleEvent;
(function (LifecycleEvent) {
    LifecycleEvent["BEFORE_LOOP"] = "before_loop";
    LifecycleEvent["BEFORE_TOOL_CALL"] = "before_tool_call";
    LifecycleEvent["AFTER_TOOL_CALL"] = "after_tool_call";
    LifecycleEvent["BEFORE_RESPONSE"] = "before_response";
    LifecycleEvent["AFTER_RESPONSE"] = "after_response";
    LifecycleEvent["ON_ERROR"] = "on_error";
    LifecycleEvent["ON_BUDGET_EXCEEDED"] = "on_budget_exceeded";
    LifecycleEvent["ON_PLAN_CREATED"] = "on_plan_created";
    LifecycleEvent["ON_STEP_COMPLETED"] = "on_step_completed";
})(LifecycleEvent || (exports.LifecycleEvent = LifecycleEvent = {}));
// ============ 任务模型转换辅助函数 ============
/**
 * 将PlanStep转换为UnifiedTaskNode
 */
function planStepToUnifiedTaskNode(step) {
    return {
        id: step.id,
        description: step.description,
        goal: step.description,
        toolName: step.toolName,
        toolParams: step.toolParams,
        expectedOutput: step.expectedOutput,
        status: UnifiedTaskStatus.PENDING,
        dependencies: [],
        priority: UnifiedTaskPriority.MEDIUM,
        maxRetries: step.maxRetries,
        currentRetry: step.retryCount,
        timeout: 300,
        retryDelay: 1,
        metadata: {},
        isEssential: true,
    };
}
/**
 * 将DAGTask中的TaskNode转换为UnifiedTaskNode
 */
function dagTaskNodeToUnifiedTaskNode(node) {
    const statusMap = {
        pending: UnifiedTaskStatus.PENDING,
        running: UnifiedTaskStatus.RUNNING,
        success: UnifiedTaskStatus.SUCCESS,
        failed: UnifiedTaskStatus.FAILED,
        skipped: UnifiedTaskStatus.SKIPPED,
        retrying: UnifiedTaskStatus.RETRYING,
    };
    const priorityMap = {
        low: UnifiedTaskPriority.LOW,
        medium: UnifiedTaskPriority.MEDIUM,
        high: UnifiedTaskPriority.HIGH,
        critical: UnifiedTaskPriority.CRITICAL,
    };
    return {
        id: node.id,
        description: node.description,
        goal: node.description,
        toolName: node.toolName,
        toolParams: node.params,
        status: statusMap[node.status] || UnifiedTaskStatus.PENDING,
        dependencies: node.dependencies,
        result: node.result,
        error: node.error?.message,
        startTime: node.startTime?.getTime(),
        endTime: node.endTime?.getTime(),
        estimatedTime: node.estimatedTime,
        priority: priorityMap[node.priority] || UnifiedTaskPriority.MEDIUM,
        maxRetries: node.maxRetries,
        currentRetry: node.currentRetry,
        timeout: node.timeout,
        retryDelay: node.retryDelay,
        metadata: node.metadata,
        isEssential: node.isEssential,
    };
}
/**
 * 将TaskDispatcher的TaskNode转换为UnifiedTaskNode
 */
function dispatcherTaskNodeToUnifiedTaskNode(node) {
    const statusMap = {
        pending: UnifiedTaskStatus.PENDING,
        running: UnifiedTaskStatus.RUNNING,
        completed: UnifiedTaskStatus.SUCCESS,
        failed: UnifiedTaskStatus.FAILED,
        cancelled: UnifiedTaskStatus.CANCELLED,
    };
    return {
        id: node.id,
        description: node.goal,
        goal: node.goal,
        agentId: node.agentId,
        assignedTo: node.assignedTo,
        tools: node.tools,
        status: statusMap[node.status] || UnifiedTaskStatus.PENDING,
        dependencies: node.dependencies,
        result: node.result,
        error: node.error,
        priority: node.priority,
        maxRetries: 2,
        currentRetry: 0,
        timeout: 300,
        retryDelay: 1,
        metadata: {},
        isEssential: true,
        context: node.context,
    };
}
/**
 * 将UnifiedTaskNode转换为PlanStep（向后兼容）
 */
function unifiedTaskNodeToPlanStep(node) {
    return {
        id: node.id,
        description: node.description,
        toolName: node.toolName,
        toolParams: node.toolParams,
        expectedOutput: node.expectedOutput,
        retryCount: node.currentRetry,
        maxRetries: node.maxRetries,
        toUnifiedTaskNode: () => node,
    };
}
/**
 * 将UnifiedTaskNode转换为DAGTask的TaskNode
 */
function unifiedTaskNodeToDagTaskNode(node) {
    const { TaskStatus, TaskPriority, TaskNode } = require('../core/DAGTask');
    const statusMap = {
        [UnifiedTaskStatus.PENDING]: TaskStatus.PENDING,
        [UnifiedTaskStatus.RUNNING]: TaskStatus.RUNNING,
        [UnifiedTaskStatus.SUCCESS]: TaskStatus.SUCCESS,
        [UnifiedTaskStatus.FAILED]: TaskStatus.FAILED,
        [UnifiedTaskStatus.SKIPPED]: TaskStatus.SKIPPED,
        [UnifiedTaskStatus.RETRYING]: TaskStatus.RETRYING,
        [UnifiedTaskStatus.CANCELLED]: TaskStatus.FAILED,
    };
    const priorityMap = {
        [UnifiedTaskPriority.LOW]: TaskPriority.LOW,
        [UnifiedTaskPriority.MEDIUM]: TaskPriority.MEDIUM,
        [UnifiedTaskPriority.HIGH]: TaskPriority.HIGH,
        [UnifiedTaskPriority.CRITICAL]: TaskPriority.CRITICAL,
    };
    const dagNode = new TaskNode(node.id, node.description, node.toolName || '', node.toolParams || {}, statusMap[node.status], node.dependencies, priorityMap[node.priority]);
    dagNode.estimatedTime = node.estimatedTime || 0;
    dagNode.maxRetries = node.maxRetries;
    dagNode.currentRetry = node.currentRetry;
    dagNode.timeout = node.timeout;
    dagNode.retryDelay = node.retryDelay;
    dagNode.metadata = node.metadata;
    dagNode.isEssential = node.isEssential;
    if (node.startTime) {
        dagNode.startTime = new Date(node.startTime);
    }
    if (node.endTime) {
        dagNode.endTime = new Date(node.endTime);
    }
    if (node.result) {
        dagNode.result = node.result;
    }
    if (node.error) {
        dagNode.error = new Error(node.error);
    }
    return dagNode;
}

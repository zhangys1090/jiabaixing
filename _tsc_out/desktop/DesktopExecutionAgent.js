"use strict";
/**
 * 增强版桌面执行Agent (Codex风格)
 *
 * 整合：
 * - 归一化坐标系统
 * - MCP 工具调用
 * - 事件流实时推送
 * - 安全防护系统
 * - 技能包系统
 *
 * 工作流程：
 * 用户指令 → 技能匹配/LLM规划 → 安全检查 → 执行动作 → 观察验证 → 循环直到完成
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.executionAgent = exports.DesktopExecutionAgent = void 0;
const events_1 = require("events");
const DesktopEventStream_1 = require("./DesktopEventStream");
const DesktopMCPServer_1 = require("./DesktopMCPServer");
const DesktopSafetyGuard_1 = require("./DesktopSafetyGuard");
const DesktopSkillRegistry_1 = require("./DesktopSkillRegistry");
const DesktopActionAuthority_1 = require("./DesktopActionAuthority");
const DesktopVisionEngine_1 = require("./DesktopVisionEngine");
const NormalizedCoordinates_1 = require("./NormalizedCoordinates");
// F3: 桌面执行规划不再独立持有 TS LLMProvider（违反 AGENTS.md §0.1），
// 改为路由到 Python 后端的 LLM（经 PythonAgentBridge）。
const bootstrap_1 = require("../server/bootstrap");
const Logger_1 = require("../utils/Logger");
const DecisionAuthority_1 = require("../authority/DecisionAuthority");
const GoalAuthority_1 = require("../authority/GoalAuthority");
const StateAuthority_1 = require("../authority/StateAuthority");
const SkillProposer_1 = require("../authority/SkillProposer");
const DesktopLLMProposer_1 = require("../authority/DesktopLLMProposer");
const AuthoritySignature_1 = require("../authority/AuthoritySignature");
const GoalContextResolver_1 = require("../core/GoalContextResolver");
const DEFAULT_CONFIG = {
    safetyLevel: 'moderate',
    enableSkills: true,
    enableLLMPlanning: true,
    maxSteps: 50,
    autoVerify: true,
};
class DesktopExecutionAgent extends events_1.EventEmitter {
    static instance = null;
    config;
    // 核心模块
    mcpServer;
    eventStream;
    safetyGuard;
    authority;
    skillRegistry;
    coords;
    visionEngine;
    // 状态
    initialized = false;
    isRunning = false;
    currentTaskId = '';
    _projectContext;
    constructor(config) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.mcpServer = DesktopMCPServer_1.DesktopMCPServer.getInstance();
        this.eventStream = DesktopEventStream_1.DesktopEventStream.getInstance();
        this.safetyGuard = DesktopSafetyGuard_1.DesktopSafetyGuard.getInstance();
        this.authority = DesktopActionAuthority_1.DesktopActionAuthority.getInstance();
        this.skillRegistry = DesktopSkillRegistry_1.DesktopSkillRegistry.getInstance();
        this.coords = NormalizedCoordinates_1.NormalizedCoordinateSystem.getInstance();
        this.visionEngine = DesktopVisionEngine_1.DesktopVisionEngine.getInstance();
    }
    static getInstance(config) {
        if (!DesktopExecutionAgent.instance) {
            DesktopExecutionAgent.instance = new DesktopExecutionAgent(config);
        }
        return DesktopExecutionAgent.instance;
    }
    /**
     * 初始化执行Agent
     */
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🚀 桌面执行Agent初始化 (Codex风格)', 'ExecAgent');
        // 初始化所有子模块
        await this.mcpServer.initialize();
        await this.safetyGuard.initialize();
        await this.authority.initialize();
        await this.visionEngine.initialize();
        this.coords.refreshScreenInfo();
        // F3: 不再初始化本地 LLMProvider；决策经 Python LLM（Bridge）。
        if (this.config.enableLLMPlanning && this._bridgeLlmAvailable()) {
            Logger_1.Logger.info('🧠 桌面执行规划将路由到 Python LLM（经 Bridge）', 'ExecAgent');
        }
        // 设置安全回调
        this.safetyGuard.onEmergencyStop(() => {
            this.handleEmergencyStop();
        });
        this.initialized = true;
        Logger_1.Logger.info('✅ 桌面执行Agent初始化完成', 'ExecAgent');
        this.emit('initialized');
    }
    /**
     * 执行任务（主入口）
     */
    async executeTask(taskDescription, authorityMeta) {
        this.ensureInitialized();
        if (this.isRunning) {
            return {
                success: false,
                taskDescription,
                stepsCompleted: 0,
                totalSteps: 0,
                durationMs: 0,
                observations: [],
                report: 'Agent正忙，请等待当前任务完成',
                error: 'AGENT_BUSY',
            };
        }
        this.isRunning = true;
        const startTime = Date.now();
        const observations = [];
        // 开始任务
        this.currentTaskId = this.eventStream.startTask(taskDescription);
        this.safetyGuard.startTask();
        Logger_1.Logger.info(`🎯 开始执行任务: ${taskDescription}`, 'ExecAgent');
        try {
            let result;
            // D4-I1-R2: 当收到 Python DecisionAuthority 的 authority_decisionId 时，
            // TS 不重新决策，直接执行 Python 指定的动作。
            // 这证明 TS 是 executor/transport，不是独立的 FINAL Decision Authority。
            //
            // D4-I2 Post-Audit: delegation metadata 完整性 + HMAC 签名校验——
            // 必须同时包含 goalId + snapshotId + decisionId 且签名有效
            // （签名绑定 task 内容，防"合法 decisionId + 任意 action"换货）。
            // 签名无效时 fail-safe：降级为 TS 本地 DecisionAuthority 决策链。
            if (authorityMeta &&
                authorityMeta['authority_decisionId'] &&
                authorityMeta['authority_goalId'] &&
                authorityMeta['authority_snapshotId']) {
                if (!(0, AuthoritySignature_1.verifyAuthorityMeta)(authorityMeta, taskDescription)) {
                    Logger_1.Logger.warn(`🚫 D4 Authority: delegated metadata 签名校验失败 (decisionId=${authorityMeta['authority_decisionId']})，拒绝委托执行，降级为 TS 本地决策链`, 'ExecAgent');
                }
                else {
                    Logger_1.Logger.info(`🔗 D4 Authority: 收到 Python Decision ${authorityMeta['authority_decisionId']} (签名校验通过), 跳过 TS 侧决策`, 'ExecAgent');
                    result = await this.executeWithAuthorityDelegation(taskDescription, authorityMeta, observations);
                    return result;
                }
            }
            // D4-I2-3: TS 独立运行时也必须经过 DecisionAuthority。
            // matchSkill() 和 parseLLMAction() 降级为 Proposer，不再直接决定执行。
            result = await this.executeViaDecisionAuthority(taskDescription, observations);
            return result;
        }
        catch (error) {
            const duration = Date.now() - startTime;
            const errorMsg = error.message;
            Logger_1.Logger.error(`❌ 任务执行失败: ${errorMsg}`, error, 'ExecAgent');
            this.eventStream.endTask(false, errorMsg);
            return {
                success: false,
                taskDescription,
                stepsCompleted: 0,
                totalSteps: 0,
                durationMs: duration,
                observations,
                report: `执行失败: ${errorMsg}`,
                error: errorMsg,
            };
        }
        finally {
            this.isRunning = false;
        }
    }
    /**
     * 紧急停止
     */
    stop(reason = '用户停止') {
        if (!this.isRunning)
            return;
        Logger_1.Logger.warn(`⏹️  任务停止: ${reason}`, 'ExecAgent');
        this.safetyGuard.emergencyStop(reason);
    }
    /**
     * 暂停任务
     */
    pause(reason = '用户暂停') {
        this.safetyGuard.pause(reason);
        this.eventStream.emitStatusChange('paused', reason);
    }
    /**
     * 恢复任务
     */
    resume() {
        this.safetyGuard.resume();
        this.eventStream.emitStatusChange('running');
    }
    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            isPaused: this.safetyGuard.getStatus().isPaused,
            isStopped: this.safetyGuard.getStatus().isStopped,
            currentTaskId: this.currentTaskId,
            safetyStatus: this.safetyGuard.getStatus(),
        };
    }
    /**
     * 获取事件流
     */
    getEventStream() {
        return this.eventStream;
    }
    /**
     * 获取MCP服务器
     */
    getMCPServer() {
        return this.mcpServer;
    }
    setProjectContext(context) {
        this._projectContext = context;
    }
    // ========== 内部执行方法 ==========
    /**
     * D4-I2-3: TS 独立运行时也必须经过 DecisionAuthority。
     *
     * 链路：
     *   taskDescription
     *     → GoalAuthority.createGoal() → goalId
     *     → StateAuthority.captureSnapshot() → snapshotId
     *     → SkillProposer.propose() + DesktopLLMProposer.propose() → candidates
     *     → DecisionAuthority.decide() → Decision (FINAL)
     *     → ActionAuthority.executeAction() → execute
     *     → Evidence → GoalAuthority.updateFromEvidence()
     *
     * matchSkill() 和 parseLLMAction() 现在只是 Proposer，不再直接决定执行。
     */
    async executeViaDecisionAuthority(taskDescription, observations) {
        const startTime = Date.now();
        const decisionAuthority = DecisionAuthority_1.DecisionAuthority.getInstance();
        const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
        const stateAuthority = StateAuthority_1.StateAuthority.getInstance();
        const goal = goalAuthority.createGoal({
            description: taskDescription,
            originalInput: taskDescription,
            executionDomain: 'desktop',
            bindings: (0, GoalContextResolver_1.resolveGoalBinding)({ projectContext: this._projectContext }),
        });
        const goalId = goal.goalId;
        Logger_1.Logger.info(`🔗 D4-I2: TS 独立运行 — Goal ${goalId} created, entering DecisionAuthority`, 'ExecAgent');
        const snapshot = await stateAuthority.captureSnapshot([goalId]);
        const skillProposer = new SkillProposer_1.SkillProposer();
        const llmProposer = new DesktopLLMProposer_1.DesktopLLMProposer();
        const context = {
            goalId,
            snapshot,
            candidates: [],
        };
        const allCandidates = [];
        if (this.config.enableSkills) {
            try {
                const skillCandidates = await skillProposer.propose(context);
                allCandidates.push(...skillCandidates);
            }
            catch (e) {
                Logger_1.Logger.warn(`SkillProposer failed: ${e.message}`, 'ExecAgent');
            }
        }
        if (this.config.enableLLMPlanning) {
            try {
                const llmCandidates = await llmProposer.propose(context);
                allCandidates.push(...llmCandidates);
            }
            catch (e) {
                Logger_1.Logger.warn(`DesktopLLMProposer failed: ${e.message}`, 'ExecAgent');
            }
        }
        if (allCandidates.length === 0) {
            const duration = Date.now() - startTime;
            this.eventStream.endTask(false, 'No candidates from any proposer');
            return {
                success: false,
                taskDescription,
                stepsCompleted: 0,
                totalSteps: 0,
                durationMs: duration,
                observations,
                report: 'DecisionAuthority: no candidates produced, action denied',
                error: 'authority_denied',
            };
        }
        const decision = await decisionAuthority.decide({
            goalId,
            snapshot,
            candidates: allCandidates,
        });
        Logger_1.Logger.info(`🔗 D4-I2: DecisionAuthority FINAL decision ${decision.decisionId} — chosen=${decision.chosen.candidateId} proposer=${decision.chosen.proposerId}`, 'ExecAgent');
        const chosenAction = decision.chosen.action;
        const action = {
            type: chosenAction.payload?.actionType || chosenAction.type,
            description: chosenAction.payload?.description || taskDescription,
            params: chosenAction.payload?.params || chosenAction.payload,
        };
        this.eventStream.emitActionStart(action.type, action.description, action.params);
        // D4 Authority: chosen action 的 type 是 proposer 提议的工具名（运行时字符串），
        // DesktopAction.type 联合类型是静态白名单；ActionAuthority/SafetyGuard 在运行时兜底裁决。
        const { result: actionResult, authorization } = await this.authority.executeAction(action);
        if (!authorization.allowed) {
            const duration = Date.now() - startTime;
            this.eventStream.endTask(false, authorization.reason || '安全检查未通过');
            return {
                success: false,
                taskDescription,
                stepsCompleted: 0,
                totalSteps: 1,
                durationMs: duration,
                observations,
                report: `ActionAuthority denied: ${authorization.reason || '安全检查未通过'}`,
                error: 'authority_denied',
            };
        }
        const duration = Date.now() - startTime;
        this.eventStream.endTask(actionResult.success);
        goalAuthority.updateFromEvidence({
            goalId,
            decisionId: decision.decisionId,
            observation: actionResult.output || '',
            action: chosenAction,
            expectedEffect: action.description,
            actualEffect: actionResult.success ? 'success' : (actionResult.error || 'failed'),
            progressDelta: actionResult.success ? 0.5 : -0.05,
        });
        return {
            success: actionResult.success,
            taskDescription,
            stepsCompleted: 1,
            totalSteps: 1,
            durationMs: duration,
            observations,
            report: actionResult.success
                ? `DecisionAuthority ${decision.decisionId}: executed ${action.type} (proposer=${decision.chosen.proposerId})`
                : `DecisionAuthority ${decision.decisionId}: execution failed — ${actionResult.error || 'unknown'}`,
            error: actionResult.success ? undefined : actionResult.error,
        };
    }
    /**
     * D4-I1-R2: Authority 委托执行——TS 不重新决策，直接执行 Python DecisionAuthority 指定的动作。
     *
     * 这证明 TS DesktopExecutionAgent 在收到 authority_decisionId 时是 executor/transport，
     * 不是独立的 FINAL Decision Authority。
     *
     * D4-I2 Post-Audit: 执行后写 Evidence 回同一 goalId（影子 Goal 注册），
     * 使 G→S→D→A→E 链在跨进程路径也完整。
     *
     * 链路：
     *   Python DecisionAuthority.decide() → Decision(chosen=X)
     *     → ToolCall(metadata={authority_decisionId: D123, ..., authority_sig})
     *     → HTTP POST /api/desktop/automate {task, authority}
     *     → TS DesktopExecutionAgent.executeTask(task, authorityMeta)
     *     → HMAC 签名校验 → executeWithAuthorityDelegation(task, authorityMeta)
     *     → DesktopActionAuthority.executeAction(action)
     *     → Evidence → GoalAuthority.updateFromEvidence()
     */
    async executeWithAuthorityDelegation(taskDescription, authorityMeta, observations) {
        const startTime = Date.now();
        let stepsCompleted = 0;
        const initialObs = await this.visionEngine.observe();
        observations.push(initialObs);
        const action = {
            type: 'desktop_automate',
            description: taskDescription,
            params: { task: taskDescription },
        };
        this.eventStream.emitActionStart(action.type, action.description, action.params);
        const { result: actionResult, authorization } = await this.authority.executeAction(action);
        if (!authorization.allowed) {
            const duration = Date.now() - startTime;
            this.eventStream.endTask(false, authorization.reason || '安全检查未通过');
            return {
                success: false,
                taskDescription,
                stepsCompleted: 0,
                totalSteps: 1,
                durationMs: duration,
                observations,
                report: `Authority 委托执行被拒绝: ${authorization.reason || '安全检查未通过'}`,
                error: 'authority_denied',
            };
        }
        stepsCompleted = 1;
        const duration = Date.now() - startTime;
        this.eventStream.endTask(true);
        // D4-I2 Post-Audit: delegated 路径补 Evidence 写入。
        // progressDelta 仍为结果驱动 stub（+0.5/-0.05），与 TS 独立路径一致；
        // 真实 progress 需等待 D5 Learning 用 Evidence 的 prediction error 校准。
        const delegatedGoalId = String(authorityMeta['authority_goalId']);
        const delegatedDecisionId = String(authorityMeta['authority_decisionId']);
        try {
            const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
            goalAuthority.ensureGoal(delegatedGoalId, {
                description: taskDescription,
                originalInput: taskDescription,
                executionDomain: 'desktop',
                bindings: (0, GoalContextResolver_1.resolveGoalBinding)({ projectContext: this._projectContext }),
            });
            goalAuthority.updateFromEvidence({
                goalId: delegatedGoalId,
                decisionId: delegatedDecisionId,
                observation: actionResult.output || '',
                action: { type: 'desktop_action', payload: action.params },
                expectedEffect: taskDescription,
                actualEffect: actionResult.success
                    ? 'success'
                    : actionResult.error || 'failed',
                progressDelta: actionResult.success ? 0.5 : -0.05,
            });
        }
        catch (e) {
            Logger_1.Logger.warn(`D4 Authority: delegated evidence write-back failed — ${e.message}`, 'ExecAgent');
        }
        return {
            success: actionResult.success,
            taskDescription,
            stepsCompleted,
            totalSteps: 1,
            durationMs: duration,
            observations,
            report: actionResult.success
                ? `Authority 委托执行完成 (decisionId: ${delegatedDecisionId})`
                : `Authority 委托执行失败: ${actionResult.error || 'unknown'}`,
            error: actionResult.success ? undefined : actionResult.error,
        };
    }
    /**
     * 处理紧急停止
     */
    handleEmergencyStop() {
        this.isRunning = false;
        this.eventStream.emitStatusChange('stopped', '紧急停止');
        this.emit('emergency_stop');
    }
    /**
     * F3: 经 PythonAgentBridge 调用 Python 端 LLM 做文本规划。
     * Bridge 不可用时抛出，由调用方 try/catch 降级为技能/基础模式（保持原有鲁棒性）。
     */
    _bridgeLlmAvailable() {
        try {
            return (0, bootstrap_1.getPythonBridge)() != null;
        }
        catch {
            return false;
        }
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('桌面执行Agent未初始化，请先调用 initialize()');
        }
    }
}
exports.DesktopExecutionAgent = DesktopExecutionAgent;
// 便捷导出
exports.executionAgent = DesktopExecutionAgent.getInstance();

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
 * v3: 推进能力边界增强
 *   - 执行上下文管理: 维护任务执行中的上下文状态（窗口焦点、剪贴板、活动应用）
 *   - 多策略执行: 根据任务特征自动选择最优执行策略（技能/LLM/基础/组合）
 *   - 执行诊断: 失败后自动诊断原因，生成诊断报告和修复建议
 *   - 执行快照: 支持在关键步骤保存/恢复执行状态
 *   - 进度估算: 基于历史数据估算任务完成度和剩余时间
 *
 * 工作流程：
 * 用户指令 → 技能匹配/LLM规划 → 安全检查 → 执行动作 → 观察验证 → 循环直到完成
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.executionAgent = exports.DesktopExecutionAgent = void 0;
const events_1 = require("events");
const DesktopMCPServer_1 = require("./DesktopMCPServer");
const DesktopEventStream_1 = require("./DesktopEventStream");
const DesktopSafetyGuard_1 = require("./DesktopSafetyGuard");
const DesktopSkillRegistry_1 = require("./DesktopSkillRegistry");
const NormalizedCoordinates_1 = require("./NormalizedCoordinates");
const DesktopVisionEngine_1 = require("./DesktopVisionEngine");
const ContextWindowManager_1 = require("../harness/context/ContextWindowManager");
// F3: 桌面执行规划不再独立持有 TS LLMProvider（违反 AGENTS.md §0.1），
// 改为路由到 Python 后端的 LLM（经 PythonAgentBridge）。
const bootstrap_1 = require("../server/bootstrap");
const Logger_1 = require("../utils/Logger");
const DEFAULT_CONFIG = {
    safetyLevel: 'moderate',
    enableSkills: true,
    enableLLMPlanning: true,
    maxSteps: 50,
    autoVerify: true,
};
class DesktopExecutionAgent extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.initialized = false;
        this.isRunning = false;
        this.currentTaskId = '';
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.mcpServer = DesktopMCPServer_1.DesktopMCPServer.getInstance();
        this.eventStream = DesktopEventStream_1.DesktopEventStream.getInstance();
        this.safetyGuard = DesktopSafetyGuard_1.DesktopSafetyGuard.getInstance();
        this.skillRegistry = DesktopSkillRegistry_1.DesktopSkillRegistry.getInstance();
        this.coords = NormalizedCoordinates_1.NormalizedCoordinateSystem.getInstance();
        this.visionEngine = DesktopVisionEngine_1.DesktopVisionEngine.getInstance();
        this._executionContext = {
            activeWindow: null,
            clipboardContent: null,
            activeApp: null,
            lastActionType: null,
            lastActionResult: null,
            stepsCompleted: 0,
            totalSteps: 0,
            startTime: 0,
        };
        this._snapshots = new Map();
        this._maxSnapshots = 10;
        this._executionHistory = [];
        this._maxHistory = 50;
        this._diagnostics = [];
        this._contextWindowManager = new ContextWindowManager_1.ContextWindowManager();
        this._llmConversationHistory = [];
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
    async executeTask(taskDescription) {
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
        this._executionContext.startTime = startTime;
        this._executionContext.stepsCompleted = 0;
        this._executionContext.totalSteps = 0;
        this.currentTaskId = this.eventStream.startTask(taskDescription);
        this.safetyGuard.startTask();
        Logger_1.Logger.info(`🎯 开始执行任务: ${taskDescription}`, 'ExecAgent');
        try {
            let result;
            const strategy = this._selectStrategy(taskDescription);
            Logger_1.Logger.info(`📊 选择执行策略: ${strategy}`, 'ExecAgent');
            if (strategy === 'skill' && this.config.enableSkills) {
                const skillMatch = this.skillRegistry.matchSkill(taskDescription);
                if (skillMatch && skillMatch.confidence > 50) {
                    Logger_1.Logger.info(`🎯 匹配到技能: ${skillMatch.skill.name} (置信度: ${Math.round(skillMatch.confidence)}%)`, 'ExecAgent');
                    result = await this.executeWithSkill(skillMatch.skill, skillMatch.extractedParams, observations);
                    result.usedSkill = skillMatch.skill.name;
                    this._recordHistory(taskDescription, 'skill', result);
                    return result;
                }
            }
            if (strategy === 'llm' || strategy === 'skill') {
                if (this.config.enableLLMPlanning && this._bridgeLlmAvailable()) {
                    Logger_1.Logger.info('🧠 使用LLM规划执行', 'ExecAgent');
                    result = await this.executeWithLLMPlanning(taskDescription, observations);
                    this._recordHistory(taskDescription, 'llm', result);
                    return result;
                }
            }
            if (strategy === 'composite') {
                Logger_1.Logger.info('🔗 使用组合执行策略', 'ExecAgent');
                result = await this._executeComposite(taskDescription, observations);
                this._recordHistory(taskDescription, 'composite', result);
                return result;
            }
            Logger_1.Logger.info('⚙️  使用基础执行模式', 'ExecAgent');
            result = await this.executeBasic(taskDescription, observations);
            this._recordHistory(taskDescription, 'basic', result);
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
    // ========== 内部执行方法 ==========
    /**
     * 使用技能执行
     */
    async executeWithSkill(skill, params, observations) {
        const startTime = Date.now();
        const result = await this.skillRegistry.executeSkill(skill.id, params, async (step) => {
            // 安全检查
            const safetyCheck = this.safetyGuard.checkAction(step.type, step.description);
            if (!safetyCheck.allowed) {
                if (safetyCheck.requireConfirmation) {
                    this.eventStream.emitUserInterventionRequired(safetyCheck.reason || '需要确认');
                    // 实际实现中这里会等待用户确认
                    Logger_1.Logger.warn(`⚠️  需要用户确认: ${safetyCheck.reason}`, 'ExecAgent');
                }
                throw new Error(safetyCheck.reason || '安全检查未通过');
            }
            // 执行步骤
            this.eventStream.emitActionStart(step.type, step.description, step.action?.params || {});
            let success = true;
            switch (step.type) {
                case 'action':
                    if (step.action) {
                        const mcpResult = await this.mcpServer.callTool(step.action.type, step.action.params);
                        success = !mcpResult.isError;
                    }
                    break;
                case 'wait':
                    if (step.wait) {
                        await new Promise((resolve) => setTimeout(resolve, step.wait.durationMs));
                    }
                    break;
                case 'screenshot':
                    const observation = await this.visionEngine.observe();
                    observations.push(observation);
                    this.eventStream.emitObservation(observation.screenshotBase64 ?? '', observation.screenWidth ?? 0, observation.screenHeight ?? 0);
                    break;
                case 'verify':
                    // 验证逻辑
                    success = true; // 简化实现
                    break;
                case 'llm_plan':
                    // LLM动态规划
                    success = true; // 简化实现
                    break;
            }
            this.safetyGuard.recordAction(step.type, step.description || step.type);
            this.eventStream.emitActionEnd(step.type, step.description, success);
            return success;
        });
        const duration = Date.now() - startTime;
        this.eventStream.endTask(result.success, result.skillName);
        return {
            success: result.success,
            taskDescription: skill.description,
            stepsCompleted: result.stepsCompleted,
            totalSteps: result.totalSteps,
            durationMs: duration,
            observations,
            report: result.success
                ? `技能执行成功: ${skill.name}`
                : `技能执行失败: ${result.error}`,
            error: result.error,
            usedSkill: skill.name,
        };
    }
    /**
     * 使用LLM规划执行
     */
    async executeWithLLMPlanning(taskDescription, observations) {
        const startTime = Date.now();
        let stepsCompleted = 0;
        const maxSteps = this.config.maxSteps;
        // 初始观察
        const initialObs = await this.visionEngine.observe();
        observations.push(initialObs);
        this.eventStream.emitObservation(initialObs.screenshotBase64 ?? '', initialObs.screenWidth ?? 0, initialObs.screenHeight ?? 0);
        // 获取可用工具列表
        const tools = this.mcpServer.listTools();
        const toolsDescription = tools
            .map((t) => `- ${t.name}: ${t.description}`)
            .join('\n');
        // LLM规划循环
        let currentObservation = initialObs;
        let stepCount = 0;
        let consecutiveParseFailures = 0;
        const MAX_PARSE_FAILURES = 5;
        let consecutiveActionFailures = 0;
        const MAX_ACTION_FAILURES = 5;
        this._llmConversationHistory = [];
        this._llmConversationHistory.push({
            role: 'system',
            content: this.getSystemPrompt(),
        });
        this._llmConversationHistory.push({
            role: 'user',
            content: `任务目标: ${taskDescription}\n\n可用工具:\n${toolsDescription}\n\n请开始执行任务，每步返回一个JSON动作。`,
        });
        while (stepCount < maxSteps) {
            stepCount++;
            // 安全检查
            if (this.safetyGuard.getStatus().isStopped) {
                throw new Error('已触发紧急停止');
            }
            // 调用LLM生成下一步动作
            const obsSummary = `步数${stepCount} | 分辨率:${currentObservation.screenWidth}×${currentObservation.screenHeight} | 活动窗口:${currentObservation.activeWindow || '未知'} | 窗口列表:${currentObservation.windowTitles?.join(', ') || '无'}`;
            this._llmConversationHistory.push({
                role: 'user',
                content: `[当前屏幕观察] ${obsSummary}\n\n请决定下一步操作（返回JSON）。`,
            });
            this._llmConversationHistory = this._contextWindowManager.manageWindow(this._llmConversationHistory);
            this.eventStream.emitStatusChange('planning');
            const llmResponse = await this._bridgeChat(
                this._llmConversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
                this.getSystemPrompt()
            );
            this._llmConversationHistory.push({
                role: 'assistant',
                content: llmResponse,
            });
            // 解析LLM响应，提取动作
            const action = this.parseLLMAction(llmResponse);
            if (!action) {
                consecutiveParseFailures++;
                Logger_1.Logger.warn(`⚠️ 无法解析LLM响应 (${consecutiveParseFailures}/${MAX_PARSE_FAILURES})`, 'ExecAgent');
                if (consecutiveParseFailures >= MAX_PARSE_FAILURES) {
                    throw new Error(`连续 ${MAX_PARSE_FAILURES} 次无法解析LLM响应，终止执行`);
                }
                continue;
            }
            consecutiveParseFailures = 0;
            if (action.type === 'done') {
                // 任务完成
                Logger_1.Logger.info('✅ LLM判定任务完成', 'ExecAgent');
                break;
            }
            // 安全检查
            if (stepCount % 5 === 0) {
                try {
                    const fgWindow = await this.windowManager.getForegroundWindow();
                    if (fgWindow?.processName) {
                        this.safetyGuard.updateAppContext(fgWindow.processName);
                    }
                }
                catch { /* ignore window query failure */ }
            }
            const safetyCheck = this.safetyGuard.checkAction(action.type, action.description || action.type, action.params);
            if (!safetyCheck.allowed) {
                if (safetyCheck.requireConfirmation) {
                    this.eventStream.emitUserInterventionRequired(safetyCheck.reason || '需要确认');
                    // 实际实现中等待用户确认
                    Logger_1.Logger.warn(`⚠️  需要用户确认: ${safetyCheck.reason}`, 'ExecAgent');
                }
                throw new Error(safetyCheck.reason || '安全检查未通过');
            }
            // 执行动作
            this.eventStream.emitActionStart(action.type, action.description || action.type, action.params || {});
            const mcpResult = await this.mcpServer.callTool(action.type, action.params || {});
            this.safetyGuard.recordAction(action.type, action.description || action.type);
            stepsCompleted++;
            this.eventStream.emitActionEnd(action.type, action.description || action.type, !mcpResult.isError);
            if (mcpResult.isError) {
                const errorMsg = mcpResult.content?.[0]?.text || '未知错误';
                Logger_1.Logger.warn(`⚠️ 动作执行失败: ${action.type} - ${errorMsg}`, 'ExecAgent');
                this.eventStream.emitActionError(action.type, action.description || action.type, errorMsg);
                consecutiveActionFailures++;
                this._llmConversationHistory.push({
                    role: 'user',
                    content: `[动作结果] 执行失败: ${errorMsg}\n\n请调整策略并重试。`,
                });
                if (consecutiveActionFailures >= MAX_ACTION_FAILURES) {
                    throw new Error(`连续 ${MAX_ACTION_FAILURES} 次动作执行失败，终止执行`);
                }
            }
            else {
                consecutiveActionFailures = 0;
                const resultText = mcpResult.content?.[0]?.text || '执行成功';
                this._llmConversationHistory.push({
                    role: 'user',
                    content: `[动作结果] 成功: ${resultText.substring(0, 500)}`,
                });
            }
            // 验证：重新观察
            if (this.config.autoVerify) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                currentObservation = await this.visionEngine.observe();
                observations.push(currentObservation);
                this.eventStream.emitObservation(currentObservation.screenshotBase64 ?? '', currentObservation.screenWidth ?? 0, currentObservation.screenHeight ?? 0);
            }
        }
        const duration = Date.now() - startTime;
        const success = stepCount < maxSteps;
        this.eventStream.endTask(success, success ? '任务完成' : '达到最大步数');
        return {
            success,
            taskDescription,
            stepsCompleted,
            totalSteps: stepCount,
            durationMs: duration,
            observations,
            report: success
                ? `任务完成，共执行 ${stepsCompleted} 步`
                : `任务未完成，达到最大步数 ${maxSteps}`,
        };
    }
    /**
     * 基础执行模式（降级方案）
     */
    async executeBasic(taskDescription, observations) {
        const startTime = Date.now();
        // 简单的关键词匹配执行
        const observation = await this.visionEngine.observe();
        observations.push(observation);
        this.eventStream.emitObservation(observation.screenshotBase64 ?? '', observation.screenWidth ?? 0, observation.screenHeight ?? 0);
        const duration = Date.now() - startTime;
        this.eventStream.endTask(false, '基础模式无法执行复杂任务，请启用LLM规划或使用技能');
        return {
            success: false,
            taskDescription,
            stepsCompleted: 1,
            totalSteps: 1,
            durationMs: duration,
            observations,
            report: '基础模式仅支持截图等简单操作，复杂任务请启用LLM规划',
            error: 'BASIC_MODE_LIMITED',
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
     * 构建LLM规划提示词
     */
    buildPlanningPrompt(task, observation, toolsDesc, step, completed) {
        return `你是一个桌面操作助手。你的任务是根据当前屏幕状态，决定下一步操作。

任务目标: ${task}
当前步数: ${step}
已完成动作: ${completed}

可用工具:
${toolsDesc}

坐标说明:
- 使用归一化坐标 [0-1000] × [0-1000]
- 屏幕左上角为 (0, 0)，右下角为 (1000, 1000)
- 例如：屏幕中间位置是 (500, 500)

当前屏幕信息:
- 分辨率: ${observation.screenWidth} × ${observation.screenHeight}
- 活动窗口: ${observation.activeWindow || '未知'}
- 窗口列表: ${observation.windowTitles?.join(', ') || '无'}

请分析当前屏幕状态，然后决定下一步操作。
只返回一个JSON对象，格式如下：
{
  "type": "工具名称",
  "params": { ...参数 },
  "description": "动作描述",
  "reasoning": "为什么选择这个动作"
}

如果认为任务已经完成，返回：
{"type": "done", "description": "任务完成描述"}`;
    }
    /**
     * 获取系统提示词
     */
    getSystemPrompt() {
        return `你是一个专业的桌面操作助手，擅长通过鼠标和键盘操作电脑。

操作原则：
1. 每一步操作前都要仔细观察屏幕状态
2. 优先使用精确的UI元素操作，而不是盲目点击
3. 操作后验证结果是否符合预期
4. 遇到问题及时调整策略
5. 保持操作节奏稳定，不要过快

坐标系统：
- 所有坐标使用归一化值，范围 [0, 1000]
- x: 0 = 屏幕最左，1000 = 屏幕最右
- y: 0 = 屏幕最上，1000 = 屏幕最下

请始终以安全、准确、高效的方式完成任务。`;
    }
    /**
     * 解析LLM动作响应
     */
    parseLLMAction(response) {
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const action = JSON.parse(jsonMatch[0]);
                    return action;
                }
                catch {
                    const repaired = this._repairActionJson(jsonMatch[0]);
                    if (repaired) return repaired;
                }
            }
        }
        catch {
            // 解析失败
        }
        try {
            const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (codeBlockMatch) {
                const action = JSON.parse(codeBlockMatch[1].trim());
                return action;
            }
        }
        catch {
            // code block解析失败
        }
        const typeMatch = response.match(/"type"\s*:\s*"([^"]+)"/);
        if (typeMatch) {
            const action = { type: typeMatch[1] };
            const paramsMatch = response.match(/"params"\s*:\s*(\{[^}]*\})/);
            if (paramsMatch) {
                try {
                    action.params = JSON.parse(paramsMatch[1]);
                }
                catch {
                    action.params = {};
                }
            }
            const descMatch = response.match(/"description"\s*:\s*"([^"]+)"/);
            if (descMatch) {
                action.description = descMatch[1];
            }
            return action;
        }
        return null;
    }
    _repairActionJson(raw) {
        try {
            const MessageSanitizer = require("../models/MessageSanitizer");
            const repaired = MessageSanitizer.MessageSanitizer.repairJson(raw);
            return repaired;
        }
        catch {
            return null;
        }
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
    async _bridgeChat(planPrompt, systemPrompt) {
        const bridge = (0, bootstrap_1.getPythonBridge)();
        if (!bridge) {
            throw new Error('Python Bridge 不可用，无法执行 LLM 规划');
        }
        const history = [];
        const lines = planPrompt.split('\n\n');
        for (const line of lines) {
            const colonIdx = line.indexOf(': ');
            if (colonIdx > 0 && colonIdx < 20) {
                const role = line.substring(0, colonIdx).trim();
                const content = line.substring(colonIdx + 2);
                if (role === 'user' || role === 'assistant') {
                    history.push({ role, content });
                    continue;
                }
            }
            break;
        }
        const lastUserIdx = planPrompt.lastIndexOf('user: ');
        const userMessage = lastUserIdx >= 0
            ? planPrompt.substring(lastUserIdx + 6).trim()
            : planPrompt;
        return await bridge.llmChat(userMessage, history, systemPrompt);
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('桌面执行Agent未初始化，请先调用 initialize()');
        }
    }
    async executeAdaptivePlan(taskDescription, options) {
        this.ensureInitialized();
        const maxPhases = options?.maxPhases ?? 3;
        const convergenceThreshold = options?.convergenceThreshold ?? 0.8;
        const phaseResults = [];
        let currentGoal = taskDescription;
        let overallConfidence = 0;
        for (let phase = 0; phase < maxPhases; phase++) {
            Logger_1.Logger.info(`🔄 自适应规划 阶段 ${phase + 1}/${maxPhases}: ${currentGoal.substring(0, 60)}`, 'ExecAgent');
            const phaseResult = await this.executeTask(currentGoal);
            phaseResults.push(phaseResult);
            if (phaseResult.success) {
                overallConfidence = 1.0;
                break;
            }
            if (!this._bridgeLlmAvailable()) {
                break;
            }
            try {
                const obs = await this.visionEngine.observe();
                const diagPrompt = `任务: ${taskDescription}\n阶段 ${phase + 1} 执行结果: ${phaseResult.success ? '成功' : '失败'}\n报告: ${phaseResult.report}\n当前屏幕: ${obs.summary?.substring(0, 200) || '未知'}\n\n请分析失败原因并给出调整后的下一步操作建议。只返回一个JSON: {"diagnosis": "诊断", "adjustedGoal": "调整后的目标", "confidence": 0.5}`;
                const diagResponse = await this._bridgeChat(diagPrompt, this.getSystemPrompt());
                const diagAction = this.parseLLMAction(diagResponse);
                if (diagAction?.adjustedGoal) {
                    currentGoal = diagAction.adjustedGoal;
                    overallConfidence = diagAction.confidence ?? 0.5;
                }
                else {
                    break;
                }
            }
            catch {
                break;
            }
            if (overallConfidence >= convergenceThreshold) {
                break;
            }
        }
        const anySuccess = phaseResults.some((r) => r.success);
        return {
            success: anySuccess,
            taskDescription,
            phases: phaseResults,
            totalPhases: phaseResults.length,
            finalConfidence: overallConfidence,
            report: anySuccess
                ? `自适应规划完成: ${phaseResults.length} 个阶段, 最终置信度 ${overallConfidence.toFixed(2)}`
                : `自适应规划未完成: ${phaseResults.length} 个阶段均未成功`,
        };
    }
    async executeConditional(taskDescription, conditions) {
        this.ensureInitialized();
        const obs = await this.visionEngine.observe();
        const screenSummary = obs.summary?.toLowerCase() || '';
        for (const condition of conditions) {
            const matched = condition.matchKeywords?.some((kw) => screenSummary.includes(kw.toLowerCase())) ?? false;
            if (matched) {
                Logger_1.Logger.info(`🔀 条件匹配: "${condition.name}" → 执行对应任务`, 'ExecAgent');
                return this.executeTask(condition.task);
            }
        }
        Logger_1.Logger.info('🔀 无条件匹配，执行默认任务', 'ExecAgent');
        return this.executeTask(taskDescription);
    }
    _selectStrategy(taskDescription) {
        const desc = taskDescription.toLowerCase();
        const skillMatch = this.config.enableSkills
            ? this.skillRegistry.matchSkill(taskDescription)
            : null;
        if (skillMatch && skillMatch.confidence > 70) {
            return 'skill';
        }
        const complexIndicators = ['然后', '之后', '接着', '并且', '同时', 'after', 'then', 'and also'];
        const hasComplex = complexIndicators.some((kw) => desc.includes(kw));
        if (hasComplex && this._bridgeLlmAvailable()) {
            return 'composite';
        }
        if (this._bridgeLlmAvailable()) {
            return 'llm';
        }
        if (skillMatch && skillMatch.confidence > 40) {
            return 'skill';
        }
        return 'basic';
    }
    async _executeComposite(taskDescription, observations) {
        const startTime = Date.now();
        const parts = this._splitCompositeTask(taskDescription);
        Logger_1.Logger.info(`🔗 组合任务分解为 ${parts.length} 个子任务`, 'ExecAgent');
        const results = [];
        for (let i = 0; i < parts.length; i++) {
            Logger_1.Logger.info(`🔗 子任务 ${i + 1}/${parts.length}: ${parts[i].substring(0, 60)}`, 'ExecAgent');
            const subResult = await this._executeSubTask(parts[i], observations);
            results.push(subResult);
            if (!subResult.success && i < parts.length - 1) {
                Logger_1.Logger.warn(`⚠️ 子任务${i + 1}失败，尝试继续`, 'ExecAgent');
            }
        }
        const successCount = results.filter((r) => r.success).length;
        const duration = Date.now() - startTime;
        return {
            success: successCount === results.length,
            taskDescription,
            stepsCompleted: results.reduce((s, r) => s + r.stepsCompleted, 0),
            totalSteps: results.reduce((s, r) => s + r.totalSteps, 0),
            durationMs: duration,
            observations,
            report: `组合执行: ${successCount}/${results.length} 子任务成功`,
            subResults: results,
        };
    }
    _splitCompositeTask(taskDescription) {
        const separators = ['然后', '之后', '接着', '并且', 'after that', 'then', 'and then'];
        for (const sep of separators) {
            if (taskDescription.includes(sep)) {
                return taskDescription.split(sep).map((s) => s.trim()).filter((s) => s.length > 0);
            }
        }
        return [taskDescription];
    }
    async _executeSubTask(taskDescription, observations) {
        const startTime = Date.now();
        const strategy = this._selectStrategy(taskDescription);
        try {
            if (strategy === 'skill' && this.config.enableSkills) {
                const skillMatch = this.skillRegistry.matchSkill(taskDescription);
                if (skillMatch && skillMatch.confidence > 50) {
                    const result = await this.executeWithSkill(skillMatch.skill, skillMatch.extractedParams, observations);
                    result.usedSkill = skillMatch.skill.name;
                    return result;
                }
            }
            if ((strategy === 'llm' || strategy === 'skill') && this.config.enableLLMPlanning && this._bridgeLlmAvailable()) {
                return await this.executeWithLLMPlanning(taskDescription, observations);
            }
            return await this.executeBasic(taskDescription, observations);
        }
        catch (error) {
            const duration = Date.now() - startTime;
            return {
                success: false,
                taskDescription,
                stepsCompleted: 0,
                totalSteps: 0,
                durationMs: duration,
                observations,
                report: `子任务失败: ${error.message}`,
                error: error.message,
            };
        }
    }
    updateExecutionContext(key, value) {
        this._executionContext[key] = value;
    }
    getExecutionContext() {
        return { ...this._executionContext };
    }
    saveSnapshot(id) {
        const snapshot = {
            id,
            timestamp: Date.now(),
            context: { ...this._executionContext },
            taskId: this.currentTaskId,
            isRunning: this.isRunning,
            safetyStatus: this.safetyGuard.getStatus(),
            actionSequence: this.safetyGuard.getActionSequence().slice(-10),
        };
        this._snapshots.set(id, snapshot);
        if (this._snapshots.size > this._maxSnapshots) {
            const oldest = this._snapshots.keys().next().value;
            if (oldest) this._snapshots.delete(oldest);
        }
        Logger_1.Logger.info(`📸 执行快照已保存: ${id}`, 'ExecAgent');
        return snapshot;
    }
    restoreSnapshot(id) {
        const snapshot = this._snapshots.get(id);
        if (!snapshot) {
            Logger_1.Logger.warn(`⚠️ 快照不存在: ${id}`, 'ExecAgent');
            return false;
        }
        this._executionContext = { ...snapshot.context };
        Logger_1.Logger.info(`📸 执行快照已恢复: ${id}`, 'ExecAgent');
        return true;
    }
    getSnapshot(id) {
        return this._snapshots.get(id) || null;
    }
    listSnapshots() {
        return Array.from(this._snapshots.values());
    }
    _recordHistory(taskDescription, strategy, result) {
        this._executionHistory.push({
            taskDescription: taskDescription.substring(0, 100),
            strategy,
            success: result.success,
            durationMs: result.durationMs,
            stepsCompleted: result.stepsCompleted,
            timestamp: Date.now(),
        });
        if (this._executionHistory.length > this._maxHistory) {
            this._executionHistory.shift();
        }
        this._executionContext.stepsCompleted = result.stepsCompleted;
        this._executionContext.totalSteps = result.totalSteps;
        this._executionContext.lastActionResult = result.success ? 'success' : 'failed';
    }
    getExecutionHistory(limit) {
        const history = [...this._executionHistory];
        return limit ? history.slice(-limit) : history;
    }
    async diagnoseFailure(taskDescription, result) {
        const diagnosis = {
            taskDescription,
            success: result.success,
            stepsCompleted: result.stepsCompleted,
            totalSteps: result.totalSteps,
            durationMs: result.durationMs,
            error: result.error || null,
            timestamp: Date.now(),
            possibleCauses: [],
            suggestions: [],
        };
        if (result.stepsCompleted === 0) {
            diagnosis.possibleCauses.push('任务未开始执行，可能是初始化失败或安全检查阻止');
            diagnosis.suggestions.push('检查安全策略是否过于严格');
            diagnosis.suggestions.push('确认桌面环境是否可访问');
        }
        else if (result.stepsCompleted < result.totalSteps * 0.3) {
            diagnosis.possibleCauses.push('任务早期失败，可能是目标元素未找到或操作被拒绝');
            diagnosis.suggestions.push('先截图观察当前屏幕状态');
            diagnosis.suggestions.push('尝试使用 find_element 精确定位');
        }
        else if (result.stepsCompleted < result.totalSteps * 0.8) {
            diagnosis.possibleCauses.push('任务中途失败，可能是页面变化或元素状态改变');
            diagnosis.suggestions.push('重新观察屏幕并调整策略');
            diagnosis.suggestions.push('使用自适应规划模式');
        }
        else {
            diagnosis.possibleCauses.push('任务接近完成时失败，可能是验证步骤未通过');
            diagnosis.suggestions.push('检查最终验证条件是否合理');
            diagnosis.suggestions.push('尝试放宽验证条件');
        }
        if (result.error) {
            if (result.error.includes('timeout') || result.error.includes('超时')) {
                diagnosis.possibleCauses.push('操作超时，可能是应用响应慢或等待条件未满足');
                diagnosis.suggestions.push('增加超时时间');
                diagnosis.suggestions.push('检查目标应用是否正常运行');
            }
            if (result.error.includes('safety') || result.error.includes('安全')) {
                diagnosis.possibleCauses.push('安全策略阻止了操作');
                diagnosis.suggestions.push('检查安全级别设置');
                diagnosis.suggestions.push('确认操作是否确实安全');
            }
        }
        const anomalyDetections = this.safetyGuard.getAnomalyDetections(3);
        if (anomalyDetections.length > 0) {
            diagnosis.possibleCauses.push(`检测到异常行为: ${anomalyDetections.map((d) => d.type).join(', ')}`);
            diagnosis.suggestions.push('检查是否存在循环操作或快速重复操作');
        }
        this._diagnostics.push(diagnosis);
        if (this._diagnostics.length > 100) {
            this._diagnostics = this._diagnostics.slice(-50);
        }
        Logger_1.Logger.info(`🔍 执行诊断完成: ${diagnosis.possibleCauses.length} 个可能原因, ${diagnosis.suggestions.length} 条建议`, 'ExecAgent');
        return diagnosis;
    }
    getDiagnostics(limit) {
        const diags = [...this._diagnostics];
        return limit ? diags.slice(-limit) : diags;
    }
    estimateProgress() {
        const ctx = this._executionContext;
        if (ctx.totalSteps === 0) return { percent: 0, estimatedRemainingMs: 0 };
        const percent = Math.min(100, Math.round((ctx.stepsCompleted / ctx.totalSteps) * 100));
        const elapsed = Date.now() - ctx.startTime;
        const avgStepMs = ctx.stepsCompleted > 0 ? elapsed / ctx.stepsCompleted : 1000;
        const remaining = (ctx.totalSteps - ctx.stepsCompleted) * avgStepMs;
        return { percent, estimatedRemainingMs: Math.round(remaining) };
    }
    getFullStatus() {
        return {
            isRunning: this.isRunning,
            isPaused: this.safetyGuard.getStatus().isPaused,
            isStopped: this.safetyGuard.getStatus().isStopped,
            currentTaskId: this.currentTaskId,
            safetyStatus: this.safetyGuard.getStatus(),
            dynamicSafety: this.safetyGuard.getDynamicSafetyStatus(),
            executionContext: this.getExecutionContext(),
            progress: this.estimateProgress(),
            historySize: this._executionHistory.length,
            snapshotsSize: this._snapshots.size,
            diagnosticsSize: this._diagnostics.length,
            mcpCapabilities: this.mcpServer.getCapabilities(),
            eventAnalytics: this.eventStream.getAnalytics(),
        };
    }
    async shutdown() {
        try { await this.visionEngine.shutdown(); } catch (e) { Logger_1.Logger.warn(`视觉引擎关闭异常: ${e.message}`, 'ExecAgent'); }
        try { await this.safetyGuard.shutdown(); } catch (e) { Logger_1.Logger.warn(`安全防护关闭异常: ${e.message}`, 'ExecAgent'); }
        try { await this.mcpServer.shutdown(); } catch (e) { Logger_1.Logger.warn(`MCP服务关闭异常: ${e.message}`, 'ExecAgent'); }
        try { await this.eventStream.shutdown(); } catch (e) { Logger_1.Logger.warn(`事件流关闭异常: ${e.message}`, 'ExecAgent'); }
        this._executionHistory = [];
        this._snapshots.clear();
        this._diagnostics = [];
        this.isRunning = false;
        this.initialized = false;
        Logger_1.Logger.info('🤖 DesktopExecutionAgent 已关闭', 'ExecAgent');
    }
}
exports.DesktopExecutionAgent = DesktopExecutionAgent;
DesktopExecutionAgent.instance = null;
let _executionAgentInstance = null;
function getExecutionAgent() {
    if (!_executionAgentInstance) {
        _executionAgentInstance = DesktopExecutionAgent.getInstance();
    }
    return _executionAgentInstance;
}
exports.executionAgent = { get instance() { return getExecutionAgent(); } };

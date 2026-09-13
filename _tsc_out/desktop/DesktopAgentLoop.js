"use strict";
/**
 * DesktopAgentLoop - 桌面智能体循环
 * 观察 → 决策 → 执行 → 验证 → 汇报
 * v3: LLM驱动决策 + 视觉理解 + 错误恢复闭环 + UI元素交互 + 剪贴板操作
 *     + CODEX风格 Sandbox/Snapshot/Manifest (checkpoint恢复 + 安全沙箱 + 工作空间描述)
 * 集成到 JiabaixingCore.processInput()
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopAgentLoop = void 0;
const Logger_1 = require("../utils/Logger");
const DesktopUIInspector_1 = require("./DesktopUIInspector");
const DesktopVisionEngine_1 = require("./DesktopVisionEngine");
const StateSnapshotManager_1 = require("./StateSnapshotManager");
const SystemInput_1 = require("./SystemInput");
const WindowManager_1 = require("./WindowManager");
// F3: 桌面决策不再独立持有 TS LLMProvider（违反 AGENTS.md §0.1），
// 改为路由到 Python 后端的 LLM（经 PythonAgentBridge）。
const bootstrap_1 = require("../server/bootstrap");
const DesktopActionAuthority_1 = require("./DesktopActionAuthority");
const DEFAULT_MANIFEST = {
    workspace: process.cwd(),
    allowedApps: [],
    allowedPaths: ['./'],
    outputDirs: ['./output', './logs'],
    maxActionsPerTask: 20,
    forbiddenActions: [
        'format',
        'del /s',
        'rm -rf',
        'rm -rf /',
        'rm -rf /*',
        'shutdown',
        'restart',
        'reg delete',
        'reg add',
        'net user',
        'net localgroup',
        'cipher /w',
        'diskpart',
        'bcdedit',
        'taskkill /f /im svchost',
    ],
};
class DesktopAgentLoop {
    static instance = null;
    authority;
    visionEngine;
    windowManager;
    systemInput;
    uiInspector;
    snapshotManager;
    manifest;
    config;
    initialized = false;
    isRunning = false;
    lastCheckpointId = null;
    constructor(config) {
        this.authority = DesktopActionAuthority_1.DesktopActionAuthority.getInstance();
        this.visionEngine = DesktopVisionEngine_1.DesktopVisionEngine.getInstance();
        this.windowManager = WindowManager_1.WindowManager.getInstance();
        this.systemInput = SystemInput_1.SystemInput.getInstance();
        this.uiInspector = DesktopUIInspector_1.DesktopUIInspector.getInstance();
        this.snapshotManager = StateSnapshotManager_1.StateSnapshotManager.getInstance();
        this.manifest = { ...DEFAULT_MANIFEST };
        this.config = {
            maxRetries: config?.maxRetries ?? 3,
            verifyAfterAction: config?.verifyAfterAction ?? true,
            autoObserveIntervalMs: config?.autoObserveIntervalMs || 5000,
            enableLLMPlanning: config?.enableLLMPlanning ?? true,
            maxPlanSteps: config?.maxPlanSteps ?? 20,
            enableCheckpoint: config?.enableCheckpoint ?? true,
            sandboxMode: config?.sandboxMode ?? 'moderate',
            executionTimeoutMs: config?.executionTimeoutMs ?? 120000,
        };
    }
    static getInstance(config) {
        if (!DesktopAgentLoop.instance) {
            DesktopAgentLoop.instance = new DesktopAgentLoop(config);
        }
        return DesktopAgentLoop.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🤖 DesktopAgentLoop 初始化', 'DesktopAgentLoop');
        await this.authority.initialize();
        await this.visionEngine.initialize();
        await this.windowManager.initialize();
        await this.systemInput.initialize();
        await this.uiInspector.initialize();
        await this.snapshotManager.initialize();
        if (this.config.enableLLMPlanning && this._bridgeLlmAvailable()) {
            Logger_1.Logger.info('🤖 DesktopAgentLoop 决策将路由到 Python LLM（经 Bridge）', 'DesktopAgentLoop');
        }
        this.initialized = true;
        Logger_1.Logger.info('🤖 DesktopAgentLoop 初始化完成', 'DesktopAgentLoop');
    }
    /**
     * 核心循环：一句话 → 操作桌面 → 完成 → 汇报结果
     * v2: 支持错误恢复闭环（失败后重新观察→重新规划→重试）
     */
    async execute(userInput) {
        this.ensureInitialized();
        this.isRunning = true;
        Logger_1.Logger.info(`🤖 收到桌面操作指令: "${userInput}"`, 'DesktopAgentLoop');
        const observations = [];
        let retryCount = 0;
        const startTime = Date.now();
        const isTimedOut = () => Date.now() - startTime > this.config.executionTimeoutMs;
        try {
            for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
                if (isTimedOut()) {
                    Logger_1.Logger.warn('⏰ 执行超时，终止重试', 'DesktopAgentLoop');
                    this.isRunning = false;
                    return {
                        success: false,
                        taskDescription: userInput,
                        executionResult: {
                            success: false,
                            actions: [],
                            summary: '执行超时',
                        },
                        observations,
                        report: `操作超时 (${this.config.executionTimeoutMs}ms)`,
                        error: 'EXECUTION_TIMEOUT',
                        retryCount,
                    };
                }
                // ═══════════════════════ 1. 观察 ═══════════════════════
                Logger_1.Logger.info('🔍 阶段1: 观察桌面', 'DesktopAgentLoop');
                const observation = await this.visionEngine.observe();
                observations.push(observation);
                // ═══════════════════════ 2. 决策 ═══════════════════════
                Logger_1.Logger.info('🧠 阶段2: 决策规划', 'DesktopAgentLoop');
                let actions;
                if (this.config.enableLLMPlanning && this._bridgeLlmAvailable()) {
                    actions = await this.llmPlanActions(userInput, observation);
                }
                else {
                    Logger_1.Logger.warn('🛡️ Python Bridge 不可用，桌面执行被阻止 (FAIL CLOSED)', 'DesktopAgentLoop');
                    this.isRunning = false;
                    return {
                        success: false,
                        taskDescription: userInput,
                        executionResult: {
                            success: false,
                            actions: [],
                            summary: 'Python Bridge 不可用，桌面执行被阻止',
                        },
                        observations,
                        report: '桌面操作需要 Python 后端支持，当前后端不可用。请检查 Python Agent 状态或重启服务。',
                        error: 'BRIDGE_UNAVAILABLE_FAIL_CLOSED',
                        retryCount,
                    };
                }
                if (actions.length === 0) {
                    this.isRunning = false;
                    return {
                        success: false,
                        taskDescription: userInput,
                        executionResult: {
                            success: false,
                            actions: [],
                            summary: '无法解析操作指令',
                        },
                        observations,
                        report: '我无法理解这个桌面操作指令。请尝试更具体的描述，如"打开记事本并输入Hello"、"点击保存按钮"等。',
                        retryCount,
                    };
                }
                actions = actions.slice(0, this.config.maxPlanSteps);
                // ═══════════ CODEX风格: 安全沙箱检查 ═══════════
                if (this.config.sandboxMode !== 'off') {
                    const unsafeActions = this.filterUnsafeActions(actions);
                    if (unsafeActions.length > 0) {
                        Logger_1.Logger.warn(`🛡️ 沙箱拦截 ${unsafeActions.length} 个不安全动作`, 'DesktopAgentLoop');
                        actions = actions.filter((a) => !unsafeActions.includes(a));
                    }
                }
                if (actions.length === 0) {
                    this.isRunning = false;
                    return {
                        success: false,
                        taskDescription: userInput,
                        executionResult: {
                            success: false,
                            actions: [],
                            summary: '所有动作被安全沙箱拦截',
                        },
                        observations,
                        report: '操作被安全策略拦截。请尝试更安全的操作方式。',
                        retryCount,
                    };
                }
                // ═══════════ CODEX风格: 执行前checkpoint ═══════════
                if (this.config.enableCheckpoint) {
                    try {
                        const checkpoint = await this.snapshotManager.checkpointBeforeAction(userInput);
                        this.lastCheckpointId = checkpoint.snapshotId;
                        Logger_1.Logger.info(`📸 Checkpoint已保存: ${checkpoint.snapshotId}`, 'DesktopAgentLoop');
                    }
                    catch (err) {
                        Logger_1.Logger.warn(`⚠️ Checkpoint保存失败: ${err.message}`, 'DesktopAgentLoop');
                    }
                }
                // ═══════════════════════ 3. 执行 ═══════════════════════
                Logger_1.Logger.info(`🎮 阶段3: 执行 ${actions.length} 个动作 (尝试 ${attempt + 1}/${this.config.maxRetries + 1})`, 'DesktopAgentLoop');
                const executionResult = await this.authority.execute(actions);
                if (executionResult.success) {
                    // ═══════════════════════ 4. 验证 ═══════════════════════
                    if (this.config.verifyAfterAction) {
                        Logger_1.Logger.info('✅ 阶段4: 验证结果', 'DesktopAgentLoop');
                        await this.sleep(500);
                        const finalObservation = await this.visionEngine.observe();
                        observations.push(finalObservation);
                    }
                    const report = this.generateReport(userInput, executionResult, observations);
                    Logger_1.Logger.info('🤖 桌面操作完成', 'DesktopAgentLoop');
                    this.isRunning = false;
                    return {
                        success: true,
                        taskDescription: userInput,
                        executionResult,
                        observations,
                        report,
                        retryCount,
                    };
                }
                // 执行失败 — 判断是否值得重试
                retryCount++;
                if (attempt < this.config.maxRetries) {
                    Logger_1.Logger.warn(`⚠️ 执行失败，准备重新观察并重试 (${retryCount}/${this.config.maxRetries})`, 'DesktopAgentLoop');
                    // ═══════════ CODEX风格: 从checkpoint恢复 ═══════════
                    if (this.config.enableCheckpoint && this.lastCheckpointId) {
                        try {
                            await this.snapshotManager.restoreSnapshot(this.lastCheckpointId, {
                                restoreWindows: true,
                                restoreClipboard: true,
                            });
                            Logger_1.Logger.info(`♻️ 已从Checkpoint恢复: ${this.lastCheckpointId}`, 'DesktopAgentLoop');
                        }
                        catch (restoreErr) {
                            Logger_1.Logger.warn(`⚠️ Checkpoint恢复失败: ${restoreErr.message}`, 'DesktopAgentLoop');
                        }
                    }
                    await this.sleep(1000);
                }
                else {
                    const report = this.generateReport(userInput, executionResult, observations);
                    this.isRunning = false;
                    return {
                        success: false,
                        taskDescription: userInput,
                        executionResult,
                        observations,
                        report: report + `\n\n⚠️ 已重试 ${retryCount} 次仍失败`,
                        error: executionResult.error,
                        retryCount,
                    };
                }
            }
        }
        catch (error) {
            this.isRunning = false;
            Logger_1.Logger.error('❌ DesktopAgentLoop 执行失败', error, 'DesktopAgentLoop');
            return {
                success: false,
                taskDescription: userInput,
                executionResult: {
                    success: false,
                    actions: [],
                    summary: '执行异常',
                    error: error.message,
                },
                observations,
                report: `操作失败: ${error.message}`,
                error: error.message,
                retryCount,
            };
        }
        this.isRunning = false;
        return {
            success: false,
            taskDescription: userInput,
            executionResult: {
                success: false,
                actions: [],
                summary: '未知错误',
            },
            observations,
            report: '操作失败: 未知错误',
            retryCount,
        };
    }
    /**
     * LLM 驱动的动作规划
     * 将桌面观察结果 + 用户指令发给 LLM，返回结构化动作列表
     */
    async llmPlanActions(userInput, observation) {
        if (!this._bridgeLlmAvailable()) {
            Logger_1.Logger.warn('🛡️ llmPlanActions: Bridge 不可用，返回空 (FAIL CLOSED)', 'DesktopAgentLoop');
            return [];
        }
        try {
            const screenshotBase64 = observation.screenshot.success
                ? observation.screenshot.buffer.toString('base64')
                : '';
            const windowList = observation.windows
                .filter((w) => w.isVisible && !w.isMinimized)
                .slice(0, 8)
                .map((w) => `- "${w.title}" (${w.processName}) 位置:(${w.bounds.x},${w.bounds.y}) 尺寸:${w.bounds.width}x${w.bounds.height}`)
                .join('\n');
            let uiElementsContext = '';
            try {
                const elements = this.uiInspector.getInteractiveElements();
                const clickableElements = elements
                    .filter((e) => e.isClickable || e.isEditable)
                    .slice(0, 30)
                    .map((e) => `- "${e.name}" 类型:${e.controlTypeName} 位置:(${e.boundingRect.x},${e.boundingRect.y}) 尺寸:${e.boundingRect.width}x${e.boundingRect.height}${e.isClickable ? ' [可点击]' : ''}${e.isEditable ? ' [可编辑]' : ''}`)
                    .join('\n');
                if (clickableElements) {
                    uiElementsContext = `\n\n可交互UI元素:\n${clickableElements}`;
                }
            }
            catch {
                // UI检查失败不影响规划
            }
            const userPrompt = `用户指令: ${userInput}

当前桌面状态:
窗口列表:
${windowList || '(无可见窗口)'}
${uiElementsContext}
${observation.visionAnalysis.description ? `\n视觉分析: ${observation.visionAnalysis.description}` : ''}

请规划操作步骤。`;
            const images = screenshotBase64
                ? [`data:image/png;base64,${screenshotBase64}`]
                : [];
            const llmResponse = await this._bridgePlan(userPrompt, images);
            const actions = llmResponse ? this.parseLLMActions(llmResponse) : [];
            if (actions.length > 0) {
                Logger_1.Logger.info(`🧠 LLM 规划了 ${actions.length} 个动作`, 'DesktopAgentLoop');
                return actions;
            }
            Logger_1.Logger.warn('⚠️ LLM 规划结果为空，返回空 (FAIL CLOSED，不降级正则)', 'DesktopAgentLoop');
            return [];
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ LLM 规划失败，返回空 (FAIL CLOSED): ${error.message}`, 'DesktopAgentLoop');
            return [];
        }
    }
    /**
     * F3: 经 PythonAgentBridge 调用 Python 端多模态 LLM 做桌面动作规划。
     * Bridge 不可用时返回 null，由调用方降级为正则模式。
     */
    _bridgeLlmAvailable() {
        try {
            return (0, bootstrap_1.getPythonBridge)() != null;
        }
        catch {
            return false;
        }
    }
    async _bridgePlan(userPrompt, images) {
        try {
            const bridge = (0, bootstrap_1.getPythonBridge)();
            if (!bridge)
                return null;
            const result = await bridge.llmMultimodalChat(userPrompt, images);
            return result && result.trim() ? result : null;
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ Bridge 规划调用失败，降级正则模式: ${error.message}`, 'DesktopAgentLoop');
            return null;
        }
    }
    /**
     * 解析 LLM 返回的 JSON 动作列表
     */
    parseLLMActions(llmResponse) {
        try {
            const jsonMatch = llmResponse.match(/\[[\s\S]*\]/);
            if (!jsonMatch)
                return [];
            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed))
                return [];
            const validTypes = new Set([
                'screenshot',
                'click',
                'rightClick',
                'type',
                'key',
                'keyCombo',
                'moveMouse',
                'scroll',
                'drag',
                'openApp',
                'activateWindow',
                'closeWindow',
                'maximize',
                'minimize',
                'observe',
                'wait',
                'shell',
                'clipboardRead',
                'clipboardWrite',
                'clickElement',
                'typeIntoElement',
                'getElementText',
            ]);
            return parsed
                .filter((item) => item.type && validTypes.has(item.type) && item.params)
                .map((item) => ({
                type: item.type,
                params: item.params || {},
                description: item.description || `${item.type}`,
            }));
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ 解析 LLM 动作失败: ${error.message}`, 'DesktopAgentLoop');
            return [];
        }
    }
    /**
     * 正则模式：自然语言 → 动作规划（LLM 不可用时的降级方案）
     */
    planActions(input, observation) {
        void observation;
        const lower = input.toLowerCase().trim();
        const actions = [];
        if (/看看|观察|截图|屏幕|桌面/.test(lower)) {
            actions.push({ type: 'observe', params: {}, description: '观察桌面' });
            return actions;
        }
        if (/记事本|notepad/.test(lower)) {
            const textMatch = lower.match(/输入[""']([^""']+)[""']/);
            const text = textMatch ? textMatch[1] : 'Hello from jiabaixing!';
            const saveMatch = lower.match(/保存[到为]?\s*([\w\\\.:\/]+)/);
            const savePath = saveMatch ? saveMatch[1] : undefined;
            actions.push({
                type: 'shell',
                params: { command: 'start notepad' },
                description: '打开记事本',
            }, { type: 'wait', params: { ms: 1000 }, description: '等待启动' });
            if (/输入|打字|写/.test(lower)) {
                actions.push({
                    type: 'type',
                    params: { text },
                    description: '输入文字',
                });
            }
            if (savePath) {
                actions.push({ type: 'key', params: { key: 'CTRL' }, description: 'Ctrl' }, { type: 'key', params: { key: 'S' }, description: 'S' }, { type: 'wait', params: { ms: 500 }, description: '等待对话框' }, { type: 'type', params: { text: savePath }, description: '输入路径' }, { type: 'key', params: { key: 'ENTER' }, description: '确认' });
            }
            return actions;
        }
        const clickMatch = lower.match(/点击\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/);
        if (clickMatch) {
            const x = parseInt(clickMatch[1]);
            const y = parseInt(clickMatch[2]);
            actions.push({
                type: 'moveMouse',
                params: { x, y },
                description: `移动 (${x},${y})`,
            }, { type: 'click', params: { x, y }, description: '点击' });
            return actions;
        }
        if (/点击.*中央|点击.*中间|点击.*中心/.test(lower)) {
            const screen = this.windowManager.getScreenSize();
            const cx = Math.floor(screen.width / 2);
            const cy = Math.floor(screen.height / 2);
            actions.push({
                type: 'moveMouse',
                params: { x: cx, y: cy },
                description: `移动到中央 (${cx},${cy})`,
            }, { type: 'click', params: { x: cx, y: cy }, description: '点击中央' });
            return actions;
        }
        const appMatch = lower.match(/打开\s*(.+)/);
        if (appMatch) {
            const app = appMatch[1].trim();
            actions.push({ type: 'openApp', params: { app }, description: `打开 ${app}` }, { type: 'wait', params: { ms: 2000 }, description: '等待启动' }, { type: 'observe', params: {}, description: '观察结果' });
            return actions;
        }
        const activateMatch = lower.match(/激活|切换到|聚焦\s*(.+)/);
        if (activateMatch) {
            const title = activateMatch[1].trim();
            actions.push({
                type: 'activateWindow',
                params: { title },
                description: `激活 ${title}`,
            });
            return actions;
        }
        const closeMatch = lower.match(/关闭\s*(.+)/);
        if (closeMatch) {
            const title = closeMatch[1].trim();
            actions.push({
                type: 'closeWindow',
                params: { title },
                description: `关闭 ${title}`,
            });
            return actions;
        }
        const scrollMatch = lower.match(/滚动\s*([\d-]+)/);
        if (scrollMatch) {
            const delta = parseInt(scrollMatch[1]);
            actions.push({
                type: 'scroll',
                params: { delta },
                description: `滚动 ${delta}`,
            });
            return actions;
        }
        const dragMatch = lower.match(/拖拽\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?\s*到\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/);
        if (dragMatch) {
            actions.push({
                type: 'drag',
                params: {
                    fromX: parseInt(dragMatch[1]),
                    fromY: parseInt(dragMatch[2]),
                    toX: parseInt(dragMatch[3]),
                    toY: parseInt(dragMatch[4]),
                },
                description: '拖拽',
            });
            return actions;
        }
        const typeMatch = lower.match(/输入[""']([^""']+)[""']/);
        if (typeMatch) {
            actions.push({
                type: 'type',
                params: { text: typeMatch[1] },
                description: `输入 "${typeMatch[1]}"`,
            });
            return actions;
        }
        const keyMatch = lower.match(/按\s*(.+)/);
        if (keyMatch) {
            const key = keyMatch[1].trim().toUpperCase();
            actions.push({
                type: 'key',
                params: { key },
                description: `按键 ${key}`,
            });
            return actions;
        }
        if (/截图|拍照|capture/.test(lower)) {
            actions.push({ type: 'screenshot', params: {}, description: '截图' });
            return actions;
        }
        if (/复制|拷贝|copy/.test(lower)) {
            actions.push({
                type: 'clipboardRead',
                params: {},
                description: '读取剪贴板',
            });
            return actions;
        }
        if (/粘贴|paste/.test(lower)) {
            actions.push({
                type: 'keyCombo',
                params: { keys: ['CTRL', 'V'] },
                description: 'Ctrl+V 粘贴',
            });
            return actions;
        }
        return actions;
    }
    /**
     * 生成汇报
     */
    generateReport(taskDescription, executionResult, observations) {
        let report = `🎯 任务: "${taskDescription}"\n\n`;
        if (executionResult.success) {
            report += '✅ 执行成功\n\n';
        }
        else {
            report += `⚠️ 执行遇到问题: ${executionResult.error || '部分动作失败'}\n\n`;
        }
        report += `📊 执行详情:\n`;
        executionResult.actions.forEach((action, i) => {
            const icon = action.success ? '✅' : '❌';
            report += `  ${icon} ${i + 1}. ${action.action.description || action.action.type}\n`;
            if (action.output) {
                report += `     ${action.output.substring(0, 80)}\n`;
            }
            if (action.error) {
                report += `     错误: ${action.error}\n`;
            }
        });
        if (observations.length > 0) {
            const latest = observations[observations.length - 1];
            report += `\n👁️ 桌面状态:\n`;
            report += `  窗口数: ${latest.windows.length}\n`;
            report += `  ${this.visionEngine.generateReport(latest).substring(0, 200)}\n`;
        }
        return report;
    }
    isExecuting() {
        return this.isRunning;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('DesktopAgentLoop 未初始化！请先调用 initialize()');
        }
    }
    async shutdown() {
        this.isRunning = false;
        this.snapshotManager.dispose();
        this.initialized = false;
        Logger_1.Logger.info('🤖 DesktopAgentLoop 已关闭', 'DesktopAgentLoop');
    }
    /**
     * CODEX风格: 安全沙箱过滤
     * 检查动作是否违反 Manifest 中的安全策略
     */
    filterUnsafeActions(actions) {
        const unsafe = [];
        for (const action of actions) {
            if (action.type === 'shell') {
                const command = (action.params.command || '').toLowerCase();
                for (const forbidden of this.manifest.forbiddenActions) {
                    if (command.includes(forbidden.toLowerCase())) {
                        unsafe.push(action);
                        Logger_1.Logger.warn(`🛡️ 拦截危险命令: "${command}" (匹配规则: ${forbidden})`, 'DesktopAgentLoop');
                        break;
                    }
                }
            }
            if (this.config.sandboxMode === 'strict') {
                if (action.type === 'shell' && this.manifest.allowedApps.length > 0) {
                    const command = (action.params.command || '').toLowerCase();
                    const isAllowed = this.manifest.allowedApps.some((app) => command.includes(app.toLowerCase()));
                    if (!isAllowed) {
                        unsafe.push(action);
                    }
                }
            }
        }
        return unsafe;
    }
    /**
     * 更新 Manifest（工作空间描述）
     */
    updateManifest(manifest) {
        Object.assign(this.manifest, manifest);
        Logger_1.Logger.info('📋 Manifest 已更新', 'DesktopAgentLoop');
    }
    /**
     * 获取当前 Manifest
     */
    getManifest() {
        return { ...this.manifest };
    }
    /**
     * 手动恢复到最近的 checkpoint
     */
    async restoreLastCheckpoint() {
        if (!this.lastCheckpointId) {
            Logger_1.Logger.warn('⚠️ 没有可用的 Checkpoint', 'DesktopAgentLoop');
            return false;
        }
        try {
            const result = await this.snapshotManager.restoreSnapshot(this.lastCheckpointId);
            return result.success;
        }
        catch (error) {
            Logger_1.Logger.error('❌ Checkpoint恢复失败', error, 'DesktopAgentLoop');
            return false;
        }
    }
}
exports.DesktopAgentLoop = DesktopAgentLoop;
exports.default = DesktopAgentLoop;

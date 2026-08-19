"use strict";
/**
 * DesktopActionExecutor - 桌面操作执行器
 * 统一封装：截图 + 窗口管理 + 鼠标键盘操作 + UI元素交互 + 剪贴板
 * v3: 推进能力边界增强
 *   - 新增动作类型: doubleClick, hover, waitForElement, scrollToElement,
 *     selectAll, copy, paste, selectAllAndCopy, resizeWindow, setFocus
 *   - 自适应指数退避重试 (可配置最大重试次数、退避倍率)
 *   - 动作前置条件校验 (窗口/元素存在性检查)
 *   - 动作录制/回放系统 (录制动作序列用于技能学习)
 *   - 并行执行支持 (独立动作并发执行)
 *   - 执行指标采集 (成功率、耗时分布、动作频率统计)
 *   v2: rightClick, keyCombo, clipboardRead, clipboardWrite,
 *       clickElement, typeIntoElement, getElementText
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopActionExecutor = void 0;
const ScreenCapture_1 = require("./ScreenCapture");
const WindowManager_1 = require("./WindowManager");
const SystemInput_1 = require("./SystemInput");
const DesktopVisionEngine_1 = require("./DesktopVisionEngine");
const DesktopUIInspector_1 = require("./DesktopUIInspector");
const Logger_1 = require("../utils/Logger");
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 2,
    baseDelayMs: 300,
    backoffMultiplier: 2.0,
    retryableTypes: new Set([
        'click', 'rightClick', 'doubleClick', 'type', 'key', 'keyCombo',
        'clickElement', 'typeIntoElement', 'activateWindow', 'hover',
        'waitForElement', 'scrollToElement', 'paste',
    ]),
};
const DEFAULT_METRICS = {
    totalActions: 0,
    successActions: 0,
    failedActions: 0,
    retriedActions: 0,
    totalDurationMs: 0,
    actionTypeCounts: {},
    recentErrors: [],
};
const DANGEROUS_SHELL_COMMANDS = [
    'rm -rf', 'del /s /q', 'format', 'shutdown', 'rmdir /s /q',
    'rd /s /q', 'taskkill /f /im', 'reg delete', 'reg add',
    'net user', 'net localgroup', 'cipher /w',
];
class DesktopActionExecutor {
    constructor() {
        this.initialized = false;
        this.screenCapture = ScreenCapture_1.ScreenCapture.getInstance();
        this.windowManager = WindowManager_1.WindowManager.getInstance();
        this.systemInput = SystemInput_1.SystemInput.getInstance();
        this.visionEngine = DesktopVisionEngine_1.DesktopVisionEngine.getInstance();
        this.uiInspector = DesktopUIInspector_1.DesktopUIInspector.getInstance();
        this._retryConfig = { ...DEFAULT_RETRY_CONFIG };
        this._metrics = { ...DEFAULT_METRICS, actionTypeCounts: {}, recentErrors: [] };
        this._recording = null;
        this._recordings = new Map();
        this._middlewareBefore = [];
        this._middlewareAfter = [];
    }
    static getInstance() {
        if (!DesktopActionExecutor.instance) {
            DesktopActionExecutor.instance = new DesktopActionExecutor();
        }
        return DesktopActionExecutor.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🎮 DesktopActionExecutor 初始化', 'DesktopActionExecutor');
        await this.screenCapture.initialize();
        await this.windowManager.initialize();
        await this.systemInput.initialize();
        await this.visionEngine.initialize();
        await this.uiInspector.initialize();
        this.initialized = true;
        Logger_1.Logger.info('🎮 DesktopActionExecutor 初始化完成', 'DesktopActionExecutor');
    }
    configureRetry(config) {
        this._retryConfig = { ...this._retryConfig, ...config };
        Logger_1.Logger.info(`🎮 重试配置已更新: maxRetries=${this._retryConfig.maxRetries}, baseDelay=${this._retryConfig.baseDelayMs}ms`, 'DesktopActionExecutor');
    }
    useMiddleware(phase, fn) {
        if (phase === 'before') {
            this._middlewareBefore.push(fn);
        }
        else {
            this._middlewareAfter.push(fn);
        }
        return this;
    }
    startRecording(name) {
        this._recording = { name, actions: [], startTime: Date.now() };
        Logger_1.Logger.info(`🎬 开始录制: ${name}`, 'DesktopActionExecutor');
    }
    stopRecording() {
        if (!this._recording)
            return null;
        const rec = { ...this._recording, endTime: Date.now(), durationMs: Date.now() - this._recording.startTime };
        this._recordings.set(rec.name, rec);
        this._recording = null;
        Logger_1.Logger.info(`🎬 录制完成: ${rec.name} (${rec.actions.length} 个动作, ${rec.durationMs}ms)`, 'DesktopActionExecutor');
        return rec;
    }
    getRecording(name) {
        return this._recordings.get(name) || null;
    }
    async replayRecording(name, params) {
        const rec = this._recordings.get(name);
        if (!rec) {
            Logger_1.Logger.warn(`🎬 录制不存在: ${name}`, 'DesktopActionExecutor');
            return { success: false, actions: [], summary: `录制不存在: ${name}`, finalObservation: undefined };
        }
        let actions = rec.actions;
        if (params) {
            actions = actions.map((a) => {
                const resolved = { ...a, params: { ...a.params } };
                for (const [key, val] of Object.entries(params)) {
                    for (const [pk, pv] of Object.entries(resolved.params)) {
                        if (typeof pv === 'string' && pv.includes(`{{${key}}}`)) {
                            resolved.params[pk] = pv.replace(`{{${key}}}`, val);
                        }
                    }
                }
                return resolved;
            });
        }
        Logger_1.Logger.info(`🎬 回放录制: ${name} (${actions.length} 个动作)`, 'DesktopActionExecutor');
        return this.executeTask(actions);
    }
    getMetrics() {
        const m = this._metrics;
        const successRate = m.totalActions > 0 ? m.successActions / m.totalActions : 0;
        const avgDuration = m.totalActions > 0 ? m.totalDurationMs / m.totalActions : 0;
        return { ...m, successRate, avgDurationMs: avgDuration };
    }
    resetMetrics() {
        this._metrics = { ...DEFAULT_METRICS, actionTypeCounts: {}, recentErrors: [] };
    }
    async executeParallel(actionsGroups) {
        const allResults = [];
        const groups = await Promise.allSettled(actionsGroups.map((group) => this.executeTask(group.actions)));
        for (let i = 0; i < groups.length; i++) {
            const settled = groups[i];
            const groupResult = settled.status === 'fulfilled'
                ? settled.value
                : { success: false, actions: [], summary: `并行组 ${i} 异常: ${settled.reason?.message || '未知'}`, finalObservation: undefined };
            allResults.push({ group: actionsGroups[i].name || `group_${i}`, result: groupResult });
        }
        const totalSuccess = allResults.filter((r) => r.result.success).length;
        return {
            success: totalSuccess === allResults.length,
            groups: allResults,
            summary: `并行执行完成: ${totalSuccess}/${allResults.length} 组成功`,
        };
    }
    async validatePrecondition(action) {
        if (action.type === 'activateWindow' || action.type === 'closeWindow' || action.type === 'maximize' || action.type === 'minimize' || action.type === 'resizeWindow' || action.type === 'setFocus') {
            const title = action.params?.title;
            if (title) {
                const win = await this.windowManager.findWindow(title);
                if (!win) {
                    return { valid: false, reason: `前置条件不满足: 窗口 "${title}" 不存在` };
                }
            }
        }
        if (action.type === 'clickElement' || action.type === 'typeIntoElement' || action.type === 'getElementText' || action.type === 'scrollToElement') {
            const desc = action.params?.description;
            if (desc && action.params?.skipPrecheck !== true) {
                const elem = await this.uiInspector.findElementByDescription(desc);
                if (!elem) {
                    return { valid: false, reason: `前置条件不满足: UI元素 "${desc}" 未找到` };
                }
            }
        }
        return { valid: true };
    }
    _recordAction(action, result) {
        if (this._recording) {
            this._recording.actions.push({
                ...action,
                _timestamp: Date.now(),
                _success: result.success,
            });
        }
    }
    _updateMetrics(action, result, durationMs, retried) {
        this._metrics.totalActions++;
        if (result.success)
            this._metrics.successActions++;
        else
            this._metrics.failedActions++;
        if (retried)
            this._metrics.retriedActions++;
        this._metrics.totalDurationMs += durationMs;
        const type = action.type;
        this._metrics.actionTypeCounts[type] = (this._metrics.actionTypeCounts[type] || 0) + 1;
        if (!result.success) {
            this._metrics.recentErrors.push({
                type,
                error: result.error || '未知错误',
                timestamp: Date.now(),
            });
            if (this._metrics.recentErrors.length > 50) {
                this._metrics.recentErrors.shift();
            }
        }
    }
    async executeAction(action) {
        this.ensureInitialized();
        const actionStart = Date.now();
        Logger_1.Logger.info(`🎮 执行: ${action.description || action.type}`, 'DesktopActionExecutor');
        for (const mw of this._middlewareBefore) {
            try {
                const verdict = await mw(action);
                if (verdict && !verdict.proceed) {
                    const failResult = { success: false, action, error: verdict.reason || '前置中间件拦截' };
                    this._recordAction(action, failResult);
                    this._updateMetrics(action, failResult, Date.now() - actionStart, false);
                    return failResult;
                }
            }
            catch { }
        }
        const precondition = await this.validatePrecondition(action);
        if (!precondition.valid) {
            Logger_1.Logger.warn(`⚠️ ${precondition.reason}`, 'DesktopActionExecutor');
            const failResult = { success: false, action, error: precondition.reason };
            this._recordAction(action, failResult);
            this._updateMetrics(action, failResult, Date.now() - actionStart, false);
            return failResult;
        }
        try {
            let result;
            switch (action.type) {
                case 'screenshot':
                    result = await this.handleScreenshot(action);
                    break;
                case 'click':
                    result = await this.handleClick(action);
                    break;
                case 'rightClick':
                    result = await this.handleRightClick(action);
                    break;
                case 'doubleClick':
                    result = await this.handleDoubleClick(action);
                    break;
                case 'hover':
                    result = await this.handleHover(action);
                    break;
                case 'type':
                    result = await this.handleType(action);
                    break;
                case 'key':
                    result = await this.handleKey(action);
                    break;
                case 'keyCombo':
                    result = await this.handleKeyCombo(action);
                    break;
                case 'moveMouse':
                    result = await this.handleMoveMouse(action);
                    break;
                case 'scroll':
                    result = await this.handleScroll(action);
                    break;
                case 'drag':
                    result = await this.handleDrag(action);
                    break;
                case 'openApp':
                    result = await this.handleOpenApp(action);
                    break;
                case 'activateWindow':
                    result = await this.handleActivateWindow(action);
                    break;
                case 'closeWindow':
                    result = await this.handleCloseWindow(action);
                    break;
                case 'maximize':
                    result = await this.handleMaximize(action);
                    break;
                case 'minimize':
                    result = await this.handleMinimize(action);
                    break;
                case 'resizeWindow':
                    result = await this.handleResizeWindow(action);
                    break;
                case 'setFocus':
                    result = await this.handleSetFocus(action);
                    break;
                case 'observe':
                    result = await this.handleObserve(action);
                    break;
                case 'wait':
                    result = await this.handleWait(action);
                    break;
                case 'waitForElement':
                    result = await this.handleWaitForElement(action);
                    break;
                case 'scrollToElement':
                    result = await this.handleScrollToElement(action);
                    break;
                case 'shell':
                    result = await this.handleShell(action);
                    break;
                case 'clipboardRead':
                    result = await this.handleClipboardRead(action);
                    break;
                case 'clipboardWrite':
                    result = await this.handleClipboardWrite(action);
                    break;
                case 'selectAll':
                    result = await this.handleSelectAll(action);
                    break;
                case 'copy':
                    result = await this.handleCopy(action);
                    break;
                case 'paste':
                    result = await this.handlePaste(action);
                    break;
                case 'selectAllAndCopy':
                    result = await this.handleSelectAllAndCopy(action);
                    break;
                case 'clickElement':
                    result = await this.handleClickElement(action);
                    break;
                case 'typeIntoElement':
                    result = await this.handleTypeIntoElement(action);
                    break;
                case 'getElementText':
                    result = await this.handleGetElementText(action);
                    break;
                default:
                    result = { success: false, action, error: `未知动作类型: ${action.type}` };
            }
            for (const mw of this._middlewareAfter) {
                try {
                    await mw(action, result);
                }
                catch { }
            }
            this._recordAction(action, result);
            this._updateMetrics(action, result, Date.now() - actionStart, false);
            return result;
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 动作执行失败: ${action.type}`, error, 'DesktopActionExecutor');
            const failResult = { success: false, action, error: error.message };
            this._recordAction(action, failResult);
            this._updateMetrics(action, failResult, Date.now() - actionStart, false);
            return failResult;
        }
    }
    /**
     * 执行动作序列
     *
     * v3 增强特性：
     * - 自适应指数退避重试：可配置最大重试次数、退避倍率
     * - 错误恢复：非关键动作失败后可选择继续
     * - 执行统计：记录成功率、耗时等
     * - 动作间延迟可配置
     */
    async executeTask(actions) {
        Logger_1.Logger.info(`🎮 开始执行任务，共 ${actions.length} 个动作`, 'DesktopActionExecutor');
        const results = [];
        let finalObservation;
        const { maxRetries, baseDelayMs, backoffMultiplier, retryableTypes } = this._retryConfig;
        for (const action of actions) {
            let result = await this.executeAction(action);
            if (!result.success && retryableTypes.has(action.type)) {
                let retried = false;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                    Logger_1.Logger.info(`🔄 重试动作 (${attempt}/${maxRetries}): ${action.description || action.type} (${delay}ms后)`, 'DesktopActionExecutor');
                    await this.sleep(delay);
                    result = await this.executeAction(action);
                    if (result.success) {
                        result.output = `(重试${attempt}次成功) ${result.output || ''}`;
                        retried = true;
                        break;
                    }
                }
                if (!retried && maxRetries > 0) {
                    this._metrics.retriedActions++;
                }
            }
            results.push(result);
            if (result.observation) {
                finalObservation = result.observation;
            }
            if (!result.success) {
                const isCritical = !action.optional;
                if (isCritical) {
                    Logger_1.Logger.warn(`⚠️ 关键动作失败，停止执行: ${action.description || action.type}`, 'DesktopActionExecutor');
                    return {
                        success: false,
                        actions: results,
                        summary: `执行失败: ${result.error || '未知错误'}`,
                        finalObservation,
                    };
                }
                Logger_1.Logger.warn(`⚠️ 可选动作失败，继续执行: ${action.description || action.type}`, 'DesktopActionExecutor');
            }
            const interDelay = action._interDelay ?? 200;
            if (interDelay > 0) {
                await this.sleep(interDelay);
            }
        }
        try {
            finalObservation = await this.visionEngine.observe();
        }
        catch {
        }
        const successCount = results.filter((r) => r.success).length;
        const summary = `执行完成: ${successCount}/${results.length} 个动作成功`;
        Logger_1.Logger.info(`🎮 ${summary}`, 'DesktopActionExecutor');
        return {
            success: successCount === results.length,
            actions: results,
            summary,
            finalObservation,
        };
    }
    // ═════════════════════════ 动作处理器 ═════════════════════════
    async handleScreenshot(action) {
        const result = await this.screenCapture.captureFullScreen();
        return {
            success: result.success,
            action,
            output: result.success
                ? `截图完成: ${result.buffer.length} bytes`
                : result.error,
        };
    }
    async handleClick(action) {
        const x = action.params.x;
        const y = action.params.y;
        if (x !== undefined && (typeof x !== 'number' || x < 0)) {
            return { success: false, action, error: `无效X坐标: ${x}` };
        }
        if (y !== undefined && (typeof y !== 'number' || y < 0)) {
            return { success: false, action, error: `无效Y坐标: ${y}` };
        }
        const result = await this.systemInput.click(x, y);
        return {
            success: result.success,
            action,
            output: `点击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
            error: result.error,
        };
    }
    async handleType(action) {
        const text = action.params.text;
        const result = await this.systemInput.typeText(text);
        return {
            success: result.success,
            action,
            output: `输入文字: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
            error: result.error,
        };
    }
    async handleKey(action) {
        const key = action.params.key;
        const keyCode = SystemInput_1.SystemInput.Keys[key.toUpperCase()];
        if (!keyCode) {
            return { success: false, action, error: `未知按键: ${key}` };
        }
        const result = await this.systemInput.keyPress(keyCode);
        return {
            success: result.success,
            action,
            output: `按键: ${key}`,
            error: result.error,
        };
    }
    async handleMoveMouse(action) {
        const x = action.params.x;
        const y = action.params.y;
        const result = await this.systemInput.moveMouse(x, y);
        return {
            success: result.success,
            action,
            output: `移动鼠标到 (${x}, ${y})`,
            error: result.error,
        };
    }
    async handleScroll(action) {
        const delta = action.params.delta;
        const result = await this.systemInput.scroll(delta);
        return {
            success: result.success,
            action,
            output: `滚动: ${delta}`,
            error: result.error,
        };
    }
    async handleDrag(action) {
        const fromX = action.params.fromX;
        const fromY = action.params.fromY;
        const toX = action.params.toX;
        const toY = action.params.toY;
        if (typeof fromX !== 'number' || typeof fromY !== 'number' ||
            typeof toX !== 'number' || typeof toY !== 'number') {
            return { success: false, action, error: '拖拽坐标参数无效' };
        }
        const result = await this.systemInput.drag(fromX, fromY, toX, toY);
        return {
            success: result.success,
            action,
            output: `拖拽: (${fromX},${fromY}) → (${toX},${toY})`,
            error: result.error,
        };
    }
    async handleOpenApp(action) {
        const appName = action.params.app;
        const appArgs = action.params.args || [];
        if (!appName || typeof appName !== 'string') {
            return { success: false, action, error: '应用名称无效' };
        }
        if (/[;&|`$]/.test(appName)) {
            return { success: false, action, error: `应用名称包含非法字符: ${appName}` };
        }
        for (const arg of appArgs) {
            if (typeof arg !== 'string' || /[;&|`$]/.test(arg)) {
                return { success: false, action, error: `应用参数包含非法字符: ${arg}` };
            }
        }
        try {
            const safeAppName = appName.replace(/'/g, "''");
            const safeArgs = appArgs.map((a) => a.replace(/'/g, "''"));
            const argsPart = safeArgs.length > 0 ? ` -ArgumentList '${safeArgs.join("','")}'` : '';
            const psScript = `Start-Process -FilePath '${safeAppName}'${argsPart}`;
            await this.systemInput.executePs(psScript, 10000);
            return {
                success: true,
                action,
                output: `打开应用: ${appName}`,
            };
        }
        catch (error) {
            return {
                success: false,
                action,
                error: error.message,
            };
        }
    }
    async handleActivateWindow(action) {
        const title = action.params.title;
        const result = await this.windowManager.activateWindowByTitle(title);
        return {
            success: result.success,
            action,
            output: `激活窗口: ${title}`,
            error: result.error,
        };
    }
    async handleCloseWindow(action) {
        const title = action.params.title;
        const window = await this.windowManager.findWindow(title);
        if (!window) {
            return { success: false, action, error: `未找到窗口: ${title}` };
        }
        try {
            const result = await this.windowManager.closeWindow(window.handle);
            return {
                success: result.success,
                action,
                output: `关闭窗口: ${title}`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleMaximize(action) {
        const title = action.params.title;
        const window = await this.windowManager.findWindow(title);
        if (!window) {
            return { success: false, action, error: `未找到窗口: ${title}` };
        }
        const result = await this.windowManager.maximizeWindow(window.handle);
        return {
            success: result.success,
            action,
            output: `最大化窗口: ${title}`,
            error: result.error,
        };
    }
    async handleMinimize(action) {
        const title = action.params.title;
        const window = await this.windowManager.findWindow(title);
        if (!window) {
            return { success: false, action, error: `未找到窗口: ${title}` };
        }
        const result = await this.windowManager.minimizeWindow(window.handle);
        return {
            success: result.success,
            action,
            output: `最小化窗口: ${title}`,
            error: result.error,
        };
    }
    async handleObserve(action) {
        const observation = await this.visionEngine.observe();
        return {
            success: true,
            action,
            output: this.visionEngine.generateReport(observation),
            observation,
        };
    }
    async handleWait(action) {
        const ms = action.params.ms;
        if (typeof ms !== 'number' || ms < 0) {
            return { success: false, action, error: `无效等待时间: ${ms}` };
        }
        const cappedMs = Math.min(ms, 60000);
        await this.sleep(cappedMs);
        return {
            success: true,
            action,
            output: `等待 ${cappedMs}ms`,
        };
    }
    async handleRightClick(action) {
        const x = action.params.x;
        const y = action.params.y;
        if (x !== undefined && (typeof x !== 'number' || x < 0)) {
            return { success: false, action, error: `无效X坐标: ${x}` };
        }
        if (y !== undefined && (typeof y !== 'number' || y < 0)) {
            return { success: false, action, error: `无效Y坐标: ${y}` };
        }
        const result = await this.systemInput.rightClick(x, y);
        return {
            success: result.success,
            action,
            output: `右键点击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
            error: result.error,
        };
    }
    async handleKeyCombo(action) {
        const keys = action.params.keys;
        if (!keys || !Array.isArray(keys) || keys.length < 2) {
            return { success: false, action, error: 'keyCombo 需要至少2个按键' };
        }
        try {
            const keyCodes = keys.map((k) => {
                const code = SystemInput_1.SystemInput.Keys[k.toUpperCase()];
                if (!code)
                    throw new Error(`未知按键: ${k}`);
                return code;
            });
            const result = await this.systemInput.keyCombo(...keyCodes);
            return {
                success: result.success,
                action,
                output: `组合键: ${keys.join('+')}`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleClipboardRead(action) {
        try {
            const content = await this.systemInput.executePs('Get-Clipboard', 5000);
            return {
                success: true,
                action,
                output: content.substring(0, 500),
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleClipboardWrite(action) {
        const text = action.params.text;
        try {
            const escaped = text.replace(/'/g, "''");
            await this.systemInput.executePs(`Set-Clipboard -Value '${escaped}'`, 5000);
            return {
                success: true,
                action,
                output: `写入剪贴板: ${text.substring(0, 50)}`,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleClickElement(action) {
        const description = action.params.description;
        try {
            const element = await this.uiInspector.findElementByDescription(description);
            if (!element) {
                return {
                    success: false,
                    action,
                    error: `未找到UI元素: ${description}`,
                };
            }
            const clickX = element.boundingRect.x + Math.floor(element.boundingRect.width / 2);
            const clickY = element.boundingRect.y + Math.floor(element.boundingRect.height / 2);
            const result = await this.systemInput.click(clickX, clickY);
            return {
                success: result.success,
                action,
                output: `点击元素 "${description}" 于 (${clickX}, ${clickY})`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleTypeIntoElement(action) {
        const description = action.params.description;
        const text = action.params.text;
        try {
            const element = await this.uiInspector.findElementByDescription(description);
            if (!element) {
                return {
                    success: false,
                    action,
                    error: `未找到UI元素: ${description}`,
                };
            }
            const clickX = element.boundingRect.x + Math.floor(element.boundingRect.width / 2);
            const clickY = element.boundingRect.y + Math.floor(element.boundingRect.height / 2);
            await this.systemInput.click(clickX, clickY);
            await this.sleep(200);
            const result = await this.systemInput.typeText(text);
            return {
                success: result.success,
                action,
                output: `在 "${description}" 中输入: ${text.substring(0, 50)}`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleGetElementText(action) {
        const description = action.params.description;
        try {
            const element = await this.uiInspector.findElementByDescription(description);
            if (!element) {
                return {
                    success: false,
                    action,
                    error: `未找到UI元素: ${description}`,
                };
            }
            return {
                success: true,
                action,
                output: element.name || '(无文本)',
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    // ═════════════════════════ v3 新增动作处理器 ═════════════════════════
    async handleDoubleClick(action) {
        const x = action.params.x;
        const y = action.params.y;
        if (x !== undefined && (typeof x !== 'number' || x < 0)) {
            return { success: false, action, error: `无效X坐标: ${x}` };
        }
        if (y !== undefined && (typeof y !== 'number' || y < 0)) {
            return { success: false, action, error: `无效Y坐标: ${y}` };
        }
        try {
            const result = await this.systemInput.doubleClick(x, y);
            return {
                success: result.success,
                action,
                output: `双击 (${x ?? '当前位置'}, ${y ?? '当前位置'})`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleHover(action) {
        const x = action.params.x;
        const y = action.params.y;
        const durationMs = action.params.durationMs ?? 500;
        try {
            const moveResult = await this.systemInput.moveMouse(x, y);
            if (!moveResult.success) {
                return { success: false, action, error: moveResult.error };
            }
            await this.sleep(durationMs);
            return {
                success: true,
                action,
                output: `悬停 (${x}, ${y}) ${durationMs}ms`,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleWaitForElement(action) {
        const description = action.params.description;
        const timeoutMs = action.params.timeoutMs ?? 10000;
        const intervalMs = action.params.intervalMs ?? 500;
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                const element = await this.uiInspector.findElementByDescription(description);
                if (element) {
                    return {
                        success: true,
                        action,
                        output: `元素 "${description}" 已出现 (${Date.now() - startTime}ms)`,
                    };
                }
            }
            catch { }
            await this.sleep(intervalMs);
        }
        return {
            success: false,
            action,
            error: `等待元素超时: "${description}" (${timeoutMs}ms)`,
        };
    }
    async handleScrollToElement(action) {
        const description = action.params.description;
        try {
            const element = await this.uiInspector.findElementByDescription(description);
            if (!element) {
                return {
                    success: false,
                    action,
                    error: `未找到UI元素: ${description}`,
                };
            }
            const centerX = element.boundingRect.x + Math.floor(element.boundingRect.width / 2);
            const centerY = element.boundingRect.y + Math.floor(element.boundingRect.height / 2);
            const screenSize = await this.windowManager.getScreenSize();
            const screenH = screenSize.height || 1080;
            if (centerY < 0 || centerY > screenH) {
                const scrollDelta = centerY < 0 ? 120 * 5 : -120 * 5;
                await this.systemInput.scroll(scrollDelta);
                await this.sleep(300);
            }
            await this.systemInput.moveMouse(centerX, Math.max(0, Math.min(centerY, screenH)));
            await this.sleep(100);
            return {
                success: true,
                action,
                output: `滚动到元素 "${description}" 于 (${centerX}, ${centerY})`,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleSelectAll(action) {
        try {
            await this.systemInput.keyCombo(SystemInput_1.SystemInput.Keys.CTRL, SystemInput_1.SystemInput.Keys.A);
            return { success: true, action, output: '全选 (Ctrl+A)' };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleCopy(action) {
        try {
            await this.systemInput.keyCombo(SystemInput_1.SystemInput.Keys.CTRL, SystemInput_1.SystemInput.Keys.C);
            return { success: true, action, output: '复制 (Ctrl+C)' };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handlePaste(action) {
        try {
            await this.systemInput.keyCombo(SystemInput_1.SystemInput.Keys.CTRL, SystemInput_1.SystemInput.Keys.V);
            await this.sleep(100);
            return { success: true, action, output: '粘贴 (Ctrl+V)' };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleSelectAllAndCopy(action) {
        try {
            await this.systemInput.keyCombo(SystemInput_1.SystemInput.Keys.CTRL, SystemInput_1.SystemInput.Keys.A);
            await this.sleep(100);
            await this.systemInput.keyCombo(SystemInput_1.SystemInput.Keys.CTRL, SystemInput_1.SystemInput.Keys.C);
            return { success: true, action, output: '全选并复制 (Ctrl+A → Ctrl+C)' };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleResizeWindow(action) {
        const title = action.params.title;
        const width = action.params.width;
        const height = action.params.height;
        const window = await this.windowManager.findWindow(title);
        if (!window) {
            return { success: false, action, error: `未找到窗口: ${title}` };
        }
        try {
            const result = await this.windowManager.moveWindow(window.handle, window.bounds?.x ?? 0, window.bounds?.y ?? 0, width, height);
            return {
                success: result.success,
                action,
                output: `调整窗口 "${title}" 大小为 ${width}x${height}`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleSetFocus(action) {
        const title = action.params.title;
        const window = await this.windowManager.findWindow(title);
        if (!window) {
            return { success: false, action, error: `未找到窗口: ${title}` };
        }
        try {
            const result = await this.windowManager.activateWindow(window.handle);
            return {
                success: result.success,
                action,
                output: `聚焦窗口: ${title}`,
                error: result.error,
            };
        }
        catch (error) {
            return { success: false, action, error: error.message };
        }
    }
    async handleShell(action) {
        const command = action.params.command;
        if (!command || typeof command !== 'string') {
            return { success: false, action, error: '命令无效' };
        }
        const isDangerous = DANGEROUS_SHELL_COMMANDS.some(dc => command.toLowerCase().includes(dc));
        if (isDangerous) {
            Logger_1.Logger.warn(`🛡️ 危险命令被拦截: ${command.substring(0, 100)}`, 'DesktopActionExecutor');
            return {
                success: false,
                action,
                error: `危险命令被安全策略拦截: ${command.substring(0, 50)}`,
            };
        }
        try {
            const escaped = command.replace(/"/g, '\\"');
            const psScript = `cmd /c "${escaped}"`;
            const output = await this.systemInput.executePs(psScript, 30000);
            return {
                success: true,
                action,
                output: (output || '(无输出)').substring(0, 500),
            };
        }
        catch (error) {
            return {
                success: false,
                action,
                error: error.message,
            };
        }
    }
    // ═════════════════════════ 快捷任务 ═════════════════════════
    /**
     * 快捷任务：打开记事本，输入文字，保存
     */
    async openNotepadAndType(text, savePath) {
        const actions = [
            {
                type: 'openApp',
                params: { app: 'notepad' },
                description: '打开记事本',
            },
            { type: 'wait', params: { ms: 1000 }, description: '等待记事本启动' },
            { type: 'type', params: { text }, description: '输入文字' },
        ];
        if (savePath) {
            actions.push({ type: 'keyCombo', params: { keys: ['ctrl', 's'] }, description: '保存 (Ctrl+S)' }, { type: 'wait', params: { ms: 500 }, description: '等待保存对话框' }, {
                type: 'type',
                params: { text: savePath },
                description: '输入保存路径',
            }, { type: 'key', params: { key: 'enter' }, description: '确认保存' });
        }
        return this.executeTask(actions);
    }
    /**
     * 快捷任务：观察桌面并汇报
     */
    async observeAndReport() {
        const actions = [
            { type: 'observe', params: {}, description: '观察桌面' },
        ];
        return this.executeTask(actions);
    }
    /**
     * 快捷任务：点击指定坐标
     */
    async clickAt(x, y) {
        const actions = [
            {
                type: 'moveMouse',
                params: { x, y },
                description: `移动鼠标到 (${x}, ${y})`,
            },
            { type: 'click', params: { x, y }, description: '点击' },
        ];
        return this.executeTask(actions);
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('DesktopActionExecutor 未初始化！请先调用 initialize()');
        }
    }
    async shutdown() {
        if (this._recording) {
            this.stopRecording();
        }
        await this.visionEngine.shutdown();
        await this.systemInput.shutdown();
        await this.windowManager.shutdown();
        await this.screenCapture.shutdown();
        try { await this.uiInspector.shutdown(); } catch { }
        this._middlewareBefore = [];
        this._middlewareAfter = [];
        this._recordings.clear();
        this._metrics = { ...DEFAULT_METRICS, actionTypeCounts: {}, recentErrors: [] };
        this.initialized = false;
        Logger_1.Logger.info('🎮 DesktopActionExecutor 已关闭', 'DesktopActionExecutor');
    }
}
exports.DesktopActionExecutor = DesktopActionExecutor;
DesktopActionExecutor.instance = null;
exports.default = DesktopActionExecutor;

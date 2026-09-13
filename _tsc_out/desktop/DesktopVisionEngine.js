"use strict";
/**
 * DesktopVisionEngine - 桌面视觉引擎
 * 整合 ScreenCapture + OCR + LLM视觉理解
 * v2: 截图发给LLM做视觉理解，获得精确的屏幕内容描述
 * 实现"看桌面 → 理解内容 → 汇报"的完整链路
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopVisionEngine = void 0;
const Logger_1 = require("../utils/Logger");
const ScreenCapture_1 = require("./ScreenCapture");
const WindowManager_1 = require("./WindowManager");
// F3: 桌面视觉理解不再独立持有 TS LLMProvider（违反 AGENTS.md §0.1），
// 改为路由到 Python 后端的 LLM（经 PythonAgentBridge）。
const bootstrap_1 = require("../server/bootstrap");
class DesktopVisionEngine {
    static instance = null;
    screenCapture;
    windowManager;
    config;
    initialized = false;
    observationHistory = [];
    isObserving = false;
    constructor(config) {
        this.screenCapture = ScreenCapture_1.ScreenCapture.getInstance();
        this.windowManager = WindowManager_1.WindowManager.getInstance();
        this.config = {
            captureIntervalMs: config?.captureIntervalMs || 5000,
            visionPrompt: config?.visionPrompt ||
                '请描述这张桌面截图。告诉我：1) 当前打开了哪些应用程序窗口；2) 桌面上有什么内容；3) 用户在做什么。用中文回答。',
            enableOcr: config?.enableOcr ?? true,
            enableLLMVision: config?.enableLLMVision ?? true,
            maxObservations: config?.maxObservations || 10,
        };
    }
    static getInstance(config) {
        if (!DesktopVisionEngine.instance) {
            DesktopVisionEngine.instance = new DesktopVisionEngine(config);
        }
        return DesktopVisionEngine.instance;
    }
    static reset() {
        if (DesktopVisionEngine.instance) {
            DesktopVisionEngine.instance.shutdown().catch((err) => Logger_1.Logger.warn('关闭 DesktopVisionEngine 失败', 'DesktopVisionEngine', {
                error: err.message,
            }));
        }
        DesktopVisionEngine.instance = null;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('👁️ DesktopVisionEngine 初始化', 'DesktopVisionEngine');
        await this.screenCapture.initialize();
        await this.windowManager.initialize();
        if (this.config.enableLLMVision && this._bridgeLlmAvailable()) {
            Logger_1.Logger.info('👁️ DesktopVisionEngine 视觉理解将路由到 Python LLM（经 Bridge）', 'DesktopVisionEngine');
        }
        this.initialized = true;
        Logger_1.Logger.info('👁️ DesktopVisionEngine 初始化完成', 'DesktopVisionEngine');
    }
    async observe() {
        this.ensureInitialized();
        const startTime = Date.now();
        Logger_1.Logger.info('👁️ 开始观察桌面...', 'DesktopVisionEngine');
        const screenshot = await this.screenCapture.captureFullScreen();
        if (!screenshot.success) {
            throw new Error(`截图失败: ${screenshot.error}`);
        }
        const windows = this.windowManager.listWindows();
        let visionAnalysis;
        if (this.config.enableLLMVision && this._bridgeLlmAvailable()) {
            visionAnalysis = await this.analyzeWithLLM(screenshot, windows);
        }
        else {
            visionAnalysis = {
                success: true,
                description: this.generateLocalDescription(windows),
                processingTime: Date.now() - startTime,
                llmAnalyzed: false,
            };
        }
        const observation = {
            timestamp: Date.now(),
            screenshot,
            visionAnalysis,
            windows,
            summary: visionAnalysis.description || this.generateLocalDescription(windows),
            screenshotBase64: screenshot.buffer.toString('base64'),
            screenWidth: screenshot.width,
            screenHeight: screenshot.height,
            activeWindow: windows[0]?.title || '',
            windowTitles: windows.map((w) => w.title),
        };
        this.addObservation(observation);
        Logger_1.Logger.info(`👁️ 桌面观察完成: ${observation.summary.substring(0, 100)}...`, 'DesktopVisionEngine');
        return observation;
    }
    /**
     * 使用 LLM Vision 分析截图
     */
    async analyzeWithLLM(screenshot, windows) {
        const startTime = Date.now();
        try {
            const base64 = screenshot.buffer.toString('base64');
            const imageDataUrl = `data:image/png;base64,${base64}`;
            const windowContext = windows
                .filter((w) => w.isVisible && !w.isMinimized)
                .slice(0, 5)
                .map((w) => `"${w.title}" (${w.processName})`)
                .join('、');
            const prompt = `${this.config.visionPrompt}\n\n已知窗口列表: ${windowContext || '无可见窗口'}`;
            // F3: 视觉理解经 Python LLM（Bridge），不再使用本地 LLMProvider。
            const llmDescription = await this._bridgeVision(prompt, imageDataUrl);
            if (llmDescription) {
                return {
                    success: true,
                    description: llmDescription,
                    processingTime: Date.now() - startTime,
                    llmAnalyzed: true,
                };
            }
            // Bridge 不可用或返回空 → 降级本地描述（保持原有鲁棒性）
            return {
                success: true,
                description: this.generateLocalDescription(windows),
                processingTime: Date.now() - startTime,
                llmAnalyzed: false,
            };
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ LLM 视觉分析失败，降级为本地描述: ${error.message}`, 'DesktopVisionEngine');
            return {
                success: true,
                description: this.generateLocalDescription(windows),
                processingTime: Date.now() - startTime,
                llmAnalyzed: false,
            };
        }
    }
    /**
     * F3: 经 PythonAgentBridge 调用 Python 端多模态 LLM 做视觉理解。
     * Bridge 不可用时返回 null，由调用方降级为本地描述。
     */
    _bridgeLlmAvailable() {
        try {
            return (0, bootstrap_1.getPythonBridge)() != null;
        }
        catch {
            return false;
        }
    }
    async _bridgeVision(prompt, imageDataUrl) {
        try {
            const bridge = (0, bootstrap_1.getPythonBridge)();
            if (!bridge)
                return null;
            const result = await bridge.llmMultimodalChat(prompt, [imageDataUrl]);
            return result && result.trim() ? result : null;
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ Bridge 视觉理解调用失败，降级本地描述: ${error.message}`, 'DesktopVisionEngine');
            return null;
        }
    }
    async startObservation(callback) {
        if (this.isObserving)
            return;
        this.isObserving = true;
        Logger_1.Logger.info('👁️ 开始持续观察桌面', 'DesktopVisionEngine');
        while (this.isObserving) {
            try {
                const observation = await this.observe();
                if (callback) {
                    callback(observation);
                }
            }
            catch (error) {
                Logger_1.Logger.error('❌ 观察失败', error, 'DesktopVisionEngine');
            }
            await this.sleep(this.config.captureIntervalMs || 5000);
        }
    }
    stopObservation() {
        this.isObserving = false;
        Logger_1.Logger.info('👁️ 停止持续观察', 'DesktopVisionEngine');
    }
    getLatestObservation() {
        return this.observationHistory.length > 0
            ? this.observationHistory[this.observationHistory.length - 1]
            : null;
    }
    getObservationHistory() {
        return [...this.observationHistory];
    }
    async captureWindow(windowTitle) {
        const window = this.windowManager.findWindow(windowTitle);
        if (!window) {
            return {
                success: false,
                buffer: Buffer.alloc(0),
                width: 0,
                height: 0,
                format: 'png',
                timestamp: Date.now(),
                error: `未找到窗口: ${windowTitle}`,
            };
        }
        return this.screenCapture.captureRegion({
            x: window.bounds.x,
            y: window.bounds.y,
            width: window.bounds.width,
            height: window.bounds.height,
        });
    }
    generateReport(observation) {
        const obs = observation || this.getLatestObservation();
        if (!obs) {
            return '还没有观察到桌面内容。';
        }
        const windowList = obs.windows
            .slice(0, 5)
            .map((w) => `"${w.title}"`)
            .join('、');
        let report = `我看到你桌面上有 ${obs.windows.length} 个窗口：`;
        if (windowList) {
            report += `${windowList}。`;
        }
        if (obs.visionAnalysis.description) {
            report += `\n\n${obs.visionAnalysis.description}`;
        }
        return report;
    }
    generateLocalDescription(windows) {
        const topWindows = windows
            .filter((w) => w.isVisible && !w.isMinimized)
            .slice(0, 5);
        if (topWindows.length === 0) {
            return '桌面上没有可见窗口。';
        }
        const names = topWindows.map((w) => w.title || w.processName).join('、');
        return `桌面上打开了: ${names}`;
    }
    addObservation(obs) {
        this.observationHistory.push(obs);
        if (this.observationHistory.length > (this.config.maxObservations || 10)) {
            this.observationHistory.shift();
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('DesktopVisionEngine 未初始化！请先调用 initialize()');
        }
    }
    async shutdown() {
        this.isObserving = false;
        this.observationHistory = [];
        await this.screenCapture.shutdown();
        await this.windowManager.shutdown();
        this.initialized = false;
        Logger_1.Logger.info('👁️ DesktopVisionEngine 已关闭', 'DesktopVisionEngine');
    }
}
exports.DesktopVisionEngine = DesktopVisionEngine;
exports.default = DesktopVisionEngine;

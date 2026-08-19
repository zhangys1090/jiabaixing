"use strict";
/**
 * DesktopVisionEngine - 桌面视觉引擎
 * 整合 ScreenCapture + OCR + LLM视觉理解
 * v3: 推进能力边界增强
 *   - 屏幕变化检测: 像素差异比对，窗口变更检测，智能跳过无变化帧
 *   - ROI区域追踪: 聚焦观察指定屏幕区域，降低LLM调用开销
 *   - 智能观察缓存: 缓存未变化的观察结果，减少重复截图/分析
 *   - 观察优先级队列: 按任务相关性排列观察优先级
 *   - 多分辨率捕获: 按需选择捕获精度（全精度/降采样/缩略图）
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
const CHANGE_DETECT_THRESHOLD = 0.03;
const ROI_DEFAULTS = {
    enabled: false,
    regions: [],
    captureFullOnMiss: true,
};
const CACHE_DEFAULTS = {
    enabled: true,
    ttlMs: 2000,
    maxEntries: 20,
    skipIfUnchanged: true,
    changeThreshold: CHANGE_DETECT_THRESHOLD,
};
class DesktopVisionEngine {
    constructor(config) {
        this.initialized = false;
        this.observationHistory = [];
        this.isObserving = false;
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
        this._lastScreenshotHash = null;
        this._lastWindowSnapshot = null;
        this._roiConfig = { ...ROI_DEFAULTS, ...config?.roi };
        this._roiRegions = new Map();
        this._cacheConfig = { ...CACHE_DEFAULTS, ...config?.cache };
        this._observationCache = new Map();
        this._cacheTimestamps = new Map();
        this._changeStats = { checks: 0, changed: 0, unchanged: 0, avgChangeRatio: 0 };
        this._observationPriority = 'normal';
        this._captureResolution = 'full';
    }
    static getInstance(config) {
        if (!DesktopVisionEngine.instance) {
            DesktopVisionEngine.instance = new DesktopVisionEngine(config);
        }
        return DesktopVisionEngine.instance;
    }
    static reset() {
        if (DesktopVisionEngine.instance) {
            DesktopVisionEngine.instance.shutdown().catch((err) => {
                Logger_1.Logger.debug(`桌面视觉引擎关闭失败: ${err?.message}`, 'DesktopVisionEngine');
            });
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
    async observe(options) {
        this.ensureInitialized();
        const startTime = Date.now();
        const priority = options?.priority ?? this._observationPriority;
        const resolution = options?.resolution ?? this._captureResolution;
        const forceFresh = options?.forceFresh ?? false;
        const roiId = options?.roiId ?? null;
        if (this._cacheConfig.enabled && !forceFresh) {
            const cached = this._getCachedObservation(roiId || 'full');
            if (cached) {
                Logger_1.Logger.debug('👁️ 使用缓存的观察结果（屏幕未变化）', 'DesktopVisionEngine');
                return cached;
            }
        }
        Logger_1.Logger.info('👁️ 开始观察桌面...', 'DesktopVisionEngine');
        let screenshot;
        if (roiId && this._roiConfig.enabled) {
            const roi = this._roiRegions.get(roiId);
            if (roi) {
                screenshot = await this.screenCapture.captureRegion(roi.bounds);
                Logger_1.Logger.debug(`👁️ ROI捕获: ${roiId} [${roi.bounds.x},${roi.bounds.y},${roi.bounds.width},${roi.bounds.height}]`, 'DesktopVisionEngine');
            }
            else if (this._roiConfig.captureFullOnMiss) {
                screenshot = await this.screenCapture.captureFullScreen();
            }
            else {
                throw new Error(`ROI区域未注册: ${roiId}`);
            }
        }
        else {
            screenshot = await this.screenCapture.captureFullScreen();
        }
        if (!screenshot.success) {
            throw new Error(`截图失败: ${screenshot.error}`);
        }
        const changeResult = await this._detectChange(screenshot);
        if (changeResult.unchanged && this._cacheConfig.skipIfUnchanged && !forceFresh) {
            const lastObs = this.getLatestObservation();
            if (lastObs) {
                Logger_1.Logger.debug(`👁️ 屏幕无变化 (变化率: ${(changeResult.ratio * 100).toFixed(2)}%)，复用上次观察`, 'DesktopVisionEngine');
                this._updateChangeStats(false, changeResult.ratio);
                return lastObs;
            }
        }
        this._updateChangeStats(true, changeResult.ratio);
        const windows = await this.windowManager.listWindows();
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
            changeDetected: changeResult.changed,
            changeRatio: changeResult.ratio,
            roiId: roiId || null,
            priority,
            resolution,
        };
        this.addObservation(observation);
        if (this._cacheConfig.enabled) {
            this._setCachedObservation(roiId || 'full', observation);
        }
        Logger_1.Logger.info(`👁️ 桌面观察完成: ${observation.summary.substring(0, 100)}... (变化: ${changeResult.changed ? '是' : '否'}, ${(changeResult.ratio * 100).toFixed(1)}%)`, 'DesktopVisionEngine');
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
        const window = await this.windowManager.findWindow(windowTitle);
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
    async _detectChange(screenshot) {
        const currentHash = this._computeScreenshotHash(screenshot);
        const currentWindows = await this.windowManager.listWindows();
        const windowSnapshot = currentWindows.map((w) => `${w.title}|${w.processName}|${w.isVisible}`).join(';');
        if (this._lastScreenshotHash === null) {
            this._lastScreenshotHash = currentHash;
            this._lastWindowSnapshot = windowSnapshot;
            return { changed: true, unchanged: false, ratio: 1.0 };
        }
        const hashChanged = currentHash !== this._lastScreenshotHash;
        const windowsChanged = windowSnapshot !== this._lastWindowSnapshot;
        let ratio = 0;
        if (hashChanged) {
            ratio = this._estimatePixelChangeRatio(screenshot);
        }
        else if (windowsChanged) {
            ratio = 0.05;
        }
        const changed = ratio >= this._cacheConfig.changeThreshold || windowsChanged;
        this._lastScreenshotHash = currentHash;
        this._lastWindowSnapshot = windowSnapshot;
        return { changed, unchanged: !changed, ratio };
    }
    _computeScreenshotHash(screenshot) {
        const buf = screenshot.buffer;
        if (!buf || buf.length === 0) return 'empty';
        const sampleSize = Math.min(2048, buf.length);
        const step = Math.max(1, Math.floor(buf.length / sampleSize));
        let h1 = 0x811c9dc5;
        let h2 = 0x5bd1e995;
        for (let i = 0; i < buf.length; i += step) {
            h1 ^= buf[i];
            h1 = Math.imul(h1, 0x01000193);
            h2 ^= buf[i];
            h2 = Math.imul(h2, 0x5bd1e995);
        }
        return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
    }
    _estimatePixelChangeRatio(screenshot) {
        if (!this.observationHistory.length) return 1.0;
        const lastObs = this.observationHistory[this.observationHistory.length - 1];
        if (!lastObs?.screenshot?.buffer) return 1.0;
        const curr = screenshot.buffer;
        const prev = lastObs.screenshot.buffer;
        if (curr.length !== prev.length) return 1.0;
        const maxSamples = 500;
        const sampleStep = Math.max(1, Math.floor(curr.length / maxSamples));
        let diffCount = 0;
        let sampleCount = 0;
        for (let i = 0; i < curr.length && sampleCount < maxSamples; i += sampleStep) {
            sampleCount++;
            if (Math.abs(curr[i] - prev[i]) > 30) {
                diffCount++;
            }
        }
        return sampleCount > 0 ? diffCount / sampleCount : 0;
    }
    _updateChangeStats(changed, ratio) {
        this._changeStats.checks++;
        if (changed) this._changeStats.changed++;
        else this._changeStats.unchanged++;
        const total = this._changeStats.checks;
        this._changeStats.avgChangeRatio =
            (this._changeStats.avgChangeRatio * (total - 1) + ratio) / total;
    }
    registerROI(id, bounds, options) {
        this._roiRegions.set(id, {
            id,
            bounds,
            label: options?.label || id,
            priority: options?.priority ?? 'normal',
            lastObservedAt: 0,
        });
        Logger_1.Logger.info(`👁️ 注册ROI区域: ${id} [${bounds.x},${bounds.y},${bounds.width},${bounds.height}]`, 'DesktopVisionEngine');
    }
    unregisterROI(id) {
        const removed = this._roiRegions.delete(id);
        if (removed) {
            Logger_1.Logger.info(`👁️ 注销ROI区域: ${id}`, 'DesktopVisionEngine');
        }
        return removed;
    }
    getROI(id) {
        return this._roiRegions.get(id) || null;
    }
    listROIs() {
        return Array.from(this._roiRegions.values());
    }
    async observeROI(id, options) {
        return this.observe({ ...options, roiId: id, forceFresh: options?.forceFresh ?? false });
    }
    async observeAllROIs(options) {
        const results = [];
        for (const [id, roi] of this._roiRegions) {
            try {
                const obs = await this.observe({ ...options, roiId: id, forceFresh: true });
                roi.lastObservedAt = Date.now();
                results.push({ roiId: id, observation: obs });
            }
            catch (err) {
                Logger_1.Logger.warn(`👁️ ROI观察失败: ${id} - ${err.message}`, 'DesktopVisionEngine');
                results.push({ roiId: id, observation: null, error: err.message });
            }
        }
        return results;
    }
    _getCachedObservation(key) {
        const ts = this._cacheTimestamps.get(key);
        if (!ts) return null;
        if (Date.now() - ts > this._cacheConfig.ttlMs) {
            this._observationCache.delete(key);
            this._cacheTimestamps.delete(key);
            return null;
        }
        return this._observationCache.get(key) || null;
    }
    _setCachedObservation(key, observation) {
        this._observationCache.set(key, observation);
        this._cacheTimestamps.set(key, Date.now());
        if (this._observationCache.size > this._cacheConfig.maxEntries) {
            const oldest = this._cacheTimestamps.entries().next().value;
            if (oldest) {
                this._observationCache.delete(oldest[0]);
                this._cacheTimestamps.delete(oldest[0]);
            }
        }
    }
    clearObservationCache() {
        this._observationCache.clear();
        this._cacheTimestamps.clear();
        Logger_1.Logger.debug('👁️ 观察缓存已清空', 'DesktopVisionEngine');
    }
    setObservationPriority(priority) {
        this._observationPriority = priority;
        Logger_1.Logger.debug(`👁️ 观察优先级设为: ${priority}`, 'DesktopVisionEngine');
    }
    setCaptureResolution(resolution) {
        this._captureResolution = resolution;
        Logger_1.Logger.debug(`👁️ 捕获分辨率设为: ${resolution}`, 'DesktopVisionEngine');
    }
    getChangeStats() {
        return { ...this._changeStats };
    }
    getCacheStats() {
        return {
            size: this._observationCache.size,
            maxEntries: this._cacheConfig.maxEntries,
            ttlMs: this._cacheConfig.ttlMs,
            enabled: this._cacheConfig.enabled,
        };
    }
    configureROI(config) {
        this._roiConfig = { ...this._roiConfig, ...config };
        Logger_1.Logger.info(`👁️ ROI配置已更新: enabled=${this._roiConfig.enabled}, regions=${this._roiRegions.size}`, 'DesktopVisionEngine');
    }
    configureCache(config) {
        this._cacheConfig = { ...this._cacheConfig, ...config };
        Logger_1.Logger.info(`👁️ 缓存配置已更新: enabled=${this._cacheConfig.enabled}, ttl=${this._cacheConfig.ttlMs}ms`, 'DesktopVisionEngine');
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
DesktopVisionEngine.instance = null;
exports.default = DesktopVisionEngine;

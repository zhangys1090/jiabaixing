"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateSnapshotManager = exports.SnapshotTriggerType = exports.SnapshotStatus = void 0;
const Logger_1 = require("../utils/Logger");
const TimerManager_1 = require("../utils/TimerManager");
const DesktopUIInspector_1 = require("./DesktopUIInspector");
const SnapshotStorage_1 = require("./snapshot/SnapshotStorage");
const types_1 = require("./snapshot/types");
Object.defineProperty(exports, "SnapshotStatus", { enumerable: true, get: function () { return types_1.SnapshotStatus; } });
Object.defineProperty(exports, "SnapshotTriggerType", { enumerable: true, get: function () { return types_1.SnapshotTriggerType; } });
const WindowManager_1 = require("./WindowManager");
const DesktopActionAuthority_1 = require("./DesktopActionAuthority");
class StateSnapshotManager {
    static instance = null;
    config;
    timerManager;
    windowManager;
    uiInspector;
    storage;
    authority;
    customProviders = new Map();
    autoSnapshotTimerId = null;
    initialized = false;
    constructor(config) {
        this.config = {
            storageDir: config.storageDir || './snapshots',
            enableAutoSnapshot: config.enableAutoSnapshot ?? false,
            autoSnapshotIntervalMs: config.autoSnapshotIntervalMs || 300000,
            maxSnapshotCount: config.maxSnapshotCount || 100,
            snapshotExpiryMs: config.snapshotExpiryMs || 0,
            includeClipboard: config.includeClipboard ?? false,
            includeUITree: config.includeUITree ?? true,
            compressStorage: config.compressStorage ?? true,
            enableChecksum: config.enableChecksum ?? true,
        };
        this.timerManager = TimerManager_1.TimerManager.getInstance();
        this.windowManager = WindowManager_1.WindowManager.getInstance();
        this.uiInspector = DesktopUIInspector_1.DesktopUIInspector.getInstance();
        this.authority = DesktopActionAuthority_1.DesktopActionAuthority.getInstance();
        this.storage = SnapshotStorage_1.SnapshotStorage.getInstance(this.config);
    }
    static getInstance(config) {
        if (!StateSnapshotManager.instance) {
            StateSnapshotManager.instance = new StateSnapshotManager(config || {});
        }
        return StateSnapshotManager.instance;
    }
    static reset() {
        if (StateSnapshotManager.instance) {
            StateSnapshotManager.instance.dispose();
        }
        StateSnapshotManager.instance = null;
        SnapshotStorage_1.SnapshotStorage.reset();
    }
    async initialize() {
        if (this.initialized)
            return;
        try {
            await this.storage.ensureStorageDir();
            await this.storage.loadIndex();
            if (this.config.enableAutoSnapshot) {
                this.startAutoSnapshot();
            }
            this.initialized = true;
            Logger_1.Logger.info('✅ StateSnapshotManager 初始化完成', 'StateSnapshotManager');
        }
        catch (error) {
            Logger_1.Logger.error('❌ StateSnapshotManager 初始化失败', error, 'StateSnapshotManager');
            throw error;
        }
    }
    dispose() {
        if (this.autoSnapshotTimerId) {
            this.timerManager.clearTimer(this.autoSnapshotTimerId);
            this.autoSnapshotTimerId = null;
        }
        this.initialized = false;
        Logger_1.Logger.info('🛑 StateSnapshotManager 已释放', 'StateSnapshotManager');
    }
    async takeSnapshot(description = '手动快照', tags = [], parentSnapshotId) {
        return this.captureSnapshot(types_1.SnapshotTriggerType.MANUAL, description, tags, parentSnapshotId);
    }
    async checkpointBeforeAction(actionDescription) {
        return this.captureSnapshot(types_1.SnapshotTriggerType.PRE_ACTION, `操作前检查点: ${actionDescription}`, ['checkpoint', 'pre-action']);
    }
    async snapshotAfterAction(actionDescription, parentSnapshotId) {
        return this.captureSnapshot(types_1.SnapshotTriggerType.POST_ACTION, `操作后快照: ${actionDescription}`, ['checkpoint', 'post-action'], parentSnapshotId);
    }
    async restoreSnapshot(snapshotId, options = {}) {
        const startTime = Date.now();
        const result = {
            success: false,
            snapshotId,
            restoredComponents: [],
            failedComponents: [],
            warnings: [],
        };
        try {
            const snapshot = await this.storage.loadSnapshot(snapshotId);
            if (!snapshot) {
                throw new Error(`快照不存在: ${snapshotId}`);
            }
            if (options.restoreWindows !== false && snapshot.foregroundWindowHandle) {
                try {
                    const { result: actionResult, authorization } = await this.authority.executeAction({
                        type: 'restoreWindowState',
                        params: { handle: snapshot.foregroundWindowHandle },
                        description: '恢复前台窗口状态',
                    });
                    if (!authorization.allowed) {
                        throw new Error(authorization.reason || '窗口恢复被安全策略阻止');
                    }
                    if (!actionResult.success) {
                        throw new Error(actionResult.error || '窗口恢复执行失败');
                    }
                    result.restoredComponents.push('foreground_window');
                }
                catch (error) {
                    result.failedComponents.push({
                        component: 'foreground_window',
                        error: error.message,
                    });
                }
            }
            if (options.restoreClipboard !== false &&
                snapshot.clipboard?.textContent) {
                try {
                    await this.restoreClipboard(snapshot.clipboard);
                    result.restoredComponents.push('clipboard');
                }
                catch (error) {
                    result.failedComponents.push({
                        component: 'clipboard',
                        error: error.message,
                    });
                }
            }
            if (options.restoreCustomStates !== false && snapshot.customStates) {
                for (const [providerName, state] of Object.entries(snapshot.customStates)) {
                    const provider = this.customProviders.get(providerName);
                    if (provider) {
                        try {
                            const success = await provider.restoreState(state);
                            if (success) {
                                result.restoredComponents.push(`custom:${providerName}`);
                            }
                            else {
                                result.warnings.push(`自定义状态提供者 ${providerName} 恢复返回 false`);
                            }
                        }
                        catch (error) {
                            result.failedComponents.push({
                                component: `custom:${providerName}`,
                                error: error.message,
                            });
                        }
                    }
                    else {
                        result.warnings.push(`自定义状态提供者 ${providerName} 未注册，跳过恢复`);
                    }
                }
            }
            const meta = this.storage.getMetadata(snapshotId);
            if (meta) {
                meta.status = types_1.SnapshotStatus.RESTORED;
                await this.storage.saveIndex();
            }
            result.success = result.failedComponents.length === 0;
            Logger_1.Logger.info(`♻️ 快照恢复完成: ${snapshotId} (${Date.now() - startTime}ms)`, 'StateSnapshotManager');
            return result;
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 恢复快照失败: ${snapshotId}`, error, 'StateSnapshotManager');
            result.failedComponents.push({
                component: 'overall',
                error: error.message,
            });
            return result;
        }
    }
    async diffSnapshots(snapshotIdA, snapshotIdB) {
        const [snapshotA, snapshotB] = await Promise.all([
            this.storage.loadSnapshot(snapshotIdA),
            this.storage.loadSnapshot(snapshotIdB),
        ]);
        if (!snapshotA)
            throw new Error(`快照不存在: ${snapshotIdA}`);
        if (!snapshotB)
            throw new Error(`快照不存在: ${snapshotIdB}`);
        const result = {
            snapshotIdA,
            snapshotIdB,
            timestampA: snapshotA.timestamp,
            timestampB: snapshotB.timestamp,
            addedWindows: [],
            removedWindows: [],
            modifiedWindows: [],
            addedProcesses: [],
            removedProcesses: [],
            foregroundChanged: false,
            beforeForeground: snapshotA.foregroundWindowHandle,
            afterForeground: snapshotB.foregroundWindowHandle,
            uiTreeChanged: false,
            clipboardChanged: false,
            mouseMoved: false,
            mouseDelta: { dx: 0, dy: 0 },
            customStateChanges: {},
            summary: '',
        };
        const windowsA = new Map(snapshotA.windows.map((w) => [w.handle, w]));
        const windowsB = new Map(snapshotB.windows.map((w) => [w.handle, w]));
        for (const [handle, winB] of windowsB) {
            const winA = windowsA.get(handle);
            if (!winA) {
                result.addedWindows.push(winB);
            }
            else {
                const changes = this.compareWindowState(winA, winB);
                if (changes.length > 0) {
                    result.modifiedWindows.push({ before: winA, after: winB, changes });
                }
            }
        }
        for (const [handle, winA] of windowsA) {
            if (!windowsB.has(handle)) {
                result.removedWindows.push(winA);
            }
        }
        result.foregroundChanged =
            snapshotA.foregroundWindowHandle !== snapshotB.foregroundWindowHandle;
        const procsA = new Map(snapshotA.processes.map((p) => [p.pid, p]));
        const procsB = new Map(snapshotB.processes.map((p) => [p.pid, p]));
        for (const [pid, procB] of procsB) {
            if (!procsA.has(pid))
                result.addedProcesses.push(procB);
        }
        for (const [pid, procA] of procsA) {
            if (!procsB.has(pid))
                result.removedProcesses.push(procA);
        }
        result.uiTreeChanged =
            JSON.stringify(snapshotA.uiTree) !== JSON.stringify(snapshotB.uiTree);
        result.clipboardChanged =
            JSON.stringify(snapshotA.clipboard) !==
                JSON.stringify(snapshotB.clipboard);
        result.mouseMoved =
            snapshotA.mousePosition.x !== snapshotB.mousePosition.x ||
                snapshotA.mousePosition.y !== snapshotB.mousePosition.y;
        result.mouseDelta = {
            dx: snapshotB.mousePosition.x - snapshotA.mousePosition.x,
            dy: snapshotB.mousePosition.y - snapshotA.mousePosition.y,
        };
        for (const key of new Set([
            ...Object.keys(snapshotA.customStates),
            ...Object.keys(snapshotB.customStates),
        ])) {
            const before = snapshotA.customStates[key];
            const after = snapshotB.customStates[key];
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                result.customStateChanges[key] = { before, after };
            }
        }
        result.summary = this.generateDiffSummary(result);
        Logger_1.Logger.info(`📊 快照差异分析完成: ${snapshotIdA} vs ${snapshotIdB}`, 'StateSnapshotManager');
        return result;
    }
    async listSnapshots(options = {}) {
        return this.storage.listSnapshots(options);
    }
    async getLatestSnapshot() {
        return this.storage.getLatestSnapshot();
    }
    async deleteSnapshot(snapshotId) {
        return this.storage.deleteSnapshotFile(snapshotId);
    }
    async cleanupExpiredSnapshots() {
        return this.storage.cleanupExpiredSnapshots(this.config.snapshotExpiryMs);
    }
    registerCustomStateProvider(provider) {
        this.customProviders.set(provider.name, provider);
        Logger_1.Logger.info(`🔌 自定义状态提供者已注册: ${provider.name}`, 'StateSnapshotManager');
    }
    unregisterCustomStateProvider(name) {
        this.customProviders.delete(name);
        Logger_1.Logger.info(`🔌 自定义状态提供者已注销: ${name}`, 'StateSnapshotManager');
    }
    startAutoSnapshot() {
        if (this.autoSnapshotTimerId)
            return;
        this.autoSnapshotTimerId = this.timerManager.setInterval(() => {
            this.captureSnapshot(types_1.SnapshotTriggerType.SCHEDULED, '定时自动快照', [
                'auto',
            ]).catch((error) => {
                Logger_1.Logger.error('❌ 自动快照失败', error, 'StateSnapshotManager');
            });
        }, this.config.autoSnapshotIntervalMs, 'snapshot', '自动快照定时器');
        Logger_1.Logger.info(`⏰ 自动快照已启动，间隔 ${this.config.autoSnapshotIntervalMs}ms`, 'StateSnapshotManager');
    }
    stopAutoSnapshot() {
        if (this.autoSnapshotTimerId) {
            this.timerManager.clearTimer(this.autoSnapshotTimerId);
            this.autoSnapshotTimerId = null;
            Logger_1.Logger.info('⏹️ 自动快照已停止', 'StateSnapshotManager');
        }
    }
    updateConfig(config) {
        const wasAutoSnapshot = this.config.enableAutoSnapshot;
        Object.assign(this.config, config);
        this.storage.updateConfig(this.config);
        if (config.autoSnapshotIntervalMs && this.autoSnapshotTimerId) {
            this.stopAutoSnapshot();
            this.startAutoSnapshot();
        }
        if (!wasAutoSnapshot && this.config.enableAutoSnapshot) {
            this.startAutoSnapshot();
        }
        else if (wasAutoSnapshot && !this.config.enableAutoSnapshot) {
            this.stopAutoSnapshot();
        }
    }
    async captureSnapshot(triggerType, description, tags = [], parentSnapshotId) {
        const startTime = Date.now();
        const snapshotId = this.generateSnapshotId();
        try {
            const windowList = this.windowManager.listWindows();
            const uiTreeNodes = this.config.includeUITree
                ? this.uiInspector.getControlTree()
                : [];
            const mousePos = await this.getMousePosition();
            let foregroundWindow = null;
            try {
                foregroundWindow = this.windowManager.getForegroundWindow();
            }
            catch {
                foregroundWindow = null;
            }
            const foregroundHandle = foregroundWindow?.handle || 0;
            const windows = windowList.map((win, index) => ({
                handle: win.handle,
                title: win.title,
                processName: win.processName || 'unknown',
                bounds: win.bounds || { x: 0, y: 0, width: 0, height: 0 },
                visible: win.isVisible,
                minimized: win.isMinimized,
                maximized: win.isMaximized,
                isForeground: win.handle === foregroundHandle,
                zOrder: index,
            }));
            const processes = await this.captureProcessStates(windowList);
            const clipboard = this.config.includeClipboard
                ? await this.captureClipboardState()
                : null;
            const fileSystemContext = await this.captureFileSystemContext();
            const customStates = {};
            for (const [name, provider] of this.customProviders) {
                try {
                    customStates[name] = await provider.getState();
                }
                catch {
                    Logger_1.Logger.warn(`自定义状态获取失败: ${name}`, 'StateSnapshotManager');
                }
            }
            const snapshot = {
                timestamp: Date.now(),
                snapshotId,
                triggerType,
                description,
                windows,
                foregroundWindowHandle: foregroundWindow?.handle || 0,
                uiTree: uiTreeNodes.length > 0 ? uiTreeNodes[0] : null,
                processes,
                clipboard,
                fileSystemContext,
                screenResolution: await this.getScreenResolution(),
                mousePosition: mousePos,
                customStates,
            };
            const filePath = await this.storage.saveSnapshotToFile(snapshot);
            const sizeBytes = await this.storage.getSnapshotFileSize(filePath);
            const snapshotData = JSON.stringify(snapshot, null, 2);
            const checksum = this.config.enableChecksum
                ? this.storage.calculateChecksum(snapshotData)
                : '';
            const metadata = {
                snapshotId,
                timestamp: snapshot.timestamp,
                triggerType,
                description,
                status: types_1.SnapshotStatus.ACTIVE,
                filePath,
                checksum,
                sizeBytes,
                windowCount: windows.length,
                processCount: processes.length,
                uiTreeNodeCount: this.countUITreeNodes(snapshot.uiTree),
                tags,
                parentSnapshotId,
            };
            this.storage.setMetadata(snapshotId, metadata);
            await this.storage.saveIndex();
            await this.storage.enforceMaxSnapshotCount(this.config.maxSnapshotCount);
            Logger_1.Logger.info(`📸 快照已捕获: ${snapshotId} (${Date.now() - startTime}ms, ${sizeBytes} bytes)`, 'StateSnapshotManager');
            return metadata;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 快照捕获失败', error, 'StateSnapshotManager');
            throw error;
        }
    }
    generateSnapshotId() {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `snap_${timestamp}_${random}`;
    }
    countUITreeNodes(node) {
        if (!node)
            return 0;
        return (1 +
            node.children.reduce((sum, child) => sum + this.countUITreeNodes(child), 0));
    }
    async captureProcessStates(windows) {
        const processMap = new Map();
        for (const win of windows) {
            const pid = win.handle;
            if (!processMap.has(pid)) {
                processMap.set(pid, {
                    pid,
                    name: win.processName || 'unknown',
                    executablePath: '',
                    windowHandles: [],
                    memoryUsageMb: 0,
                    cpuUsagePercent: 0,
                });
            }
            processMap.get(pid).windowHandles.push(win.handle);
        }
        return Array.from(processMap.values());
    }
    async captureClipboardState() {
        return {
            hasText: false,
            hasImage: false,
            formats: [],
        };
    }
    async restoreClipboard(state) {
        if (state.textContent) {
            Logger_1.Logger.info('恢复剪贴板文本', 'StateSnapshotManager');
        }
    }
    async captureFileSystemContext() {
        return {
            currentWorkingDirectory: process.cwd(),
            openFilePaths: [],
            recentDocuments: [],
        };
    }
    async getMousePosition() {
        return { x: 0, y: 0 };
    }
    async getScreenResolution() {
        return { width: 1920, height: 1080 };
    }
    compareWindowState(before, after) {
        const changes = [];
        if (before.title !== after.title)
            changes.push('title');
        if (before.visible !== after.visible)
            changes.push('visible');
        if (before.minimized !== after.minimized)
            changes.push('minimized');
        if (before.maximized !== after.maximized)
            changes.push('maximized');
        if (before.isForeground !== after.isForeground)
            changes.push('foreground');
        if (before.bounds.x !== after.bounds.x)
            changes.push('x');
        if (before.bounds.y !== after.bounds.y)
            changes.push('y');
        if (before.bounds.width !== after.bounds.width)
            changes.push('width');
        if (before.bounds.height !== after.bounds.height)
            changes.push('height');
        if (before.zOrder !== after.zOrder)
            changes.push('zOrder');
        return changes;
    }
    generateDiffSummary(diff) {
        const parts = [];
        if (diff.addedWindows.length)
            parts.push(`新增 ${diff.addedWindows.length} 个窗口`);
        if (diff.removedWindows.length)
            parts.push(`关闭 ${diff.removedWindows.length} 个窗口`);
        if (diff.modifiedWindows.length)
            parts.push(`${diff.modifiedWindows.length} 个窗口状态变化`);
        if (diff.foregroundChanged)
            parts.push('前台窗口变化');
        if (diff.addedProcesses.length)
            parts.push(`新增 ${diff.addedProcesses.length} 个进程`);
        if (diff.removedProcesses.length)
            parts.push(`退出 ${diff.removedProcesses.length} 个进程`);
        if (diff.uiTreeChanged)
            parts.push('UI 树变化');
        if (diff.clipboardChanged)
            parts.push('剪贴板变化');
        if (diff.mouseMoved)
            parts.push(`鼠标移动 (${diff.mouseDelta.dx}, ${diff.mouseDelta.dy})`);
        const customKeys = Object.keys(diff.customStateChanges);
        if (customKeys.length)
            parts.push(`${customKeys.length} 项自定义状态变化`);
        return parts.join('；') || '无显著变化';
    }
}
exports.StateSnapshotManager = StateSnapshotManager;

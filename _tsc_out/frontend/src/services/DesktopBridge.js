"use strict";
/**
 * DesktopBridge - 安全的Electron API封装
 *
 * 为前端React组件提供统一的桌面能力接口
 *
 * 安全设计：
 * 1. 所有调用通过preload.js白名单通道
 * 2. 数据传递经过序列化验证
 * 3. 提供优雅降级（Web模式下返回模拟数据）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopBridge = void 0;
function isElectron() {
    return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}
class DesktopBridge {
    electronAPI = null;
    isElectronEnv;
    constructor() {
        this.isElectronEnv = isElectron();
        if (this.isElectronEnv) {
            this.electronAPI = window.electronAPI;
        }
    }
    get platform() {
        return this.electronAPI?.platform || (typeof navigator !== 'undefined' ? navigator.platform : 'unknown');
    }
    get isElectron() {
        return this.isElectronEnv;
    }
    // ============================================================
    // 窗口控制
    // ============================================================
    minimize() {
        this.electronAPI?.window.minimize();
    }
    maximize() {
        this.electronAPI?.window.maximize();
    }
    close() {
        this.electronAPI?.window.close();
    }
    toggleFullscreen() {
        this.electronAPI?.window.toggleFullscreen();
    }
    onMaximizeChange(callback) {
        if (this.electronAPI) {
            return this.electronAPI.window.onMaximizeChange(callback);
        }
        return () => { };
    }
    // ============================================================
    // 系统信息
    // ============================================================
    async getSystemInfo() {
        if (this.electronAPI) {
            return await this.electronAPI.system.getInfo();
        }
        return {
            platform: navigator.platform,
            arch: 'unknown',
            electronVersion: 'N/A',
            nodeVersion: 'N/A',
            chromeVersion: 'N/A',
            appVersion: 'web',
            appName: 'jiabaixing (Web)',
        };
    }
    async getSystemPath(name) {
        return (await this.electronAPI?.system.getPath(name)) ?? null;
    }
    // ============================================================
    // 文件操作
    // ============================================================
    async openFileDialog(options) {
        if (this.electronAPI) {
            const result = await this.electronAPI.file.openDialog(options);
            return {
                canceled: result.canceled,
                filePaths: result.filePaths,
            };
        }
        return { canceled: true, filePaths: [] };
    }
    async saveFileDialog(options) {
        if (this.electronAPI) {
            const result = await this.electronAPI.file.saveDialog(options);
            return {
                canceled: result.canceled,
                filePath: result.filePath,
            };
        }
        return { canceled: true };
    }
    async readFile(filePath) {
        if (this.electronAPI) {
            return await this.electronAPI.file.read(filePath);
        }
        return { success: false, error: 'Not in Electron environment' };
    }
    async writeFile(filePath, content) {
        if (this.electronAPI) {
            return await this.electronAPI.file.write(filePath, content);
        }
        return { success: false, error: 'Not in Electron environment' };
    }
    // ============================================================
    // 外部链接
    // ============================================================
    openExternalURL(url) {
        if (this.electronAPI) {
            this.electronAPI.shell.openURL(url);
        }
        else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }
    async openLocalPath(path) {
        if (this.electronAPI) {
            return await this.electronAPI.shell.openPath(path);
        }
        return { success: false, error: 'Not in Electron environment' };
    }
    // ============================================================
    // 服务通信
    // ============================================================
    async getServiceStatus() {
        return (await this.electronAPI?.service.getStatus()) ?? null;
    }
    sendServiceMessage(data) {
        this.electronAPI?.service.sendMessage({
            type: 'chat',
            payload: data,
            timestamp: Date.now(),
        });
    }
    onServiceMessage(callback) {
        if (this.electronAPI) {
            return this.electronAPI.service.onMessage((msg) => callback(msg.payload));
        }
        return () => { };
    }
    // ============================================================
    // 应用控制
    // ============================================================
    quit() {
        this.electronAPI?.app.quit();
    }
    reload() {
        this.electronAPI?.app.reload();
    }
    toggleDevTools() {
        this.electronAPI?.app.toggleDevTools();
    }
    // ============================================================
    // 托盘管理
    // ============================================================
    showWindow() {
        this.electronAPI?.tray.showWindow();
    }
    hideWindow() {
        this.electronAPI?.tray.hideWindow();
    }
    async getTrayStatus() {
        if (this.electronAPI) {
            return await this.electronAPI.tray.getStatus();
        }
        return null;
    }
    // ============================================================
    // 自动更新
    // ============================================================
    checkForUpdates() {
        this.electronAPI?.update.checkForUpdates();
    }
    downloadUpdate() {
        this.electronAPI?.update.downloadUpdate();
    }
    installUpdate() {
        this.electronAPI?.update.installUpdate();
    }
    onUpdateAvailable(callback) {
        if (this.electronAPI) {
            return this.electronAPI.update.onAvailable(callback);
        }
        return () => { };
    }
    onUpdateNotAvailable(callback) {
        if (this.electronAPI) {
            return this.electronAPI.update.onNotAvailable(callback);
        }
        return () => { };
    }
    onUpdateProgress(callback) {
        if (this.electronAPI) {
            return this.electronAPI.update.onProgress(callback);
        }
        return () => { };
    }
    onUpdateDownloaded(callback) {
        if (this.electronAPI) {
            return this.electronAPI.update.onDownloaded(callback);
        }
        return () => { };
    }
    onUpdateError(callback) {
        if (this.electronAPI) {
            return this.electronAPI.update.onError(callback);
        }
        return () => { };
    }
    // ============================================================
    // 通知系统
    // ============================================================
    showNotification(data) {
        this.electronAPI?.notification.show(data);
    }
    onNotificationClick(callback) {
        if (this.electronAPI) {
            return this.electronAPI.notification.onClick(callback);
        }
        return () => { };
    }
    // ============================================================
    // 快捷键
    // ============================================================
    async registerShortcut(accelerator, callbackId) {
        if (this.electronAPI) {
            const result = await this.electronAPI.shortcuts.register(accelerator, callbackId);
            return result.success;
        }
        return false;
    }
    unregisterShortcut(callbackId) {
        this.electronAPI?.shortcuts.unregister(callbackId);
    }
    onShortcutTriggered(callback) {
        if (this.electronAPI) {
            return this.electronAPI.shortcuts.onTriggered(callback);
        }
        return () => { };
    }
}
exports.desktopBridge = new DesktopBridge();
exports.default = exports.desktopBridge;

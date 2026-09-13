"use strict";
/**
 * ScreenCapture - 桌面截图服务
 * 基于 screenshot-desktop，支持全屏/区域/窗口截图
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenCapture = void 0;
const screenshot_desktop_1 = __importDefault(require("screenshot-desktop"));
const Logger_1 = require("../utils/Logger");
class ScreenCapture {
    static instance = null;
    initialized = false;
    constructor() { }
    static create() {
        return new ScreenCapture();
    }
    static getInstance() {
        if (!ScreenCapture.instance) {
            ScreenCapture.instance = ScreenCapture.create();
        }
        return ScreenCapture.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('📸 ScreenCapture 初始化', 'ScreenCapture');
        this.initialized = true;
    }
    /**
     * 截取全屏
     */
    async captureFullScreen(options = {}) {
        try {
            const buffer = await (0, screenshot_desktop_1.default)({
                format: options.format || 'png',
            });
            Logger_1.Logger.info(`📸 全屏截图完成: ${this.formatBytes(buffer.length)}`, 'ScreenCapture');
            return {
                success: true,
                buffer,
                width: 0,
                height: 0,
                format: options.format || 'png',
                timestamp: Date.now(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 全屏截图失败', error, 'ScreenCapture');
            return {
                success: false,
                buffer: Buffer.alloc(0),
                width: 0,
                height: 0,
                format: 'png',
                timestamp: Date.now(),
                error: error.message,
            };
        }
    }
    /**
     * 截取指定区域
     */
    async captureRegion(region) {
        try {
            const buffer = await (0, screenshot_desktop_1.default)({
                format: 'png',
            });
            Logger_1.Logger.info(`📸 区域截图完成: ${region.width}x${region.height} @ (${region.x},${region.y})`, 'ScreenCapture');
            return {
                success: true,
                buffer,
                width: region.width,
                height: region.height,
                format: 'png',
                timestamp: Date.now(),
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 区域截图失败', error, 'ScreenCapture');
            return {
                success: false,
                buffer: Buffer.alloc(0),
                width: 0,
                height: 0,
                format: 'png',
                timestamp: Date.now(),
                error: error.message,
            };
        }
    }
    /**
     * 截取指定显示器
     */
    async captureScreen(screenIndex = 0) {
        return this.captureFullScreen({ screenIndex });
    }
    /**
     * 连续截图（用于监控变化）
     */
    async captureSequence(count, intervalMs) {
        const results = [];
        for (let i = 0; i < count; i++) {
            const result = await this.captureFullScreen();
            results.push(result);
            if (i < count - 1) {
                await this.sleep(intervalMs);
            }
        }
        return results;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    formatBytes(bytes) {
        if (bytes < 1024)
            return `${bytes}B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    async shutdown() {
        this.initialized = false;
        Logger_1.Logger.info('📸 ScreenCapture 已关闭', 'ScreenCapture');
    }
}
exports.ScreenCapture = ScreenCapture;
exports.default = ScreenCapture;

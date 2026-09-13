"use strict";
/**
 * 归一化坐标系统
 * 参考 UI-TARS / Codex Computer Use 设计
 * 所有坐标统一使用 [0, 1000] × [0, 1000] 归一化值
 * 内部自动转换为实际像素坐标，无需开发者处理分辨率适配
 *
 * 支持 Electron 环境和 Node.js 环境（降级使用默认分辨率）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.coords = exports.NormalizedCoordinateSystem = exports.NORMALIZED_MAX = void 0;
exports.toPixel = toPixel;
exports.toNormalized = toNormalized;
const Logger_1 = require("../utils/Logger");
// 尝试导入 electron，如果不存在则降级
let electronScreen = null;
try {
    electronScreen = require('electron')?.screen || null;
}
catch {
    // 非 Electron 环境，使用降级方案
    electronScreen = null;
}
exports.NORMALIZED_MAX = 1000;
class NormalizedCoordinateSystem {
    static instance = null;
    screenWidth = 1920;
    screenHeight = 1080;
    scaleFactor = 1;
    constructor() {
        this.refreshScreenInfo();
    }
    static create() {
        return new NormalizedCoordinateSystem();
    }
    static getInstance() {
        if (!NormalizedCoordinateSystem.instance) {
            NormalizedCoordinateSystem.instance = NormalizedCoordinateSystem.create();
        }
        return NormalizedCoordinateSystem.instance;
    }
    /**
     * 刷新屏幕信息（分辨率变化时调用）
     */
    refreshScreenInfo() {
        try {
            if (electronScreen &&
                typeof electronScreen.getPrimaryDisplay === 'function') {
                // Electron 环境
                const primaryDisplay = electronScreen.getPrimaryDisplay();
                const workAreaSize = primaryDisplay?.workAreaSize || {
                    width: 1920,
                    height: 1080,
                };
                const { width, height } = workAreaSize;
                this.screenWidth = width;
                this.screenHeight = height;
                this.scaleFactor =
                    primaryDisplay
                        ?.scaleFactor || 1;
                Logger_1.Logger.info(`📐 屏幕信息: ${width}x${height}, 缩放: ${this.scaleFactor}`, 'NormalizedCoords');
            }
            else {
                // 非 Electron 环境，尝试使用其他方式获取
                // 降级使用默认分辨率
                Logger_1.Logger.warn('⚠️ 非Electron环境，使用默认分辨率 1920x1080', 'NormalizedCoords');
            }
        }
        catch (err) {
            // 出错时使用默认值
            Logger_1.Logger.warn(`⚠️ 获取屏幕信息失败，使用默认分辨率: ${err.message}`, 'NormalizedCoords');
        }
    }
    /**
     * 归一化坐标 → 实际像素坐标
     */
    toPixel(normalized) {
        const clampedX = this.clamp(normalized.x, 0, exports.NORMALIZED_MAX);
        const clampedY = this.clamp(normalized.y, 0, exports.NORMALIZED_MAX);
        return {
            x: Math.round((clampedX / exports.NORMALIZED_MAX) * this.screenWidth),
            y: Math.round((clampedY / exports.NORMALIZED_MAX) * this.screenHeight),
        };
    }
    /**
     * 实际像素坐标 → 归一化坐标
     */
    toNormalized(pixel) {
        return {
            x: Math.round((pixel.x / this.screenWidth) * exports.NORMALIZED_MAX),
            y: Math.round((pixel.y / this.screenHeight) * exports.NORMALIZED_MAX),
        };
    }
    /**
     * 归一化矩形 → 实际像素矩形
     */
    rectToPixel(normalized) {
        const topLeft = this.toPixel({ x: normalized.x, y: normalized.y });
        const bottomRight = this.toPixel({
            x: normalized.x + normalized.width,
            y: normalized.y + normalized.height,
        });
        return {
            x: topLeft.x,
            y: topLeft.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y,
        };
    }
    /**
     * 实际像素矩形 → 归一化矩形
     */
    rectToNormalized(pixel) {
        const topLeft = this.toNormalized({ x: pixel.x, y: pixel.y });
        const bottomRight = this.toNormalized({
            x: pixel.x + pixel.width,
            y: pixel.y + pixel.height,
        });
        return {
            x: topLeft.x,
            y: topLeft.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y,
        };
    }
    /**
     * 获取屏幕尺寸（归一化）
     */
    getNormalizedScreenSize() {
        return { width: exports.NORMALIZED_MAX, height: exports.NORMALIZED_MAX };
    }
    /**
     * 获取屏幕尺寸（像素）
     */
    getPixelScreenSize() {
        return { width: this.screenWidth, height: this.screenHeight };
    }
    /**
     * 检查坐标是否在屏幕范围内
     */
    isWithinScreen(point) {
        return (point.x >= 0 &&
            point.x <= exports.NORMALIZED_MAX &&
            point.y >= 0 &&
            point.y <= exports.NORMALIZED_MAX);
    }
    /**
     * 计算两点之间的距离（归一化）
     */
    distance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
    /**
     * 线性插值
     */
    lerp(from, to, t) {
        return {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
        };
    }
    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
}
exports.NormalizedCoordinateSystem = NormalizedCoordinateSystem;
// 便捷导出函数
exports.coords = NormalizedCoordinateSystem.getInstance();
function toPixel(x, y) {
    return exports.coords.toPixel({ x, y });
}
function toNormalized(x, y) {
    return exports.coords.toNormalized({ x, y });
}

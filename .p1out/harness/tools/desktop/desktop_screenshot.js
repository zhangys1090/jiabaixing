"use strict";
/**
 * Harness Tool: desktop_screenshot - 截取屏幕截图
 *
 * 使用 screenshot-desktop 实现真实截图，保存到 /tmp/ 目录。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DESKTOP_SCREENSHOT_DEF = void 0;
exports.createDesktopScreenshotExecutor = createDesktopScreenshotExecutor;
const types_1 = require("../../types");
const Logger_1 = require("../../../utils/Logger");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const ScreenCapture_1 = require("../../../desktop/ScreenCapture");
exports.DESKTOP_SCREENSHOT_DEF = {
    name: 'desktop_screenshot',
    description: '截取屏幕截图并可选进行视觉分析。适用场景：用户说"看看我屏幕上是什么"、"帮我截个图"、需要了解用户桌面状态时。不适用：自动化操作桌面（用 desktop_automate）。',
    category: types_1.ToolCategory.DESKTOP,
    parameters: {
        region: {
            type: 'object',
            description: '截取区域 {x, y, width, height}，不指定则截取全屏',
            properties: {
                x: { type: 'number', description: '起始X坐标' },
                y: { type: 'number', description: '起始Y坐标' },
                width: { type: 'number', description: '宽度' },
                height: { type: 'number', description: '高度' },
            },
        },
        screenIndex: {
            type: 'number',
            description: '显示器索引（多显示器时使用），默认0为主显示器',
            default: 0,
        },
        analyze: {
            type: 'boolean',
            description: '是否对截图进行视觉分析（描述截图内容）',
            default: false,
        },
    },
    requiredParams: [],
    requiredPermissions: [types_1.Permission.DESKTOP_CONTROL],
    riskLevel: 'high',
    idempotent: true,
    timeout: 15000,
    requiresConfirmation: true,
};
async function defaultCaptureScreen(params) {
    const screenCapture = ScreenCapture_1.ScreenCapture.getInstance();
    if (!screenCapture.initialized) {
        await screenCapture.initialize();
    }
    if (params.region && params.region.x !== undefined && params.region.y !== undefined) {
        const result = await screenCapture.captureRegion(params.region);
        if (!result.success) {
            throw new Error(result.error || '区域截图失败');
        }
        return { buffer: result.buffer, width: result.width, height: result.height };
    }
    const result = await screenCapture.captureFullScreen();
    if (!result.success) {
        throw new Error(result.error || '全屏截图失败');
    }
    return { buffer: result.buffer, width: result.width, height: result.height };
}
/** 创建 desktop_screenshot 执行器 */
function createDesktopScreenshotExecutor(deps = {}) {
    return async (params, _context) => {
        const region = params.region;
        const screenIndex = Number(params.screenIndex) || 0;
        const analyze = Boolean(params.analyze);
        // 使用注入的 captureScreen，或默认实现
        const captureFn = deps.captureScreen || defaultCaptureScreen;
        try {
            const screenshot = await captureFn({
                region,
                screenIndex,
            });
            const output = screenshot.buffer
                ? `截图成功: ${screenshot.width}x${screenshot.height}, 大小 ${(screenshot.buffer.length / 1024).toFixed(1)}KB`
                : '截图成功';
            let finalOutput = output;
            if (analyze && deps.analyzeImage) {
                const analysis = await deps.analyzeImage(screenshot.buffer);
                finalOutput += `\n\n视觉分析: ${analysis}`;
            }
            else if (analyze) {
                finalOutput += '\n\n视觉分析不可用，仅返回截图数据。';
            }
            return {
                success: true,
                output: finalOutput,
                duration: 0,
                validated: false,
                metadata: {
                    width: screenshot.width,
                    height: screenshot.height,
                    sizeKB: Math.round((screenshot.buffer?.length || 0) / 1024),
                    analyzed: analyze && !!deps.analyzeImage,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: `截图失败: ${error.message}`,
                error: error.message,
                duration: 0,
                validated: false,
            };
        }
    };
}

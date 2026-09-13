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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
// screenshot-desktop 是 CommonJS 模块，使用动态导入兼容 ESM
let screenshotDesktop;
Promise.resolve().then(() => __importStar(require('screenshot-desktop'))).then((mod) => {
    screenshotDesktop = mod.default || mod;
})
    .catch((err) => {
    Logger_1.Logger.warn('desktop_screenshot 动态导入失败，功能将不可用', 'DesktopScreenshot', err);
});
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
/** 默认截图实现：使用 screenshot-desktop 保存到 /tmp/ */
async function defaultCaptureScreen(_params) {
    const timestamp = Date.now();
    const filename = path.join('/tmp', `screenshot_${timestamp}.png`);
    // screenshot-desktop 支持直接保存到文件
    await screenshotDesktop({ filename, format: 'png' });
    // 读取文件获取 buffer 和尺寸
    const buffer = await fs.promises.readFile(filename);
    Logger_1.Logger.info(`截图已保存到 ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`, 'DesktopScreenshot');
    // 从 PNG 文件解析宽高
    // PNG header: 8 bytes signature + IHDR chunk (4 len + 4 type + 4 width + 4 height)
    let width = 0;
    let height = 0;
    if (buffer.length >= 24) {
        width = buffer.readUInt32BE(16);
        height = buffer.readUInt32BE(20);
    }
    return { buffer, width, height };
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

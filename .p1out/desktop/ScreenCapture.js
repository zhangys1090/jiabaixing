"use strict";
/**
 * ScreenCapture - 桌面截图服务
 * 基于 screenshot-desktop，支持全屏/区域/窗口截图
 *
 * v2: captureRegion 迁移到 SystemInput 常驻 PowerShell 会话，消除 execSync 开销
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenCapture = void 0;
const screenshot_desktop_1 = __importDefault(require("screenshot-desktop"));
const Logger_1 = require("../utils/Logger");
const SystemInput_1 = require("./SystemInput");
class ScreenCapture {
    constructor() {
        this.initialized = false;
        this.systemInput = SystemInput_1.SystemInput.getInstance();
    }
    static getInstance() {
        if (!ScreenCapture.instance) {
            ScreenCapture.instance = new ScreenCapture();
        }
        return ScreenCapture.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('📸 ScreenCapture 初始化', 'ScreenCapture');
        await this.systemInput.initialize();
        this.initialized = true;
    }
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
    async captureRegion(region) {
        try {
            const fullBuffer = await (0, screenshot_desktop_1.default)({ format: 'png' });
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const tmpDir = os.tmpdir();
            const srcFile = path.join(tmpDir, `sc_src_${Date.now()}.png`);
            const outFile = path.join(tmpDir, `sc_crop_${Date.now()}.png`);
            fs.writeFileSync(srcFile, fullBuffer);
            const cropScript = `
Add-Type -AssemblyName System.Drawing
$srcImg = [System.Drawing.Image]::FromFile('${srcFile.replace(/'/g, "''")}')
$cropRect = New-Object System.Drawing.Rectangle(${region.x},${region.y},${region.width},${region.height})
$cropRect = [System.Drawing.Rectangle]::Intersect($cropRect, (New-Object System.Drawing.Rectangle(0,0,$srcImg.Width,$srcImg.Height)))
if ($cropRect.IsEmpty) { $srcImg.Dispose(); Write-Output "EMPTY"; Remove-Item '${srcFile.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue; return }
$cropped = New-Object System.Drawing.Bitmap($cropRect.Width,$cropRect.Height)
$g = [System.Drawing.Graphics]::FromImage($cropped)
$g.DrawImage($srcImg, (New-Object System.Drawing.Rectangle(0,0,$cropRect.Width,$cropRect.Height)), $cropRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $srcImg.Dispose()
$cropped.Save('${outFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$cropped.Dispose()
Write-Output "OK"
`;
            const psOutput = await this.systemInput.executePs(cropScript, 15000);
            const trimmed = psOutput.trim();
            try { fs.unlinkSync(srcFile); } catch { /* ignore */ }
            if (trimmed === 'EMPTY') {
                return { success: false, buffer: Buffer.alloc(0), width: 0, height: 0, format: 'png', timestamp: Date.now(), error: '裁剪区域为空' };
            }
            if (!fs.existsSync(outFile)) {
                return { success: false, buffer: Buffer.alloc(0), width: 0, height: 0, format: 'png', timestamp: Date.now(), error: '裁剪输出文件未生成' };
            }
            const croppedBuffer = fs.readFileSync(outFile);
            try { fs.unlinkSync(outFile); } catch { /* ignore */ }
            Logger_1.Logger.info(`📸 区域截图完成: ${region.width}x${region.height} @ (${region.x},${region.y})`, 'ScreenCapture');
            return { success: true, buffer: croppedBuffer, width: region.width, height: region.height, format: 'png', timestamp: Date.now() };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 区域截图失败', error, 'ScreenCapture');
            return { success: false, buffer: Buffer.alloc(0), width: 0, height: 0, format: 'png', timestamp: Date.now(), error: error.message };
        }
    }
    async captureScreen(screenIndex = 0) {
        return this.captureFullScreen({ screenIndex });
    }
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
ScreenCapture.instance = null;
exports.default = ScreenCapture;

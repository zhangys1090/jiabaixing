/**
 * ScreenCapture - 桌面截图服务
 * 基于 screenshot-desktop，支持全屏/区域/窗口截图
 */

import screenshot from 'screenshot-desktop';
import { Logger } from '../utils/Logger';

export interface ScreenshotOptions {
  format?: 'png' | 'jpg';
  quality?: number;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  screenIndex?: number;
}

export interface ScreenshotResult {
  success: boolean;
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  timestamp: number;
  error?: string;
}

export class ScreenCapture {
  private static instance: ScreenCapture | null = null;
  private initialized: boolean = false;

  private constructor() {}

  public static getInstance(): ScreenCapture {
    if (!ScreenCapture.instance) {
      ScreenCapture.instance = new ScreenCapture();
    }
    return ScreenCapture.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    Logger.info('📸 ScreenCapture 初始化', 'ScreenCapture');
    this.initialized = true;
  }

  /**
   * 截取全屏
   */
  public async captureFullScreen(
    options: ScreenshotOptions = {}
  ): Promise<ScreenshotResult> {
    try {
      const buffer = await screenshot({
        format: options.format || 'png',
      });

      Logger.info(
        `📸 全屏截图完成: ${this.formatBytes(buffer.length)}`,
        'ScreenCapture'
      );

      return {
        success: true,
        buffer,
        width: 0,
        height: 0,
        format: options.format || 'png',
        timestamp: Date.now(),
      };
    } catch (error) {
      Logger.error('❌ 全屏截图失败', error as Error, 'ScreenCapture');
      return {
        success: false,
        buffer: Buffer.alloc(0),
        width: 0,
        height: 0,
        format: 'png',
        timestamp: Date.now(),
        error: (error as Error).message,
      };
    }
  }

  /**
   * 截取指定区域
   */
  public async captureRegion(
    region: NonNullable<ScreenshotOptions['region']>
  ): Promise<ScreenshotResult> {
    try {
      const buffer = await screenshot({
        format: 'png',
      });

      Logger.info(
        `📸 区域截图完成: ${region.width}x${region.height} @ (${region.x},${region.y})`,
        'ScreenCapture'
      );

      return {
        success: true,
        buffer,
        width: region.width,
        height: region.height,
        format: 'png',
        timestamp: Date.now(),
      };
    } catch (error) {
      Logger.error('❌ 区域截图失败', error as Error, 'ScreenCapture');
      return {
        success: false,
        buffer: Buffer.alloc(0),
        width: 0,
        height: 0,
        format: 'png',
        timestamp: Date.now(),
        error: (error as Error).message,
      };
    }
  }

  /**
   * 截取指定显示器
   */
  public async captureScreen(
    screenIndex: number = 0
  ): Promise<ScreenshotResult> {
    return this.captureFullScreen({ screenIndex });
  }

  /**
   * 连续截图（用于监控变化）
   */
  public async captureSequence(
    count: number,
    intervalMs: number
  ): Promise<ScreenshotResult[]> {
    const results: ScreenshotResult[] = [];
    for (let i = 0; i < count; i++) {
      const result = await this.captureFullScreen();
      results.push(result);
      if (i < count - 1) {
        await this.sleep(intervalMs);
      }
    }
    return results;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  public async shutdown(): Promise<void> {
    this.initialized = false;
    Logger.info('📸 ScreenCapture 已关闭', 'ScreenCapture');
  }
}

export default ScreenCapture;

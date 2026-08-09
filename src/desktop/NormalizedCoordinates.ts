/**
 * 归一化坐标系统
 * 参考 UI-TARS / Codex Computer Use 设计
 * 所有坐标统一使用 [0, 1000] × [0, 1000] 归一化值
 * 内部自动转换为实际像素坐标，无需开发者处理分辨率适配
 *
 * 支持 Electron 环境和 Node.js 环境（降级使用默认分辨率）
 */

import { Logger } from '../utils/Logger';

// 尝试导入 electron，如果不存在则降级
let electronScreen: {
  getPrimaryDisplay?: () => { workAreaSize: { width: number; height: number } };
} | null = null;
try {
  electronScreen = require('electron')?.screen || null;
} catch {
  // 非 Electron 环境，使用降级方案
  electronScreen = null;
}

export interface NormalizedPoint {
  x: number; // 0-1000
  y: number; // 0-1000
}

export interface PixelPoint {
  x: number; // 实际像素
  y: number; // 实际像素
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NORMALIZED_MAX = 1000;

export class NormalizedCoordinateSystem {
  private static instance: NormalizedCoordinateSystem | null = null;
  private screenWidth: number = 1920;
  private screenHeight: number = 1080;
  private scaleFactor: number = 1;

  private constructor() {
    this.refreshScreenInfo();
  }

  public static getInstance(): NormalizedCoordinateSystem {
    if (!NormalizedCoordinateSystem.instance) {
      NormalizedCoordinateSystem.instance = new NormalizedCoordinateSystem();
    }
    return NormalizedCoordinateSystem.instance;
  }

  /**
   * 刷新屏幕信息（分辨率变化时调用）
   */
  public refreshScreenInfo(): void {
    try {
      if (
        electronScreen &&
        typeof electronScreen.getPrimaryDisplay === 'function'
      ) {
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
          (primaryDisplay as unknown as { scaleFactor?: number })
            ?.scaleFactor || 1;
        Logger.info(
          `📐 屏幕信息: ${width}x${height}, 缩放: ${this.scaleFactor}`,
          'NormalizedCoords'
        );
      } else {
        // 非 Electron 环境，尝试使用其他方式获取
        // 降级使用默认分辨率
        Logger.warn(
          '⚠️ 非Electron环境，使用默认分辨率 1920x1080',
          'NormalizedCoords'
        );
      }
    } catch (err) {
      // 出错时使用默认值
      Logger.warn(
        `⚠️ 获取屏幕信息失败，使用默认分辨率: ${(err as Error).message}`,
        'NormalizedCoords'
      );
    }
  }

  /**
   * 归一化坐标 → 实际像素坐标
   */
  public toPixel(normalized: NormalizedPoint): PixelPoint {
    const clampedX = this.clamp(normalized.x, 0, NORMALIZED_MAX);
    const clampedY = this.clamp(normalized.y, 0, NORMALIZED_MAX);

    return {
      x: Math.round((clampedX / NORMALIZED_MAX) * this.screenWidth),
      y: Math.round((clampedY / NORMALIZED_MAX) * this.screenHeight),
    };
  }

  /**
   * 实际像素坐标 → 归一化坐标
   */
  public toNormalized(pixel: PixelPoint): NormalizedPoint {
    return {
      x: Math.round((pixel.x / this.screenWidth) * NORMALIZED_MAX),
      y: Math.round((pixel.y / this.screenHeight) * NORMALIZED_MAX),
    };
  }

  /**
   * 归一化矩形 → 实际像素矩形
   */
  public rectToPixel(normalized: NormalizedRect): PixelRect {
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
  public rectToNormalized(pixel: PixelRect): NormalizedRect {
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
  public getNormalizedScreenSize(): { width: number; height: number } {
    return { width: NORMALIZED_MAX, height: NORMALIZED_MAX };
  }

  /**
   * 获取屏幕尺寸（像素）
   */
  public getPixelScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  /**
   * 检查坐标是否在屏幕范围内
   */
  public isWithinScreen(point: NormalizedPoint): boolean {
    return (
      point.x >= 0 &&
      point.x <= NORMALIZED_MAX &&
      point.y >= 0 &&
      point.y <= NORMALIZED_MAX
    );
  }

  /**
   * 计算两点之间的距离（归一化）
   */
  public distance(a: NormalizedPoint, b: NormalizedPoint): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * 线性插值
   */
  public lerp(
    from: NormalizedPoint,
    to: NormalizedPoint,
    t: number
  ): NormalizedPoint {
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}

// 便捷导出函数
export const coords = NormalizedCoordinateSystem.getInstance();

export function toPixel(x: number, y: number): PixelPoint {
  return coords.toPixel({ x, y });
}

export function toNormalized(x: number, y: number): NormalizedPoint {
  return coords.toNormalized({ x, y });
}

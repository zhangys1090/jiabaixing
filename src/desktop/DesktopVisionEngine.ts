/**
 * DesktopVisionEngine - 桌面视觉引擎
 * 整合 ScreenCapture + OCR + LLM视觉理解
 * v2: 截图发给LLM做视觉理解，获得精确的屏幕内容描述
 * 实现"看桌面 → 理解内容 → 汇报"的完整链路
 */

import { Logger } from '../utils/Logger';
import { ScreenCapture, ScreenshotResult } from './ScreenCapture';
import { WindowInfo, WindowManager } from './WindowManager';
import { LLMProvider } from '../models/LLMProvider';

export interface VisionAnalysisResult {
  success: boolean;
  description: string;
  processingTime: number;
  llmAnalyzed?: boolean;
}

export interface DesktopObservation {
  timestamp: number;
  screenshot: ScreenshotResult;
  visionAnalysis: VisionAnalysisResult;
  windows: WindowInfo[];
  summary: string;
  /** Base64 编码的截图（便于传输和前端展示） */
  screenshotBase64?: string;
  /** 屏幕宽度 */
  screenWidth?: number;
  /** 屏幕高度 */
  screenHeight?: number;
  /** 当前活动窗口标题 */
  activeWindow?: string;
  /** 所有窗口标题 */
  windowTitles?: string[];
}

export interface DesktopVisionConfig {
  captureIntervalMs?: number;
  visionPrompt?: string;
  enableOcr?: boolean;
  enableLLMVision?: boolean;
  maxObservations?: number;
}

export class DesktopVisionEngine {
  private static instance: DesktopVisionEngine | null = null;
  private screenCapture: ScreenCapture;
  private windowManager: WindowManager;
  private llmProvider: LLMProvider | null;
  private config: Required<DesktopVisionConfig>;
  private initialized: boolean = false;
  private observationHistory: DesktopObservation[] = [];
  private isObserving: boolean = false;

  private constructor(config?: DesktopVisionConfig) {
    this.screenCapture = ScreenCapture.getInstance();
    this.windowManager = WindowManager.getInstance();
    try {
      this.llmProvider = new LLMProvider();
    } catch {
      this.llmProvider = null;
    }
    this.config = {
      captureIntervalMs: config?.captureIntervalMs || 5000,
      visionPrompt:
        config?.visionPrompt ||
        '请描述这张桌面截图。告诉我：1) 当前打开了哪些应用程序窗口；2) 桌面上有什么内容；3) 用户在做什么。用中文回答。',
      enableOcr: config?.enableOcr ?? true,
      enableLLMVision: config?.enableLLMVision ?? true,
      maxObservations: config?.maxObservations || 10,
    };
  }

  public static getInstance(config?: DesktopVisionConfig): DesktopVisionEngine {
    if (!DesktopVisionEngine.instance) {
      DesktopVisionEngine.instance = new DesktopVisionEngine(config);
    }
    return DesktopVisionEngine.instance;
  }

  public static reset(): void {
    if (DesktopVisionEngine.instance) {
      DesktopVisionEngine.instance.shutdown().catch(() => {});
    }
    DesktopVisionEngine.instance = null;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    Logger.info('👁️ DesktopVisionEngine 初始化', 'DesktopVisionEngine');
    await this.screenCapture.initialize();
    await this.windowManager.initialize();

    if (this.llmProvider && this.config.enableLLMVision) {
      try {
        await this.llmProvider.initialize();
        Logger.info(
          '👁️ DesktopVisionEngine LLM 视觉理解已就绪',
          'DesktopVisionEngine'
        );
      } catch (err) {
        Logger.warn(
          `⚠️ LLM 视觉初始化失败，降级为本地描述: ${(err as Error).message}`,
          'DesktopVisionEngine'
        );
        this.llmProvider = null;
      }
    }

    this.initialized = true;
    Logger.info('👁️ DesktopVisionEngine 初始化完成', 'DesktopVisionEngine');
  }

  public async observe(): Promise<DesktopObservation> {
    this.ensureInitialized();

    const startTime = Date.now();
    Logger.info('👁️ 开始观察桌面...', 'DesktopVisionEngine');

    const screenshot = await this.screenCapture.captureFullScreen();
    if (!screenshot.success) {
      throw new Error(`截图失败: ${screenshot.error}`);
    }

    const windows = this.windowManager.listWindows();

    let visionAnalysis: VisionAnalysisResult;

    if (this.config.enableLLMVision && this.llmProvider?.isAvailable()) {
      visionAnalysis = await this.analyzeWithLLM(screenshot, windows);
    } else {
      visionAnalysis = {
        success: true,
        description: this.generateLocalDescription(windows),
        processingTime: Date.now() - startTime,
        llmAnalyzed: false,
      };
    }

    const observation: DesktopObservation = {
      timestamp: Date.now(),
      screenshot,
      visionAnalysis,
      windows,
      summary:
        visionAnalysis.description || this.generateLocalDescription(windows),
      screenshotBase64: screenshot.buffer.toString('base64'),
      screenWidth: screenshot.width,
      screenHeight: screenshot.height,
      activeWindow: windows[0]?.title || '',
      windowTitles: windows.map((w) => w.title),
    };

    this.addObservation(observation);

    Logger.info(
      `👁️ 桌面观察完成: ${observation.summary.substring(0, 100)}...`,
      'DesktopVisionEngine'
    );

    return observation;
  }

  /**
   * 使用 LLM Vision 分析截图
   */
  private async analyzeWithLLM(
    screenshot: ScreenshotResult,
    windows: WindowInfo[]
  ): Promise<VisionAnalysisResult> {
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

      const llmDescription = await this.llmProvider!.multimodalChat(prompt, [
        imageDataUrl,
      ]);

      return {
        success: true,
        description: llmDescription || this.generateLocalDescription(windows),
        processingTime: Date.now() - startTime,
        llmAnalyzed: true,
      };
    } catch (error) {
      Logger.warn(
        `⚠️ LLM 视觉分析失败，降级为本地描述: ${(error as Error).message}`,
        'DesktopVisionEngine'
      );
      return {
        success: true,
        description: this.generateLocalDescription(windows),
        processingTime: Date.now() - startTime,
        llmAnalyzed: false,
      };
    }
  }

  public async startObservation(
    callback?: (obs: DesktopObservation) => void
  ): Promise<void> {
    if (this.isObserving) return;
    this.isObserving = true;

    Logger.info('👁️ 开始持续观察桌面', 'DesktopVisionEngine');

    while (this.isObserving) {
      try {
        const observation = await this.observe();
        if (callback) {
          callback(observation);
        }
      } catch (error) {
        Logger.error('❌ 观察失败', error as Error, 'DesktopVisionEngine');
      }

      await this.sleep(this.config.captureIntervalMs || 5000);
    }
  }

  public stopObservation(): void {
    this.isObserving = false;
    Logger.info('👁️ 停止持续观察', 'DesktopVisionEngine');
  }

  public getLatestObservation(): DesktopObservation | null {
    return this.observationHistory.length > 0
      ? this.observationHistory[this.observationHistory.length - 1]
      : null;
  }

  public getObservationHistory(): DesktopObservation[] {
    return [...this.observationHistory];
  }

  public async captureWindow(windowTitle: string): Promise<ScreenshotResult> {
    const window = this.windowManager.findWindow(windowTitle);
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

  public generateReport(observation?: DesktopObservation): string {
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

  private generateLocalDescription(windows: WindowInfo[]): string {
    const topWindows = windows
      .filter((w) => w.isVisible && !w.isMinimized)
      .slice(0, 5);

    if (topWindows.length === 0) {
      return '桌面上没有可见窗口。';
    }

    const names = topWindows.map((w) => w.title || w.processName).join('、');
    return `桌面上打开了: ${names}`;
  }

  private addObservation(obs: DesktopObservation): void {
    this.observationHistory.push(obs);
    if (this.observationHistory.length > (this.config.maxObservations || 10)) {
      this.observationHistory.shift();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('DesktopVisionEngine 未初始化！请先调用 initialize()');
    }
  }

  public async shutdown(): Promise<void> {
    this.isObserving = false;
    this.observationHistory = [];
    await this.screenCapture.shutdown();
    await this.windowManager.shutdown();
    this.initialized = false;
    Logger.info('👁️ DesktopVisionEngine 已关闭', 'DesktopVisionEngine');
  }
}

export default DesktopVisionEngine;

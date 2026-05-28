/**
 * DesktopAgentLoop - 桌面智能体循环
 * 观察 → 决策 → 执行 → 验证 → 汇报
 * 集成到 JiabaixingCore.processInput()
 */

import {
  DesktopActionExecutor,
  DesktopAction,
  DesktopTaskResult,
} from './DesktopActionExecutor';
import { DesktopVisionEngine, DesktopObservation } from './DesktopVisionEngine';
import { WindowManager } from './WindowManager';
import { SystemInput } from './SystemInput';
import { Logger } from '../utils/Logger';

export interface DesktopAgentConfig {
  maxRetries?: number;
  verifyAfterAction?: boolean;
  autoObserveIntervalMs?: number;
}

export interface DesktopAgentResult {
  success: boolean;
  taskDescription: string;
  executionResult: DesktopTaskResult;
  observations: DesktopObservation[];
  report: string;
  error?: string;
}

export class DesktopAgentLoop {
  private static instance: DesktopAgentLoop | null = null;
  private executor: DesktopActionExecutor;
  private visionEngine: DesktopVisionEngine;
  private windowManager: WindowManager;
  private systemInput: SystemInput;
  private config: DesktopAgentConfig;
  private initialized: boolean = false;
  private isRunning: boolean = false;

  private constructor(config?: DesktopAgentConfig) {
    this.executor = DesktopActionExecutor.getInstance();
    this.visionEngine = DesktopVisionEngine.getInstance();
    this.windowManager = WindowManager.getInstance();
    this.systemInput = SystemInput.getInstance();
    this.config = {
      maxRetries: config?.maxRetries || 3,
      verifyAfterAction: config?.verifyAfterAction ?? true,
      autoObserveIntervalMs: config?.autoObserveIntervalMs || 5000,
    };
  }

  public static getInstance(config?: DesktopAgentConfig): DesktopAgentLoop {
    if (!DesktopAgentLoop.instance) {
      DesktopAgentLoop.instance = new DesktopAgentLoop(config);
    }
    return DesktopAgentLoop.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    Logger.info('🤖 DesktopAgentLoop 初始化', 'DesktopAgentLoop');
    await this.executor.initialize();
    await this.visionEngine.initialize();
    await this.windowManager.initialize();
    await this.systemInput.initialize();

    this.initialized = true;
    Logger.info('🤖 DesktopAgentLoop 初始化完成', 'DesktopAgentLoop');
  }

  /**
   * 核心循环：一句话 → 操作桌面 → 完成 → 汇报结果
   */
  public async execute(userInput: string): Promise<DesktopAgentResult> {
    this.ensureInitialized();
    this.isRunning = true;

    Logger.info(`🤖 收到桌面操作指令: "${userInput}"`, 'DesktopAgentLoop');

    const observations: DesktopObservation[] = [];

    try {
      // ═══════════════════════ 1. 观察 ═══════════════════════
      Logger.info('🔍 阶段1: 观察桌面', 'DesktopAgentLoop');
      const initialObservation = await this.visionEngine.observe();
      observations.push(initialObservation);

      // ═══════════════════════ 2. 决策 ═══════════════════════
      Logger.info('🧠 阶段2: 决策规划', 'DesktopAgentLoop');
      const actions = this.planActions(userInput, initialObservation);

      if (actions.length === 0) {
        return {
          success: false,
          taskDescription: userInput,
          executionResult: {
            success: false,
            actions: [],
            summary: '无法解析操作指令',
          },
          observations,
          report:
            '我无法理解这个桌面操作指令。请尝试说："打开记事本"、"截图"、"点击屏幕中央"等。',
        };
      }

      // ═══════════════════════ 3. 执行 ═══════════════════════
      Logger.info(
        `🎮 阶段3: 执行 ${actions.length} 个动作`,
        'DesktopAgentLoop'
      );
      const executionResult = await this.executor.executeTask(actions);

      // ═══════════════════════ 4. 验证 ═══════════════════════
      if (this.config.verifyAfterAction) {
        Logger.info('✅ 阶段4: 验证结果', 'DesktopAgentLoop');
        await this.sleep(500);
        const finalObservation = await this.visionEngine.observe();
        observations.push(finalObservation);
      }

      // ═══════════════════════ 5. 汇报 ═══════════════════════
      const report = this.generateReport(
        userInput,
        executionResult,
        observations
      );

      Logger.info('🤖 桌面操作完成', 'DesktopAgentLoop');

      this.isRunning = false;
      return {
        success: executionResult.success,
        taskDescription: userInput,
        executionResult,
        observations,
        report,
      };
    } catch (error) {
      this.isRunning = false;
      Logger.error(
        '❌ DesktopAgentLoop 执行失败',
        error as Error,
        'DesktopAgentLoop'
      );
      return {
        success: false,
        taskDescription: userInput,
        executionResult: {
          success: false,
          actions: [],
          summary: '执行异常',
          error: (error as Error).message,
        },
        observations,
        report: `操作失败: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 自然语言 → 动作规划
   */
  private planActions(
    input: string,
    observation: DesktopObservation
  ): DesktopAction[] {
    void observation;
    const lower = input.toLowerCase().trim();
    const actions: DesktopAction[] = [];

    // ── 观察类 ──
    if (/看看|观察|截图|屏幕|桌面/.test(lower)) {
      actions.push({ type: 'observe', params: {}, description: '观察桌面' });
      return actions;
    }

    // ── 记事本 ──
    if (/记事本|notepad/.test(lower)) {
      const textMatch = lower.match(/输入[""']([^""']+)[""']/);
      const text = textMatch ? textMatch[1] : 'Hello from jiabaixing!';
      const saveMatch = lower.match(/保存[到为]?\s*([\w\\\.:\/]+)/);
      const savePath = saveMatch ? saveMatch[1] : undefined;

      actions.push(
        {
          type: 'shell',
          params: { command: 'start notepad' },
          description: '打开记事本',
        },
        { type: 'wait', params: { ms: 1000 }, description: '等待启动' }
      );

      if (/输入|打字|写/.test(lower)) {
        actions.push({
          type: 'type',
          params: { text },
          description: '输入文字',
        });
      }

      if (savePath) {
        actions.push(
          { type: 'key', params: { key: 'CTRL' }, description: 'Ctrl' },
          { type: 'key', params: { key: 'S' }, description: 'S' },
          { type: 'wait', params: { ms: 500 }, description: '等待对话框' },
          { type: 'type', params: { text: savePath }, description: '输入路径' },
          { type: 'key', params: { key: 'ENTER' }, description: '确认' }
        );
      }

      return actions;
    }

    // ── 点击 ──
    const clickMatch = lower.match(/点击\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/);
    if (clickMatch) {
      const x = parseInt(clickMatch[1]);
      const y = parseInt(clickMatch[2]);
      actions.push(
        {
          type: 'moveMouse',
          params: { x, y },
          description: `移动 (${x},${y})`,
        },
        { type: 'click', params: { x, y }, description: '点击' }
      );
      return actions;
    }

    // ── 点击屏幕中央 ──
    if (/点击.*中央|点击.*中间|点击.*中心/.test(lower)) {
      const screen = this.windowManager.getScreenSize();
      const cx = Math.floor(screen.width / 2);
      const cy = Math.floor(screen.height / 2);
      actions.push(
        {
          type: 'moveMouse',
          params: { x: cx, y: cy },
          description: `移动到中央 (${cx},${cy})`,
        },
        { type: 'click', params: { x: cx, y: cy }, description: '点击中央' }
      );
      return actions;
    }

    // ── 打开应用 ──
    const appMatch = lower.match(/打开\s*(.+)/);
    if (appMatch) {
      const app = appMatch[1].trim();
      actions.push(
        { type: 'openApp', params: { app }, description: `打开 ${app}` },
        { type: 'wait', params: { ms: 2000 }, description: '等待启动' },
        { type: 'observe', params: {}, description: '观察结果' }
      );
      return actions;
    }

    // ── 激活窗口 ──
    const activateMatch = lower.match(/激活|切换到|聚焦\s*(.+)/);
    if (activateMatch) {
      const title = activateMatch[1].trim();
      actions.push({
        type: 'activateWindow',
        params: { title },
        description: `激活 ${title}`,
      });
      return actions;
    }

    // ── 关闭窗口 ──
    const closeMatch = lower.match(/关闭\s*(.+)/);
    if (closeMatch) {
      const title = closeMatch[1].trim();
      actions.push({
        type: 'closeWindow',
        params: { title },
        description: `关闭 ${title}`,
      });
      return actions;
    }

    // ── 滚动 ──
    const scrollMatch = lower.match(/滚动\s*([\d-]+)/);
    if (scrollMatch) {
      const delta = parseInt(scrollMatch[1]);
      actions.push({
        type: 'scroll',
        params: { delta },
        description: `滚动 ${delta}`,
      });
      return actions;
    }

    // ── 拖拽 ──
    const dragMatch = lower.match(
      /拖拽\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?\s*到\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/
    );
    if (dragMatch) {
      actions.push({
        type: 'drag',
        params: {
          fromX: parseInt(dragMatch[1]),
          fromY: parseInt(dragMatch[2]),
          toX: parseInt(dragMatch[3]),
          toY: parseInt(dragMatch[4]),
        },
        description: '拖拽',
      });
      return actions;
    }

    // ── 输入文字 ──
    const typeMatch = lower.match(/输入[""']([^""']+)[""']/);
    if (typeMatch) {
      actions.push({
        type: 'type',
        params: { text: typeMatch[1] },
        description: `输入 "${typeMatch[1]}"`,
      });
      return actions;
    }

    // ── 按键 ──
    const keyMatch = lower.match(/按\s*(.+)/);
    if (keyMatch) {
      const key = keyMatch[1].trim().toUpperCase();
      actions.push({
        type: 'key',
        params: { key },
        description: `按键 ${key}`,
      });
      return actions;
    }

    // ── 截图 ──
    if (/截图|拍照|capture/.test(lower)) {
      actions.push({ type: 'screenshot', params: {}, description: '截图' });
      return actions;
    }

    return actions;
  }

  /**
   * 生成汇报
   */
  private generateReport(
    taskDescription: string,
    executionResult: DesktopTaskResult,
    observations: DesktopObservation[]
  ): string {
    let report = `🎯 任务: "${taskDescription}"\n\n`;

    if (executionResult.success) {
      report += '✅ 执行成功\n\n';
    } else {
      report += `⚠️ 执行遇到问题: ${executionResult.error || '部分动作失败'}\n\n`;
    }

    report += `📊 执行详情:\n`;
    executionResult.actions.forEach((action, i) => {
      const icon = action.success ? '✅' : '❌';
      report += `  ${icon} ${i + 1}. ${action.action.description || action.action.type}\n`;
      if (action.output) {
        report += `     ${action.output.substring(0, 80)}\n`;
      }
      if (action.error) {
        report += `     错误: ${action.error}\n`;
      }
    });

    if (observations.length > 0) {
      const latest = observations[observations.length - 1];
      report += `\n👁️ 桌面状态:\n`;
      report += `  窗口数: ${latest.windows.length}\n`;
      report += `  ${this.visionEngine.generateReport(latest).substring(0, 200)}\n`;
    }

    return report;
  }

  public isExecuting(): boolean {
    return this.isRunning;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('DesktopAgentLoop 未初始化！请先调用 initialize()');
    }
  }

  public async shutdown(): Promise<void> {
    this.isRunning = false;
    await this.executor.shutdown();
    this.initialized = false;
    Logger.info('🤖 DesktopAgentLoop 已关闭', 'DesktopAgentLoop');
  }
}

export default DesktopAgentLoop;

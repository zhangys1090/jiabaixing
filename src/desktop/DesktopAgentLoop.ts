/**
 * DesktopAgentLoop - 桌面智能体循环
 * 观察 → 决策 → 执行 → 验证 → 汇报
 * v3: LLM驱动决策 + 视觉理解 + 错误恢复闭环 + UI元素交互 + 剪贴板操作
 *     + CODEX风格 Sandbox/Snapshot/Manifest (checkpoint恢复 + 安全沙箱 + 工作空间描述)
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
import { DesktopUIInspector } from './DesktopUIInspector';
import { StateSnapshotManager, SnapshotMetadata } from './StateSnapshotManager';
import { Logger } from '../utils/Logger';
import { LLMProvider } from '../models/LLMProvider';

export interface DesktopAgentConfig {
  maxRetries?: number;
  verifyAfterAction?: boolean;
  autoObserveIntervalMs?: number;
  enableLLMPlanning?: boolean;
  maxPlanSteps?: number;
  enableCheckpoint?: boolean;
  sandboxMode?: 'strict' | 'moderate' | 'off';
  executionTimeoutMs?: number;
}

export interface DesktopAgentResult {
  success: boolean;
  taskDescription: string;
  executionResult: DesktopTaskResult;
  observations: DesktopObservation[];
  report: string;
  error?: string;
  retryCount?: number;
  checkpointId?: string;
  restoredFromCheckpoint?: boolean;
}

export interface DesktopManifest {
  workspace: string;
  allowedApps: string[];
  allowedPaths: string[];
  outputDirs: string[];
  maxActionsPerTask: number;
  forbiddenActions: string[];
}

const DEFAULT_MANIFEST: DesktopManifest = {
  workspace: process.cwd(),
  allowedApps: [],
  allowedPaths: ['./'],
  outputDirs: ['./output', './logs'],
  maxActionsPerTask: 20,
  forbiddenActions: [
    'format',
    'del /s',
    'rm -rf',
    'rm -rf /',
    'rm -rf /*',
    'shutdown',
    'restart',
    'reg delete',
    'reg add',
    'net user',
    'net localgroup',
    'cipher /w',
    'diskpart',
    'bcdedit',
    'taskkill /f /im svchost',
  ],
};

const DESKTOP_PLANNING_SYSTEM_PROMPT = `你是贾百姓的桌面操作规划引擎。你的任务是根据用户指令和当前桌面状态，规划一系列桌面操作动作。

可用动作类型：
- click: 点击坐标 {x, y}
- rightClick: 右键点击坐标 {x, y}
- type: 输入文字 {text}
- key: 按键 {key} (ENTER, ESCAPE, TAB, BACKSPACE, DELETE, UP, DOWN, LEFT, RIGHT, HOME, END, F5, F11)
- keyCombo: 组合键 {keys: ["CTRL","S"]}
- moveMouse: 移动鼠标 {x, y}
- scroll: 滚动 {delta} (正数向上，负数向下)
- drag: 拖拽 {fromX, fromY, toX, toY}
- openApp: 打开应用 {app}
- activateWindow: 激活窗口 {title}
- closeWindow: 关闭窗口 {title}
- maximize: 最大化窗口 {title}
- minimize: 最小化窗口 {title}
- wait: 等待 {ms}
- observe: 观察桌面 {}
- screenshot: 截图 {}
- clipboardRead: 读取剪贴板 {}
- clipboardWrite: 写入剪贴板 {text}
- clickElement: 点击UI元素 {description} (如"保存按钮"、"地址栏")
- typeIntoElement: 在UI元素中输入 {description, text} (如"搜索框中输入hello")
- getElementText: 获取UI元素文本 {description}
- shell: 执行命令 {command}

规则：
1. 每个动作必须包含 type、params、description
2. 操作之间加适当的 wait（打开应用后等1-2秒，点击后等200-500ms）
3. 优先使用 clickElement/typeIntoElement 而非坐标点击，更稳定
4. 复杂任务分解为小步骤，每步可验证
5. 只返回 JSON 数组，不要其他文字

返回格式：
[{"type":"...","params":{...},"description":"..."}]`;

export class DesktopAgentLoop {
  private static instance: DesktopAgentLoop | null = null;
  private executor: DesktopActionExecutor;
  private visionEngine: DesktopVisionEngine;
  private windowManager: WindowManager;
  private systemInput: SystemInput;
  private uiInspector: DesktopUIInspector;
  private snapshotManager: StateSnapshotManager;
  private llmProvider: LLMProvider | null;
  private manifest: DesktopManifest;
  private config: Required<DesktopAgentConfig>;
  private initialized: boolean = false;
  private isRunning: boolean = false;
  private lastCheckpointId: string | null = null;

  private constructor(config?: DesktopAgentConfig) {
    this.executor = DesktopActionExecutor.getInstance();
    this.visionEngine = DesktopVisionEngine.getInstance();
    this.windowManager = WindowManager.getInstance();
    this.systemInput = SystemInput.getInstance();
    this.uiInspector = DesktopUIInspector.getInstance();
    this.snapshotManager = StateSnapshotManager.getInstance();
    try {
      this.llmProvider = new LLMProvider();
    } catch {
      this.llmProvider = null;
    }
    this.manifest = { ...DEFAULT_MANIFEST };
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      verifyAfterAction: config?.verifyAfterAction ?? true,
      autoObserveIntervalMs: config?.autoObserveIntervalMs || 5000,
      enableLLMPlanning: config?.enableLLMPlanning ?? true,
      maxPlanSteps: config?.maxPlanSteps ?? 20,
      enableCheckpoint: config?.enableCheckpoint ?? true,
      sandboxMode: config?.sandboxMode ?? 'moderate',
      executionTimeoutMs: config?.executionTimeoutMs ?? 120000,
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
    await this.uiInspector.initialize();
    await this.snapshotManager.initialize();

    if (this.llmProvider) {
      try {
        await this.llmProvider.initialize();
        Logger.info('🤖 DesktopAgentLoop LLM 决策引擎已就绪', 'DesktopAgentLoop');
      } catch (err) {
        Logger.warn(
          `⚠️ LLM 初始化失败，降级为正则模式: ${(err as Error).message}`,
          'DesktopAgentLoop'
        );
        this.llmProvider = null;
      }
    }

    this.initialized = true;
    Logger.info('🤖 DesktopAgentLoop 初始化完成', 'DesktopAgentLoop');
  }

  /**
   * 核心循环：一句话 → 操作桌面 → 完成 → 汇报结果
   * v2: 支持错误恢复闭环（失败后重新观察→重新规划→重试）
   */
  public async execute(userInput: string): Promise<DesktopAgentResult> {
    this.ensureInitialized();
    this.isRunning = true;

    Logger.info(`🤖 收到桌面操作指令: "${userInput}"`, 'DesktopAgentLoop');

    const observations: DesktopObservation[] = [];
    let retryCount = 0;
    const startTime = Date.now();

    const isTimedOut = (): boolean =>
      Date.now() - startTime > this.config.executionTimeoutMs;

    try {
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        if (isTimedOut()) {
          Logger.warn('⏰ 执行超时，终止重试', 'DesktopAgentLoop');
          this.isRunning = false;
          return {
            success: false,
            taskDescription: userInput,
            executionResult: { success: false, actions: [], summary: '执行超时' },
            observations,
            report: `操作超时 (${this.config.executionTimeoutMs}ms)`,
            error: 'EXECUTION_TIMEOUT',
            retryCount,
          };
        }
        // ═══════════════════════ 1. 观察 ═══════════════════════
        Logger.info('🔍 阶段1: 观察桌面', 'DesktopAgentLoop');
        const observation = await this.visionEngine.observe();
        observations.push(observation);

        // ═══════════════════════ 2. 决策 ═══════════════════════
        Logger.info('🧠 阶段2: 决策规划', 'DesktopAgentLoop');
        let actions: DesktopAction[];

        if (this.config.enableLLMPlanning && this.llmProvider?.isAvailable()) {
          actions = await this.llmPlanActions(userInput, observation);
        } else {
          actions = this.planActions(userInput, observation);
        }

        if (actions.length === 0) {
          this.isRunning = false;
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
              '我无法理解这个桌面操作指令。请尝试更具体的描述，如"打开记事本并输入Hello"、"点击保存按钮"等。',
            retryCount,
          };
        }

        actions = actions.slice(0, this.config.maxPlanSteps);

        // ═══════════ CODEX风格: 安全沙箱检查 ═══════════
        if (this.config.sandboxMode !== 'off') {
          const unsafeActions = this.filterUnsafeActions(actions);
          if (unsafeActions.length > 0) {
            Logger.warn(
              `🛡️ 沙箱拦截 ${unsafeActions.length} 个不安全动作`,
              'DesktopAgentLoop'
            );
            actions = actions.filter((a) => !unsafeActions.includes(a));
          }
        }

        if (actions.length === 0) {
          this.isRunning = false;
          return {
            success: false,
            taskDescription: userInput,
            executionResult: {
              success: false,
              actions: [],
              summary: '所有动作被安全沙箱拦截',
            },
            observations,
            report: '操作被安全策略拦截。请尝试更安全的操作方式。',
            retryCount,
          };
        }

        // ═══════════ CODEX风格: 执行前checkpoint ═══════════
        if (this.config.enableCheckpoint) {
          try {
            const checkpoint = await this.snapshotManager.checkpointBeforeAction(
              userInput
            );
            this.lastCheckpointId = checkpoint.snapshotId;
            Logger.info(
              `📸 Checkpoint已保存: ${checkpoint.snapshotId}`,
              'DesktopAgentLoop'
            );
          } catch (err) {
            Logger.warn(
              `⚠️ Checkpoint保存失败: ${(err as Error).message}`,
              'DesktopAgentLoop'
            );
          }
        }

        // ═══════════════════════ 3. 执行 ═══════════════════════
        Logger.info(
          `🎮 阶段3: 执行 ${actions.length} 个动作 (尝试 ${attempt + 1}/${this.config.maxRetries + 1})`,
          'DesktopAgentLoop'
        );
        const executionResult = await this.executor.executeTask(actions);

        if (executionResult.success) {
          // ═══════════════════════ 4. 验证 ═══════════════════════
          if (this.config.verifyAfterAction) {
            Logger.info('✅ 阶段4: 验证结果', 'DesktopAgentLoop');
            await this.sleep(500);
            const finalObservation = await this.visionEngine.observe();
            observations.push(finalObservation);
          }

          const report = this.generateReport(
            userInput,
            executionResult,
            observations
          );

          Logger.info('🤖 桌面操作完成', 'DesktopAgentLoop');
          this.isRunning = false;
          return {
            success: true,
            taskDescription: userInput,
            executionResult,
            observations,
            report,
            retryCount,
          };
        }

        // 执行失败 — 判断是否值得重试
        retryCount++;
        if (attempt < this.config.maxRetries) {
          Logger.warn(
            `⚠️ 执行失败，准备重新观察并重试 (${retryCount}/${this.config.maxRetries})`,
            'DesktopAgentLoop'
          );

          // ═══════════ CODEX风格: 从checkpoint恢复 ═══════════
          if (this.config.enableCheckpoint && this.lastCheckpointId) {
            try {
              await this.snapshotManager.restoreSnapshot(this.lastCheckpointId, {
                restoreWindows: true,
                restoreClipboard: true,
              });
              Logger.info(
                `♻️ 已从Checkpoint恢复: ${this.lastCheckpointId}`,
                'DesktopAgentLoop'
              );
            } catch (restoreErr) {
              Logger.warn(
                `⚠️ Checkpoint恢复失败: ${(restoreErr as Error).message}`,
                'DesktopAgentLoop'
              );
            }
          }

          await this.sleep(1000);
        } else {
          const report = this.generateReport(
            userInput,
            executionResult,
            observations
          );
          this.isRunning = false;
          return {
            success: false,
            taskDescription: userInput,
            executionResult,
            observations,
            report: report + `\n\n⚠️ 已重试 ${retryCount} 次仍失败`,
            error: executionResult.error,
            retryCount,
          };
        }
      }
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
        retryCount,
      };
    }

    this.isRunning = false;
    return {
      success: false,
      taskDescription: userInput,
      executionResult: {
        success: false,
        actions: [],
        summary: '未知错误',
      },
      observations,
      report: '操作失败: 未知错误',
      retryCount,
    };
  }

  /**
   * LLM 驱动的动作规划
   * 将桌面观察结果 + 用户指令发给 LLM，返回结构化动作列表
   */
  private async llmPlanActions(
    userInput: string,
    observation: DesktopObservation
  ): Promise<DesktopAction[]> {
    if (!this.llmProvider) return this.planActions(userInput, observation);

    try {
      const screenshotBase64 = observation.screenshot.success
        ? observation.screenshot.buffer.toString('base64')
        : '';

      const windowList = observation.windows
        .filter((w) => w.isVisible && !w.isMinimized)
        .slice(0, 8)
        .map(
          (w) =>
            `- "${w.title}" (${w.processName}) 位置:(${w.bounds.x},${w.bounds.y}) 尺寸:${w.bounds.width}x${w.bounds.height}`
        )
        .join('\n');

      let uiElementsContext = '';
      try {
        const elements = this.uiInspector.getInteractiveElements();
        const clickableElements = elements
          .filter((e) => e.isClickable || e.isEditable)
          .slice(0, 30)
          .map(
            (e) =>
              `- "${e.name}" 类型:${e.controlTypeName} 位置:(${e.boundingRect.x},${e.boundingRect.y}) 尺寸:${e.boundingRect.width}x${e.boundingRect.height}${e.isClickable ? ' [可点击]' : ''}${e.isEditable ? ' [可编辑]' : ''}`
          )
          .join('\n');
        if (clickableElements) {
          uiElementsContext = `\n\n可交互UI元素:\n${clickableElements}`;
        }
      } catch {
        // UI检查失败不影响规划
      }

      const userPrompt = `用户指令: ${userInput}

当前桌面状态:
窗口列表:
${windowList || '(无可见窗口)'}
${uiElementsContext}
${observation.visionAnalysis.description ? `\n视觉分析: ${observation.visionAnalysis.description}` : ''}

请规划操作步骤。`;

      const images = screenshotBase64 ? [`data:image/png;base64,${screenshotBase64}`] : undefined;

      const llmResponse = await this.llmProvider.multimodalChat(
        userPrompt,
        images
      );

      const actions = this.parseLLMActions(llmResponse);
      if (actions.length > 0) {
        Logger.info(
          `🧠 LLM 规划了 ${actions.length} 个动作`,
          'DesktopAgentLoop'
        );
        return actions;
      }

      Logger.warn(
        '⚠️ LLM 规划结果为空，降级为正则模式',
        'DesktopAgentLoop'
      );
      return this.planActions(userInput, observation);
    } catch (error) {
      Logger.warn(
        `⚠️ LLM 规划失败，降级为正则模式: ${(error as Error).message}`,
        'DesktopAgentLoop'
      );
      return this.planActions(userInput, observation);
    }
  }

  /**
   * 解析 LLM 返回的 JSON 动作列表
   */
  private parseLLMActions(llmResponse: string): DesktopAction[] {
    try {
      const jsonMatch = llmResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      const validTypes = new Set([
        'screenshot', 'click', 'rightClick', 'type', 'key', 'keyCombo',
        'moveMouse', 'scroll', 'drag', 'openApp', 'activateWindow',
        'closeWindow', 'maximize', 'minimize', 'observe', 'wait',
        'shell', 'clipboardRead', 'clipboardWrite', 'clickElement',
        'typeIntoElement', 'getElementText',
      ]);

      return parsed
        .filter(
          (item: Record<string, unknown>) =>
            item.type && validTypes.has(item.type as string) && item.params
        )
        .map((item: Record<string, unknown>) => ({
          type: item.type as DesktopAction['type'],
          params: (item.params as Record<string, unknown>) || {},
          description: (item.description as string) || `${item.type}`,
        }));
    } catch (error) {
      Logger.warn(
        `⚠️ 解析 LLM 动作失败: ${(error as Error).message}`,
        'DesktopAgentLoop'
      );
      return [];
    }
  }

  /**
   * 正则模式：自然语言 → 动作规划（LLM 不可用时的降级方案）
   */
  private planActions(
    input: string,
    observation: DesktopObservation
  ): DesktopAction[] {
    void observation;
    const lower = input.toLowerCase().trim();
    const actions: DesktopAction[] = [];

    if (/看看|观察|截图|屏幕|桌面/.test(lower)) {
      actions.push({ type: 'observe', params: {}, description: '观察桌面' });
      return actions;
    }

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

    const typeMatch = lower.match(/输入[""']([^""']+)[""']/);
    if (typeMatch) {
      actions.push({
        type: 'type',
        params: { text: typeMatch[1] },
        description: `输入 "${typeMatch[1]}"`,
      });
      return actions;
    }

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

    if (/截图|拍照|capture/.test(lower)) {
      actions.push({ type: 'screenshot', params: {}, description: '截图' });
      return actions;
    }

    if (/复制|拷贝|copy/.test(lower)) {
      actions.push({ type: 'clipboardRead', params: {}, description: '读取剪贴板' });
      return actions;
    }

    if (/粘贴|paste/.test(lower)) {
      actions.push({
        type: 'keyCombo',
        params: { keys: ['CTRL', 'V'] },
        description: 'Ctrl+V 粘贴',
      });
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
    await this.snapshotManager.dispose();
    this.initialized = false;
    Logger.info('🤖 DesktopAgentLoop 已关闭', 'DesktopAgentLoop');
  }

  /**
   * CODEX风格: 安全沙箱过滤
   * 检查动作是否违反 Manifest 中的安全策略
   */
  private filterUnsafeActions(actions: DesktopAction[]): DesktopAction[] {
    const unsafe: DesktopAction[] = [];

    for (const action of actions) {
      if (action.type === 'shell') {
        const command = (action.params.command as string || '').toLowerCase();
        for (const forbidden of this.manifest.forbiddenActions) {
          if (command.includes(forbidden.toLowerCase())) {
            unsafe.push(action);
            Logger.warn(
              `🛡️ 拦截危险命令: "${command}" (匹配规则: ${forbidden})`,
              'DesktopAgentLoop'
            );
            break;
          }
        }
      }

      if (this.config.sandboxMode === 'strict') {
        if (action.type === 'shell' && this.manifest.allowedApps.length > 0) {
          const command = (action.params.command as string || '').toLowerCase();
          const isAllowed = this.manifest.allowedApps.some((app) =>
            command.includes(app.toLowerCase())
          );
          if (!isAllowed) {
            unsafe.push(action);
          }
        }
      }
    }

    return unsafe;
  }

  /**
   * 更新 Manifest（工作空间描述）
   */
  public updateManifest(manifest: Partial<DesktopManifest>): void {
    Object.assign(this.manifest, manifest);
    Logger.info('📋 Manifest 已更新', 'DesktopAgentLoop');
  }

  /**
   * 获取当前 Manifest
   */
  public getManifest(): DesktopManifest {
    return { ...this.manifest };
  }

  /**
   * 手动恢复到最近的 checkpoint
   */
  public async restoreLastCheckpoint(): Promise<boolean> {
    if (!this.lastCheckpointId) {
      Logger.warn('⚠️ 没有可用的 Checkpoint', 'DesktopAgentLoop');
      return false;
    }
    try {
      const result = await this.snapshotManager.restoreSnapshot(
        this.lastCheckpointId
      );
      return result.success;
    } catch (error) {
      Logger.error(
        '❌ Checkpoint恢复失败',
        error as Error,
        'DesktopAgentLoop'
      );
      return false;
    }
  }
}

export default DesktopAgentLoop;

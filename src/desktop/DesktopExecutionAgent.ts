/**
 * 增强版桌面执行Agent (Codex风格)
 *
 * 整合：
 * - 归一化坐标系统
 * - MCP 工具调用
 * - 事件流实时推送
 * - 安全防护系统
 * - 技能包系统
 *
 * 工作流程：
 * 用户指令 → 技能匹配/LLM规划 → 安全检查 → 执行动作 → 观察验证 → 循环直到完成
 */

import { EventEmitter } from 'events';
import { DesktopMCPServer } from './DesktopMCPServer';
import { DesktopEventStream } from './DesktopEventStream';
import { DesktopSafetyGuard } from './DesktopSafetyGuard';
import {
  DesktopSkillRegistry,
  DesktopSkill,
  SkillStep,
} from './DesktopSkillRegistry';
import { NormalizedCoordinateSystem } from './NormalizedCoordinates';
import { DesktopVisionEngine, DesktopObservation } from './DesktopVisionEngine';
import { LLMProvider } from '../models/LLMProvider';
import { Logger } from '../utils/Logger';

export interface ExecutionAgentConfig {
  safetyLevel?: 'strict' | 'moderate' | 'permissive';
  enableSkills?: boolean;
  enableLLMPlanning?: boolean;
  maxSteps?: number;
  autoVerify?: boolean;
}

export interface ExecutionResult {
  success: boolean;
  taskDescription: string;
  stepsCompleted: number;
  totalSteps: number;
  durationMs: number;
  observations: DesktopObservation[];
  report: string;
  error?: string;
  usedSkill?: string;
}

const DEFAULT_CONFIG: Required<ExecutionAgentConfig> = {
  safetyLevel: 'moderate',
  enableSkills: true,
  enableLLMPlanning: true,
  maxSteps: 50,
  autoVerify: true,
};

export class DesktopExecutionAgent extends EventEmitter {
  private static instance: DesktopExecutionAgent | null = null;
  private config: Required<ExecutionAgentConfig>;

  // 核心模块
  private mcpServer: DesktopMCPServer;
  private eventStream: DesktopEventStream;
  private safetyGuard: DesktopSafetyGuard;
  private skillRegistry: DesktopSkillRegistry;
  private coords: NormalizedCoordinateSystem;
  private visionEngine: DesktopVisionEngine;
  private llmProvider: LLMProvider | null = null;

  // 状态
  private initialized: boolean = false;
  private isRunning: boolean = false;
  private currentTaskId: string = '';

  private constructor(config?: ExecutionAgentConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.mcpServer = DesktopMCPServer.getInstance();
    this.eventStream = DesktopEventStream.getInstance();
    this.safetyGuard = DesktopSafetyGuard.getInstance();
    this.skillRegistry = DesktopSkillRegistry.getInstance();
    this.coords = NormalizedCoordinateSystem.getInstance();
    this.visionEngine = DesktopVisionEngine.getInstance();
  }

  public static getInstance(
    config?: ExecutionAgentConfig
  ): DesktopExecutionAgent {
    if (!DesktopExecutionAgent.instance) {
      DesktopExecutionAgent.instance = new DesktopExecutionAgent(config);
    }
    return DesktopExecutionAgent.instance;
  }

  /**
   * 初始化执行Agent
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    Logger.info('🚀 桌面执行Agent初始化 (Codex风格)', 'ExecAgent');

    // 初始化所有子模块
    await this.mcpServer.initialize();
    await this.safetyGuard.initialize();
    await this.visionEngine.initialize();
    this.coords.refreshScreenInfo();

    // 初始化LLM
    if (this.config.enableLLMPlanning) {
      try {
        this.llmProvider = new LLMProvider();
        await this.llmProvider.initialize();
        Logger.info('🧠 LLM规划引擎已就绪', 'ExecAgent');
      } catch (err) {
        Logger.warn(
          `⚠️ LLM初始化失败，降级为技能模式: ${(err as Error).message}`,
          'ExecAgent'
        );
        this.llmProvider = null;
      }
    }

    // 设置安全回调
    this.safetyGuard.onEmergencyStop(() => {
      this.handleEmergencyStop();
    });

    this.initialized = true;
    Logger.info('✅ 桌面执行Agent初始化完成', 'ExecAgent');
    this.emit('initialized');
  }

  /**
   * 执行任务（主入口）
   */
  public async executeTask(taskDescription: string): Promise<ExecutionResult> {
    this.ensureInitialized();

    if (this.isRunning) {
      return {
        success: false,
        taskDescription,
        stepsCompleted: 0,
        totalSteps: 0,
        durationMs: 0,
        observations: [],
        report: 'Agent正忙，请等待当前任务完成',
        error: 'AGENT_BUSY',
      };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const observations: DesktopObservation[] = [];

    // 开始任务
    this.currentTaskId = this.eventStream.startTask(taskDescription);
    this.safetyGuard.startTask();

    Logger.info(`🎯 开始执行任务: ${taskDescription}`, 'ExecAgent');

    try {
      let result: ExecutionResult;

      // 1. 尝试匹配技能
      if (this.config.enableSkills) {
        const skillMatch = this.skillRegistry.matchSkill(taskDescription);
        if (skillMatch && skillMatch.confidence > 50) {
          Logger.info(
            `🎯 匹配到技能: ${skillMatch.skill.name} (置信度: ${Math.round(skillMatch.confidence)}%)`,
            'ExecAgent'
          );
          result = await this.executeWithSkill(
            skillMatch.skill,
            skillMatch.extractedParams,
            observations
          );
          result.usedSkill = skillMatch.skill.name;
          return result;
        }
      }

      // 2. 使用LLM规划执行
      if (this.config.enableLLMPlanning && this.llmProvider) {
        Logger.info('🧠 使用LLM规划执行', 'ExecAgent');
        result = await this.executeWithLLMPlanning(
          taskDescription,
          observations
        );
        return result;
      }

      // 3. 降级：基础模式
      Logger.info('⚙️  使用基础执行模式', 'ExecAgent');
      result = await this.executeBasic(taskDescription, observations);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = (error as Error).message;

      Logger.error(`❌ 任务执行失败: ${errorMsg}`, error as Error, 'ExecAgent');
      this.eventStream.endTask(false, errorMsg);

      return {
        success: false,
        taskDescription,
        stepsCompleted: 0,
        totalSteps: 0,
        durationMs: duration,
        observations,
        report: `执行失败: ${errorMsg}`,
        error: errorMsg,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 紧急停止
   */
  public stop(reason: string = '用户停止'): void {
    if (!this.isRunning) return;
    Logger.warn(`⏹️  任务停止: ${reason}`, 'ExecAgent');
    this.safetyGuard.emergencyStop(reason);
  }

  /**
   * 暂停任务
   */
  public pause(reason: string = '用户暂停'): void {
    this.safetyGuard.pause(reason);
    this.eventStream.emitStatusChange('paused', reason);
  }

  /**
   * 恢复任务
   */
  public resume(): void {
    this.safetyGuard.resume();
    this.eventStream.emitStatusChange('running');
  }

  /**
   * 获取当前状态
   */
  public getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.safetyGuard.getStatus().isPaused,
      isStopped: this.safetyGuard.getStatus().isStopped,
      currentTaskId: this.currentTaskId,
      safetyStatus: this.safetyGuard.getStatus(),
    };
  }

  /**
   * 获取事件流
   */
  public getEventStream(): DesktopEventStream {
    return this.eventStream;
  }

  /**
   * 获取MCP服务器
   */
  public getMCPServer(): DesktopMCPServer {
    return this.mcpServer;
  }

  // ========== 内部执行方法 ==========

  /**
   * 使用技能执行
   */
  private async executeWithSkill(
    skill: DesktopSkill,
    params: Record<string, string>,
    observations: DesktopObservation[]
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    const result = await this.skillRegistry.executeSkill(
      skill.id,
      params,
      async (step: SkillStep) => {
        // 安全检查
        const safetyCheck = this.safetyGuard.checkAction(
          step.type,
          step.description
        );
        if (!safetyCheck.allowed) {
          if (safetyCheck.requireConfirmation) {
            this.eventStream.emitUserInterventionRequired(
              safetyCheck.reason || '需要确认'
            );
            // 实际实现中这里会等待用户确认
            Logger.warn(`⚠️  需要用户确认: ${safetyCheck.reason}`, 'ExecAgent');
          }
          throw new Error(safetyCheck.reason || '安全检查未通过');
        }

        // 执行步骤
        this.eventStream.emitActionStart(
          step.type,
          step.description,
          step.action?.params || {}
        );

        let success = true;

        switch (step.type) {
          case 'action':
            if (step.action) {
              const mcpResult = await this.mcpServer.callTool(
                step.action.type,
                step.action.params
              );
              success = !mcpResult.isError;
            }
            break;

          case 'wait':
            if (step.wait) {
              await new Promise((resolve) =>
                setTimeout(resolve, step.wait!.durationMs)
              );
            }
            break;

          case 'screenshot':
            const observation = await this.visionEngine.observe();
            observations.push(observation);
            this.eventStream.emitObservation(
              observation.screenshotBase64,
              observation.screenWidth,
              observation.screenHeight
            );
            break;

          case 'verify':
            // 验证逻辑
            success = true; // 简化实现
            break;

          case 'llm_plan':
            // LLM动态规划
            success = true; // 简化实现
            break;
        }

        this.safetyGuard.recordAction();
        this.eventStream.emitActionEnd(step.type, step.description, success);

        return success;
      }
    );

    const duration = Date.now() - startTime;
    this.eventStream.endTask(result.success, result.skillName);

    return {
      success: result.success,
      taskDescription: skill.description,
      stepsCompleted: result.stepsCompleted,
      totalSteps: result.totalSteps,
      durationMs: duration,
      observations,
      report: result.success
        ? `技能执行成功: ${skill.name}`
        : `技能执行失败: ${result.error}`,
      error: result.error,
      usedSkill: skill.name,
    };
  }

  /**
   * 使用LLM规划执行
   */
  private async executeWithLLMPlanning(
    taskDescription: string,
    observations: DesktopObservation[]
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let stepsCompleted = 0;
    const maxSteps = this.config.maxSteps;

    // 初始观察
    const initialObs = await this.visionEngine.observe();
    observations.push(initialObs);
    this.eventStream.emitObservation(
      initialObs.screenshotBase64,
      initialObs.screenWidth,
      initialObs.screenHeight
    );

    // 获取可用工具列表
    const tools = this.mcpServer.listTools();
    const toolsDescription = tools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');

    // LLM规划循环
    let currentObservation = initialObs;
    let stepCount = 0;

    while (stepCount < maxSteps) {
      stepCount++;

      // 安全检查
      if (this.safetyGuard.getStatus().isStopped) {
        throw new Error('已触发紧急停止');
      }

      // 调用LLM生成下一步动作
      const planPrompt = this.buildPlanningPrompt(
        taskDescription,
        currentObservation,
        toolsDescription,
        stepCount,
        stepsCompleted
      );

      this.eventStream.emitStatusChange('planning');

      const llmResponse = await this.llmProvider!.chat(
        planPrompt,
        [],
        this.getSystemPrompt()
      );

      // 解析LLM响应，提取动作
      const action = this.parseLLMAction(llmResponse);

      if (!action) {
        Logger.warn('⚠️ 无法解析LLM响应，尝试重新规划', 'ExecAgent');
        continue;
      }

      if (action.type === 'done') {
        // 任务完成
        Logger.info('✅ LLM判定任务完成', 'ExecAgent');
        break;
      }

      // 安全检查
      const safetyCheck = this.safetyGuard.checkAction(
        action.type,
        action.description || action.type,
        action.params
      );

      if (!safetyCheck.allowed) {
        if (safetyCheck.requireConfirmation) {
          this.eventStream.emitUserInterventionRequired(
            safetyCheck.reason || '需要确认'
          );
          // 实际实现中等待用户确认
          Logger.warn(`⚠️  需要用户确认: ${safetyCheck.reason}`, 'ExecAgent');
        }
        throw new Error(safetyCheck.reason || '安全检查未通过');
      }

      // 执行动作
      this.eventStream.emitActionStart(
        action.type,
        action.description || action.type,
        action.params || {}
      );

      const mcpResult = await this.mcpServer.callTool(
        action.type,
        action.params || {}
      );

      this.safetyGuard.recordAction();
      stepsCompleted++;

      this.eventStream.emitActionEnd(
        action.type,
        action.description || action.type,
        !mcpResult.isError
      );

      // 验证：重新观察
      if (this.config.autoVerify) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        currentObservation = await this.visionEngine.observe();
        observations.push(currentObservation);
        this.eventStream.emitObservation(
          currentObservation.screenshotBase64,
          currentObservation.screenWidth,
          currentObservation.screenHeight
        );
      }

      if (mcpResult.isError) {
        Logger.warn(
          `⚠️ 动作执行失败: ${action.type} - ${mcpResult.content[0]?.text}`,
          'ExecAgent'
        );
        // 可以在这里添加重试逻辑
      }
    }

    const duration = Date.now() - startTime;
    const success = stepCount < maxSteps;

    this.eventStream.endTask(success, success ? '任务完成' : '达到最大步数');

    return {
      success,
      taskDescription,
      stepsCompleted,
      totalSteps: stepCount,
      durationMs: duration,
      observations,
      report: success
        ? `任务完成，共执行 ${stepsCompleted} 步`
        : `任务未完成，达到最大步数 ${maxSteps}`,
    };
  }

  /**
   * 基础执行模式（降级方案）
   */
  private async executeBasic(
    taskDescription: string,
    observations: DesktopObservation[]
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // 简单的关键词匹配执行
    const observation = await this.visionEngine.observe();
    observations.push(observation);
    this.eventStream.emitObservation(
      observation.screenshotBase64,
      observation.screenWidth,
      observation.screenHeight
    );

    const duration = Date.now() - startTime;

    this.eventStream.endTask(
      false,
      '基础模式无法执行复杂任务，请启用LLM规划或使用技能'
    );

    return {
      success: false,
      taskDescription,
      stepsCompleted: 1,
      totalSteps: 1,
      durationMs: duration,
      observations,
      report: '基础模式仅支持截图等简单操作，复杂任务请启用LLM规划',
      error: 'BASIC_MODE_LIMITED',
    };
  }

  /**
   * 处理紧急停止
   */
  private handleEmergencyStop(): void {
    this.isRunning = false;
    this.eventStream.emitStatusChange('stopped', '紧急停止');
    this.emit('emergency_stop');
  }

  /**
   * 构建LLM规划提示词
   */
  private buildPlanningPrompt(
    task: string,
    observation: DesktopObservation,
    toolsDesc: string,
    step: number,
    completed: number
  ): string {
    return `你是一个桌面操作助手。你的任务是根据当前屏幕状态，决定下一步操作。

任务目标: ${task}
当前步数: ${step}
已完成动作: ${completed}

可用工具:
${toolsDesc}

坐标说明:
- 使用归一化坐标 [0-1000] × [0-1000]
- 屏幕左上角为 (0, 0)，右下角为 (1000, 1000)
- 例如：屏幕中间位置是 (500, 500)

当前屏幕信息:
- 分辨率: ${observation.screenWidth} × ${observation.screenHeight}
- 活动窗口: ${observation.activeWindow || '未知'}
- 窗口列表: ${observation.windowTitles?.join(', ') || '无'}

请分析当前屏幕状态，然后决定下一步操作。
只返回一个JSON对象，格式如下：
{
  "type": "工具名称",
  "params": { ...参数 },
  "description": "动作描述",
  "reasoning": "为什么选择这个动作"
}

如果认为任务已经完成，返回：
{"type": "done", "description": "任务完成描述"}`;
  }

  /**
   * 获取系统提示词
   */
  private getSystemPrompt(): string {
    return `你是一个专业的桌面操作助手，擅长通过鼠标和键盘操作电脑。

操作原则：
1. 每一步操作前都要仔细观察屏幕状态
2. 优先使用精确的UI元素操作，而不是盲目点击
3. 操作后验证结果是否符合预期
4. 遇到问题及时调整策略
5. 保持操作节奏稳定，不要过快

坐标系统：
- 所有坐标使用归一化值，范围 [0, 1000]
- x: 0 = 屏幕最左，1000 = 屏幕最右
- y: 0 = 屏幕最上，1000 = 屏幕最下

请始终以安全、准确、高效的方式完成任务。`;
  }

  /**
   * 解析LLM动作响应
   */
  private parseLLMAction(response: string): {
    type: string;
    params?: Record<string, unknown>;
    description?: string;
    reasoning?: string;
  } | null {
    try {
      // 尝试提取JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const action = JSON.parse(jsonMatch[0]);
        return action;
      }
    } catch {
      // 解析失败，继续尝试其他方式
    }

    return null;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('桌面执行Agent未初始化，请先调用 initialize()');
    }
  }
}

// 便捷导出
export const executionAgent = DesktopExecutionAgent.getInstance();

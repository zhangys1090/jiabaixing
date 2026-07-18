/**
 * 交互网关 - 三入口统一
 *
 * 统一 CLI / WebSocket / HTTP 三个入口的输入路由
 * 差异仅在传输层，统一到 InteractionGateway
 *
 * 架构：
 * User Input → [CLI Adapter / WebSocket Adapter / HTTP Adapter]
 *                    ↓
 *              InteractionGateway（统一路由）
 *                    ↓
 *              AgentHarness / JiabaixingCore
 */

import { TaskComplexityAnalyzer } from '../core/TaskComplexityAnalyzer';
import { EventBus, JiabaixingEventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';

/** 输入来源枚举 */
export enum InputSource {
  CLI = 'cli',
  WEBSOCKET = 'websocket',
  HTTP = 'http',
  UNKNOWN = 'unknown',
}

/** 统一输入接口 */
export interface UnifiedInput {
  /** 输入文本 */
  text: string;
  /** 输入来源 */
  source: InputSource;
  /** 用户ID */
  userId: string;
  /** 客户端IP */
  clientIp?: string;
  /** 追踪ID */
  traceId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 附加数据 */
  metadata?: Record<string, unknown>;
}

/** 统一输出接口 */
export interface UnifiedOutput {
  /** 响应文本 */
  response: string;
  /** 是否成功 */
  success: boolean;
  /** 追踪ID */
  traceId: string;
  /** 执行深度 */
  executionDepth: ExecutionDepth;
  /** 执行时长(ms) */
  duration: number;
  /** 错误信息 */
  error?: string;
  /** 质量评分 */
  qualityScore?: number;
  /** 使用的工具列表 */
  toolsUsed?: string[];
}

/** 执行深度枚举 */
export enum ExecutionDepth {
  /** 仅 Execute，跳过 Plan/Evaluate（简单问答） */
  MINIMAL = 'minimal',
  /** Execute + ToolGuard（工具调用） */
  STANDARD = 'standard',
  /** 完整 6 层循环（复杂任务） */
  FULL = 'full',
}

/** 网关配置 */
export interface GatewayConfig {
  /** 是否启用工具懒加载 */
  enableToolLazyLoad: boolean;
  /** 是否启用执行深度自动检测 */
  enableExecutionDepthAutoDetect: boolean;
  /** 简单任务阈值（ token 数） */
  simpleTaskTokenThreshold: number;
}

const DEFAULT_CONFIG: GatewayConfig = {
  enableToolLazyLoad: true,
  enableExecutionDepthAutoDetect: true,
  simpleTaskTokenThreshold: 500,
};

/** 交互网关单例 */
export class InteractionGateway {
  private static instance: InteractionGateway | null = null;
  private config: GatewayConfig;
  private complexityAnalyzer: TaskComplexityAnalyzer;

  private constructor(config?: Partial<GatewayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.complexityAnalyzer = new TaskComplexityAnalyzer();
  }

  /**
   * 获取网关单例
   */
  public static getInstance(
    config?: Partial<GatewayConfig>
  ): InteractionGateway {
    if (!InteractionGateway.instance) {
      InteractionGateway.instance = new InteractionGateway(config);
    }
    return InteractionGateway.instance;
  }

  /**
   * 路由统一输入（供各适配器调用）
   * @param input - 统一输入
   * @param core - 核心引擎
   * @returns 统一输出
   */
  async route(
    input: UnifiedInput,
    core: {
      processInput(
        text: string,
        userId?: string,
        traceId?: string
      ): Promise<{ response: string; traceId?: string }>;
      getHarness?(): {
        getToolRegistry?(): {
          lazyLoad?(tools: string[]): Promise<number>;
          getRegisteredToolNames?(): string[];
        };
        getLoopController?(): {
          run(
            input: { text: string; userId?: string; traceId?: string },
            messages: unknown[]
          ): Promise<unknown>;
        };
      };
    }
  ): Promise<UnifiedOutput> {
    const startTime = Date.now();
    const traceId =
      input.traceId ||
      `gw_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    Logger.info(
      `[Gateway] 📥 收到输入 | source=${input.source} | text="${input.text.substring(0, 50)}${input.text.length > 50 ? '...' : ''}"`,
      'InteractionGateway'
    );

    try {
      // 1. 分析执行深度
      const executionDepth = this.detectExecutionDepth(input.text);

      Logger.info(
        `[Gateway] 📊 执行深度: ${executionDepth} | traceId=${traceId}`,
        'InteractionGateway'
      );

      // 2. 按需加载工具
      if (this.config.enableToolLazyLoad) {
        await this.loadRequiredTools(input.text, core);
      }

      // 3. 发送到核心处理
      (EventBus as JiabaixingEventBus).emit('gateway_input_received', {
        traceId,
        source: input.source,
        textLength: input.text.length,
        executionDepth: Number(executionDepth),
      });

      const result = await core.processInput(input.text, input.userId, traceId);

      const duration = Date.now() - startTime;

      const output: UnifiedOutput = {
        response: result.response,
        success: true,
        traceId: result.traceId || traceId,
        executionDepth,
        duration,
      };

      (EventBus as JiabaixingEventBus).emit('gateway_output_sent', {
        traceId,
        response: result.response,
        duration,
        success: true,
      });

      Logger.info(
        `[Gateway] ✅ 处理完成 | duration=${duration}ms | depth=${executionDepth} | traceId=${traceId}`,
        'InteractionGateway'
      );

      return output;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = (error as Error).message;

      Logger.error(
        `[Gateway] ❌ 处理失败: ${errorMessage}`,
        error as Error,
        'InteractionGateway'
      );

      (EventBus as JiabaixingEventBus).emit('gateway_output_sent', {
        traceId,
        response: '',
        duration,
        success: false,
      });

      return {
        response: '',
        success: false,
        traceId,
        executionDepth: ExecutionDepth.STANDARD,
        duration,
        error: errorMessage,
      };
    }
  }

  /**
   * 检测执行深度
   * 根据输入复杂度自动选择执行路径
   */
  private detectExecutionDepth(text: string): ExecutionDepth {
    if (!this.config.enableExecutionDepthAutoDetect) {
      return ExecutionDepth.FULL;
    }

    // 使用复杂度分析器
    const complexity = this.complexityAnalyzer.analyzeComplexity(text);

    // 简单问答：直接执行
    if (complexity.complexity === 'simple') {
      return ExecutionDepth.MINIMAL;
    }

    // 中等复杂度：标准执行
    if (complexity.complexity === 'medium') {
      return ExecutionDepth.STANDARD;
    }

    // 复杂任务：完整循环
    return ExecutionDepth.FULL;
  }

  /**
   * 按需加载工具
   * 根据输入内容检测所需工具，动态加载
   */
  private async loadRequiredTools(
    text: string,
    core: {
      getHarness?(): {
        getToolRegistry?(): {
          lazyLoad?(tools: string[]): Promise<number>;
          getRegisteredToolNames?(): string[];
        };
      };
    }
  ): Promise<void> {
    const harness = core.getHarness?.();
    const toolRegistry = harness?.getToolRegistry?.();

    if (!toolRegistry?.lazyLoad) {
      return;
    }

    // 检测输入中提到的工具关键词
    const requiredTools = this.detectRequiredTools(text);

    if (requiredTools.length > 0) {
      Logger.info(
        `[Gateway] 🔧 按需加载工具: [${requiredTools.join(', ')}]`,
        'InteractionGateway'
      );
      await toolRegistry.lazyLoad(requiredTools);
    }
  }

  /**
   * 检测所需工具
   * 根据输入内容分析需要哪些工具
   */
  private detectRequiredTools(text: string): string[] {
    const lowerText = text.toLowerCase();
    const tools: string[] = [];

    // 文件操作
    if (/\b(读|写|查看|编辑|搜索|文件)\b/.test(lowerText)) {
      tools.push('file_read', 'incremental_edit', 'file_search');
    }

    // Shell 命令
    if (/\b(执行|运行|命令|shell|终端)\b/.test(lowerText)) {
      tools.push('shell_exec');
    }

    // Web 搜索
    if (/\b(搜索|查找|查询|搜索)\b/.test(lowerText)) {
      tools.push('web_search', 'web_fetch');
    }

    // 记忆操作
    if (/\b(记忆|存储|记住|回忆)\b/.test(lowerText)) {
      tools.push('memory_store', 'memory_recall');
    }

    // 桌面操作
    if (/\b(桌面|截图|自动化|点击)\b/.test(lowerText)) {
      tools.push('desktop_screenshot', 'desktop_automate');
    }

    // 代码相关
    if (/\b(代码|编程|函数|调试)\b/.test(lowerText)) {
      tools.push('code_analyze', 'code_review');
    }

    return [...new Set(tools)];
  }

  /**
   * 从 CLI 消息构建统一输入
   */
  public static fromCLI(
    text: string,
    userId: string = 'cli_user'
  ): UnifiedInput {
    return {
      text,
      source: InputSource.CLI,
      userId,
      timestamp: Date.now(),
    };
  }

  /**
   * 从 WebSocket 消息构建统一输入
   */
  public static fromWebSocket(
    text: string,
    userId: string,
    clientIp: string,
    traceId?: string
  ): UnifiedInput {
    return {
      text,
      source: InputSource.WEBSOCKET,
      userId,
      clientIp,
      traceId,
      timestamp: Date.now(),
    };
  }

  /**
   * 从 HTTP 请求构建统一输入
   */
  public static fromHTTP(
    text: string,
    userId: string,
    traceId?: string
  ): UnifiedInput {
    return {
      text,
      source: InputSource.HTTP,
      userId,
      traceId,
      timestamp: Date.now(),
    };
  }

  /**
   * 更新配置
   */
  public updateConfig(config: Partial<GatewayConfig>): void {
    this.config = { ...this.config, ...config };
    Logger.info(
      `[Gateway] ⚙️ 配置更新: ${JSON.stringify(config)}`,
      'InteractionGateway'
    );
  }

  /**
   * 获取当前配置
   */
  public getConfig(): GatewayConfig {
    return { ...this.config };
  }
}

/**
 * 便捷函数：创建网关实例
 */
export function createInteractionGateway(
  config?: Partial<GatewayConfig>
): InteractionGateway {
  return InteractionGateway.getInstance(config);
}

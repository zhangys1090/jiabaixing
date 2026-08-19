/**
 * ActionDispatcher —— 统一动作调度器（编排层单一入口）
 *
 * 归并 harness 工具 / 桌面 / MCP 三通道为一个调度接口：
 *   编排层 → dispatch({ channel, ... }) → 对应 ActionChannel → ActionResult
 *
 * 同时提供 verifyDesktopAction(...) 便捷封装，供桌面动作在执行后接回
 * Python ActionVerifier（闭环）。各通道后端对象经 use* 方法注入，启动时装配。
 */

import type {
  ActionChannel,
  ActionChannelKind,
  ActionRequest,
  ActionResult,
  VerificationOutcome,
  VerifyRequest,
} from './types';
import type { ToolRegistry } from '../tools/registry/ToolRegistry';
import type { DesktopActionExecutor } from '../../desktop/DesktopActionExecutor';
import { ToolChannel } from './channels/ToolChannel';
import { DesktopChannel } from './channels/DesktopChannel';
import { McpChannel } from './channels/McpChannel';
import {
  getActionVerificationBridge,
  type VerificationBridge,
} from './verify/VerificationBridge';
import { DesktopActionExecutor as DefaultDesktopExecutor } from '../../desktop/DesktopActionExecutor';
import { Logger } from '../../utils/Logger';

export class ActionDispatcher {
  private readonly channels = new Map<ActionChannelKind, ActionChannel>();
  private toolRegistry: ToolRegistry | null = null;
  private desktopExecutor: DesktopActionExecutor | null = null;
  private verifier: VerificationBridge = getActionVerificationBridge();

  constructor() {
    this.ensureChannels();
  }

  private ensureChannels(): void {
    // MCP / Desktop 通道不依赖外部注入，始终可用
    if (!this.channels.has('mcp')) {
      this.channels.set('mcp', new McpChannel());
    }
    const desktop = this.desktopExecutor ?? DefaultDesktopExecutor.getInstance();
    if (!this.channels.has('desktop')) {
      this.channels.set('desktop', new DesktopChannel(desktop, this.verifier));
    }
  }

  /** 注入真实工具注册表（启动时由 AgentHarness 装配） */
  useToolRegistry(registry: ToolRegistry): this {
    this.toolRegistry = registry;
    this.channels.set('tool', new ToolChannel(registry));
    return this;
  }

  /** 注入桌面执行器实例（默认使用 DesktopActionExecutor 单例） */
  useDesktopExecutor(executor: DesktopActionExecutor): this {
    this.desktopExecutor = executor;
    this.channels.set(
      'desktop',
      new DesktopChannel(executor, this.verifier)
    );
    return this;
  }

  /** 切换验证桥（默认 Python 优先，可降级为 Local） */
  useVerifier(verifier: VerificationBridge): this {
    this.verifier = verifier;
    const desktop = this.desktopExecutor ?? DefaultDesktopExecutor.getInstance();
    this.channels.set('desktop', new DesktopChannel(desktop, verifier));
    return this;
  }

  /** 注册自定义通道（扩展点） */
  registerChannel(channel: ActionChannel): this {
    this.channels.set(channel.kind, channel);
    return this;
  }

  getChannel(kind: ActionChannelKind): ActionChannel | undefined {
    return this.channels.get(kind);
  }

  /** 编排层单一入口：经统一接口调度三类动作，结果归一为 ActionResult */
  async dispatch(request: ActionRequest): Promise<ActionResult> {
    const channel = this.channels.get(request.channel);
    if (!channel) {
      Logger.warn(
        `ActionDispatcher 未注册通道: ${request.channel}`,
        'ActionDispatcher'
      );
      return {
        channel: request.channel,
        success: false,
        output: null,
        error: `未注册的动作通道: ${request.channel}`,
        durationMs: 0,
      };
    }
    return channel.dispatch(request);
  }

  /** 桌面动作接回 action_verifier 的便捷封装（验证核心在 Python 端） */
  async verifyDesktopAction(
    description: string,
    prePath?: string,
    postPath?: string,
    opts: { strategy?: VerifyRequest['strategy']; question?: string } = {}
  ): Promise<VerificationOutcome> {
    return this.verifier.verify({
      description,
      prePath,
      postPath,
      strategy: opts.strategy ?? 'auto',
      question: opts.question ?? '',
    });
  }
}

let _dispatcher: ActionDispatcher | null = null;

/** 获取全局单例调度器 */
export function getActionDispatcher(): ActionDispatcher {
  if (!_dispatcher) _dispatcher = new ActionDispatcher();
  return _dispatcher;
}

/** 启动装配：注入真实工具注册表 / 桌面执行器 / 验证桥 */
export function configureActionDispatcher(opts: {
  toolRegistry?: ToolRegistry;
  desktopExecutor?: DesktopActionExecutor;
  verifier?: VerificationBridge;
}): ActionDispatcher {
  const d = getActionDispatcher();
  if (opts.toolRegistry) d.useToolRegistry(opts.toolRegistry);
  if (opts.desktopExecutor) d.useDesktopExecutor(opts.desktopExecutor);
  if (opts.verifier) d.useVerifier(opts.verifier);
  return d;
}

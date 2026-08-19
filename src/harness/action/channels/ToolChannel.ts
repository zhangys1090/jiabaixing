/**
 * ToolChannel —— harness 工具通道适配器
 *
 * 将 ToolRegistry.execute(...) 归一为 ActionChannel 契约。
 * 编排层经 ActionDispatcher 以 channel='tool' 调度任意已注册工具。
 */

import type { ToolRegistry } from '../../tools/registry/ToolRegistry';
import type { ToolResult } from '../../types';
import type { ActionChannel, ActionRequest, ActionResult } from '../types';
import { Logger } from '../../../utils/Logger';

export class ToolChannel implements ActionChannel {
  readonly kind = 'tool' as const;

  constructor(private readonly registry: ToolRegistry) {}

  async dispatch(request: ActionRequest): Promise<ActionResult> {
    const start = Date.now();
    const tool = request.tool;

    if (!tool) {
      return {
        channel: 'tool',
        success: false,
        output: null,
        error: 'ToolChannel 需要 request.tool',
        durationMs: Date.now() - start,
      };
    }

    try {
      const result: ToolResult = await this.registry.execute(
        tool,
        request.params ?? {},
        (request.context ?? {}) as import('../../types').ToolContext
      );

      return {
        channel: 'tool',
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs: result.duration ?? Date.now() - start,
        raw: result,
        metadata: result.metadata,
      };
    } catch (err) {
      Logger.error(
        `ToolChannel 调度失败: ${tool}`,
        err as Error,
        'ToolChannel'
      );
      return {
        channel: 'tool',
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}

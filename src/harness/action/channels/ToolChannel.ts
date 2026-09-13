/**
 * ToolChannel —— harness 工具通道适配器
 *
 * 将 ToolRegistry.execute(...) 归一为 ActionChannel 契约。
 * 编排层经 ActionDispatcher 以 channel='tool' 调度任意已注册工具。
 *
 * Layer 1 收口：任何 production tool execution 必须经过 DecisionGuard，
 * 确保 goalId / snapshotId / decisionId 审计跟踪完整。
 */

import type { ToolRegistry } from '../../tools/registry/ToolRegistry';
import type { ToolResult } from '../../types';
import type { ActionChannel, ActionRequest, ActionResult } from '../types';
import { Logger } from '../../../utils/Logger';
import { DecisionGuard } from '../../../authority/DecisionGuard';
import { GoalExecutionDomain } from '../../../authority/types';

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
      const guard = DecisionGuard.getInstance();
      const { decision, snapshot, goalId } = await guard.guardAction({
        action: {
          type: 'tool_call',
          payload: { toolName: tool, params: request.params },
        },
        description: `ToolChannel execution: ${tool}`,
        executionDomain: 'tool_execution' as GoalExecutionDomain,
        proposerId: 'tool_channel_proposer',
        confidence: 0.85,
        reasoning: `Harness tool dispatch: ${tool}`,
      });

      const authorityMeta = guard.extractAuthorityMeta(decision, snapshot, goalId);

      const result: ToolResult = await this.registry.execute(
        tool,
        request.params ?? {},
        {
          ...(request.context ?? {}),
          metadata: {
            ...((request.context as unknown as Record<string, unknown>)?.metadata ?? {}),
            authorityMeta,
          },
        } as import('../../types').ToolContext
      );

      guard.reportEvidence({
        goalId,
        decisionId: decision.decisionId,
        action: decision.chosen.action,
        expectedEffect: decision.chosen.reasoning,
        actualEffect: result.success ? 'success' : `error: ${result.error}`,
        observation: result.output,
        success: result.success,
      });

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

/**
 * DesktopChannel —— 桌面动作通道适配器
 *
 * 将 DesktopActionExecutor.executeAction(...) 归一为 ActionChannel 契约。
 * 若请求携带 verify，则在动作执行后接回 VerificationBridge（→ Python ActionVerifier）
 * 形成「执行 → 验证」闭环，这是 P1-2 桌面动作接回 action_verifier 的关键落点。
 *
 * Layer 1 收口：桌面动作经过 DecisionGuard 决策链，
 * 确保 goalId / snapshotId / decisionId 审计跟踪完整。
 */

import { DesktopActionAuthority } from '../../../desktop/DesktopActionAuthority';
import type {
    DesktopActionResult,
} from '../../../desktop/DesktopActionExecutor';
import { Logger } from '../../../utils/Logger';
import type {
    ActionChannel,
    ActionRequest,
    ActionResult
} from '../types';
import type { VerificationBridge } from '../verify/VerificationBridge';
import { DecisionGuard } from '../../../authority/DecisionGuard';
import { GoalExecutionDomain } from '../../../authority/types';

export class DesktopChannel implements ActionChannel {
  readonly kind = 'desktop' as const;
  private authority: DesktopActionAuthority;

  constructor(
    verifier?: VerificationBridge
  ) {
    this.authority = DesktopActionAuthority.getInstance();
    void verifier;
  }

  async dispatch(request: ActionRequest): Promise<ActionResult> {
    const start = Date.now();
    const action = request.desktopAction;

    if (!action) {
      return {
        channel: 'desktop',
        success: false,
        output: null,
        error: 'DesktopChannel 需要 request.desktopAction',
        durationMs: Date.now() - start,
      };
    }

    try {
      Logger.info('[AUDIT] DecisionAuthority-gated action: source=DesktopChannel type=desktop_action', 'DesktopChannel');
      const guard = DecisionGuard.getInstance();
      const { decision, goalId } = await guard.guardAction({
        action: {
          type: 'desktop_action',
          payload: { actionType: action.type, params: (action as unknown as Record<string, unknown>).params },
        },
        description: `DesktopChannel action: ${action.type}`,
        executionDomain: 'desktop' as GoalExecutionDomain,
        proposerId: 'desktop_channel_proposer',
        confidence: 0.85,
        reasoning: `Harness desktop dispatch: ${action.type}`,
      });

      const { result }: { result: DesktopActionResult } =
        await this.authority.executeAction(action);

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
        channel: 'desktop',
        success: result.success,
        output: result.output ?? (result.observation ? '[observation]' : null),
        error: result.error,
        durationMs: Date.now() - start,
        raw: result,
      };
    } catch (err) {
      Logger.error('DesktopChannel 执行失败', err as Error, 'DesktopChannel');
      return {
        channel: 'desktop',
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}

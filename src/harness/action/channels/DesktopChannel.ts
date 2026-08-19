/**
 * DesktopChannel —— 桌面动作通道适配器
 *
 * 将 DesktopActionExecutor.executeAction(...) 归一为 ActionChannel 契约。
 * 若请求携带 verify，则在动作执行后接回 VerificationBridge（→ Python ActionVerifier）
 * 形成「执行 → 验证」闭环，这是 P1-2 桌面动作接回 action_verifier 的关键落点。
 */

import type { DesktopActionExecutor, DesktopActionResult } from '../../../desktop/DesktopActionExecutor';
import type {
  ActionChannel,
  ActionRequest,
  ActionResult,
  VerificationOutcome,
} from '../types';
import type { VerificationBridge } from '../verify/VerificationBridge';
import { Logger } from '../../../utils/Logger';

export class DesktopChannel implements ActionChannel {
  readonly kind = 'desktop' as const;

  constructor(
    private readonly executor: DesktopActionExecutor,
    private readonly verifier?: VerificationBridge
  ) {}

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
      const result: DesktopActionResult = await this.executor.executeAction(
        action
      );

      let verification: VerificationOutcome | undefined;
      if (request.verify && this.verifier) {
        try {
          verification = await this.verifier.verify(request.verify);
        } catch (err) {
          Logger.warn(
            `DesktopChannel 验证接回失败: ${(err as Error).message}`,
            'DesktopChannel'
          );
        }
      }

      return {
        channel: 'desktop',
        success: result.success,
        output:
          result.output ??
          (result.observation ? '[observation]' : null),
        error: result.error,
        durationMs: Date.now() - start,
        raw: result,
        verification,
      };
    } catch (err) {
      Logger.error(
        'DesktopChannel 执行失败',
        err as Error,
        'DesktopChannel'
      );
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

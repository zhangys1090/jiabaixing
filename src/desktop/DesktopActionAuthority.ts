/**
 * DesktopActionAuthority — 桌面动作唯一裁决点 (P0-A)
 *
 * 所有 production 路径必须经过此 authority 才能执行桌面动作。
 * 任何 proposer（LLM / Skill / Rule）都不能直接调用 DesktopActionExecutor。
 *
 * 链路：
 *   proposer → ActionAuthority.authorize() → ActionAuthority.execute()
 *                                              ↓
 *                                     SafetyGuard.checkAction()
 *                                              ↓
 *                                     DesktopActionExecutor.executeTask()
 *
 * Bridge 不可用时：FAIL CLOSED，不产生任何 executable fallback。
 */

import { Logger } from '../utils/Logger';
import {
    DesktopAction,
    DesktopActionExecutor,
    DesktopActionResult,
    DesktopTaskResult,
} from './DesktopActionExecutor';
import { DesktopSafetyGuard } from './DesktopSafetyGuard';

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
  severity?: string;
  requireConfirmation?: boolean;
}

export interface AuthorizedExecutionResult extends DesktopTaskResult {
  authorization: AuthorizationDecision;
}

export class DesktopActionAuthority {
  private static instance: DesktopActionAuthority | null = null;
  private safetyGuard: DesktopSafetyGuard;
  private executor: DesktopActionExecutor;

  private constructor() {
    this.safetyGuard = DesktopSafetyGuard.getInstance();
    this.executor = DesktopActionExecutor.getInstance();
  }

  public static getInstance(): DesktopActionAuthority {
    if (!DesktopActionAuthority.instance) {
      DesktopActionAuthority.instance = new DesktopActionAuthority();
    }
    return DesktopActionAuthority.instance;
  }

  public async initialize(): Promise<void> {
    await this.safetyGuard.initialize();
    await this.executor.initialize();
  }

  public authorize(
    actions: DesktopAction[]
  ): AuthorizationDecision {
    for (const action of actions) {
      const check = this.safetyGuard.checkAction(
        action.type,
        action.description || action.type,
        action.params
      );
      if (!check.allowed) {
        Logger.warn(
          `🛡️ ActionAuthority 拒绝动作: ${action.type} — ${check.reason}`,
          'ActionAuthority'
        );
        return check;
      }
    }
    return { allowed: true };
  }

  public async execute(
    actions: DesktopAction[]
  ): Promise<AuthorizedExecutionResult> {
    const authorization = this.authorize(actions);

    if (!authorization.allowed) {
      Logger.warn(
        `🛡️ ActionAuthority 阻止执行: ${authorization.reason}`,
        'ActionAuthority'
      );
      return {
        success: false,
        actions: [],
        summary: authorization.reason || '安全检查未通过',
        authorization,
      };
    }

    const result = await this.executor.executeTask(actions);
    return { ...result, authorization };
  }

  public async executeAction(
    action: DesktopAction
  ): Promise<{ result: DesktopActionResult; authorization: AuthorizationDecision }> {
    const authorization = this.authorize([action]);

    if (!authorization.allowed) {
      Logger.warn(
        `🛡️ ActionAuthority 阻止单动作执行: ${action.type} — ${authorization.reason}`,
        'ActionAuthority'
      );
      return {
        result: {
          success: false,
          action,
          error: authorization.reason || '安全检查未通过',
        },
        authorization,
      };
    }

    const result = await this.executor.executeAction(action);
    return { result, authorization };
  }
}

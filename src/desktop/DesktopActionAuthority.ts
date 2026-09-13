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

export interface ActionExecutionContext {
  decisionId: string;
  goalId: string;
  planVersion: number;
  snapshotId: string;
  authorizationSource: 'autonomous_decision' | 'external_command';
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

  public validateDecisionContext(context: ActionExecutionContext): AuthorizationDecision {
    try {
      const { GoalAuthority } = require('../authority/GoalAuthority');
      const goalAuthority = GoalAuthority.getInstance();
      const goal = goalAuthority.getGoal(context.goalId);

      if (!goal) {
        Logger.warn(
          `🛡️ ActionAuthority: goal ${context.goalId} not found — STALE`,
          'ActionAuthority'
        );
        return { allowed: false, reason: `goal_not_found: ${context.goalId}` };
      }

      if (goal.planVersion !== context.planVersion) {
        Logger.warn(
          `🛡️ ActionAuthority: STALE_DECISION — goal ${context.goalId} planVersion ${context.planVersion} != current ${goal.planVersion}`,
          'ActionAuthority'
        );
        return {
          allowed: false,
          reason: `stale_decision: planVersion ${context.planVersion} != current ${goal.planVersion}`,
        };
      }

      const { DecisionAuthority } = require('../authority/DecisionAuthority');
      const decisionAuthority = DecisionAuthority.getInstance();
      const history = decisionAuthority.getDecisionHistory(context.goalId);
      const decision = history.find((d: { decisionId: string }) => d.decisionId === context.decisionId);

      if (!decision) {
        Logger.warn(
          `🛡️ ActionAuthority: decision ${context.decisionId} not found in history — INVALID`,
          'ActionAuthority'
        );
        return { allowed: false, reason: `decision_not_found: ${context.decisionId}` };
      }

      if (decision.planVersion !== context.planVersion) {
        Logger.warn(
          `🛡️ ActionAuthority: decision planVersion mismatch — decision ${context.decisionId} has v${decision.planVersion}, context has v${context.planVersion}`,
          'ActionAuthority'
        );
        return {
          allowed: false,
          reason: `decision_planVersion_mismatch: ${decision.planVersion} != ${context.planVersion}`,
        };
      }

      return { allowed: true };
    } catch (err) {
      Logger.error(
        `🛡️ ActionAuthority: validateDecisionContext error — ${(err as Error).message}`,
        err as Error,
        'ActionAuthority'
      );
      return { allowed: false, reason: `validation_error: ${(err as Error).message}` };
    }
  }

  public async executeWithDecisionContext(
    actions: DesktopAction[],
    context: ActionExecutionContext
  ): Promise<AuthorizedExecutionResult> {
    const decisionValidation = this.validateDecisionContext(context);
    if (!decisionValidation.allowed) {
      return {
        success: false,
        actions: [],
        summary: decisionValidation.reason || 'decision validation failed',
        authorization: decisionValidation,
      };
    }

    return this.execute(actions);
  }
}

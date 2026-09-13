import type {
  Decision,
  ProposedAction,
  ActionExecutionResult,
  ExecutionStatus,
} from './types';
import type {
  ActionExecutionContext,
  AuthorizationDecision,
} from '../desktop/DesktopActionAuthority';
import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';

export interface DecisionExecutionResult {
  success: boolean;
  goalId: string;
  decisionId: string;
  planVersion: number;
  actionResult: unknown;
  authorization: AuthorizationDecision;
  reason: string;
  executionResult: ActionExecutionResult;
}

export interface DecisionExecutor {
  execute(decision: Decision): Promise<DecisionExecutionResult>;
}

function makeExecId(): string {
  return `EXEC_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function makeExecutionResult(
  decision: Decision,
  status: ExecutionStatus,
  actionType: string,
  rawResult: unknown,
  error?: string
): ActionExecutionResult {
  return {
    executionId: makeExecId(),
    decisionId: decision.decisionId,
    goalId: decision.goalId,
    planVersion: decision.planVersion,
    status,
    actionType,
    rawResult,
    error,
    timestamp: Date.now(),
  };
}

class DecisionExecutorImpl implements DecisionExecutor {
  async execute(decision: Decision): Promise<DecisionExecutionResult> {
    const { GoalAuthority } = require('./GoalAuthority');
    const goalAuthority = GoalAuthority.getInstance();
    const goal = goalAuthority.getGoal(decision.goalId);

    if (!goal) {
      return this.fail(decision, `goal ${decision.goalId} not found`);
    }

    if (goal.planVersion !== decision.planVersion) {
      return this.fail(
        decision,
        `STALE_DECISION: decision planVersion ${decision.planVersion} != goal planVersion ${goal.planVersion}`
      );
    }

    const context: ActionExecutionContext = {
      decisionId: decision.decisionId,
      goalId: decision.goalId,
      planVersion: decision.planVersion,
      snapshotId: decision.snapshotId,
      authorizationSource: 'autonomous_decision',
    };

    const action = decision.chosen.action;

    if (action.type === 'desktop_action') {
      return this.executeDesktopAction(decision, context, action);
    }

    if (action.type === 'tool_call') {
      return this.executeToolCall(decision, context, action);
    }

    if (action.type === 'message') {
      Logger.info(
        `[D7-3C] Decision ${decision.decisionId}: message action — dispatched only`,
        'DecisionExecutor'
      );
      const execResult = makeExecutionResult(decision, 'executed', 'message', { type: 'message', payload: action.payload });
      return {
        success: true,
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        planVersion: decision.planVersion,
        actionResult: { type: 'message', payload: action.payload },
        authorization: { allowed: true },
        reason: 'message_action_dispatched',
        executionResult: execResult,
      };
    }

    if (action.type === 'composite') {
      return this.executeComposite(decision, context, action);
    }

    return this.fail(decision, `unknown action type: ${action.type}`);
  }

  private async executeDesktopAction(
    decision: Decision,
    context: ActionExecutionContext,
    action: ProposedAction
  ): Promise<DecisionExecutionResult> {
    try {
      const { DesktopActionAuthority } = require('../desktop/DesktopActionAuthority');
      const authority = DesktopActionAuthority.getInstance();

      const desktopActions = this.toDesktopActions(action.payload);
      const result = await authority.executeWithDecisionContext(desktopActions, context);

      Logger.info(
        `[D7-3C] Decision ${decision.decisionId} executed: success=${result.success}`,
        'DecisionExecutor'
      );

      EventBus.emit('decision_executed', {
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        planVersion: decision.planVersion,
        success: result.success,
        reason: result.success ? 'desktop_action_executed' : (result.summary || 'execution_failed'),
      });

      const execResult = makeExecutionResult(
        decision,
        result.success ? 'executed' : 'execution_failed',
        'desktop_action',
        result,
        result.success ? undefined : (result.summary || 'execution_failed')
      );

      return {
        success: result.success,
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        planVersion: decision.planVersion,
        actionResult: result,
        authorization: result.authorization,
        reason: result.success ? 'desktop_action_executed' : (result.summary || 'execution_failed'),
        executionResult: execResult,
      };
    } catch (err) {
      Logger.error(
        `[D7-3C] Desktop action execution failed: ${(err as Error).message}`,
        err as Error,
        'DecisionExecutor'
      );
      return this.fail(decision, `desktop_action_error: ${(err as Error).message}`);
    }
  }

  private async executeToolCall(
    decision: Decision,
    context: ActionExecutionContext,
    action: ProposedAction
  ): Promise<DecisionExecutionResult> {
    try {
      let authority: any;
      try {
        const { DesktopActionAuthority } = require('../desktop/DesktopActionAuthority');
        authority = DesktopActionAuthority.getInstance();
      } catch (authErr) {
        Logger.warn(`[D8-1] DesktopActionAuthority not available: ${(authErr as Error).message}`, 'DecisionExecutor');
      }

      let validation = { allowed: true, reason: 'no_authority_check' };
      if (authority) {
        validation = authority.validateDecisionContext(context);
      }

      if (!validation.allowed) {
        return this.fail(decision, `authorization_denied: ${validation.reason}`);
      }

      const payload = action.payload as Record<string, unknown>;
      const command = payload.command as string | undefined;
      const nodeScript = payload.nodeScript as string | undefined;

      if (nodeScript) {
        return this.executeNodeScript(decision, context, nodeScript, payload);
      }

      if (command) {
        return this.executeShellCommand(decision, context, command, payload);
      }

      Logger.info(
        `[D7-3C] Decision ${decision.decisionId}: tool_call dispatched — awaiting environment verification`,
        'DecisionExecutor'
      );

      const execResult = makeExecutionResult(
        decision,
        'dispatched',
        'tool_call',
        { type: 'tool_call', payload: action.payload, dispatched: true }
      );

      return {
        success: true,
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        planVersion: decision.planVersion,
        actionResult: { type: 'tool_call', payload: action.payload, dispatched: true },
        authorization: validation,
        reason: 'tool_call_dispatched',
        executionResult: execResult,
      };
    } catch (err) {
      Logger.error(
        `[D7-3C] Tool call execution failed: ${(err as Error).message}`,
        err as Error,
        'DecisionExecutor'
      );
      return this.fail(decision, `tool_call_error: ${(err as Error).message}`);
    }
  }

  private async executeNodeScript(
    decision: Decision,
    context: ActionExecutionContext,
    script: string,
    payload: Record<string, unknown>
  ): Promise<DecisionExecutionResult> {
    try {
      let tempDir = '';
      try {
        const { GoalAuthority } = require('./GoalAuthority');
        const ga = GoalAuthority.getInstance();
        const goal = ga.getGoal(decision.goalId);
        tempDir = (goal?.metadata?.tempDir as string) || '';
      } catch {
        tempDir = ((context as unknown) as Record<string, unknown>).tempDir as string || '';
      }

      Logger.info(
        `[D8-1] Decision ${decision.decisionId}: executing node script (${script.length} chars) tempDir="${tempDir}"`,
        'DecisionExecutor'
      );

      const result = await new Promise<{ success: boolean; output: string; error: string }>((resolve) => {
        try {
          const logs: string[] = [];
          const fn = new Function('require', 'console', 'TEMP_DIR', script);
          fn(require, { log: (...args: unknown[]) => logs.push(args.map(String).join(' ')) }, tempDir || '');
          resolve({ success: true, output: logs.join('\n'), error: '' });
        } catch (err) {
          Logger.warn(`[D8-1] Node script EXECUTION ERROR: ${(err as Error).message}`, 'DecisionExecutor');
          resolve({ success: false, output: '', error: (err as Error).message });
        }
      });

      Logger.info(
        `[D8-1] Node script result: success=${result.success} outputLen=${result.output.length}`,
        'DecisionExecutor'
      );

      const execResult = makeExecutionResult(
        decision,
        result.success ? 'executed' : 'execution_failed',
        'tool_call',
        {
          type: 'tool_call',
          tool: payload.tool,
          nodeScript: script.slice(0, 200),
          success: result.success,
          output: result.output,
          error: result.error,
          observation: result.success ? { output: result.output, success: true } : null,
        },
        result.success ? undefined : result.error
      );

      return {
        success: result.success,
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        planVersion: decision.planVersion,
        actionResult: {
          type: 'tool_call',
          tool: payload.tool,
          success: result.success,
          output: result.output,
          error: result.error,
        },
        authorization: { allowed: true },
        reason: result.success ? 'node_script_executed' : `node_script_failed: ${result.error}`,
        executionResult: execResult,
      };
    } catch (err) {
      Logger.error(
        `[D8-1] Node script execution error: ${(err as Error).message}`,
        err as Error,
        'DecisionExecutor'
      );
      return this.fail(decision, `node_script_error: ${(err as Error).message}`);
    }
  }

  private async executeShellCommand(
    decision: Decision,
    context: ActionExecutionContext,
    command: string,
    payload: Record<string, unknown>
  ): Promise<DecisionExecutionResult> {
    try {
      const { exec } = require('child_process');
      const { GoalAuthority } = require('./GoalAuthority');
      const ga = GoalAuthority.getInstance();
      const goal = ga.getGoal(decision.goalId);
      const tempDir = goal?.metadata?.tempDir as string | undefined;

      Logger.info(
        `[D8-1] Decision ${decision.decisionId}: executing shell: ${command}`,
        'DecisionExecutor'
      );

      const result = await new Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>((resolve) => {
        exec(
          command,
          {
            timeout: 15000,
            shell: true,
            env: { ...process.env, TEMP_DIR: tempDir || '' },
          },
          (error: Error | null, stdout: string, stderr: string) => {
            resolve({
              success: !error,
              stdout: stdout?.trim() || '',
              stderr: stderr?.trim() || '',
              exitCode: error ? (error as any).code ?? 1 : 0,
            });
          }
        );
      });

      Logger.info(
        `[D8-1] Shell result: exitCode=${result.exitCode} stdout="${result.stdout.slice(0, 200)}"`,
        'DecisionExecutor'
      );

      const execResult = makeExecutionResult(
        decision,
        result.success ? 'executed' : 'execution_failed',
        'tool_call',
        {
          type: 'tool_call',
          tool: payload.tool,
          command,
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          observation: result.success ? { stdout: result.stdout, exitCode: result.exitCode } : null,
        },
        result.success ? undefined : `exit_code_${result.exitCode}: ${result.stderr}`
      );

      return {
        success: result.success,
        goalId: decision.goalId,
        decisionId: decision.decisionId,
        planVersion: decision.planVersion,
        actionResult: {
          type: 'tool_call',
          tool: payload.tool,
          command,
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
        authorization: { allowed: true },
        reason: result.success ? 'shell_executed' : `shell_failed_exit_${result.exitCode}`,
        executionResult: execResult,
      };
    } catch (err) {
      Logger.error(
        `[D8-1] Shell execution error: ${(err as Error).message}`,
        err as Error,
        'DecisionExecutor'
      );
      return this.fail(decision, `shell_error: ${(err as Error).message}`);
    }
  }

  private async executeComposite(
    decision: Decision,
    context: ActionExecutionContext,
    action: ProposedAction
  ): Promise<DecisionExecutionResult> {
    const payload = action.payload as { actions?: ProposedAction[] };
    const subActions = payload.actions || [];

    if (subActions.length === 0) {
      return this.fail(decision, 'composite action has no sub-actions');
    }

    const results: unknown[] = [];
    for (const sub of subActions) {
      if (sub.type === 'desktop_action') {
        const r = await this.executeDesktopAction(decision, context, sub);
        results.push(r);
        if (!r.success) {
          Logger.warn(
            `[D7-3C] Composite sub-action failed, stopping remaining actions`,
            'DecisionExecutor'
          );
          const execResult = makeExecutionResult(decision, 'execution_failed', 'composite', results, `sub_action_failed: ${r.reason}`);
          return {
            success: false,
            goalId: decision.goalId,
            decisionId: decision.decisionId,
            planVersion: decision.planVersion,
            actionResult: results,
            authorization: { allowed: true },
            reason: `composite_sub_action_failed: ${r.reason}`,
            executionResult: execResult,
          };
        }
      } else if (sub.type === 'tool_call') {
        const r = await this.executeToolCall(decision, context, sub);
        results.push(r);
        if (!r.success) {
          const execResult = makeExecutionResult(decision, 'execution_failed', 'composite', results, `sub_action_failed: ${r.reason}`);
          return {
            success: false,
            goalId: decision.goalId,
            decisionId: decision.decisionId,
            planVersion: decision.planVersion,
            actionResult: results,
            authorization: { allowed: true },
            reason: `composite_sub_action_failed: ${r.reason}`,
            executionResult: execResult,
          };
        }
      }
    }

    const execResult = makeExecutionResult(decision, 'executed', 'composite', results);
    return {
      success: true,
      goalId: decision.goalId,
      decisionId: decision.decisionId,
      planVersion: decision.planVersion,
      actionResult: results,
      authorization: { allowed: true },
      reason: 'composite_executed',
      executionResult: execResult,
    };
  }

  private toDesktopActions(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && typeof payload === 'object' && 'type' in (payload as Record<string, unknown>)) {
      return [payload];
    }
    return [];
  }

  private fail(decision: Decision, reason: string): DecisionExecutionResult {
    Logger.warn(
      `[D7-3C] Decision ${decision.decisionId} execution FAILED: ${reason}`,
      'DecisionExecutor'
    );
    const execResult = makeExecutionResult(decision, 'execution_failed', 'unknown', null, reason);
    return {
      success: false,
      goalId: decision.goalId,
      decisionId: decision.decisionId,
      planVersion: decision.planVersion,
      actionResult: null,
      authorization: { allowed: false, reason },
      reason,
      executionResult: execResult,
    };
  }
}

let instance: DecisionExecutor | null = null;

export function getDecisionExecutor(): DecisionExecutor {
  if (!instance) {
    instance = new DecisionExecutorImpl();
  }
  return instance;
}

export function resetDecisionExecutor(): void {
  instance = null;
}

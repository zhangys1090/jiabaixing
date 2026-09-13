"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDecisionExecutor = getDecisionExecutor;
exports.resetDecisionExecutor = resetDecisionExecutor;
const Logger_1 = require("../utils/Logger");
const EventBus_1 = require("../shared/EventBus");
function makeExecId() {
    return `EXEC_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
function makeExecutionResult(decision, status, actionType, rawResult, error) {
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
class DecisionExecutorImpl {
    async execute(decision) {
        const { GoalAuthority } = require('./GoalAuthority');
        const goalAuthority = GoalAuthority.getInstance();
        const goal = goalAuthority.getGoal(decision.goalId);
        if (!goal) {
            return this.fail(decision, `goal ${decision.goalId} not found`);
        }
        if (goal.planVersion !== decision.planVersion) {
            return this.fail(decision, `STALE_DECISION: decision planVersion ${decision.planVersion} != goal planVersion ${goal.planVersion}`);
        }
        const context = {
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
            Logger_1.Logger.info(`[D7-3C] Decision ${decision.decisionId}: message action — dispatched only`, 'DecisionExecutor');
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
    async executeDesktopAction(decision, context, action) {
        try {
            const { DesktopActionAuthority } = require('../desktop/DesktopActionAuthority');
            const authority = DesktopActionAuthority.getInstance();
            const desktopActions = this.toDesktopActions(action.payload);
            const result = await authority.executeWithDecisionContext(desktopActions, context);
            Logger_1.Logger.info(`[D7-3C] Decision ${decision.decisionId} executed: success=${result.success}`, 'DecisionExecutor');
            EventBus_1.EventBus.emit('decision_executed', {
                goalId: decision.goalId,
                decisionId: decision.decisionId,
                planVersion: decision.planVersion,
                success: result.success,
                reason: result.success ? 'desktop_action_executed' : (result.summary || 'execution_failed'),
            });
            const execResult = makeExecutionResult(decision, result.success ? 'executed' : 'execution_failed', 'desktop_action', result, result.success ? undefined : (result.summary || 'execution_failed'));
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
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-3C] Desktop action execution failed: ${err.message}`, err, 'DecisionExecutor');
            return this.fail(decision, `desktop_action_error: ${err.message}`);
        }
    }
    async executeToolCall(decision, context, action) {
        try {
            let authority;
            try {
                const { DesktopActionAuthority } = require('../desktop/DesktopActionAuthority');
                authority = DesktopActionAuthority.getInstance();
            }
            catch (authErr) {
                Logger_1.Logger.warn(`[D8-1] DesktopActionAuthority not available: ${authErr.message}`, 'DecisionExecutor');
            }
            let validation = { allowed: true, reason: 'no_authority_check' };
            if (authority) {
                validation = authority.validateDecisionContext(context);
            }
            if (!validation.allowed) {
                return this.fail(decision, `authorization_denied: ${validation.reason}`);
            }
            const payload = action.payload;
            const command = payload.command;
            const nodeScript = payload.nodeScript;
            if (nodeScript) {
                return this.executeNodeScript(decision, context, nodeScript, payload);
            }
            if (command) {
                return this.executeShellCommand(decision, context, command, payload);
            }
            Logger_1.Logger.info(`[D7-3C] Decision ${decision.decisionId}: tool_call dispatched — awaiting environment verification`, 'DecisionExecutor');
            const execResult = makeExecutionResult(decision, 'dispatched', 'tool_call', { type: 'tool_call', payload: action.payload, dispatched: true });
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
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-3C] Tool call execution failed: ${err.message}`, err, 'DecisionExecutor');
            return this.fail(decision, `tool_call_error: ${err.message}`);
        }
    }
    async executeNodeScript(decision, context, script, payload) {
        try {
            let tempDir = '';
            try {
                const { GoalAuthority } = require('./GoalAuthority');
                const ga = GoalAuthority.getInstance();
                const goal = ga.getGoal(decision.goalId);
                tempDir = goal?.metadata?.tempDir || '';
            }
            catch {
                tempDir = context.tempDir || '';
            }
            Logger_1.Logger.info(`[D8-1] Decision ${decision.decisionId}: executing node script (${script.length} chars)`, 'DecisionExecutor');
            const result = await new Promise((resolve) => {
                try {
                    const logs = [];
                    const fn = new Function('require', 'console', 'TEMP_DIR', script);
                    fn(require, { log: (...args) => logs.push(args.map(String).join(' ')) }, tempDir || '');
                    resolve({ success: true, output: logs.join('\n'), error: '' });
                }
                catch (err) {
                    resolve({ success: false, output: '', error: err.message });
                }
            });
            Logger_1.Logger.info(`[D8-1] Node script result: success=${result.success} output="${result.output.slice(0, 200)}"`, 'DecisionExecutor');
            const execResult = makeExecutionResult(decision, result.success ? 'executed' : 'execution_failed', 'tool_call', {
                type: 'tool_call',
                tool: payload.tool,
                nodeScript: script.slice(0, 200),
                success: result.success,
                output: result.output,
                error: result.error,
                observation: result.success ? { output: result.output, success: true } : null,
            }, result.success ? undefined : result.error);
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
        }
        catch (err) {
            Logger_1.Logger.error(`[D8-1] Node script execution error: ${err.message}`, err, 'DecisionExecutor');
            return this.fail(decision, `node_script_error: ${err.message}`);
        }
    }
    async executeShellCommand(decision, context, command, payload) {
        try {
            const { exec } = require('child_process');
            const { GoalAuthority } = require('./GoalAuthority');
            const ga = GoalAuthority.getInstance();
            const goal = ga.getGoal(decision.goalId);
            const tempDir = goal?.metadata?.tempDir;
            Logger_1.Logger.info(`[D8-1] Decision ${decision.decisionId}: executing shell: ${command}`, 'DecisionExecutor');
            const result = await new Promise((resolve) => {
                exec(command, {
                    timeout: 15000,
                    shell: true,
                    env: { ...process.env, TEMP_DIR: tempDir || '' },
                }, (error, stdout, stderr) => {
                    resolve({
                        success: !error,
                        stdout: stdout?.trim() || '',
                        stderr: stderr?.trim() || '',
                        exitCode: error ? error.code ?? 1 : 0,
                    });
                });
            });
            Logger_1.Logger.info(`[D8-1] Shell result: exitCode=${result.exitCode} stdout="${result.stdout.slice(0, 200)}"`, 'DecisionExecutor');
            const execResult = makeExecutionResult(decision, result.success ? 'executed' : 'execution_failed', 'tool_call', {
                type: 'tool_call',
                tool: payload.tool,
                command,
                success: result.success,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                observation: result.success ? { stdout: result.stdout, exitCode: result.exitCode } : null,
            }, result.success ? undefined : `exit_code_${result.exitCode}: ${result.stderr}`);
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
        }
        catch (err) {
            Logger_1.Logger.error(`[D8-1] Shell execution error: ${err.message}`, err, 'DecisionExecutor');
            return this.fail(decision, `shell_error: ${err.message}`);
        }
    }
    async executeComposite(decision, context, action) {
        const payload = action.payload;
        const subActions = payload.actions || [];
        if (subActions.length === 0) {
            return this.fail(decision, 'composite action has no sub-actions');
        }
        const results = [];
        for (const sub of subActions) {
            if (sub.type === 'desktop_action') {
                const r = await this.executeDesktopAction(decision, context, sub);
                results.push(r);
                if (!r.success) {
                    Logger_1.Logger.warn(`[D7-3C] Composite sub-action failed, stopping remaining actions`, 'DecisionExecutor');
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
            else if (sub.type === 'tool_call') {
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
    toDesktopActions(payload) {
        if (Array.isArray(payload)) {
            return payload;
        }
        if (payload && typeof payload === 'object' && 'type' in payload) {
            return [payload];
        }
        return [];
    }
    fail(decision, reason) {
        Logger_1.Logger.warn(`[D7-3C] Decision ${decision.decisionId} execution FAILED: ${reason}`, 'DecisionExecutor');
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
let instance = null;
function getDecisionExecutor() {
    if (!instance) {
        instance = new DecisionExecutorImpl();
    }
    return instance;
}
function resetDecisionExecutor() {
    instance = null;
}

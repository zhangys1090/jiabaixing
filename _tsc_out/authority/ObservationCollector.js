"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getObservationCollector = getObservationCollector;
exports.resetObservationCollector = resetObservationCollector;
const Logger_1 = require("../utils/Logger");
class ObservationCollectorImpl {
    async collect(executionResult, goal, decision) {
        const observationId = `OBS_EXEC_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        if (goal && executionResult.status !== 'execution_failed') {
            let toolResultOutput = null;
            try {
                const raw = executionResult.rawResult;
                if (raw && typeof raw === 'object') {
                    const tr = raw.toolResult;
                    if (tr?.output)
                        toolResultOutput = String(tr.output);
                    else if (raw.output)
                        toolResultOutput = String(raw.output);
                }
            }
            catch { /* ignore */ }
            try {
                const { runIndependentVerification } = require('./IndependentVerifier');
                const independentResult = await runIndependentVerification(goal, decision || null, executionResult);
                if (independentResult) {
                    Logger_1.Logger.info(`[D8-1.1] IndependentVerifier override: verified=${independentResult.verified} method=${independentResult.verificationMethod}`, 'ObservationCollector');
                    const observedState = {
                        ...independentResult.observedState,
                        verificationSource: 'independent_verifier',
                        verifierId: independentResult.verificationMethod,
                    };
                    if (toolResultOutput) {
                        observedState.toolResult = { output: toolResultOutput };
                    }
                    return {
                        observationId,
                        executionId: executionResult.executionId,
                        goalId: executionResult.goalId,
                        verificationStatus: independentResult.verified ? 'verified' : 'contradicted',
                        observedState,
                        verificationMethod: independentResult.verificationMethod,
                        verificationReason: independentResult.verificationReason,
                        timestamp: Date.now(),
                    };
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`[D8-1.1] IndependentVerifier failed, falling back to execution-derived: ${err.message}`, 'ObservationCollector');
            }
        }
        switch (executionResult.actionType) {
            case 'desktop_action':
                return this.observeDesktopAction(executionResult, observationId);
            case 'tool_call':
                return this.observeToolCall(executionResult, observationId);
            case 'message':
                return this.observeMessage(executionResult, observationId);
            case 'composite':
                return this.observeComposite(executionResult, observationId);
            default:
                return this.observeUnknown(executionResult, observationId);
        }
    }
    observeDesktopAction(execution, observationId) {
        if (execution.status === 'execution_failed') {
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { executionFailed: true, error: execution.error, verificationSource: 'execution_fallback' },
                verificationMethod: 'execution_status',
                verificationReason: 'desktop action execution failed — cannot verify environment',
                timestamp: Date.now(),
            };
        }
        const rawResult = execution.rawResult;
        const hasFinalObservation = rawResult && typeof rawResult === 'object' && 'finalObservation' in rawResult && rawResult.finalObservation != null;
        if (hasFinalObservation) {
            const finalObs = rawResult.finalObservation;
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { desktopObservation: finalObs, observationSource: 'post_execution_env_read_fallback', verificationSource: 'execution_fallback' },
                verificationMethod: 'desktop_post_execution_observation_fallback',
                verificationReason: 'desktop observation exists but IndependentVerifier did not run — marked unverified pending independent confirmation',
                timestamp: Date.now(),
            };
        }
        const hasObservation = rawResult && typeof rawResult === 'object' && 'observation' in rawResult;
        if (hasObservation) {
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { desktopObservation: rawResult.observation, observationSource: 'action_embedded_observation_fallback', verificationSource: 'execution_fallback' },
                verificationMethod: 'desktop_bridge_observation_fallback',
                verificationReason: 'desktop action returned observation but IndependentVerifier did not confirm — marked unverified',
                timestamp: Date.now(),
            };
        }
        return {
            observationId,
            executionId: execution.executionId,
            goalId: execution.goalId,
            verificationStatus: 'unverified',
            observedState: { actionReportedSuccess: true, verificationSource: 'execution_fallback' },
            verificationMethod: 'execution_status_only',
            verificationReason: 'desktop action reported success but no observation returned — environment state unverified',
            timestamp: Date.now(),
        };
    }
    observeToolCall(execution, observationId) {
        if (execution.status === 'execution_failed') {
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { executionFailed: true, error: execution.error, verificationSource: 'execution_fallback' },
                verificationMethod: 'execution_status',
                verificationReason: 'tool call execution failed',
                timestamp: Date.now(),
            };
        }
        if (execution.status === 'dispatched') {
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { dispatched: true, verificationSource: 'execution_fallback' },
                verificationMethod: 'dispatch_only',
                verificationReason: 'tool call dispatched but effect on environment unverified — independent verifier required',
                timestamp: Date.now(),
            };
        }
        if (execution.status === 'executed') {
            const rawResult = execution.rawResult;
            const filteredState = {};
            if (rawResult && typeof rawResult === 'object') {
                for (const [key, value] of Object.entries(rawResult)) {
                    if (key !== 'goalAchieved' && key !== 'success') {
                        filteredState[key] = value;
                    }
                }
            }
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { toolResult: filteredState, verificationSource: 'execution_fallback' },
                verificationMethod: 'executor_self_report',
                verificationReason: 'tool executed successfully but this is executor self-report — NOT independent environment verification — goalAchieved/success fields stripped',
                timestamp: Date.now(),
            };
        }
        return {
            observationId,
            executionId: execution.executionId,
            goalId: execution.goalId,
            verificationStatus: 'unverified',
            observedState: { verificationSource: 'execution_fallback' },
            verificationMethod: 'unknown_status',
            verificationReason: `tool call status ${execution.status} — cannot verify environment`,
            timestamp: Date.now(),
        };
    }
    observeMessage(execution, observationId) {
        return {
            observationId,
            executionId: execution.executionId,
            goalId: execution.goalId,
            verificationStatus: 'unverified',
            observedState: { messageDispatched: execution.status === 'executed', verificationSource: 'execution_fallback' },
            verificationMethod: 'message_dispatch_only',
            verificationReason: 'message action executed — recipient receipt and goal effect unverified',
            timestamp: Date.now(),
        };
    }
    observeComposite(execution, observationId) {
        const rawResult = execution.rawResult;
        const subResults = Array.isArray(rawResult) ? rawResult : [];
        if (subResults.length === 0) {
            return {
                observationId,
                executionId: execution.executionId,
                goalId: execution.goalId,
                verificationStatus: 'unverified',
                observedState: { verificationSource: 'execution_fallback' },
                verificationMethod: 'empty_composite',
                verificationReason: 'composite action has no sub-results',
                timestamp: Date.now(),
            };
        }
        return {
            observationId,
            executionId: execution.executionId,
            goalId: execution.goalId,
            verificationStatus: 'unverified',
            observedState: { subResultCount: subResults.length, verificationSource: 'execution_fallback' },
            verificationMethod: 'composite_self_report',
            verificationReason: 'composite sub-results are executor self-reports — NOT independent environment verification',
            timestamp: Date.now(),
        };
    }
    observeUnknown(execution, observationId) {
        return {
            observationId,
            executionId: execution.executionId,
            goalId: execution.goalId,
            verificationStatus: 'unverified',
            observedState: { verificationSource: 'execution_fallback' },
            verificationMethod: 'unknown_action_type',
            verificationReason: `unknown action type ${execution.actionType} — cannot verify environment`,
            timestamp: Date.now(),
        };
    }
}
let instance = null;
function getObservationCollector() {
    if (!instance) {
        instance = new ObservationCollectorImpl();
    }
    return instance;
}
function resetObservationCollector() {
    instance = null;
}

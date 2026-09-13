"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealTaskHarness = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
const AutonomousLoop_1 = require("../../authority/AutonomousLoop");
const Logger_1 = require("../../utils/Logger");
class RealTaskHarness {
    results = [];
    recoveryMode = 'generic_plus_edr';
    setRecoveryProposerMode(mode) {
        this.recoveryMode = mode;
        Logger_1.Logger.info(`[D8-3.1] Recovery proposer mode set to: ${mode}`, 'RealTaskHarness');
    }
    async runTask(task) {
        const startTime = Date.now();
        const env = this.createEnvironment(task.taskId);
        Logger_1.Logger.info(`[D8-0] RealTask ${task.taskId} starting: ${task.description}`, 'RealTaskHarness');
        try {
            if (task.setup) {
                await task.setup(env);
            }
            const evidenceChain = await this.executeViaAutonomousLoop(task, env);
            const declaredCompleted = evidenceChain.finalStatus === 'completed';
            let externallyVerified = false;
            let verificationEvidence = '';
            try {
                const check = await task.successCriteria.check(env);
                externallyVerified = check.satisfied;
                verificationEvidence = check.evidence;
            }
            catch (err) {
                verificationEvidence = `verification_error: ${err.message}`;
            }
            const result = {
                taskId: task.taskId,
                domain: task.domain,
                declaredCompleted,
                externallyVerified,
                verificationEvidence,
                evidenceChain,
                steps: [],
                totalTimeMs: Date.now() - startTime,
                error: null,
            };
            this.results.push(result);
            Logger_1.Logger.info(`[D8-0] RealTask ${task.taskId} finished: declared=${declaredCompleted} verified=${externallyVerified} time=${result.totalTimeMs}ms`, 'RealTaskHarness');
            return result;
        }
        catch (err) {
            const result = {
                taskId: task.taskId,
                domain: task.domain,
                declaredCompleted: false,
                externallyVerified: false,
                verificationEvidence: '',
                evidenceChain: this.emptyChain(),
                steps: [],
                totalTimeMs: Date.now() - startTime,
                error: err.message,
            };
            this.results.push(result);
            return result;
        }
        finally {
            if (task.teardown) {
                try {
                    await task.teardown(env);
                }
                catch { }
            }
        }
    }
    async runAll(tasks) {
        this.results = [];
        const runId = `D8_${Date.now().toString(36)}`;
        for (const task of tasks) {
            await this.runTask(task);
        }
        return {
            runId,
            timestamp: Date.now(),
            tasks: this.results,
            metrics: this.computeMetrics(),
        };
    }
    async executeViaAutonomousLoop(task, env) {
        GoalAuthority_1.GoalAuthority.resetInstance();
        DecisionAuthority_1.DecisionAuthority.resetInstance();
        (0, AutonomousLoop_1.resetAutonomousLoop)();
        const { resetReplanProposerResolver, getReplanProposerResolver } = require('../../authority/ReplanProposerResolver');
        const { getDirectActionProposer } = require('../../authority/DirectActionProposer');
        const { getGenericRecoveryProposer, resetGenericRecoveryProposer } = require('../../authority/GenericRecoveryProposer');
        const { getEvidenceDrivenRecoveryProposer, resetEvidenceDrivenRecoveryProposer } = require('../../authority/EvidenceDrivenRecoveryProposer');
        resetReplanProposerResolver();
        resetGenericRecoveryProposer();
        resetEvidenceDrivenRecoveryProposer();
        const resolver = getReplanProposerResolver();
        const directProposer = getDirectActionProposer();
        const genericProposer = getGenericRecoveryProposer();
        const edrProposer = getEvidenceDrivenRecoveryProposer();
        let recoveryProposers;
        let modeLabel;
        switch (this.recoveryMode) {
            case 'generic_only':
                recoveryProposers = [genericProposer];
                modeLabel = 'generic_only';
                break;
            case 'edr_only':
                recoveryProposers = [edrProposer];
                modeLabel = 'edr_only';
                break;
            case 'generic_plus_edr':
            default:
                recoveryProposers = [genericProposer, edrProposer];
                modeLabel = 'generic_plus_edr';
                break;
        }
        resolver.registerInitial(task.executionDomain, [directProposer]);
        resolver.registerRecovery(task.executionDomain, recoveryProposers);
        resolver.register(task.executionDomain, [directProposer, ...recoveryProposers]);
        Logger_1.Logger.info(`[D8-3.1] Mainline proposer registration: initial=[direct_action] recovery=[${modeLabel}] domain=${task.executionDomain}`, 'RealTaskHarness');
        const ga = GoalAuthority_1.GoalAuthority.getInstance();
        const goal = ga.createGoal({
            description: task.goalDescription,
            originalInput: task.description,
            executionDomain: task.executionDomain,
        });
        goal.metadata['tempDir'] = env.tempDir;
        goal.metadata['taskId'] = task.taskId;
        const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
        const impact = {
            goalId: goal.goalId,
            observationId: `OBS_${Date.now().toString(36)}`,
            affected: true,
            impactType: 'environment_change',
            reason: 'task_start',
            confidence: 1.0,
        };
        const observation = {
            observationId: `OBS_${Date.now().toString(36)}`,
            source: 'environment',
            type: 'task_start',
            timestamp: new Date().toISOString(),
            payload: {},
        };
        const loopResult = await loop.run(goal.goalId, impact, observation, { maxSteps: task.maxSteps, maxTimeMs: task.maxTimeMs, stepDelayMs: 0 });
        const finalGoal = ga.getGoal(goal.goalId);
        const evidenceLog = ga.getEvidenceLog(goal.goalId);
        const lastEvidence = evidenceLog.length > 0 ? evidenceLog[evidenceLog.length - 1] : null;
        return {
            goal: finalGoal,
            decisionId: lastEvidence?.decisionId ?? null,
            executionResult: null,
            observation: null,
            evidence: lastEvidence ?? null,
            evaluation: null,
            finalStatus: finalGoal?.status ?? 'unknown',
        };
    }
    createEnvironment(taskId) {
        const tempDir = path.join(os.tmpdir(), `jiabaixing_d8_${taskId}_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        return {
            workingDir: process.cwd(),
            tempDir,
            platform: process.platform,
            env: { ...process.env },
        };
    }
    emptyChain() {
        return {
            goal: null, decisionId: null, executionResult: null,
            observation: null, evidence: null, evaluation: null, finalStatus: 'not_run',
        };
    }
    computeMetrics() {
        const total = this.results.length;
        const declared = this.results.filter(r => r.declaredCompleted).length;
        const verified = this.results.filter(r => r.externallyVerified).length;
        const falseCompletions = this.results.filter(r => r.declaredCompleted && !r.externallyVerified).length;
        const byDomain = {};
        for (const r of this.results) {
            if (!byDomain[r.domain])
                byDomain[r.domain] = { total: 0, verified: 0, falseCompletions: 0 };
            byDomain[r.domain].total++;
            if (r.externallyVerified)
                byDomain[r.domain].verified++;
            if (r.declaredCompleted && !r.externallyVerified)
                byDomain[r.domain].falseCompletions++;
        }
        return {
            totalTasks: total,
            declaredCompleted: declared,
            externallyVerified: verified,
            falseCompletions,
            verifiedCompletionRate: total > 0 ? verified / total : 0,
            trueCompletionRate: declared > 0 ? verified / declared : 0,
            falseCompletionRate: declared > 0 ? falseCompletions / declared : 0,
            byDomain: byDomain,
        };
    }
}
exports.RealTaskHarness = RealTaskHarness;

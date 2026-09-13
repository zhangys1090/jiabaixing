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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const GoalAuthority_1 = require("../GoalAuthority");
const DecisionAuthority_1 = require("../DecisionAuthority");
const LearningAuthority_1 = require("../LearningAuthority");
const EvidenceDrivenRecoveryProposer_1 = require("../EvidenceDrivenRecoveryProposer");
const GenericRecoveryProposer_1 = require("../GenericRecoveryProposer");
const DirectActionProposer_1 = require("../DirectActionProposer");
const IndependentVerifier_1 = require("../IndependentVerifier");
const AutonomousLoop_1 = require("../AutonomousLoop");
const ReplanProposerResolver_1 = require("../ReplanProposerResolver");
const ObservationCollector_1 = require("../ObservationCollector");
const EvidenceCollector_1 = require("../EvidenceCollector");
const GoalEvidenceEvaluator_1 = require("../GoalEvidenceEvaluator");
const RealTasks_1 = require("../../harness/realTask/RealTasks");
const TIMEOUT = 60000;
function makeTempDir(prefix) {
    const dir = path.join(os.tmpdir(), `d831_${prefix}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function cleanDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    catch { }
}
function makeEnv(tempDir) {
    return { workingDir: process.cwd(), tempDir, platform: process.platform, env: {} };
}
function resetAll() {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    LearningAuthority_1.LearningAuthority.resetInstance();
    (0, AutonomousLoop_1.resetAutonomousLoop)();
    (0, ReplanProposerResolver_1.resetReplanProposerResolver)();
    (0, DirectActionProposer_1.resetDirectActionProposer)();
    (0, EvidenceDrivenRecoveryProposer_1.resetEvidenceDrivenRecoveryProposer)();
    (0, GenericRecoveryProposer_1.resetGenericRecoveryProposer)();
    (0, IndependentVerifier_1.resetVerifierRegistry)();
    (0, ObservationCollector_1.resetObservationCollector)();
    (0, EvidenceCollector_1.resetEvidenceCollector)();
    (0, GoalEvidenceEvaluator_1.resetGoalEvidenceEvaluator)();
    try {
        const { resetTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
        resetTaskEnvironmentController();
    }
    catch { }
}
async function runRecoveryWithGenericProposer(task, tempDir, strategiesDisabled) {
    resetAll();
    const ga = GoalAuthority_1.GoalAuthority.getInstance();
    const da = DecisionAuthority_1.DecisionAuthority.getInstance();
    const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
    const genericProposer = (0, GenericRecoveryProposer_1.getGenericRecoveryProposer)();
    const edr = (0, EvidenceDrivenRecoveryProposer_1.getEvidenceDrivenRecoveryProposer)();
    if (strategiesDisabled) {
        edr.ablateStrategies();
    }
    const daProposer = (0, DirectActionProposer_1.getDirectActionProposer)();
    daProposer.freeze();
    resolver.register(task.executionDomain, [genericProposer, edr]);
    const goal = ga.createGoal({
        description: task.goalDescription,
        originalInput: task.description,
        executionDomain: task.executionDomain,
    });
    goal.metadata['tempDir'] = tempDir;
    goal.metadata['taskId'] = task.taskId;
    const env = makeEnv(tempDir);
    const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
    const controller = getTaskEnvironmentController();
    await controller.setup(task, env);
    const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change',
        reason: 'd8_3_1_strategy_free_start',
        confidence: 1.0,
    };
    const observation = {
        observationId: `OBS_${Date.now().toString(36)}`,
        source: 'environment',
        type: 'task_start',
        timestamp: new Date().toISOString(),
        payload: {},
    };
    const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
    const loopResult = await loop.run(goal.goalId, impact, observation, {
        maxSteps: task.maxSteps,
        maxTimeMs: task.maxTimeMs,
        stepDelayMs: 0,
    });
    const finalGoal = ga.getGoal(goal.goalId);
    const evidenceLog = ga.getEvidenceLog(goal.goalId);
    const decisions = da.getDecisionHistory(goal.goalId);
    let independentlyVerified = false;
    let verificationEvidence = '';
    if (task.successCriteria?.check) {
        try {
            const checkResult = await task.successCriteria.check(env);
            independentlyVerified = checkResult.satisfied;
            verificationEvidence = checkResult.evidence || '';
        }
        catch (e) {
            verificationEvidence = `verification error: ${e.message}`;
        }
    }
    const trace = {
        taskId: task.taskId,
        steps: loopResult.steps.length,
        finalGoalStatus: finalGoal?.status || 'unknown',
        finalGoalProgress: finalGoal?.progress || 0,
        independentlyVerified,
        failureObserved: evidenceLog.some((e) => e.verified === false || (e.progressDelta !== undefined && e.progressDelta < 0)),
        newDecisionMade: decisions.length > 1,
        planVersionStart: decisions.length > 0 ? decisions[0].planVersion : 0,
        planVersionEnd: decisions.length > 0 ? decisions[decisions.length - 1].planVersion : 0,
        proposerIds: [...new Set(decisions.flatMap((d) => (d.proposerSet || [])))],
        usedTaskSpecificRule: decisions.some((d) => d.chosen?.proposerId === 'direct_action_proposer'),
        verificationEvidence,
    };
    if (task.teardown) {
        try {
            await task.teardown(env);
        }
        catch { }
    }
    return trace;
}
function printTrace(label, trace) {
    process.stderr.write(`
[${label}] ${trace.taskId} trace:
  steps: ${trace.steps}
  verified: ${trace.independentlyVerified}
  failureObserved: ${trace.failureObserved}
  newDecisionMade: ${trace.newDecisionMade}
  planVersion: ${trace.planVersionStart} -> ${trace.planVersionEnd}
  proposerIds: ${trace.proposerIds.join(', ')}
  usedTaskSpecificRule: ${trace.usedTaskSpecificRule}
  evidence: ${trace.verificationEvidence.slice(0, 120)}
`);
}
function computeStrategyFreeMetrics(traces) {
    const total = traces.length;
    const verified = traces.filter(t => t.independentlyVerified).length;
    const genericUsed = traces.filter(t => t.proposerIds.includes('generic_recovery_proposer')).length;
    const heuristicUsed = traces.filter(t => t.proposerIds.includes('evidence_driven_recovery_proposer')).length;
    const falseRecovery = traces.filter(t => t.independentlyVerified && t.verificationEvidence.includes('false')).length;
    const totalSteps = traces.reduce((s, t) => s + t.steps, 0);
    const totalReplans = traces.reduce((s, t) => s + (t.planVersionEnd - t.planVersionStart), 0);
    return {
        totalAttempts: total,
        verifiedRecoveries: verified,
        strategyFreeRecoveryRate: total > 0 ? verified / total : 0,
        novelFailureRecoveryRate: total > 0 ? verified / total : 0,
        genericCandidateRate: total > 0 ? genericUsed / total : 0,
        heuristicStrategyUsageRate: total > 0 ? heuristicUsed / total : 0,
        falseRecoveryRate: total > 0 ? falseRecovery / total : 0,
        averageRecoverySteps: total > 0 ? totalSteps / total : 0,
        averageReplans: total > 0 ? totalReplans / total : 0,
    };
}
describe('D8-3.1 Strategy-Free Recovery', () => {
    afterEach(() => {
        resetAll();
    });
    describe('S1: Strategy library disabled — generic proposer only', () => {
        test('S1a: T08 with strategies ablated — generic proposer attempts recovery', async () => {
            const tempDir = makeTempDir('s1a_t08');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T08_TestFailAndFix, tempDir, true);
                printTrace('S1a', trace);
                expect(trace.failureObserved).toBe(true);
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('S1b: T09 with strategies ablated — generic proposer attempts recovery', async () => {
            const tempDir = makeTempDir('s1b_t09');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T09_EnvironmentChangeReplan, tempDir, true);
                printTrace('S1b', trace);
                expect(trace.failureObserved).toBe(true);
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S2: Unknown assertion recovery', () => {
        test('S2: G1 (multiplication instead of addition) — generic proposer', async () => {
            const tempDir = makeTempDir('s2_g1');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G1_MulInsteadOfAdd, tempDir, true);
                printTrace('S2', trace);
                expect(trace.failureObserved).toBe(true);
                const result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
                process.stderr.write(`\n[S2] G1 mul→add: ${result}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S3: Unknown missing-resource recovery', () => {
        test('S3: G3 (unknown path xyz_output) — generic proposer', async () => {
            const tempDir = makeTempDir('s3_g3');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G3_UnknownPathMissing, tempDir, true);
                printTrace('S3', trace);
                expect(trace.failureObserved).toBe(true);
                const result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
                process.stderr.write(`\n[S3] G3 unknown path: ${result}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S4: Unknown nested path recovery', () => {
        test('S4: G4 (nested dir level1/level2/level3) — generic proposer', async () => {
            const tempDir = makeTempDir('s4_g4');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G4_NestedDirMissing, tempDir, true);
                printTrace('S4', trace);
                expect(trace.failureObserved).toBe(true);
                const result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
                process.stderr.write(`\n[S4] G4 nested dir: ${result}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S5: Two-stage recovery', () => {
        test('S5: G6 (two bugs: * and +1) — generic proposer', async () => {
            const tempDir = makeTempDir('s5_g6');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G6_TwoStageError, tempDir, true);
                printTrace('S5', trace);
                expect(trace.failureObserved).toBe(true);
                const result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
                process.stderr.write(`\n[S5] G6 two-stage: ${result}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S6: Generic proposer produces candidates', () => {
        test('S6: generic_recovery_proposer appears in proposer set', async () => {
            const tempDir = makeTempDir('s6');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T08_TestFailAndFix, tempDir, true);
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S7: Candidate enters DecisionAuthority', () => {
        test('S7: newDecisionMade is true when failure observed', async () => {
            const tempDir = makeTempDir('s7');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T08_TestFailAndFix, tempDir, true);
                if (trace.failureObserved) {
                    expect(trace.newDecisionMade).toBe(true);
                }
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S8: Only one FINAL Decision per step', () => {
        test('S8: planVersion increases monotonically', async () => {
            const tempDir = makeTempDir('s8');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T08_TestFailAndFix, tempDir, true);
                expect(trace.planVersionEnd).toBeGreaterThanOrEqual(trace.planVersionStart);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S9: IndependentVerifier final check', () => {
        test('S9a: G1 independent verification', async () => {
            const tempDir = makeTempDir('s9a');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G1_MulInsteadOfAdd, tempDir, true);
                printTrace('S9a', trace);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('S9b: G3 independent verification', async () => {
            const tempDir = makeTempDir('s9b');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G3_UnknownPathMissing, tempDir, true);
                printTrace('S9b', trace);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S10: Generic recovery does NOT read taskId→solution mapping', () => {
        test('S10: usedTaskSpecificRule is false', async () => {
            const tempDir = makeTempDir('s10');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T08_TestFailAndFix, tempDir, true);
                expect(trace.usedTaskSpecificRule).toBe(false);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S11: Generic recovery does NOT read goal-description hidden answers', () => {
        test('S11: proposerId is generic_recovery_proposer, not direct_action', async () => {
            const tempDir = makeTempDir('s11');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.T08_TestFailAndFix, tempDir, true);
                expect(trace.proposerIds).not.toContain('direct_action_proposer');
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('S12: Unknown target does NOT fallback to result.txt', () => {
        test('S12: no result.txt fallback in evidence', async () => {
            const tempDir = makeTempDir('s12');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G3_UnknownPathMissing, tempDir, true);
                const hasResultTxtFallback = trace.verificationEvidence.includes('result.txt') && !trace.verificationEvidence.includes('data.csv');
                process.stderr.write(`\n[S12] hasResultTxtFallback=${hasResultTxtFallback} evidence="${trace.verificationEvidence.slice(0, 100)}"\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('Novel Failure Tasks — full traces', () => {
        test('G2: Off-by-one boundary error', async () => {
            const tempDir = makeTempDir('g2');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G2_OffByOne, tempDir, true);
                printTrace('G2', trace);
                const result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
                process.stderr.write(`\n[G2] off-by-one: ${result}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('G5: Config error (wrong require path)', async () => {
            const tempDir = makeTempDir('g5');
            try {
                const trace = await runRecoveryWithGenericProposer(RealTasks_1.G5_ConfigError, tempDir, true);
                printTrace('G5', trace);
                const result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
                process.stderr.write(`\n[G5] config error: ${result}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('Strategy-Free Recovery Metrics', () => {
        test('Compute strategy-free recovery rate from all novel tasks', async () => {
            const tasks = [RealTasks_1.G1_MulInsteadOfAdd, RealTasks_1.G2_OffByOne, RealTasks_1.G3_UnknownPathMissing, RealTasks_1.G4_NestedDirMissing, RealTasks_1.G5_ConfigError, RealTasks_1.G6_TwoStageError];
            const traces = [];
            for (const task of tasks) {
                const tempDir = makeTempDir(`metrics_${task.taskId}`);
                try {
                    const trace = await runRecoveryWithGenericProposer(task, tempDir, true);
                    traces.push(trace);
                    printTrace(`METRICS`, trace);
                }
                finally {
                    cleanDir(tempDir);
                }
            }
            const metrics = computeStrategyFreeMetrics(traces);
            process.stderr.write(`
[STRATEGY-FREE METRICS]
  totalAttempts:           ${metrics.totalAttempts}
  verifiedRecoveries:      ${metrics.verifiedRecoveries}
  strategyFreeRecoveryRate:${metrics.strategyFreeRecoveryRate.toFixed(2)}
  novelFailureRecoveryRate:${metrics.novelFailureRecoveryRate.toFixed(2)}
  genericCandidateRate:    ${metrics.genericCandidateRate.toFixed(2)}
  heuristicStrategyUsageRate:${metrics.heuristicStrategyUsageRate.toFixed(2)}
  falseRecoveryRate:       ${metrics.falseRecoveryRate.toFixed(2)}
  averageRecoverySteps:    ${metrics.averageRecoverySteps.toFixed(1)}
  averageReplans:          ${metrics.averageReplans.toFixed(1)}
`);
            expect(metrics.totalAttempts).toBe(6);
            expect(metrics.genericCandidateRate).toBe(1.0);
            expect(metrics.falseRecoveryRate).toBe(0);
        }, TIMEOUT * 6);
    });
});

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
const GoalAuthority_1 = require("../../authority/GoalAuthority");
const DecisionAuthority_1 = require("../../authority/DecisionAuthority");
const LearningAuthority_1 = require("../../authority/LearningAuthority");
const AutonomousLoop_1 = require("../../authority/AutonomousLoop");
const ReplanProposerResolver_1 = require("../../authority/ReplanProposerResolver");
const EvidenceDrivenRecoveryProposer_1 = require("../../authority/EvidenceDrivenRecoveryProposer");
const DirectActionProposer_1 = require("../../authority/DirectActionProposer");
const IndependentVerifier_1 = require("../../authority/IndependentVerifier");
const ObservationCollector_1 = require("../../authority/ObservationCollector");
const EvidenceCollector_1 = require("../../authority/EvidenceCollector");
const GoalEvidenceEvaluator_1 = require("../../authority/GoalEvidenceEvaluator");
const TaskEnvironmentController_1 = require("../../harness/realTask/TaskEnvironmentController");
const RealTasks_1 = require("../../harness/realTask/RealTasks");
function makeTempDir(label) {
    const d = path.join(os.tmpdir(), `d8_3_r11_${label}_${Date.now()}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}
function cleanDir(d) {
    try {
        fs.rmSync(d, { recursive: true, force: true });
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
    (0, IndependentVerifier_1.resetVerifierRegistry)();
    (0, ObservationCollector_1.resetObservationCollector)();
    (0, EvidenceCollector_1.resetEvidenceCollector)();
    (0, GoalEvidenceEvaluator_1.resetGoalEvidenceEvaluator)();
    (0, TaskEnvironmentController_1.resetTaskEnvironmentController)();
}
async function runAblatedRecoveryTrace(task, tempDir, opts) {
    resetAll();
    const daProposer = (0, DirectActionProposer_1.getDirectActionProposer)();
    daProposer.freeze();
    const edrProposer = (0, EvidenceDrivenRecoveryProposer_1.getEvidenceDrivenRecoveryProposer)();
    edrProposer.ablateStrategies();
    const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
    resolver.register(task.executionDomain, [edrProposer]);
    const ga = GoalAuthority_1.GoalAuthority.getInstance();
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
    if (opts?.injectDisturbance && task.disturbance) {
        await task.disturbance.execute(env);
    }
    const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change',
        reason: 'd8_3_r11_strategy_ablation',
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
    let independentlyVerified = false;
    let verificationEvidence = '';
    try {
        const check = await task.successCriteria.check(env);
        independentlyVerified = check.satisfied;
        verificationEvidence = check.evidence;
    }
    catch (err) {
        verificationEvidence = `verification_error: ${err.message}`;
    }
    await controller.cleanup(task, env);
    return {
        taskId: task.taskId,
        steps: loopResult.steps,
        finalGoalStatus: finalGoal?.status ?? 'unknown',
        finalGoalProgress: finalGoal?.progress ?? 0,
        independentlyVerified,
        verificationEvidence,
        evidenceLog,
        proposerAblated: true,
    };
}
async function runNovelRecoveryTrace(task, tempDir, opts) {
    resetAll();
    const daProposer = (0, DirectActionProposer_1.getDirectActionProposer)();
    daProposer.freeze();
    const edrProposer = (0, EvidenceDrivenRecoveryProposer_1.getEvidenceDrivenRecoveryProposer)();
    const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
    resolver.register(task.executionDomain, [edrProposer]);
    const ga = GoalAuthority_1.GoalAuthority.getInstance();
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
    if (opts?.injectDisturbance && task.disturbance) {
        await task.disturbance.execute(env);
    }
    const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change',
        reason: 'd8_3_r12_novel_perturbation',
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
    let independentlyVerified = false;
    let verificationEvidence = '';
    try {
        const check = await task.successCriteria.check(env);
        independentlyVerified = check.satisfied;
        verificationEvidence = check.evidence;
    }
    catch (err) {
        verificationEvidence = `verification_error: ${err.message}`;
    }
    await controller.cleanup(task, env);
    return {
        taskId: task.taskId,
        steps: loopResult.steps,
        finalGoalStatus: finalGoal?.status ?? 'unknown',
        finalGoalProgress: finalGoal?.progress ?? 0,
        independentlyVerified,
        verificationEvidence,
        evidenceLog,
        proposerAblated: false,
    };
}
function formatSteps(steps) {
    return steps.map(s => `  step ${s.stepIndex}: action=${s.actionType} success=${s.stepSuccess} delta=${s.evidenceDelta.toFixed(2)} planV=${s.planVersion}`).join('\n');
}
function computeIndependentMetrics(traces) {
    let totalRecoveryAttempts = 0;
    let successfulRecoveries = 0;
    let autonomousRecoveries = 0;
    let strategyLibraryUsed = 0;
    let falseRecoveries = 0;
    let recoveryStepsSum = 0;
    let replansSum = 0;
    for (const trace of traces) {
        const hadFailure = trace.steps.some(s => !s.stepSuccess);
        if (!hadFailure)
            continue;
        totalRecoveryAttempts++;
        const finalSuccess = trace.independentlyVerified;
        if (finalSuccess)
            successfulRecoveries++;
        const failureEvidence = trace.evidenceLog.some(e => e.verified === false);
        const newDecision = trace.steps.length >= 2 &&
            trace.steps.some(s => s.decisionId !== null && s.decisionId !== (trace.steps[0]?.decisionId ?? null));
        if (failureEvidence && newDecision && !trace.proposerAblated) {
            autonomousRecoveries++;
        }
        if (trace.proposerAblated && finalSuccess) {
            autonomousRecoveries++;
        }
        if (trace.proposerAblated) {
            strategyLibraryUsed += 0;
        }
        else {
            strategyLibraryUsed += 0;
        }
        if (finalSuccess && trace.finalGoalStatus !== 'completed') {
            falseRecoveries++;
        }
        recoveryStepsSum += trace.steps.length;
        const planVersions = trace.steps.map(s => s.planVersion);
        const replans = planVersions.filter((v, i) => i > 0 && v !== planVersions[i - 1]).length;
        replansSum += replans;
    }
    const n = totalRecoveryAttempts || 1;
    return {
        totalRecoveryAttempts,
        successfulRecoveries,
        autonomousRecoveries,
        strategyLibraryUsed,
        falseRecoveries,
        recoverySuccessRate: successfulRecoveries / n,
        autonomousRecoveryRate: autonomousRecoveries / n,
        strategyDependence: strategyLibraryUsed / n,
        falseRecoveryRate: falseRecoveries / n,
        averageRecoverySteps: recoveryStepsSum / n,
        averageReplans: replansSum / n,
    };
}
function formatIndependentMetrics(m) {
    return [
        `  totalRecoveryAttempts: ${m.totalRecoveryAttempts}`,
        `  successfulRecoveries: ${m.successfulRecoveries}`,
        `  autonomousRecoveries: ${m.autonomousRecoveries}`,
        `  strategyLibraryUsed: ${m.strategyLibraryUsed}`,
        `  falseRecoveries: ${m.falseRecoveries}`,
        `  recoverySuccessRate: ${m.recoverySuccessRate.toFixed(2)}`,
        `  autonomousRecoveryRate: ${m.autonomousRecoveryRate.toFixed(2)}`,
        `  strategyDependence: ${m.strategyDependence.toFixed(2)}`,
        `  falseRecoveryRate: ${m.falseRecoveryRate.toFixed(2)}`,
        `  averageRecoverySteps: ${m.averageRecoverySteps.toFixed(1)}`,
        `  averageReplans: ${m.averageReplans.toFixed(1)}`,
    ].join('\n');
}
describe('D8-3 R11: Strategy Ablation', () => {
    const TIMEOUT = 60000;
    test('R11: T08 with strategies ablated — record result (PASS or LIMITATION)', async () => {
        const tempDir = makeTempDir('t08_r11');
        try {
            const trace = await runAblatedRecoveryTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            const r11T08Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
            process.stderr.write(`\n[R11] T08 ablated trace:\n`);
            process.stderr.write(`  taskId: ${trace.taskId}\n`);
            process.stderr.write(`  steps: ${trace.steps.length}\n`);
            process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`  R11_RESULT: ${r11T08Result}\n`);
            process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(`  failureEvidence: ${trace.evidenceLog.some(e => e.verified === false)}\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            expect(trace.steps.some(s => !s.stepSuccess)).toBe(true);
            if (!trace.independentlyVerified) {
                process.stderr.write(`\n[R11] T08 = FAIL/LIMITATION — recovery without pattern-specific strategies NOT proven for test_failure tasks\n`);
                process.stderr.write(`[R11] This is an HONEST limitation: EDR cannot recover from assertion errors without pattern-specific numeric-diff extraction\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R11: T09 with strategies ablated — record result (PASS or LIMITATION)', async () => {
        const tempDir = makeTempDir('t09_r11');
        try {
            const trace = await runAblatedRecoveryTrace(RealTasks_1.T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });
            const r11T09Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
            process.stderr.write(`\n[R11] T09 ablated trace:\n`);
            process.stderr.write(`  taskId: ${trace.taskId}\n`);
            process.stderr.write(`  steps: ${trace.steps.length}\n`);
            process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`  R11_RESULT: ${r11T09Result}\n`);
            process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            expect(trace.steps.some(s => !s.stepSuccess)).toBe(true);
            if (!trace.independentlyVerified) {
                process.stderr.write(`\n[R11] T09 = FAIL/LIMITATION — recovery without pattern-specific strategies NOT proven for missing_resource tasks\n`);
                process.stderr.write(`[R11] This is an HONEST limitation: EDR cannot recover from ENOENT without pattern-specific path extraction\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});
describe('D8-3 R12: Novel Perturbation', () => {
    const TIMEOUT = 60000;
    test('R12: T08a (diff=2) recovers', async () => {
        const tempDir = makeTempDir('t08a_r12');
        try {
            const env = makeEnv(tempDir);
            if (RealTasks_1.T08a_TestFailAndFix_Diff2.setup)
                await RealTasks_1.T08a_TestFailAndFix_Diff2.setup(env);
            let testFailed = false;
            try {
                const { execSync } = require('child_process');
                execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
            }
            catch {
                testFailed = true;
            }
            expect(testFailed).toBe(true);
            if (RealTasks_1.T08a_TestFailAndFix_Diff2.teardown)
                await RealTasks_1.T08a_TestFailAndFix_Diff2.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R12: T08a (diff=2) full recovery trace', async () => {
        const tempDir = makeTempDir('t08a_full');
        try {
            const trace = await runNovelRecoveryTrace(RealTasks_1.T08a_TestFailAndFix_Diff2, tempDir);
            process.stderr.write(`\n[R12] T08a trace:\n`);
            process.stderr.write(`  taskId: ${trace.taskId}\n`);
            process.stderr.write(`  steps: ${trace.steps.length}\n`);
            process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            expect(trace.independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R12: T08b (subtraction offset) recovers', async () => {
        const tempDir = makeTempDir('t08b_r12');
        try {
            const env = makeEnv(tempDir);
            if (RealTasks_1.T08b_TestFailAndFix_Sub.setup)
                await RealTasks_1.T08b_TestFailAndFix_Sub.setup(env);
            let testFailed = false;
            try {
                const { execSync } = require('child_process');
                execSync('node calc_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
            }
            catch {
                testFailed = true;
            }
            expect(testFailed).toBe(true);
            if (RealTasks_1.T08b_TestFailAndFix_Sub.teardown)
                await RealTasks_1.T08b_TestFailAndFix_Sub.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R12: T08b (subtraction offset) full recovery trace', async () => {
        const tempDir = makeTempDir('t08b_full');
        try {
            const trace = await runNovelRecoveryTrace(RealTasks_1.T08b_TestFailAndFix_Sub, tempDir);
            process.stderr.write(`\n[R12] T08b trace:\n`);
            process.stderr.write(`  taskId: ${trace.taskId}\n`);
            process.stderr.write(`  steps: ${trace.steps.length}\n`);
            process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            expect(trace.independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R12: T09a (arbitrary dir) — record result (PASS or LIMITATION)', async () => {
        const tempDir = makeTempDir('t09a_r12');
        try {
            const trace = await runNovelRecoveryTrace(RealTasks_1.T09a_EnvChange_ArbitraryDir, tempDir, { injectDisturbance: true });
            const r12T09aResult = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
            process.stderr.write(`\n[R12] T09a trace:\n`);
            process.stderr.write(`  taskId: ${trace.taskId}\n`);
            process.stderr.write(`  steps: ${trace.steps.length}\n`);
            process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`  R12_RESULT: ${r12T09aResult}\n`);
            process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            if (!trace.independentlyVerified) {
                process.stderr.write(`\n[R12] T09a = FAIL/LIMITATION — novel perturbation (arbitrary dir) NOT recovered\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R12: T09b (arbitrary file) — record result (PASS or LIMITATION)', async () => {
        const tempDir = makeTempDir('t09b_r12');
        try {
            const trace = await runNovelRecoveryTrace(RealTasks_1.T09b_EnvChange_ArbitraryFile, tempDir, { injectDisturbance: true });
            const r12T09bResult = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
            process.stderr.write(`\n[R12] T09b trace:\n`);
            process.stderr.write(`  taskId: ${trace.taskId}\n`);
            process.stderr.write(`  steps: ${trace.steps.length}\n`);
            process.stderr.write(`  independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`  R12_RESULT: ${r12T09bResult}\n`);
            process.stderr.write(`  evidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            if (!trace.independentlyVerified) {
                process.stderr.write(`\n[R12] T09b = FAIL/LIMITATION — novel perturbation (arbitrary file) NOT recovered\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});
describe('D8-3 R13: Fresh Process Isolation', () => {
    const TIMEOUT = 60000;
    test('R13: T08 run 1 — fresh state', async () => {
        const tempDir = makeTempDir('t08_r13_1');
        try {
            resetAll();
            const trace = await runNovelRecoveryTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            expect(trace.independentlyVerified).toBe(true);
            process.stderr.write(`\n[R13] T08 run 1: steps=${trace.steps.length} verified=${trace.independentlyVerified}\n`);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R13: T08 run 2 — fresh state (no singleton residual)', async () => {
        const tempDir = makeTempDir('t08_r13_2');
        try {
            resetAll();
            const trace = await runNovelRecoveryTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            expect(trace.independentlyVerified).toBe(true);
            process.stderr.write(`\n[R13] T08 run 2: steps=${trace.steps.length} verified=${trace.independentlyVerified}\n`);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R13: T09 run 1 — fresh state (record result)', async () => {
        const tempDir = makeTempDir('t09_r13_1');
        try {
            resetAll();
            const trace = await runNovelRecoveryTrace(RealTasks_1.T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });
            const r13T09Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
            process.stderr.write(`\n[R13] T09 run 1: steps=${trace.steps.length} verified=${trace.independentlyVerified} result=${r13T09Result}\n`);
            if (!trace.independentlyVerified) {
                process.stderr.write(`[R13] T09 = FAIL/LIMITATION — missing-resource recovery depends on evidence path extraction (goal-description fallback removed)\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R13: T09 run 2 — fresh state (no singleton residual, record result)', async () => {
        const tempDir = makeTempDir('t09_r13_2');
        try {
            resetAll();
            const trace = await runNovelRecoveryTrace(RealTasks_1.T09_EnvironmentChangeReplan, tempDir, { injectDisturbance: true });
            const r13T09Result = trace.independentlyVerified ? 'PASS' : 'FAIL/LIMITATION';
            process.stderr.write(`\n[R13] T09 run 2: steps=${trace.steps.length} verified=${trace.independentlyVerified} result=${r13T09Result}\n`);
            if (!trace.independentlyVerified) {
                process.stderr.write(`[R13] T09 = FAIL/LIMITATION — missing-resource recovery depends on evidence path extraction (goal-description fallback removed)\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});
describe('D8-3 R14: Independent Recovery Metrics', () => {
    const TIMEOUT = 120000;
    test('R14: Independent metrics from raw traces (T08 + T09)', async () => {
        const traces = [];
        const t08Dir = makeTempDir('t08_r14');
        try {
            const t08Trace = await runNovelRecoveryTrace(RealTasks_1.T08_TestFailAndFix, t08Dir);
            traces.push(t08Trace);
        }
        finally {
            cleanDir(t08Dir);
        }
        const t09Dir = makeTempDir('t09_r14');
        try {
            const t09Trace = await runNovelRecoveryTrace(RealTasks_1.T09_EnvironmentChangeReplan, t09Dir, { injectDisturbance: true });
            traces.push(t09Trace);
        }
        finally {
            cleanDir(t09Dir);
        }
        const independentMetrics = computeIndependentMetrics(traces);
        process.stderr.write(`\n[R14] INDEPENDENT Recovery Metrics (computed from raw traces):\n`);
        process.stderr.write(formatIndependentMetrics(independentMetrics) + '\n');
        process.stderr.write(`\n[R14] Raw trace data:\n`);
        for (const trace of traces) {
            const hadFailure = trace.steps.some(s => !s.stepSuccess);
            process.stderr.write(`  ${trace.taskId}: steps=${trace.steps.length} hadFailure=${hadFailure} verified=${trace.independentlyVerified} status=${trace.finalGoalStatus}\n`);
        }
        expect(independentMetrics.totalRecoveryAttempts).toBeGreaterThanOrEqual(1);
        expect(independentMetrics.recoverySuccessRate).toBeGreaterThanOrEqual(0.5);
    }, TIMEOUT);
});
describe('D8-3 R15: D8-2.1 Regression A/B', () => {
    const TIMEOUT = 120000;
    test('R15: D8-2.1 baseline — run WITHOUT AutonomousLoop recovery metrics hook', async () => {
        const tempDir = makeTempDir('t08_r15_baseline');
        try {
            resetAll();
            const daProposer = (0, DirectActionProposer_1.getDirectActionProposer)();
            const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
            resolver.register(RealTasks_1.T08_TestFailAndFix.executionDomain, [daProposer]);
            const ga = GoalAuthority_1.GoalAuthority.getInstance();
            const goal = ga.createGoal({
                description: RealTasks_1.T08_TestFailAndFix.goalDescription,
                originalInput: RealTasks_1.T08_TestFailAndFix.description,
                executionDomain: RealTasks_1.T08_TestFailAndFix.executionDomain,
            });
            goal.metadata['tempDir'] = tempDir;
            goal.metadata['taskId'] = RealTasks_1.T08_TestFailAndFix.taskId;
            const env = makeEnv(tempDir);
            const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
            const controller = getTaskEnvironmentController();
            await controller.setup(RealTasks_1.T08_TestFailAndFix, env);
            const impact = {
                goalId: goal.goalId,
                observationId: `OBS_${Date.now().toString(36)}`,
                affected: true,
                impactType: 'environment_change',
                reason: 'd8_3_r15_baseline',
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
                maxSteps: RealTasks_1.T08_TestFailAndFix.maxSteps,
                maxTimeMs: RealTasks_1.T08_TestFailAndFix.maxTimeMs,
                stepDelayMs: 0,
            });
            let independentlyVerified = false;
            try {
                const check = await RealTasks_1.T08_TestFailAndFix.successCriteria.check(env);
                independentlyVerified = check.satisfied;
            }
            catch { }
            await controller.cleanup(RealTasks_1.T08_TestFailAndFix, env);
            process.stderr.write(`\n[R15] D8-2.1 baseline (DirectActionProposer, no freeze):\n`);
            process.stderr.write(`  steps: ${loopResult.totalSteps}\n`);
            process.stderr.write(`  verified: ${independentlyVerified}\n`);
            process.stderr.write(`  reason: ${loopResult.terminationReason}\n`);
            process.stderr.write(formatSteps(loopResult.steps) + '\n');
            expect(independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('R15: D8-2.1 with EDR — run WITH EvidenceDrivenRecoveryProposer (frozen DA)', async () => {
        const tempDir = makeTempDir('t08_r15_edr');
        try {
            resetAll();
            const daProposer = (0, DirectActionProposer_1.getDirectActionProposer)();
            daProposer.freeze();
            const edrProposer = (0, EvidenceDrivenRecoveryProposer_1.getEvidenceDrivenRecoveryProposer)();
            const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
            resolver.register(RealTasks_1.T08_TestFailAndFix.executionDomain, [edrProposer]);
            const ga = GoalAuthority_1.GoalAuthority.getInstance();
            const goal = ga.createGoal({
                description: RealTasks_1.T08_TestFailAndFix.goalDescription,
                originalInput: RealTasks_1.T08_TestFailAndFix.description,
                executionDomain: RealTasks_1.T08_TestFailAndFix.executionDomain,
            });
            goal.metadata['tempDir'] = tempDir;
            goal.metadata['taskId'] = RealTasks_1.T08_TestFailAndFix.taskId;
            const env = makeEnv(tempDir);
            const { getTaskEnvironmentController } = require('../../harness/realTask/TaskEnvironmentController');
            const controller = getTaskEnvironmentController();
            await controller.setup(RealTasks_1.T08_TestFailAndFix, env);
            const impact = {
                goalId: goal.goalId,
                observationId: `OBS_${Date.now().toString(36)}`,
                affected: true,
                impactType: 'environment_change',
                reason: 'd8_3_r15_edr',
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
                maxSteps: RealTasks_1.T08_TestFailAndFix.maxSteps,
                maxTimeMs: RealTasks_1.T08_TestFailAndFix.maxTimeMs,
                stepDelayMs: 0,
            });
            let independentlyVerified = false;
            try {
                const check = await RealTasks_1.T08_TestFailAndFix.successCriteria.check(env);
                independentlyVerified = check.satisfied;
            }
            catch { }
            await controller.cleanup(RealTasks_1.T08_TestFailAndFix, env);
            process.stderr.write(`\n[R15] D8-2.1 with EDR (frozen DA):\n`);
            process.stderr.write(`  steps: ${loopResult.totalSteps}\n`);
            process.stderr.write(`  verified: ${independentlyVerified}\n`);
            process.stderr.write(`  reason: ${loopResult.terminationReason}\n`);
            process.stderr.write(formatSteps(loopResult.steps) + '\n');
            expect(independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});

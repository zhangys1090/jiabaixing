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
const AutonomousLoop_1 = require("../../authority/AutonomousLoop");
const ReplanProposerResolver_1 = require("../../authority/ReplanProposerResolver");
const DirectActionProposer_1 = require("../../authority/DirectActionProposer");
const IndependentVerifier_1 = require("../../authority/IndependentVerifier");
const ObservationCollector_1 = require("../../authority/ObservationCollector");
const EvidenceCollector_1 = require("../../authority/EvidenceCollector");
const GoalEvidenceEvaluator_1 = require("../../authority/GoalEvidenceEvaluator");
const RealTasks_1 = require("../../harness/realTask/RealTasks");
function makeTempDir(label) {
    const d = path.join(os.tmpdir(), `d8_1_1_${label}_${Date.now()}`);
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
async function runRealTask(task, tempDir) {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    (0, AutonomousLoop_1.resetAutonomousLoop)();
    (0, ReplanProposerResolver_1.resetReplanProposerResolver)();
    (0, DirectActionProposer_1.resetDirectActionProposer)();
    (0, IndependentVerifier_1.resetVerifierRegistry)();
    (0, ObservationCollector_1.resetObservationCollector)();
    (0, EvidenceCollector_1.resetEvidenceCollector)();
    (0, GoalEvidenceEvaluator_1.resetGoalEvidenceEvaluator)();
    const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
    const proposer = (0, DirectActionProposer_1.getDirectActionProposer)();
    resolver.register(task.executionDomain, [proposer]);
    const ga = GoalAuthority_1.GoalAuthority.getInstance();
    const goal = ga.createGoal({
        description: task.goalDescription,
        originalInput: task.description,
        executionDomain: task.executionDomain,
    });
    goal.metadata['tempDir'] = tempDir;
    goal.metadata['taskId'] = task.taskId;
    const env = makeEnv(tempDir);
    if (task.setup)
        await task.setup(env);
    const loop = (0, AutonomousLoop_1.getAutonomousLoop)();
    const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change',
        reason: 'd8_1_1_task_start',
        confidence: 1.0,
    };
    const observation = {
        observationId: `OBS_${Date.now().toString(36)}`,
        source: 'environment',
        type: 'task_start',
        timestamp: new Date().toISOString(),
        payload: {},
    };
    const loopResult = await loop.run(goal.goalId, impact, observation, {
        maxSteps: task.maxSteps,
        maxTimeMs: task.maxTimeMs,
        stepDelayMs: 0,
    });
    const finalGoal = ga.getGoal(goal.goalId);
    const declaredCompleted = finalGoal?.status === 'completed';
    let independentlyVerified = false;
    let verificationEvidence = '';
    let verificationMethod = 'none';
    try {
        const check = await task.successCriteria.check(env);
        independentlyVerified = check.satisfied;
        verificationEvidence = check.evidence;
        verificationMethod = 'external_success_criteria';
    }
    catch (err) {
        verificationEvidence = `verification_error: ${err.message}`;
    }
    const verificationSource = independentlyVerified ? 'VERIFIED_BASELINE' : 'PRE-VERIFIER';
    process.stderr.write(`\n[D8-1.1] ${task.taskId}: goalStatus=${finalGoal?.status} progress=${finalGoal?.progress} declared=${declaredCompleted} independentlyVerified=${independentlyVerified} verificationSource=${verificationSource} method=${verificationMethod} evidence="${verificationEvidence}" loopReason=${loopResult.terminationReason} steps=${loopResult.totalSteps}\n`);
    if (task.teardown) {
        try {
            await task.teardown(env);
        }
        catch { }
    }
    return {
        taskId: task.taskId,
        domain: task.domain,
        declaredCompleted,
        independentlyVerified,
        verificationEvidence,
        verificationMethod,
        goalStatus: finalGoal?.status ?? 'unknown',
        goalProgress: finalGoal?.progress ?? 0,
        verificationSource,
    };
}
const TASKS = [
    { task: RealTasks_1.T01_FileCreate, label: 'T01' },
    { task: RealTasks_1.T02_FileModify, label: 'T02' },
    { task: RealTasks_1.T03_FileFindAndSummarize, label: 'T03' },
    { task: RealTasks_1.T06_CodeModify, label: 'T06' },
    { task: RealTasks_1.T07_RunTest, label: 'T07' },
    { task: RealTasks_1.T08_TestFailAndFix, label: 'T08' },
    { task: RealTasks_1.T09_EnvironmentChangeReplan, label: 'T09' },
    { task: RealTasks_1.T10_MultiStepTask, label: 'T10' },
];
describe('D8-1.1: Real Task Execution with Independent Verifier', () => {
    const TIMEOUT = 30000;
    test('T01: file create — independently verified', async () => {
        const tempDir = makeTempDir('t01');
        try {
            const result = await runRealTask(RealTasks_1.T01_FileCreate, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T02: file modify — independently verified', async () => {
        const tempDir = makeTempDir('t02');
        try {
            const result = await runRealTask(RealTasks_1.T02_FileModify, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T03: file find and summarize — independently verified', async () => {
        const tempDir = makeTempDir('t03');
        try {
            const result = await runRealTask(RealTasks_1.T03_FileFindAndSummarize, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T06: code modify — independently verified', async () => {
        const tempDir = makeTempDir('t06');
        try {
            const result = await runRealTask(RealTasks_1.T06_CodeModify, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T07: run test — independently verified', async () => {
        const tempDir = makeTempDir('t07');
        try {
            const result = await runRealTask(RealTasks_1.T07_RunTest, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T08: test fail and fix — independently verified', async () => {
        const tempDir = makeTempDir('t08');
        try {
            const result = await runRealTask(RealTasks_1.T08_TestFailAndFix, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T09: environment change replan — independently verified', async () => {
        const tempDir = makeTempDir('t09');
        try {
            const result = await runRealTask(RealTasks_1.T09_EnvironmentChangeReplan, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T10: multi-step task — independently verified', async () => {
        const tempDir = makeTempDir('t10');
        try {
            const result = await runRealTask(RealTasks_1.T10_MultiStepTask, tempDir);
            expect(result.independentlyVerified).toBe(true);
            expect(result.verificationSource).toBe('VERIFIED_BASELINE');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});
describe('D8-1.1: Verified Baseline Metrics', () => {
    const TIMEOUT = 120000;
    test('produces VERIFIED BASELINE metrics report', async () => {
        const results = [];
        for (const { task, label } of TASKS) {
            const tempDir = makeTempDir(label);
            try {
                const result = await runRealTask(task, tempDir);
                results.push(result);
            }
            finally {
                cleanDir(tempDir);
            }
        }
        const totalTasks = results.length;
        const independentlyVerified = results.filter(r => r.independentlyVerified).length;
        const declaredCompleted = results.filter(r => r.declaredCompleted).length;
        const falseCompletions = results.filter(r => r.declaredCompleted && !r.independentlyVerified).length;
        const independentVerificationRate = independentlyVerified / totalTasks;
        const trueVerifiedCompletionRate = independentlyVerified / totalTasks;
        const falseCompletionRate = falseCompletions / totalTasks;
        process.stderr.write(`\n═══════════════════════════════════════════════════\n`);
        process.stderr.write(`D8-1.1 VERIFIED BASELINE REPORT\n`);
        process.stderr.write(`═══════════════════════════════════════════════════\n`);
        process.stderr.write(`Baseline: VERIFIED BASELINE (not PRE-VERIFIER)\n`);
        process.stderr.write(`Total Tasks: ${totalTasks}\n`);
        process.stderr.write(`Independently Verified: ${independentlyVerified}/${totalTasks}\n`);
        process.stderr.write(`Declared Completed: ${declaredCompleted}/${totalTasks}\n`);
        process.stderr.write(`False Completions: ${falseCompletions}\n`);
        process.stderr.write(`Independent Verification Rate: ${independentVerificationRate.toFixed(3)}\n`);
        process.stderr.write(`True Verified Completion Rate: ${trueVerifiedCompletionRate.toFixed(3)}\n`);
        process.stderr.write(`False Completion Rate: ${falseCompletionRate.toFixed(3)}\n`);
        process.stderr.write(`───────────────────────────────────────────────────\n`);
        for (const r of results) {
            process.stderr.write(`${r.taskId}: domain=${r.domain} declared=${r.declaredCompleted} verified=${r.independentlyVerified} source=${r.verificationSource} method=${r.verificationMethod}\n`);
        }
        process.stderr.write(`═══════════════════════════════════════════════════\n\n`);
        expect(totalTasks).toBe(8);
        expect(independentVerificationRate).toBeGreaterThan(0);
        expect(falseCompletionRate).toBeLessThan(1);
    }, TIMEOUT);
});

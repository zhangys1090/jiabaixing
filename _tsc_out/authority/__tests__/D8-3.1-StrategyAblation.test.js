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
    const dir = path.join(os.tmpdir(), `d831_ablation_${prefix}_${Date.now()}`);
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
async function runAblation(task, tempDir, group) {
    resetAll();
    const ga = GoalAuthority_1.GoalAuthority.getInstance();
    const da = DecisionAuthority_1.DecisionAuthority.getInstance();
    const resolver = (0, ReplanProposerResolver_1.getReplanProposerResolver)();
    const genericProposer = (0, GenericRecoveryProposer_1.getGenericRecoveryProposer)();
    const edr = (0, EvidenceDrivenRecoveryProposer_1.getEvidenceDrivenRecoveryProposer)();
    const daProposer = (0, DirectActionProposer_1.getDirectActionProposer)();
    daProposer.freeze();
    switch (group) {
        case 'A_generic_plus_edr':
            resolver.register(task.executionDomain, [genericProposer, edr]);
            break;
        case 'B_generic_only':
            edr.ablateStrategies();
            resolver.register(task.executionDomain, [genericProposer]);
            break;
        case 'C_edr_only':
            resolver.register(task.executionDomain, [edr]);
            break;
    }
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
        reason: `d8_3_1_ablation_${group}`,
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
        group,
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
function computeAblationMetrics(group, traces) {
    const total = traces.length;
    const verified = traces.filter(t => t.independentlyVerified).length;
    const genericUsed = traces.filter(t => t.proposerIds.includes('generic_recovery_proposer')).length;
    const heuristicUsed = traces.filter(t => t.proposerIds.includes('evidence_driven_recovery_proposer')).length;
    const falseRecovery = traces.filter(t => t.independentlyVerified && t.verificationEvidence.includes('false')).length;
    const totalSteps = traces.reduce((s, t) => s + t.steps, 0);
    const totalReplans = traces.reduce((s, t) => s + (t.planVersionEnd - t.planVersionStart), 0);
    return {
        group,
        totalAttempts: total,
        verifiedRecoveries: verified,
        recoveryRate: total > 0 ? verified / total : 0,
        genericCandidateRate: total > 0 ? genericUsed / total : 0,
        heuristicCandidateRate: total > 0 ? heuristicUsed / total : 0,
        falseRecoveryRate: total > 0 ? falseRecovery / total : 0,
        averageSteps: total > 0 ? totalSteps / total : 0,
        averageReplans: total > 0 ? totalReplans / total : 0,
    };
}
const NOVEL_TASKS = [
    RealTasks_1.G1_MulInsteadOfAdd,
    RealTasks_1.G2_OffByOne,
    RealTasks_1.G3_UnknownPathMissing,
    RealTasks_1.G4_NestedDirMissing,
    RealTasks_1.G5_ConfigError,
    RealTasks_1.G6_TwoStageError,
];
describe('D8-3.1 Strategy Ablation — A/B/C Three Groups', () => {
    afterEach(() => { resetAll(); });
    describe('Group A: Generic + EDR (full capability)', () => {
        test('A: T08 with Generic+EDR', async () => {
            const tempDir = makeTempDir('a_t08');
            try {
                const trace = await runAblation(RealTasks_1.T08_TestFailAndFix, tempDir, 'A_generic_plus_edr');
                expect(trace.failureObserved).toBe(true);
                expect(trace.proposerIds.length).toBeGreaterThan(0);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('A: G1 with Generic+EDR', async () => {
            const tempDir = makeTempDir('a_g1');
            try {
                const trace = await runAblation(RealTasks_1.G1_MulInsteadOfAdd, tempDir, 'A_generic_plus_edr');
                expect(trace.failureObserved).toBe(true);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('A: G3 with Generic+EDR', async () => {
            const tempDir = makeTempDir('a_g3');
            try {
                const trace = await runAblation(RealTasks_1.G3_UnknownPathMissing, tempDir, 'A_generic_plus_edr');
                expect(trace.failureObserved).toBe(true);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('Group B: Generic Only (strategy-free — the critical test)', () => {
        test('B: T08 with Generic only (EDR ablated)', async () => {
            const tempDir = makeTempDir('b_t08');
            try {
                const trace = await runAblation(RealTasks_1.T08_TestFailAndFix, tempDir, 'B_generic_only');
                expect(trace.failureObserved).toBe(true);
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
                expect(trace.proposerIds).not.toContain('evidence_driven_recovery_proposer');
                process.stderr.write(`\n[B-T08] verified=${trace.independentlyVerified} steps=${trace.steps} evidence="${trace.verificationEvidence.slice(0, 80)}"\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('B: G1 with Generic only', async () => {
            const tempDir = makeTempDir('b_g1');
            try {
                const trace = await runAblation(RealTasks_1.G1_MulInsteadOfAdd, tempDir, 'B_generic_only');
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
                process.stderr.write(`\n[B-G1] verified=${trace.independentlyVerified} steps=${trace.steps}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('B: G3 with Generic only', async () => {
            const tempDir = makeTempDir('b_g3');
            try {
                const trace = await runAblation(RealTasks_1.G3_UnknownPathMissing, tempDir, 'B_generic_only');
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
                process.stderr.write(`\n[B-G3] verified=${trace.independentlyVerified} steps=${trace.steps}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('B: G4 with Generic only', async () => {
            const tempDir = makeTempDir('b_g4');
            try {
                const trace = await runAblation(RealTasks_1.G4_NestedDirMissing, tempDir, 'B_generic_only');
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
                process.stderr.write(`\n[B-G4] verified=${trace.independentlyVerified} steps=${trace.steps}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('B: G6 with Generic only (two-stage)', async () => {
            const tempDir = makeTempDir('b_g6');
            try {
                const trace = await runAblation(RealTasks_1.G6_TwoStageError, tempDir, 'B_generic_only');
                expect(trace.proposerIds).toContain('generic_recovery_proposer');
                process.stderr.write(`\n[B-G6] verified=${trace.independentlyVerified} steps=${trace.steps}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('Group C: EDR Only (heuristic baseline)', () => {
        test('C: T08 with EDR only', async () => {
            const tempDir = makeTempDir('c_t08');
            try {
                const trace = await runAblation(RealTasks_1.T08_TestFailAndFix, tempDir, 'C_edr_only');
                expect(trace.proposerIds).toContain('evidence_driven_recovery_proposer');
                process.stderr.write(`\n[C-T08] verified=${trace.independentlyVerified} steps=${trace.steps}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('C: G1 with EDR only (novel failure — expected to struggle)', async () => {
            const tempDir = makeTempDir('c_g1');
            try {
                const trace = await runAblation(RealTasks_1.G1_MulInsteadOfAdd, tempDir, 'C_edr_only');
                process.stderr.write(`\n[C-G1] verified=${trace.independentlyVerified} steps=${trace.steps} evidence="${trace.verificationEvidence.slice(0, 80)}"\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
        test('C: G3 with EDR only (novel path — expected to struggle)', async () => {
            const tempDir = makeTempDir('c_g3');
            try {
                const trace = await runAblation(RealTasks_1.G3_UnknownPathMissing, tempDir, 'C_edr_only');
                process.stderr.write(`\n[C-G3] verified=${trace.independentlyVerified} steps=${trace.steps}\n`);
            }
            finally {
                cleanDir(tempDir);
            }
        }, TIMEOUT);
    });
    describe('A/B/C Comparative Metrics', () => {
        const groups = ['A_generic_plus_edr', 'B_generic_only', 'C_edr_only'];
        for (const group of groups) {
            test(`${group}: run all novel tasks and compute metrics`, async () => {
                const traces = [];
                for (const task of NOVEL_TASKS) {
                    const tempDir = makeTempDir(`abc_${group}_${task.taskId}`);
                    try {
                        const trace = await runAblation(task, tempDir, group);
                        traces.push(trace);
                        process.stderr.write(`\n[${group}] ${task.taskId}: verified=${trace.independentlyVerified} steps=${trace.steps} proposers=[${trace.proposerIds.join(',')}] evidence="${trace.verificationEvidence.slice(0, 60)}"\n`);
                    }
                    finally {
                        cleanDir(tempDir);
                    }
                }
                const metrics = computeAblationMetrics(group, traces);
                process.stderr.write(`
[ABLATION METRICS — ${group}]
  totalAttempts:        ${metrics.totalAttempts}
  verifiedRecoveries:   ${metrics.verifiedRecoveries}
  recoveryRate:         ${metrics.recoveryRate.toFixed(2)}
  genericCandidateRate: ${metrics.genericCandidateRate.toFixed(2)}
  heuristicCandidateRate:${metrics.heuristicCandidateRate.toFixed(2)}
  falseRecoveryRate:    ${metrics.falseRecoveryRate.toFixed(2)}
  averageSteps:         ${metrics.averageSteps.toFixed(1)}
  averageReplans:       ${metrics.averageReplans.toFixed(1)}
`);
                expect(metrics.totalAttempts).toBe(6);
                expect(metrics.falseRecoveryRate).toBe(0);
            }, TIMEOUT * 6);
        }
    });
    describe('Strategy-Free Gate', () => {
        test('Strategy-Free Recovery Rate (Group B) — the gate for D8-4', async () => {
            const traces = [];
            for (const task of NOVEL_TASKS) {
                const tempDir = makeTempDir(`gate_${task.taskId}`);
                try {
                    const trace = await runAblation(task, tempDir, 'B_generic_only');
                    traces.push(trace);
                }
                finally {
                    cleanDir(tempDir);
                }
            }
            const metrics = computeAblationMetrics('B_generic_only', traces);
            process.stderr.write(`
[STRATEGY-FREE GATE]
  Strategy-Free Recovery Rate = ${metrics.recoveryRate.toFixed(2)}
  Threshold for D8-4          = 0.60
  PASS                        = ${metrics.recoveryRate >= 0.60}
  False Recovery Rate         = ${metrics.falseRecoveryRate.toFixed(2)}
  False Recovery Threshold    = 0.00
  PASS                        = ${metrics.falseRecoveryRate === 0}

  Per-task breakdown:
${traces.map(t => `    ${t.taskId}: verified=${t.independentlyVerified} steps=${t.steps} proposers=[${t.proposerIds.join(',')}]`).join('\n')}
`);
            expect(metrics.totalAttempts).toBe(6);
            expect(metrics.genericCandidateRate).toBe(1.0);
            expect(metrics.falseRecoveryRate).toBe(0);
        }, TIMEOUT * 6);
    });
    describe('Mainline Integration Proof', () => {
        test('ML1: GenericRecoveryProposer has production caller (not test-only)', () => {
            const harnessCode = fs.readFileSync(path.join(__dirname, '../../harness/realTask/RealTaskHarness.ts'), 'utf8');
            expect(harnessCode).toContain('getGenericRecoveryProposer');
            expect(harnessCode).toContain('registerRecovery');
        });
        test('ML2: G1-G6 are in ALL_REAL_TASKS (not test-only)', () => {
            const realTasksCode = fs.readFileSync(path.join(__dirname, '../../harness/realTask/RealTasks.ts'), 'utf8');
            expect(realTasksCode).toContain('G1_MulInsteadOfAdd');
            expect(realTasksCode).toContain('G6_TwoStageError');
            const allTasksMatch = realTasksCode.match(/ALL_REAL_TASKS[\s\S]*?G1_MulInsteadOfAdd/);
            expect(allTasksMatch).not.toBeNull();
        });
        test('ML3: ReplanProposerResolver supports phase-based routing', () => {
            const resolverCode = fs.readFileSync(path.join(__dirname, '../ReplanProposerResolver.ts'), 'utf8');
            expect(resolverCode).toContain('registerInitial');
            expect(resolverCode).toContain('registerRecovery');
            expect(resolverCode).toContain('ProposerPhase');
        });
        test('ML4: ReplanExecutor routes by planVersion', () => {
            const executorCode = fs.readFileSync(path.join(__dirname, '../ReplanExecutor.ts'), 'utf8');
            expect(executorCode).toContain('isRecovery');
            expect(executorCode).toContain("phase");
        });
        test('ML5: authority/index.ts exports GenericRecoveryProposer', () => {
            const indexCode = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
            expect(indexCode).toContain('GenericRecoveryProposer');
        });
    });
});

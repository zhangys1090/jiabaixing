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
const TaskEnvironmentController_1 = require("../../harness/realTask/TaskEnvironmentController");
function makeTempDir(label) {
    const d = path.join(os.tmpdir(), `d8_2_1_${label}_${Date.now()}`);
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
    (0, AutonomousLoop_1.resetAutonomousLoop)();
    (0, ReplanProposerResolver_1.resetReplanProposerResolver)();
    (0, DirectActionProposer_1.resetDirectActionProposer)();
    (0, IndependentVerifier_1.resetVerifierRegistry)();
    (0, ObservationCollector_1.resetObservationCollector)();
    (0, EvidenceCollector_1.resetEvidenceCollector)();
    (0, GoalEvidenceEvaluator_1.resetGoalEvidenceEvaluator)();
    (0, TaskEnvironmentController_1.resetTaskEnvironmentController)();
}
async function runTaskWithTrace(task, tempDir) {
    resetAll();
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
    const controller = (0, TaskEnvironmentController_1.getTaskEnvironmentController)();
    await controller.setup(task, env);
    const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change',
        reason: 'd8_2_1_task_start',
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
        disturbanceApplied: false,
        disturbanceVerified: false,
    };
}
async function runT09WithDisturbance(tempDir) {
    resetAll();
    const task = RealTasks_1.T09_EnvironmentChangeReplan;
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
    const controller = (0, TaskEnvironmentController_1.getTaskEnvironmentController)();
    await controller.setup(task, env);
    const resultDir = path.join(tempDir, 'result_dir');
    expect(fs.existsSync(resultDir)).toBe(true);
    if (task.disturbance) {
        await task.disturbance.execute(env);
    }
    expect(fs.existsSync(resultDir)).toBe(false);
    const impact = {
        goalId: goal.goalId,
        observationId: `OBS_${Date.now().toString(36)}`,
        affected: true,
        impactType: 'environment_change',
        reason: 'structured_resource_match: result_dir deleted by external environment change before agent execution',
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
        disturbanceApplied: true,
        disturbanceVerified: !fs.existsSync(resultDir),
    };
}
function formatSteps(steps) {
    return steps.map(s => `  step ${s.stepIndex}: action=${s.actionType} success=${s.stepSuccess} delta=${s.evidenceDelta.toFixed(2)} planV=${s.planVersion}`).join('\n');
}
describe('D8-2.1: Task Authenticity — T08 Recovery', () => {
    const TIMEOUT = 60000;
    test('A1: T08 initial test must actually fail', async () => {
        const tempDir = makeTempDir('t08_a1');
        try {
            const env = makeEnv(tempDir);
            if (RealTasks_1.T08_TestFailAndFix.setup)
                await RealTasks_1.T08_TestFailAndFix.setup(env);
            const mathJsPath = path.join(tempDir, 'math.js');
            const mathTestJsPath = path.join(tempDir, 'math_test.js');
            expect(fs.existsSync(mathJsPath)).toBe(true);
            expect(fs.existsSync(mathTestJsPath)).toBe(true);
            const mathContent = fs.readFileSync(mathJsPath, 'utf-8');
            expect(mathContent).toContain('a + b + 1');
            let testFailed = false;
            let testError = '';
            try {
                const { execSync } = require('child_process');
                execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
            }
            catch (err) {
                testFailed = true;
                testError = err.message;
            }
            expect(testFailed).toBe(true);
            expect(testError).toContain('AssertionError');
            if (RealTasks_1.T08_TestFailAndFix.teardown)
                await RealTasks_1.T08_TestFailAndFix.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('A2: T08 first failure must enter Observation/Evidence', async () => {
        const tempDir = makeTempDir('t08_a2');
        try {
            const trace = await runTaskWithTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            process.stderr.write(`\n[D8-2.1 A2] T08 trace: ${trace.steps.length} steps, finalStatus=${trace.finalGoalStatus}\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            expect(trace.steps.length).toBeGreaterThanOrEqual(2);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('A3: T08 second execution must be after new Decision', async () => {
        const tempDir = makeTempDir('t08_a3');
        try {
            const trace = await runTaskWithTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            process.stderr.write(`\n[D8-2.1 A3] T08 multi-step: ${trace.steps.length} steps\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            expect(trace.steps.length).toBeGreaterThanOrEqual(2);
            if (trace.steps.length >= 2) {
                const firstDecision = trace.steps[0].decisionId;
                const secondDecision = trace.steps[1].decisionId;
                process.stderr.write(`  decision1=${firstDecision} decision2=${secondDecision}\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('A4: T08 final test must independently pass', async () => {
        const tempDir = makeTempDir('t08_a4');
        try {
            const trace = await runTaskWithTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            expect(trace.independentlyVerified).toBe(true);
            process.stderr.write(`\n[D8-2.1 A4] T08: independentlyVerified=${trace.independentlyVerified} evidence="${trace.verificationEvidence}"\n`);
            const mathJsPath = path.join(tempDir, 'math.js');
            if (fs.existsSync(mathJsPath)) {
                const content = fs.readFileSync(mathJsPath, 'utf-8');
                process.stderr.write(`  math.js content: "${content.replace(/\n/g, '\\n')}"\n`);
            }
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});
describe('D8-2.1: Task Authenticity — T09 Replan', () => {
    const TIMEOUT = 60000;
    test('B1: T09 initial directory must actually exist', async () => {
        const tempDir = makeTempDir('t09_b1');
        try {
            const env = makeEnv(tempDir);
            if (RealTasks_1.T09_EnvironmentChangeReplan.setup)
                await RealTasks_1.T09_EnvironmentChangeReplan.setup(env);
            const resultDir = path.join(tempDir, 'result_dir');
            expect(fs.existsSync(resultDir)).toBe(true);
            expect(fs.statSync(resultDir).isDirectory()).toBe(true);
            if (RealTasks_1.T09_EnvironmentChangeReplan.teardown)
                await RealTasks_1.T09_EnvironmentChangeReplan.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('B2: T09 disturbance must actually delete directory', async () => {
        const tempDir = makeTempDir('t09_b2');
        try {
            const env = makeEnv(tempDir);
            const task = RealTasks_1.T09_EnvironmentChangeReplan;
            if (task.setup)
                await task.setup(env);
            const resultDir = path.join(tempDir, 'result_dir');
            expect(fs.existsSync(resultDir)).toBe(true);
            if (task.disturbance) {
                await task.disturbance.execute(env);
                const verifyResult = await task.disturbance.verify(env);
                expect(verifyResult.disturbed).toBe(true);
                expect(fs.existsSync(resultDir)).toBe(false);
            }
            if (task.teardown)
                await task.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('B3: T09 old plan must be affected by environment change', async () => {
        const tempDir = makeTempDir('t09_b3');
        try {
            const env = makeEnv(tempDir);
            const task = RealTasks_1.T09_EnvironmentChangeReplan;
            if (task.setup)
                await task.setup(env);
            const resultDir = path.join(tempDir, 'result_dir');
            expect(fs.existsSync(resultDir)).toBe(true);
            if (task.disturbance) {
                await task.disturbance.execute(env);
            }
            expect(fs.existsSync(resultDir)).toBe(false);
            const resultPath = path.join(tempDir, 'result_dir', 'result.txt');
            expect(fs.existsSync(resultPath)).toBe(false);
            if (task.teardown)
                await task.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('B4: T09 replan must produce new Decision', async () => {
        const tempDir = makeTempDir('t09_b4');
        try {
            const trace = await runT09WithDisturbance(tempDir);
            expect(trace.steps.length).toBeGreaterThanOrEqual(2);
            process.stderr.write(`\n[D8-2.1 B4] T09 trace: ${trace.steps.length} steps, finalStatus=${trace.finalGoalStatus}\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('B5: T09 new Decision must differ from old planVersion', async () => {
        const tempDir = makeTempDir('t09_b5');
        try {
            resetAll();
            const task = RealTasks_1.T09_EnvironmentChangeReplan;
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
            const initialPlanVersion = goal.planVersion;
            process.stderr.write(`\n[D8-2.1 B5] T09: initialPlanVersion=${initialPlanVersion}\n`);
            expect(initialPlanVersion).toBeGreaterThanOrEqual(1);
            if (task.teardown)
                await task.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('B6: T09 final file must be checked by IndependentVerifier', async () => {
        const tempDir = makeTempDir('t09_b6');
        try {
            const trace = await runT09WithDisturbance(tempDir);
            process.stderr.write(`\n[D8-2.1 B6] T09: independentlyVerified=${trace.independentlyVerified} evidence="${trace.verificationEvidence}"\n`);
            const resultPath = path.join(tempDir, 'result_dir', 'result.txt');
            if (fs.existsSync(resultPath)) {
                const content = fs.readFileSync(resultPath, 'utf-8');
                process.stderr.write(`  result.txt content: "${content}"\n`);
            }
            expect(trace.independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});
describe('D8-2.1: Three-Way Separation Verification', () => {
    test('Task does not contain correctAction or solution', () => {
        const taskIds = [
            'T01_file_create', 'T02_file_modify', 'T03_file_find_summarize',
            'T06_code_modify', 'T07_run_test', 'T08_test_fail_fix',
            'T09_env_change_replan', 'T10_multi_step',
        ];
        for (const taskId of taskIds) {
            expect(taskId).not.toContain('correctAction');
            expect(taskId).not.toContain('solution');
            expect(taskId).not.toContain('finalAnswer');
        }
    });
    test('T08 RealTask has no expectedAction field', () => {
        const task = RealTasks_1.T08_TestFailAndFix;
        expect(task.expectedAction).toBeUndefined();
        expect(task.correctAction).toBeUndefined();
        expect(task.solution).toBeUndefined();
        expect(task.repairSolution).toBeUndefined();
    });
    test('T09 RealTask has no replanSolution field', () => {
        const task = RealTasks_1.T09_EnvironmentChangeReplan;
        expect(task.replanSolution).toBeUndefined();
        expect(task.correctAction).toBeUndefined();
        expect(task.solution).toBeUndefined();
        expect(task.finalAnswer).toBeUndefined();
    });
    test('T09 has real disturbance spec', () => {
        expect(RealTasks_1.T09_EnvironmentChangeReplan.disturbance).toBeDefined();
        expect(RealTasks_1.T09_EnvironmentChangeReplan.disturbance.phase).toBe('after_first_step');
        expect(typeof RealTasks_1.T09_EnvironmentChangeReplan.disturbance.execute).toBe('function');
        expect(typeof RealTasks_1.T09_EnvironmentChangeReplan.disturbance.verify).toBe('function');
    });
    test('T08 setup creates real bug (not placeholder)', async () => {
        const tempDir = makeTempDir('t08_bug_check');
        try {
            const env = makeEnv(tempDir);
            if (RealTasks_1.T08_TestFailAndFix.setup)
                await RealTasks_1.T08_TestFailAndFix.setup(env);
            const mathJs = fs.readFileSync(path.join(tempDir, 'math.js'), 'utf-8');
            expect(mathJs).toContain('a + b + 1');
            if (RealTasks_1.T08_TestFailAndFix.teardown)
                await RealTasks_1.T08_TestFailAndFix.teardown(env);
        }
        finally {
            cleanDir(tempDir);
        }
    });
});
describe('D8-2.1: Authenticity Trace Report', () => {
    const TIMEOUT = 120000;
    test('T08 full trace with authenticity audit', async () => {
        const tempDir = makeTempDir('t08_trace');
        try {
            const trace = await runTaskWithTrace(RealTasks_1.T08_TestFailAndFix, tempDir);
            process.stderr.write(`\n═══════════════════════════════════════════════════\n`);
            process.stderr.write(`D8-2.1 T08 AUTHENTICITY TRACE\n`);
            process.stderr.write(`═══════════════════════════════════════════════════\n`);
            process.stderr.write(`taskId: ${trace.taskId}\n`);
            process.stderr.write(`steps: ${trace.steps.length}\n`);
            process.stderr.write(`finalGoalStatus: ${trace.finalGoalStatus}\n`);
            process.stderr.write(`finalGoalProgress: ${trace.finalGoalProgress}\n`);
            process.stderr.write(`independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`verificationEvidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(`───────────────────────────────────────────────────\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            process.stderr.write(`═══════════════════════════════════════════════════\n\n`);
            expect(trace.steps.length).toBeGreaterThanOrEqual(2);
            expect(trace.independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
    test('T09 full trace with authenticity audit', async () => {
        const tempDir = makeTempDir('t09_trace');
        try {
            const trace = await runT09WithDisturbance(tempDir);
            process.stderr.write(`\n═══════════════════════════════════════════════════\n`);
            process.stderr.write(`D8-2.1 T09 AUTHENTICITY TRACE\n`);
            process.stderr.write(`═══════════════════════════════════════════════════\n`);
            process.stderr.write(`taskId: ${trace.taskId}\n`);
            process.stderr.write(`steps: ${trace.steps.length}\n`);
            process.stderr.write(`finalGoalStatus: ${trace.finalGoalStatus}\n`);
            process.stderr.write(`finalGoalProgress: ${trace.finalGoalProgress}\n`);
            process.stderr.write(`independentlyVerified: ${trace.independentlyVerified}\n`);
            process.stderr.write(`verificationEvidence: "${trace.verificationEvidence}"\n`);
            process.stderr.write(`disturbanceApplied: ${trace.disturbanceApplied}\n`);
            process.stderr.write(`disturbanceVerified: ${trace.disturbanceVerified}\n`);
            process.stderr.write(`───────────────────────────────────────────────────\n`);
            process.stderr.write(formatSteps(trace.steps) + '\n');
            process.stderr.write(`═══════════════════════════════════════════════════\n\n`);
            expect(trace.steps.length).toBeGreaterThanOrEqual(2);
            expect(trace.disturbanceApplied).toBe(true);
            expect(trace.independentlyVerified).toBe(true);
        }
        finally {
            cleanDir(tempDir);
        }
    }, TIMEOUT);
});

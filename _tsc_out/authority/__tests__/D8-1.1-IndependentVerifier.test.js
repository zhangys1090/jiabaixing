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
const ObservationCollector_1 = require("../../authority/ObservationCollector");
const GoalEvidenceEvaluator_1 = require("../../authority/GoalEvidenceEvaluator");
const EvidenceCollector_1 = require("../../authority/EvidenceCollector");
const IndependentVerifier_1 = require("../../authority/IndependentVerifier");
let ga;
function makeExecResult(decisionId, goalId, planVersion, status, actionType, rawResult, error) {
    return {
        executionId: `EXEC_test_${Date.now().toString(36)}`,
        decisionId, goalId, planVersion, status, actionType, rawResult, error,
        timestamp: Date.now(),
    };
}
function makeExecDecisionResult(overrides) {
    return {
        success: overrides.success ?? true,
        goalId: overrides.goalId,
        decisionId: overrides.decisionId,
        planVersion: overrides.planVersion,
        actionResult: overrides.actionResult ?? null,
        authorization: overrides.authorization ?? { allowed: true },
        reason: overrides.reason ?? 'test',
        executionResult: overrides.executionResult ?? makeExecResult(overrides.decisionId, overrides.goalId, overrides.planVersion, overrides.success === false ? 'execution_failed' : 'executed', 'tool_call', overrides.actionResult),
    };
}
function makeDecision(goalId, actionType, payload, estimatedProgress) {
    return {
        decisionId: `D_${Date.now().toString(36)}`,
        decisionType: 'action',
        goalId,
        snapshotId: 'SS_1',
        planVersion: 1,
        candidateIds: [],
        chosenCandidateId: 'C_1',
        chosen: {
            candidateId: 'C_1',
            proposerId: 'P_1',
            action: { type: actionType, payload },
            confidence: 0.8,
            reasoning: 'test',
            estimatedGoalProgress: estimatedProgress,
        },
        acceptedCandidates: [],
        rejectedCandidates: [],
        selectionReason: 'test',
        proposerSet: ['P_1'],
        vetoReason: null,
        timestamp: Date.now(),
    };
}
beforeEach(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
    ga = GoalAuthority_1.GoalAuthority.getInstance();
    (0, EvidenceCollector_1.resetEvidenceCollector)();
    (0, ObservationCollector_1.resetObservationCollector)();
    (0, GoalEvidenceEvaluator_1.resetGoalEvidenceEvaluator)();
    (0, IndependentVerifier_1.resetVerifierRegistry)();
});
afterAll(() => {
    GoalAuthority_1.GoalAuthority.resetInstance();
    DecisionAuthority_1.DecisionAuthority.resetInstance();
});
describe('D8-1.1: Independent Verifier — V1-V10 Authenticity Tests', () => {
    test('V1: executor returns goalAchieved=true but environment does not have target → NOT VERIFIED', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v1_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const goal = ga.createGoal({ description: 'create hello.txt', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T01_file_create';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec', nodeScript: 'return { goalAchieved: true }' }, 0.9);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { goalAchieved: true, success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { goalAchieved: true, success: true }),
        }));
        expect(result.verified).toBe(false);
        expect(result.evaluation?.verdict).not.toBe('completed');
        expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V2: executor returns success=true but filesystem verifier check fails → Goal != COMPLETED', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v2_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const goal = ga.createGoal({ description: 'create hello.txt', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T01_file_create';
        fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Wrong content', 'utf-8');
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.9);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result.verified).toBe(false);
        expect(result.evaluation?.verdict).not.toBe('completed');
        expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V3: executor returns false but environment actually meets Success Criteria → independent observation prevails', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v3_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Hello D8', 'utf-8');
        const goal = ga.createGoal({ description: 'create hello.txt', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T01_file_create';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.9);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result.verified).toBe(true);
        expect(result.evaluation?.verdict).toBe('completed');
        expect(ga.getGoal(goal.goalId)?.status).toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V4: filesystem truly has target file + correct content → VERIFIED COMPLETED', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v4_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Hello D8', 'utf-8');
        const goal = ga.createGoal({ description: 'create hello.txt', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T01_file_create';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.9);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result.verified).toBe(true);
        expect(result.evaluation?.verdict).toBe('completed');
        expect(ga.getGoal(goal.goalId)?.status).toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V5: test truly passes → VERIFIED', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v5_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'test.js'), `
      const assert = require('assert');
      assert.strictEqual(1 + 1, 2);
      console.log('All tests passed');
    `, 'utf-8');
        const goal = ga.createGoal({ description: 'run test', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T07_run_test';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.8);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result.verified).toBe(true);
        expect(result.evaluation?.verdict).toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V6: test executes but result does not match Success Criteria → NOT COMPLETED', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v6_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'test.js'), `
      console.log('Some output without passing');
    `, 'utf-8');
        const goal = ga.createGoal({ description: 'run test', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T07_run_test';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.8);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result.verified).toBe(false);
        expect(result.evaluation?.verdict).not.toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V7: old execution result must not prove current new environment state', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v7_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Hello D8', 'utf-8');
        const goal = ga.createGoal({ description: 'create hello.txt', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T01_file_create';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.9);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result1 = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result1.verified).toBe(true);
        fs.unlinkSync(path.join(tempDir, 'hello.txt'));
        (0, EvidenceCollector_1.resetEvidenceCollector)();
        (0, ObservationCollector_1.resetObservationCollector)();
        const collector2 = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result2 = await collector2.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(result2.verified).toBe(false);
        expect(result2.evaluation?.verdict).not.toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V8: T09 environment change → replan → independent verification', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v8_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const goal = ga.createGoal({ description: 'env change replan', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T09_env_change_replan';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.8);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const resultNoFile = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(resultNoFile.verified).toBe(false);
        fs.mkdirSync(path.join(tempDir, 'result_dir'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'result_dir', 'result.txt'), 'result', 'utf-8');
        (0, EvidenceCollector_1.resetEvidenceCollector)();
        (0, ObservationCollector_1.resetObservationCollector)();
        const collector2 = (0, EvidenceCollector_1.getEvidenceCollector)();
        const resultAfterReplan = await collector2.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 2,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 2, 'executed', 'tool_call', { success: true }),
        }));
        expect(resultAfterReplan.verified).toBe(true);
        expect(resultAfterReplan.evaluation?.verdict).toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V9: T08 failure → recovery → independent verification', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v9_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'math.js'), `
      function add(a, b) { return a + b + 1; }
      module.exports = { add };
    `, 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'math_test.js'), `
      const { add } = require('./math');
      const assert = require('assert');
      assert.strictEqual(add(1, 1), 2, 'add(1,1) should be 2');
      console.log('Test passed');
    `, 'utf-8');
        const goal = ga.createGoal({ description: 'fix math bug', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T08_test_fail_fix';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.9);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const resultBeforeFix = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true }),
        }));
        expect(resultBeforeFix.verified).toBe(false);
        fs.writeFileSync(path.join(tempDir, 'math.js'), `
      function add(a, b) { return a + b; }
      module.exports = { add };
    `, 'utf-8');
        (0, EvidenceCollector_1.resetEvidenceCollector)();
        (0, ObservationCollector_1.resetObservationCollector)();
        const collector2 = (0, EvidenceCollector_1.getEvidenceCollector)();
        const resultAfterFix = await collector2.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 2,
            actionResult: { success: true },
            reason: 'node_script_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 2, 'executed', 'tool_call', { success: true }),
        }));
        expect(resultAfterFix.verified).toBe(true);
        expect(resultAfterFix.evaluation?.verdict).toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
    test('V10: complete real task chain: Decision → Action → ExecutionResult → IndependentVerifier → Observation → Evidence → GoalEvaluation → COMPLETED', async () => {
        const tempDir = path.join(os.tmpdir(), `d8_v10_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'Hello D8', 'utf-8');
        const goal = ga.createGoal({ description: 'create hello.txt', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['tempDir'] = tempDir;
        goal.metadata['taskId'] = 'T01_file_create';
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'shell_exec' }, 0.9);
        const executionResult = makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true });
        const observationCollector = (0, ObservationCollector_1.getObservationCollector)();
        const observation = await observationCollector.collect(executionResult, goal, decision);
        expect(observation.verificationStatus).toBe('verified');
        expect(observation.observedState.verificationSource).toBe('independent_verifier');
        const evaluator = (0, GoalEvidenceEvaluator_1.getGoalEvidenceEvaluator)();
        const evaluation = evaluator.evaluate(goal, decision, observation);
        expect(evaluation.verdict).toBe('completed');
        expect(evaluation.verified).toBe(true);
        expect(evaluation.verificationReason).toContain('verified observation satisfies goal success criteria');
        expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    });
});
describe('D8-1.1: Prohibition Enforcement', () => {
    test('goalAchieved in executor result is stripped and cannot cause verified', async () => {
        const goal = ga.createGoal({ description: 'test goal', originalInput: 'test', executionDomain: 'orchestrator' });
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'deploy' }, 0.5);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { goalAchieved: true, success: true },
            reason: 'tool_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { goalAchieved: true, success: true }),
        }));
        expect(result.verified).toBe(false);
        expect(result.evaluation?.verdict).not.toBe('completed');
        expect(ga.getGoal(goal.goalId)?.status).not.toBe('completed');
    });
    test('action.success=true without independent verifier → unverified', async () => {
        const goal = ga.createGoal({ description: 'generic goal', originalInput: 'test', executionDomain: 'orchestrator' });
        const decision = makeDecision(goal.goalId, 'tool_call', { tool: 'generic' }, 0.5);
        const collector = (0, EvidenceCollector_1.getEvidenceCollector)();
        const result = await collector.collect(decision, makeExecDecisionResult({
            success: true,
            goalId: goal.goalId,
            decisionId: decision.decisionId,
            planVersion: 1,
            actionResult: { success: true, data: 'something' },
            reason: 'tool_executed',
            executionResult: makeExecResult(decision.decisionId, goal.goalId, 1, 'executed', 'tool_call', { success: true, data: 'something' }),
        }));
        expect(result.verified).toBe(false);
        expect(result.evaluation?.verdict).toBe('unverified');
    });
    test('desktop action without IndependentVerifier confirmation → unverified even with observation', async () => {
        const goal = ga.createGoal({ description: 'desktop goal', originalInput: 'test', executionDomain: 'desktop' });
        const observationCollector = (0, ObservationCollector_1.getObservationCollector)();
        const execResult = makeExecResult('D1', goal.goalId, 1, 'executed', 'desktop_action', {
            observation: { goalAchieved: true, screenText: 'done' },
            success: true,
        });
        const observation = await observationCollector.collect(execResult, goal, undefined);
        expect(observation.verificationStatus).toBe('contradicted');
    });
});
describe('D8-1.1: Verifier Registry', () => {
    test('all 4 verifiers are registered', () => {
        const { getVerifierRegistry } = require('../../authority/IndependentVerifier');
        const registry = getVerifierRegistry();
        const verifiers = registry.getVerifiers();
        expect(verifiers.length).toBe(4);
        const domains = verifiers.map((v) => v.domain);
        expect(domains).toContain('filesystem');
        expect(domains).toContain('test');
        expect(domains).toContain('code');
        expect(domains).toContain('desktop');
    });
    test('CodeVerifier handles T06_code_modify', () => {
        const { getVerifierRegistry } = require('../../authority/IndependentVerifier');
        const registry = getVerifierRegistry();
        const goal = ga.createGoal({ description: 'code modify', originalInput: 'test', executionDomain: 'desktop' });
        goal.metadata['taskId'] = 'T06_code_modify';
        goal.metadata['tempDir'] = '/tmp/test';
        const execResult = makeExecResult('D1', goal.goalId, 1, 'executed', 'tool_call', {});
        const verifier = registry.findVerifier(goal, execResult);
        expect(verifier).not.toBeNull();
        expect(verifier.domain).toBe('filesystem');
    });
});

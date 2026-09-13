"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalAuthority = void 0;
const Logger_1 = require("../utils/Logger");
const types_1 = require("./types");
function generateGoalId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `G_${ts}_${rand}`;
}
function generateEvidenceId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `E_${ts}_${rand}`;
}
class GoalAuthority {
    static instance = null;
    goals = new Map();
    evidenceLog = new Map();
    constructor() { }
    static getInstance() {
        if (!GoalAuthority.instance) {
            GoalAuthority.instance = new GoalAuthority();
        }
        return GoalAuthority.instance;
    }
    static resetInstance() {
        GoalAuthority.instance = null;
    }
    createGoal(input) {
        const now = Date.now();
        const clonedBindings = input.bindings
            ? {
                repository: input.bindings.repository,
                repositoryPath: input.bindings.repositoryPath,
                paths: input.bindings.paths ? [...input.bindings.paths] : undefined,
                resources: input.bindings.resources ? [...input.bindings.resources] : undefined,
                source: input.bindings.source,
                confidence: input.bindings.confidence,
                resolvedAt: input.bindings.resolvedAt,
            }
            : undefined;
        const goal = {
            goalId: generateGoalId(),
            description: input.description,
            originalInput: input.originalInput,
            status: types_1.GoalStatus.ACTIVE,
            priority: input.priority ?? types_1.GoalPriority.NORMAL,
            progress: 0,
            parentGoalId: input.parentGoalId ?? null,
            createdAt: now,
            updatedAt: now,
            successCondition: input.successCondition ?? '',
            abandonmentCondition: input.abandonmentCondition ?? '',
            currentStage: 'created',
            planVersion: 1,
            executionDomain: input.executionDomain,
            metadata: {},
            bindings: clonedBindings,
        };
        this.goals.set(goal.goalId, goal);
        Logger_1.Logger.info(`GoalAuthority: created goal ${goal.goalId} — "${input.description.slice(0, 60)}"`, 'GoalAuthority');
        return goal;
    }
    getGoal(goalId) {
        return this.goals.get(goalId) ?? null;
    }
    /**
     * D4-I2 Post-Audit: 注册跨进程（Python DecisionAuthority 创建的）Goal 的影子记录。
     *
     * delegated 路径的 goalId 由 Python 侧生成，TS GoalAuthority 中不存在；
     * 为使 G→S→D→A→E 链在跨进程路径完整（Evidence 必须能写回同一 goalId），
     * 用 Python 提供的 goalId 注册影子 Goal（identity 与 Python 侧一致）。
     * 若该 goalId 已存在（本轮已注册），直接返回既有记录。
     */
    ensureGoal(goalId, input) {
        const existing = this.goals.get(goalId);
        if (existing) {
            return existing;
        }
        const now = Date.now();
        const clonedBindings = input.bindings
            ? {
                repository: input.bindings.repository,
                repositoryPath: input.bindings.repositoryPath,
                paths: input.bindings.paths ? [...input.bindings.paths] : undefined,
                resources: input.bindings.resources ? [...input.bindings.resources] : undefined,
                source: input.bindings.source,
                confidence: input.bindings.confidence,
                resolvedAt: input.bindings.resolvedAt,
            }
            : undefined;
        const goal = {
            goalId,
            description: input.description,
            originalInput: input.originalInput,
            status: types_1.GoalStatus.ACTIVE,
            priority: input.priority ?? types_1.GoalPriority.NORMAL,
            progress: 0,
            parentGoalId: input.parentGoalId ?? null,
            createdAt: now,
            updatedAt: now,
            successCondition: input.successCondition ?? '',
            abandonmentCondition: input.abandonmentCondition ?? '',
            currentStage: 'delegated',
            planVersion: 1,
            executionDomain: input.executionDomain,
            metadata: { shadowOfPythonGoal: true },
            bindings: clonedBindings,
        };
        this.goals.set(goalId, goal);
        Logger_1.Logger.info(`GoalAuthority: registered shadow goal ${goalId} (from Python delegated decision) — "${input.description.slice(0, 60)}"`, 'GoalAuthority');
        return goal;
    }
    getActiveGoals() {
        return Array.from(this.goals.values()).filter((g) => g.status === types_1.GoalStatus.ACTIVE);
    }
    getAllGoals() {
        return Array.from(this.goals.values());
    }
    updateFromEvidence(evidence) {
        const goal = this.getGoalOrThrow(evidence.goalId);
        const fullEvidence = {
            ...evidence,
            evidenceId: generateEvidenceId(),
            timestamp: Date.now(),
        };
        if (!this.evidenceLog.has(evidence.goalId)) {
            this.evidenceLog.set(evidence.goalId, []);
        }
        this.evidenceLog.get(evidence.goalId).push(fullEvidence);
        const clamped = Math.max(0, Math.min(1, goal.progress + evidence.progressDelta));
        goal.progress = clamped;
        goal.updatedAt = Date.now();
        if (clamped >= 1 && goal.status === types_1.GoalStatus.ACTIVE) {
            Logger_1.Logger.info(`GoalAuthority: goal ${evidence.goalId} progress reached 1.0 but NOT auto-completing — COMPLETED requires verified evidence`, 'GoalAuthority');
        }
        Logger_1.Logger.info(`GoalAuthority: evidence ${fullEvidence.evidenceId} → goal ${evidence.goalId} progress ${goal.progress.toFixed(2)} (delta=${evidence.progressDelta.toFixed(2)})`, 'GoalAuthority');
        // D5: Evidence → LearningAuthority → future Decision influence
        // E2-V1: Learning failure is non-blocking but must be observable.
        try {
            const { LearningAuthority } = require('./LearningAuthority');
            const learningAuthority = LearningAuthority.getInstance();
            const decisionAuthority = require('./DecisionAuthority').DecisionAuthority.getInstance();
            const decisionHistory = decisionAuthority.getDecisionHistory(evidence.goalId);
            const lastDecision = decisionHistory.length > 0
                ? decisionHistory[decisionHistory.length - 1]
                : null;
            const proposerId = lastDecision?.chosen?.proposerId ?? 'unknown';
            const beliefUpdate = learningAuthority.learn(fullEvidence, proposerId);
            if (beliefUpdate) {
                goal.metadata[`learning_${fullEvidence.evidenceId}`] = {
                    status: 'applied',
                    beliefId: beliefUpdate.beliefId,
                    confidenceAdj: beliefUpdate.confidenceAdjustment,
                    progressAdj: beliefUpdate.progressAdjustment,
                };
            }
            else {
                goal.metadata[`learning_${fullEvidence.evidenceId}`] = { status: 'no_update_needed' };
            }
        }
        catch (learnError) {
            goal.metadata[`learning_${fullEvidence.evidenceId}`] = {
                status: 'failed',
                error: learnError.message,
            };
            Logger_1.Logger.error(`E2-V1: LearningAuthority.learn FAILED for evidence ${fullEvidence.evidenceId} — ${learnError.message}`, learnError, 'GoalAuthority');
        }
        return goal;
    }
    getEvidenceLog(goalId) {
        return this.evidenceLog.get(goalId) ?? [];
    }
    updateGoalStatus(goalId, status) {
        const goal = this.getGoalOrThrow(goalId);
        const oldStatus = goal.status;
        goal.status = status;
        goal.updatedAt = Date.now();
        Logger_1.Logger.info(`GoalAuthority: goal ${goalId} status changed ${oldStatus} → ${status}`, 'GoalAuthority');
        return goal;
    }
    updateStage(goalId, stage) {
        const goal = this.getGoalOrThrow(goalId);
        goal.currentStage = stage;
        goal.updatedAt = Date.now();
        return goal;
    }
    markCompleted(goalId, reason) {
        const goal = this.getGoalOrThrow(goalId);
        goal.status = types_1.GoalStatus.COMPLETED;
        goal.progress = 1;
        goal.updatedAt = Date.now();
        goal.metadata['completionReason'] = reason;
        Logger_1.Logger.info(`GoalAuthority: goal ${goalId} completed — ${reason}`, 'GoalAuthority');
        return goal;
    }
    markAbandoned(goalId, reason) {
        const goal = this.getGoalOrThrow(goalId);
        goal.status = types_1.GoalStatus.ABANDONED;
        goal.updatedAt = Date.now();
        goal.metadata['abandonmentReason'] = reason;
        Logger_1.Logger.info(`GoalAuthority: goal ${goalId} abandoned — ${reason}`, 'GoalAuthority');
        return goal;
    }
    replan(goalId, reason, expectedVersion) {
        const goal = this.getGoalOrThrow(goalId);
        if (goal.planVersion !== expectedVersion) {
            throw new Error(`STALE_REQUEST: goal ${goalId} expected planVersion ${expectedVersion}, current is ${goal.planVersion}`);
        }
        goal.planVersion += 1;
        goal.updatedAt = Date.now();
        goal.metadata[`replanReason_v${goal.planVersion}`] = reason;
        Logger_1.Logger.info(`GoalAuthority: goal ${goalId} replanned → plan v${goal.planVersion} (CAS v${expectedVersion}) — ${reason}`, 'GoalAuthority');
        return goal;
    }
    evaluateStatus(goalId, evidence) {
        const goal = this.getGoalOrThrow(goalId);
        if (goal.status === types_1.GoalStatus.COMPLETED) {
            return { status: types_1.GoalStatus.COMPLETED, reason: 'progress reached 1.0' };
        }
        if (goal.status === types_1.GoalStatus.ABANDONED) {
            return { status: types_1.GoalStatus.ABANDONED, reason: goal.metadata['abandonmentReason'] ?? 'abandoned' };
        }
        if (goal.status === types_1.GoalStatus.PAUSED) {
            return { status: types_1.GoalStatus.PAUSED, reason: 'paused by external signal' };
        }
        if (goal.progress >= 1) {
            return {
                status: types_1.GoalStatus.ACTIVE,
                reason: `progress reached 1.0 but NOT verified — COMPLETED requires verified evidence, not progress alone`,
            };
        }
        if (evidence && evidence.progressDelta < -0.3) {
            return {
                status: types_1.GoalStatus.ACTIVE,
                reason: `active but negative evidence (delta=${evidence.progressDelta.toFixed(2)}), consider replan`,
            };
        }
        return { status: types_1.GoalStatus.ACTIVE, reason: `progress=${goal.progress.toFixed(2)}, plan v${goal.planVersion}` };
    }
    clear() {
        this.goals.clear();
        this.evidenceLog.clear();
    }
    getGoalOrThrow(goalId) {
        const goal = this.goals.get(goalId);
        if (!goal) {
            throw new Error(`GoalAuthority: goal ${goalId} not found`);
        }
        return goal;
    }
}
exports.GoalAuthority = GoalAuthority;

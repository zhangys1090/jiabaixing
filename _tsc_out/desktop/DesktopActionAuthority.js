"use strict";
/**
 * DesktopActionAuthority — 桌面动作唯一裁决点 (P0-A)
 *
 * 所有 production 路径必须经过此 authority 才能执行桌面动作。
 * 任何 proposer（LLM / Skill / Rule）都不能直接调用 DesktopActionExecutor。
 *
 * 链路：
 *   proposer → ActionAuthority.authorize() → ActionAuthority.execute()
 *                                              ↓
 *                                     SafetyGuard.checkAction()
 *                                              ↓
 *                                     DesktopActionExecutor.executeTask()
 *
 * Bridge 不可用时：FAIL CLOSED，不产生任何 executable fallback。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopActionAuthority = void 0;
const Logger_1 = require("../utils/Logger");
const DesktopActionExecutor_1 = require("./DesktopActionExecutor");
const DesktopSafetyGuard_1 = require("./DesktopSafetyGuard");
class DesktopActionAuthority {
    static instance = null;
    safetyGuard;
    executor;
    constructor() {
        this.safetyGuard = DesktopSafetyGuard_1.DesktopSafetyGuard.getInstance();
        this.executor = DesktopActionExecutor_1.DesktopActionExecutor.getInstance();
    }
    static getInstance() {
        if (!DesktopActionAuthority.instance) {
            DesktopActionAuthority.instance = new DesktopActionAuthority();
        }
        return DesktopActionAuthority.instance;
    }
    async initialize() {
        await this.safetyGuard.initialize();
        await this.executor.initialize();
    }
    authorize(actions) {
        for (const action of actions) {
            const check = this.safetyGuard.checkAction(action.type, action.description || action.type, action.params);
            if (!check.allowed) {
                Logger_1.Logger.warn(`🛡️ ActionAuthority 拒绝动作: ${action.type} — ${check.reason}`, 'ActionAuthority');
                return check;
            }
        }
        return { allowed: true };
    }
    async execute(actions) {
        const authorization = this.authorize(actions);
        if (!authorization.allowed) {
            Logger_1.Logger.warn(`🛡️ ActionAuthority 阻止执行: ${authorization.reason}`, 'ActionAuthority');
            return {
                success: false,
                actions: [],
                summary: authorization.reason || '安全检查未通过',
                authorization,
            };
        }
        const result = await this.executor.executeTask(actions);
        return { ...result, authorization };
    }
    async executeAction(action) {
        const authorization = this.authorize([action]);
        if (!authorization.allowed) {
            Logger_1.Logger.warn(`🛡️ ActionAuthority 阻止单动作执行: ${action.type} — ${authorization.reason}`, 'ActionAuthority');
            return {
                result: {
                    success: false,
                    action,
                    error: authorization.reason || '安全检查未通过',
                },
                authorization,
            };
        }
        const result = await this.executor.executeAction(action);
        return { result, authorization };
    }
    validateDecisionContext(context) {
        try {
            const { GoalAuthority } = require('../authority/GoalAuthority');
            const goalAuthority = GoalAuthority.getInstance();
            const goal = goalAuthority.getGoal(context.goalId);
            if (!goal) {
                Logger_1.Logger.warn(`🛡️ ActionAuthority: goal ${context.goalId} not found — STALE`, 'ActionAuthority');
                return { allowed: false, reason: `goal_not_found: ${context.goalId}` };
            }
            if (goal.planVersion !== context.planVersion) {
                Logger_1.Logger.warn(`🛡️ ActionAuthority: STALE_DECISION — goal ${context.goalId} planVersion ${context.planVersion} != current ${goal.planVersion}`, 'ActionAuthority');
                return {
                    allowed: false,
                    reason: `stale_decision: planVersion ${context.planVersion} != current ${goal.planVersion}`,
                };
            }
            const { DecisionAuthority } = require('../authority/DecisionAuthority');
            const decisionAuthority = DecisionAuthority.getInstance();
            const history = decisionAuthority.getDecisionHistory(context.goalId);
            const decision = history.find((d) => d.decisionId === context.decisionId);
            if (!decision) {
                Logger_1.Logger.warn(`🛡️ ActionAuthority: decision ${context.decisionId} not found in history — INVALID`, 'ActionAuthority');
                return { allowed: false, reason: `decision_not_found: ${context.decisionId}` };
            }
            if (decision.planVersion !== context.planVersion) {
                Logger_1.Logger.warn(`🛡️ ActionAuthority: decision planVersion mismatch — decision ${context.decisionId} has v${decision.planVersion}, context has v${context.planVersion}`, 'ActionAuthority');
                return {
                    allowed: false,
                    reason: `decision_planVersion_mismatch: ${decision.planVersion} != ${context.planVersion}`,
                };
            }
            return { allowed: true };
        }
        catch (err) {
            Logger_1.Logger.error(`🛡️ ActionAuthority: validateDecisionContext error — ${err.message}`, err, 'ActionAuthority');
            return { allowed: false, reason: `validation_error: ${err.message}` };
        }
    }
    async executeWithDecisionContext(actions, context) {
        const decisionValidation = this.validateDecisionContext(context);
        if (!decisionValidation.allowed) {
            return {
                success: false,
                actions: [],
                summary: decisionValidation.reason || 'decision validation failed',
                authorization: decisionValidation,
            };
        }
        return this.execute(actions);
    }
}
exports.DesktopActionAuthority = DesktopActionAuthority;

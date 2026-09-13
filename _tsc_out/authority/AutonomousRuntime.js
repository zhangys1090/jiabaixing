"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RUNTIME_CONFIG = exports.RuntimeState = void 0;
exports.getAutonomousRuntime = getAutonomousRuntime;
exports.resetAutonomousRuntime = resetAutonomousRuntime;
const Logger_1 = require("../utils/Logger");
const EventBus_1 = require("../shared/EventBus");
var RuntimeState;
(function (RuntimeState) {
    RuntimeState["IDLE"] = "idle";
    RuntimeState["RUNNING"] = "running";
    RuntimeState["PAUSED"] = "paused";
    RuntimeState["STOPPED"] = "stopped";
})(RuntimeState || (exports.RuntimeState = RuntimeState = {}));
exports.DEFAULT_RUNTIME_CONFIG = {
    observationIntervalMs: 5000,
    maxConcurrentGoals: 3,
    goalCooldownMs: 10000,
    loopSafety: {},
};
class AutonomousRuntimeImpl {
    state = RuntimeState.IDLE;
    config;
    observationTimer = null;
    goalStatuses = new Map();
    activeLoops = new Set();
    pendingObservations = [];
    constructor(config) {
        this.config = { ...exports.DEFAULT_RUNTIME_CONFIG, ...config };
    }
    start() {
        if (this.state === RuntimeState.RUNNING) {
            Logger_1.Logger.warn('[D7-4] Runtime already running', 'AutonomousRuntime');
            return;
        }
        this.state = RuntimeState.RUNNING;
        Logger_1.Logger.info(`[D7-4] AutonomousRuntime started: interval=${this.config.observationIntervalMs}ms maxConcurrent=${this.config.maxConcurrentGoals}`, 'AutonomousRuntime');
        EventBus_1.EventBus.emit('runtime_state_changed', { state: this.state });
        this.observationTimer = setInterval(() => {
            this.tick().catch((err) => {
                Logger_1.Logger.error(`[D7-4] Runtime tick error: ${err.message}`, err, 'AutonomousRuntime');
            });
        }, this.config.observationIntervalMs);
    }
    pause() {
        if (this.state !== RuntimeState.RUNNING)
            return;
        this.state = RuntimeState.PAUSED;
        this.clearTimer();
        Logger_1.Logger.info('[D7-4] Runtime paused', 'AutonomousRuntime');
        EventBus_1.EventBus.emit('runtime_state_changed', { state: this.state });
    }
    resume() {
        if (this.state !== RuntimeState.PAUSED)
            return;
        this.state = RuntimeState.RUNNING;
        Logger_1.Logger.info('[D7-4] Runtime resumed', 'AutonomousRuntime');
        EventBus_1.EventBus.emit('runtime_state_changed', { state: this.state });
        this.observationTimer = setInterval(() => {
            this.tick().catch((err) => {
                Logger_1.Logger.error(`[D7-4] Runtime tick error: ${err.message}`, err, 'AutonomousRuntime');
            });
        }, this.config.observationIntervalMs);
    }
    stop() {
        this.state = RuntimeState.STOPPED;
        this.clearTimer();
        this.activeLoops.clear();
        Logger_1.Logger.info('[D7-4] Runtime stopped', 'AutonomousRuntime');
        EventBus_1.EventBus.emit('runtime_state_changed', { state: this.state });
    }
    getState() {
        return this.state;
    }
    getGoalStatuses() {
        return new Map(this.goalStatuses);
    }
    async injectObservation(observation) {
        this.pendingObservations.push(observation);
        if (this.state === RuntimeState.RUNNING) {
            await this.processObservation(observation);
        }
    }
    getConfig() {
        return { ...this.config };
    }
    async tick() {
        if (this.state !== RuntimeState.RUNNING)
            return;
        const { GoalAuthority } = require('./GoalAuthority');
        const goalAuthority = GoalAuthority.getInstance();
        const activeGoals = goalAuthority.getActiveGoals();
        if (activeGoals.length === 0)
            return;
        while (this.pendingObservations.length > 0) {
            const obs = this.pendingObservations.shift();
            await this.processObservation(obs);
        }
        for (const goal of activeGoals) {
            if (this.activeLoops.has(goal.goalId))
                continue;
            const status = this.goalStatuses.get(goal.goalId);
            if (status?.running)
                continue;
            if (status?.lastEndTime) {
                const elapsed = Date.now() - status.lastEndTime;
                if (elapsed < this.config.goalCooldownMs)
                    continue;
            }
            if (this.activeLoops.size >= this.config.maxConcurrentGoals)
                break;
            await this.initiateLoopForGoal(goal);
        }
    }
    async processObservation(observation) {
        const { GoalAuthority } = require('./GoalAuthority');
        const goalAuthority = GoalAuthority.getInstance();
        const activeGoals = goalAuthority.getActiveGoals();
        if (activeGoals.length === 0)
            return;
        const { getGoalImpactEvaluator } = require('./GoalImpactEvaluator');
        const evaluator = getGoalImpactEvaluator();
        const impacts = evaluator.evaluate(activeGoals, observation);
        const affectedImpacts = impacts.filter((i) => i.affected);
        if (affectedImpacts.length === 0)
            return;
        Logger_1.Logger.info(`[D7-4] Observation ${observation.observationId} affects ${affectedImpacts.length} goal(s)`, 'AutonomousRuntime');
        for (const impact of affectedImpacts) {
            if (this.activeLoops.has(impact.goalId)) {
                Logger_1.Logger.info(`[D7-4] Goal ${impact.goalId} already has active loop — skipping`, 'AutonomousRuntime');
                continue;
            }
            if (this.activeLoops.size >= this.config.maxConcurrentGoals) {
                Logger_1.Logger.warn(`[D7-4] Max concurrent goals reached (${this.config.maxConcurrentGoals}) — deferring goal ${impact.goalId}`, 'AutonomousRuntime');
                continue;
            }
            const goal = goalAuthority.getGoal(impact.goalId);
            if (!goal || goal.status !== 'active')
                continue;
            await this.initiateLoopForGoal(goal, impact, observation);
        }
    }
    async initiateLoopForGoal(goal, impact, observation) {
        if (!impact) {
            const { getGoalImpactEvaluator } = require('./GoalImpactEvaluator');
            const evaluator = getGoalImpactEvaluator();
            const defaultObs = {
                observationId: `OBS_proactive_${Date.now().toString(36)}`,
                source: 'proactive',
                type: 'proactive_check',
                timestamp: new Date().toISOString(),
                payload: { reason: 'proactive_goal_check' },
            };
            const impacts = evaluator.evaluate([goal], defaultObs);
            impact = impacts.find((i) => i.affected) || {
                goalId: goal.goalId,
                observationId: defaultObs.observationId,
                affected: true,
                impactType: 'proactive_signal',
                reason: 'proactive goal check',
                confidence: 0.5,
            };
            observation = defaultObs;
        }
        if (!observation) {
            observation = {
                observationId: `OBS_proactive_${Date.now().toString(36)}`,
                source: 'proactive',
                type: 'proactive_check',
                timestamp: new Date().toISOString(),
                payload: {},
            };
        }
        this.activeLoops.add(goal.goalId);
        if (!this.goalStatuses.has(goal.goalId)) {
            this.goalStatuses.set(goal.goalId, {
                goalId: goal.goalId,
                running: true,
                lastStartTime: Date.now(),
                lastEndTime: null,
                lastResult: null,
                totalRuns: 0,
            });
        }
        else {
            const status = this.goalStatuses.get(goal.goalId);
            status.running = true;
            status.lastStartTime = Date.now();
        }
        Logger_1.Logger.info(`[D7-4] Initiating loop for goal ${goal.goalId} (activeLoops=${this.activeLoops.size})`, 'AutonomousRuntime');
        try {
            const { getAutonomousLoop } = require('./AutonomousLoop');
            const loop = getAutonomousLoop();
            const result = await loop.run(goal.goalId, impact, observation, this.config.loopSafety);
            const status = this.goalStatuses.get(goal.goalId);
            status.running = false;
            status.lastEndTime = Date.now();
            status.lastResult = result;
            status.totalRuns++;
            Logger_1.Logger.info(`[D7-4] Loop completed for goal ${goal.goalId}: reason=${result.terminationReason} steps=${result.totalSteps} progress=${result.finalGoalProgress.toFixed(2)}`, 'AutonomousRuntime');
        }
        catch (err) {
            Logger_1.Logger.error(`[D7-4] Loop failed for goal ${goal.goalId}: ${err.message}`, err, 'AutonomousRuntime');
            const status = this.goalStatuses.get(goal.goalId);
            if (status) {
                status.running = false;
                status.lastEndTime = Date.now();
            }
        }
        finally {
            this.activeLoops.delete(goal.goalId);
        }
    }
    clearTimer() {
        if (this.observationTimer) {
            clearInterval(this.observationTimer);
            this.observationTimer = null;
        }
    }
}
let instance = null;
function getAutonomousRuntime(config) {
    if (!instance) {
        instance = new AutonomousRuntimeImpl(config);
    }
    return instance;
}
function resetAutonomousRuntime() {
    if (instance) {
        instance.stop();
    }
    instance = null;
}

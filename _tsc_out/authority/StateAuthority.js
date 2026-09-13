"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateAuthority = void 0;
const Logger_1 = require("../utils/Logger");
const GoalAuthority_1 = require("./GoalAuthority");
function generateSnapshotId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `SS_${ts}_${rand}`;
}
class StateAuthority {
    static instance = null;
    providers = null;
    latestSnapshot = null;
    constructor() { }
    static getInstance() {
        if (!StateAuthority.instance) {
            StateAuthority.instance = new StateAuthority();
        }
        return StateAuthority.instance;
    }
    static resetInstance() {
        StateAuthority.instance = null;
    }
    registerProviders(providers) {
        this.providers = providers;
        Logger_1.Logger.info('StateAuthority: read providers registered', 'StateAuthority');
    }
    async captureSnapshot(activeGoalIds) {
        const goalAuthority = GoalAuthority_1.GoalAuthority.getInstance();
        const goals = activeGoalIds
            ? activeGoalIds.map((id) => goalAuthority.getGoal(id)).filter((g) => g !== null)
            : goalAuthority.getActiveGoals();
        const resolvedGoalIds = goals.map((g) => g.goalId);
        const primaryDescription = goals.length > 0 ? goals[0].description : '';
        if (!this.providers) {
            Logger_1.Logger.warn('StateAuthority: no read providers registered, returning minimal snapshot', 'StateAuthority');
            return this.minimalSnapshot(resolvedGoalIds);
        }
        const [world, memory, context, capabilities] = await Promise.all([
            this.providers.readWorldState().catch((e) => {
                Logger_1.Logger.warn(`StateAuthority: world read failed — ${e.message}`, 'StateAuthority');
                return { observation: null, platform: 'server', timestamp: Date.now() };
            }),
            this.providers.readMemory(primaryDescription).catch((e) => {
                Logger_1.Logger.warn(`StateAuthority: memory read failed — ${e.message}`, 'StateAuthority');
                return { relevantMemories: [], query: '', timestamp: Date.now() };
            }),
            this.providers.readContext(resolvedGoalIds).catch((e) => {
                Logger_1.Logger.warn(`StateAuthority: context read failed — ${e.message}`, 'StateAuthority');
                return { systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now() };
            }),
            this.providers.readCapabilities().catch((e) => {
                Logger_1.Logger.warn(`StateAuthority: capabilities read failed — ${e.message}`, 'StateAuthority');
                return { availableTools: [], availableSkills: [], desktopAvailable: false, bridgeAvailable: false };
            }),
        ]);
        const self = {
            agentId: this.providers.getAgentId(),
            activeGoalIds: resolvedGoalIds,
            currentStage: goals.length > 0 ? goals[0].currentStage : 'unknown',
            safetyStatus: this.providers.getSafetyStatus(),
        };
        const snapshot = {
            snapshotId: generateSnapshotId(),
            timestamp: Date.now(),
            activeGoalIds: resolvedGoalIds,
            self,
            world,
            memory,
            context,
            capabilities,
        };
        this.latestSnapshot = snapshot;
        Logger_1.Logger.info(`StateAuthority: captured snapshot ${snapshot.snapshotId} for goals [${resolvedGoalIds.join(',')}]`, 'StateAuthority');
        return snapshot;
    }
    getLatestSnapshot() {
        return this.latestSnapshot;
    }
    minimalSnapshot(activeGoalIds) {
        return {
            snapshotId: generateSnapshotId(),
            timestamp: Date.now(),
            activeGoalIds,
            self: {
                agentId: 'unknown',
                activeGoalIds,
                currentStage: 'unknown',
                safetyStatus: 'degraded',
            },
            world: { observation: null, platform: 'server', timestamp: Date.now() },
            memory: { relevantMemories: [], query: '', timestamp: Date.now() },
            context: {
                systemPrompt: '',
                conversationHistory: [],
                fileContexts: [],
                personaSummary: '',
                timestamp: Date.now(),
            },
            capabilities: {
                availableTools: [],
                availableSkills: [],
                desktopAvailable: false,
                bridgeAvailable: false,
            },
        };
    }
}
exports.StateAuthority = StateAuthority;

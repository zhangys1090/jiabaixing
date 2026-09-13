"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryAuthority = void 0;
const Logger_1 = require("../utils/Logger");
function generateMemoryOpId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `MO_${ts}_${rand}`;
}
const CANONICAL_OWNERS = [
    { domain: 'short_term', process: 'python', description: 'Python MemoryEngine.storeShortTerm' },
    { domain: 'long_term', process: 'python', description: 'Python MemoryEngine.storeLongTerm' },
    { domain: 'episodic', process: 'python', description: 'Python EpisodicMemoryStore' },
    { domain: 'cross_session', process: 'python', description: 'Python CrossSessionMemory' },
    { domain: 'visual', process: 'python', description: 'Python VisualMemory' },
    { domain: 'tool_selection', process: 'python', description: 'Python ToolSelectionMemory' },
    { domain: 'feedback', process: 'python', description: 'Python MemoryEngine.storeFeedbackSignal' },
    { domain: 'persistent_hermes', process: 'ts_bridge', description: 'TS PersistentMemoryService bridged to Python' },
];
const ROGUE_STORES = [
    {
        filePath: 'src/memory/EpisodicMemoryStore.ts',
        className: 'EpisodicMemoryStore',
        domain: 'episodic',
        issue: 'Local JSON file storage bypasses Python canonical EpisodicMemoryStore',
        recommendation: 'bridge_to_python',
    },
    {
        filePath: 'src/memory/PersistentMemoryService.ts',
        className: 'PersistentMemoryService',
        domain: 'persistent_hermes',
        issue: 'MEMORY.md/USER.md file-based storage not bridged to Python',
        recommendation: 'bridge_to_python',
    },
    {
        filePath: 'src/memory/MemoryRetriever.ts',
        className: 'MemoryRetriever',
        domain: 'short_term',
        issue: 'Imports deprecated ShortTermMemory/LongTermMemory, not imported by anyone',
        recommendation: 'deprecate',
    },
];
class MemoryAuthority {
    static instance = null;
    operationLog = [];
    MAX_OPERATION_LOG = 2000;
    bridgeAvailable = false;
    pythonWriteFn = null;
    pythonReadFn = null;
    constructor() { }
    static getInstance() {
        if (!MemoryAuthority.instance) {
            MemoryAuthority.instance = new MemoryAuthority();
        }
        return MemoryAuthority.instance;
    }
    static resetInstance() {
        MemoryAuthority.instance = null;
    }
    registerBridge(writeFn, readFn) {
        this.pythonWriteFn = writeFn;
        this.pythonReadFn = readFn;
        this.bridgeAvailable = true;
        Logger_1.Logger.info('MemoryAuthority: Python bridge registered', 'MemoryAuthority');
    }
    isBridgeAvailable() {
        return this.bridgeAvailable;
    }
    getCanonicalOwner(domain) {
        return CANONICAL_OWNERS.find((o) => o.domain === domain);
    }
    getAllCanonicalOwners() {
        return CANONICAL_OWNERS;
    }
    getRogueStores() {
        return ROGUE_STORES;
    }
    async write(request) {
        const operationId = generateMemoryOpId();
        const canonicalOwner = this.getCanonicalOwner(request.memoryType);
        if (!canonicalOwner) {
            Logger_1.Logger.warn(`MemoryAuthority: unknown domain "${request.memoryType}"`, 'MemoryAuthority');
            return { success: false, memoryId: '', operationId, source: 'ts_local' };
        }
        if (canonicalOwner.process === 'python' && this.pythonWriteFn) {
            try {
                const result = await this.pythonWriteFn(request);
                this.recordTrace({
                    operationId,
                    operation: 'store',
                    memoryType: request.memoryType,
                    goalId: request.goalId ?? null,
                    decisionId: request.decisionId ?? null,
                    snapshotId: request.snapshotId ?? null,
                    source: 'python',
                    timestamp: Date.now(),
                });
                return { ...result, operationId, source: 'python' };
            }
            catch (e) {
                Logger_1.Logger.warn(`MemoryAuthority: Python write failed — ${e.message}, falling back`, 'MemoryAuthority');
            }
        }
        if (canonicalOwner.process === 'ts_bridge') {
            this.recordTrace({
                operationId,
                operation: 'store',
                memoryType: request.memoryType,
                goalId: request.goalId ?? null,
                decisionId: request.decisionId ?? null,
                snapshotId: request.snapshotId ?? null,
                source: 'ts_bridge',
                timestamp: Date.now(),
            });
            return { success: true, memoryId: '', operationId, source: 'ts_bridge' };
        }
        if (canonicalOwner.process === 'python' && !this.pythonWriteFn) {
            this.recordTrace({
                operationId,
                operation: 'store',
                memoryType: request.memoryType,
                goalId: request.goalId ?? null,
                decisionId: request.decisionId ?? null,
                snapshotId: request.snapshotId ?? null,
                source: 'failed_closed',
                timestamp: Date.now(),
            });
            Logger_1.Logger.error(`E2-2: MemoryAuthority write for "${request.memoryType}" FAILED CLOSED — Python canonical owner unavailable, bridge not registered. Refusing silent ts_local fallback to prevent canonicality violation.`, new Error('E2-2: Memory write fail-closed — canonical owner unavailable'), 'MemoryAuthority');
            return { success: false, memoryId: '', operationId, source: 'failed_closed' };
        }
        return { success: false, memoryId: '', operationId, source: 'ts_local' };
    }
    async read(request) {
        const operationId = generateMemoryOpId();
        const domain = request.memoryType ?? 'short_term';
        const canonicalOwner = this.getCanonicalOwner(domain);
        if (!canonicalOwner) {
            Logger_1.Logger.warn(`MemoryAuthority: unknown domain "${domain}" for read`, 'MemoryAuthority');
            return { items: [], operationId, source: 'ts_local' };
        }
        if (canonicalOwner.process === 'python' && this.pythonReadFn) {
            try {
                const result = await this.pythonReadFn(request);
                this.recordTrace({
                    operationId,
                    operation: 'retrieve',
                    memoryType: domain,
                    goalId: request.goalId ?? null,
                    decisionId: null,
                    snapshotId: null,
                    source: 'python',
                    timestamp: Date.now(),
                });
                return { ...result, operationId, source: 'python' };
            }
            catch (e) {
                Logger_1.Logger.warn(`MemoryAuthority: Python read failed — ${e.message}, falling back`, 'MemoryAuthority');
            }
        }
        if (canonicalOwner.process === 'python' && !this.pythonReadFn) {
            this.recordTrace({
                operationId,
                operation: 'retrieve',
                memoryType: domain,
                goalId: request.goalId ?? null,
                decisionId: null,
                snapshotId: null,
                source: 'failed_closed',
                timestamp: Date.now(),
            });
            Logger_1.Logger.error(`E2-2: MemoryAuthority read for "${domain}" FAILED CLOSED — Python canonical owner unavailable, bridge not registered. Refusing silent ts_local fallback to prevent canonicality violation.`, new Error('E2-2: Memory read fail-closed — canonical owner unavailable'), 'MemoryAuthority');
            return { items: [], operationId, source: 'failed_closed' };
        }
        if (canonicalOwner.process === 'ts_bridge') {
            this.recordTrace({
                operationId,
                operation: 'retrieve',
                memoryType: domain,
                goalId: request.goalId ?? null,
                decisionId: null,
                snapshotId: null,
                source: 'ts_bridge',
                timestamp: Date.now(),
            });
            return { items: [], operationId, source: 'ts_bridge' };
        }
        this.recordTrace({
            operationId,
            operation: 'retrieve',
            memoryType: domain,
            goalId: request.goalId ?? null,
            decisionId: null,
            snapshotId: null,
            source: 'ts_local',
            timestamp: Date.now(),
        });
        return { items: [], operationId, source: 'ts_local' };
    }
    getOperationLog(filter) {
        if (!filter)
            return [...this.operationLog];
        return this.operationLog.filter((op) => {
            if (filter.goalId && op.goalId !== filter.goalId)
                return false;
            if (filter.memoryType && op.memoryType !== filter.memoryType)
                return false;
            return true;
        });
    }
    getOperationStats() {
        const bySource = {};
        const byOperation = {};
        const byDomain = {};
        let withAuth = 0;
        let withoutAuth = 0;
        for (const op of this.operationLog) {
            bySource[op.source] = (bySource[op.source] ?? 0) + 1;
            byOperation[op.operation] = (byOperation[op.operation] ?? 0) + 1;
            byDomain[op.memoryType] = (byDomain[op.memoryType] ?? 0) + 1;
            if (op.goalId && op.decisionId) {
                withAuth++;
            }
            else {
                withoutAuth++;
            }
        }
        return {
            total: this.operationLog.length,
            bySource,
            byOperation,
            byDomain,
            withAuthorityTrace: withAuth,
            withoutAuthorityTrace: withoutAuth,
        };
    }
    recordTraceDirect(trace) {
        this.recordTrace(trace);
    }
    recordTrace(trace) {
        this.operationLog.push(trace);
        if (this.operationLog.length > this.MAX_OPERATION_LOG) {
            this.operationLog = this.operationLog.slice(-Math.floor(this.MAX_OPERATION_LOG * 0.75));
        }
    }
}
exports.MemoryAuthority = MemoryAuthority;

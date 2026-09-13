"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryToolRuntimeState = void 0;
class InMemoryToolRuntimeState {
    circuitBreakers = new Map();
    semaphores = new Map();
    quotaCounters = new Map();
    dedupCache = new Map();
    getCircuitBreaker(toolName) {
        return this.circuitBreakers.get(toolName);
    }
    setCircuitBreaker(toolName, state) {
        this.circuitBreakers.set(toolName, state);
    }
    getSemaphore(agentKey) {
        return this.semaphores.get(agentKey);
    }
    setSemaphore(agentKey, sem) {
        this.semaphores.set(agentKey, sem);
    }
    getQuota(key) {
        return this.quotaCounters.get(key);
    }
    setQuota(key, record) {
        this.quotaCounters.set(key, record);
    }
    getDedupResult(dedupKey) {
        return this.dedupCache.get(dedupKey);
    }
    setDedupResult(dedupKey, result) {
        this.dedupCache.set(dedupKey, result);
    }
    clear() {
        this.circuitBreakers.clear();
        this.semaphores.clear();
        this.quotaCounters.clear();
        this.dedupCache.clear();
    }
}
exports.InMemoryToolRuntimeState = InMemoryToolRuntimeState;

"use strict";
/**
 * ToolChannel —— harness 工具通道适配器
 *
 * 将 ToolRegistry.execute(...) 归一为 ActionChannel 契约。
 * 编排层经 ActionDispatcher 以 channel='tool' 调度任意已注册工具。
 *
 * V2 增强：
 * - 只读工具结果缓存（相同参数短时间内不重复执行）
 * - 执行结果指标采集
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolChannel = void 0;
const Logger_1 = require("../../../utils/Logger");
const CACHE_TTL_MS = 5000;
const CACHE_MAX_SIZE = 50;
const CACHEABLE_TOOLS = new Set([
    'file_list',
    'file_read',
    'file_search',
    'file_grep',
    'memory_recall',
    'memory_search',
    'system_status',
    'tool_inspect',
]);
class ToolChannel {
    constructor(registry) {
        this.registry = registry;
        this.kind = 'tool';
        this._cache = new Map();
        this._stats = { hits: 0, misses: 0, errors: 0 };
    }
    async dispatch(request) {
        const start = Date.now();
        const tool = request.tool;
        if (!tool) {
            return {
                channel: 'tool',
                success: false,
                output: null,
                error: 'ToolChannel 需要 request.tool',
                durationMs: Date.now() - start,
            };
        }
        if (CACHEABLE_TOOLS.has(tool) && !request.noCache) {
            const cacheKey = this.buildCacheKey(tool, request.params);
            const cached = this._cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
                this._stats.hits++;
                return {
                    ...cached.result,
                    metadata: { ...cached.result.metadata, fromCache: true },
                };
            }
        }
        try {
            const result = await this.registry.execute(tool, request.params ?? {}, (request.context ?? {}));
            const actionResult = {
                channel: 'tool',
                success: result.success,
                output: result.output,
                error: result.error,
                durationMs: result.duration ?? Date.now() - start,
                raw: result,
                metadata: result.metadata,
            };
            if (CACHEABLE_TOOLS.has(tool) && result.success && !request.noCache) {
                const cacheKey = this.buildCacheKey(tool, request.params);
                this._cache.set(cacheKey, { result: actionResult, timestamp: Date.now() });
                if (this._cache.size > CACHE_MAX_SIZE) {
                    const oldestKey = this._cache.keys().next().value;
                    this._cache.delete(oldestKey);
                }
            }
            this._stats.misses++;
            return actionResult;
        }
        catch (err) {
            this._stats.errors++;
            Logger_1.Logger.error(`ToolChannel 调度失败: ${tool}`, err, 'ToolChannel');
            return {
                channel: 'tool',
                success: false,
                output: null,
                error: err.message,
                durationMs: Date.now() - start,
            };
        }
    }
    buildCacheKey(tool, params) {
        try {
            return `${tool}:${JSON.stringify(params || {})}`;
        }
        catch {
            return `${tool}:${Date.now()}`;
        }
    }
    getStats() {
        return { ...this._stats, cacheSize: this._cache.size };
    }
    clearCache() {
        this._cache.clear();
    }
}
exports.ToolChannel = ToolChannel;

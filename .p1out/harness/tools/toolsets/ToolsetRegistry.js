"use strict";
/**
 * 工具集（Toolset）— 按场景/角色预组装的工具包
 *
 * 设计目标:
 *   - 不同 Agent 角色使用不同工具集（CodingAgent 用代码工具，DesktopAgent 用桌面工具）
 *   - 避免把全部 25+ 工具一股脑传给 LLM（选择空间过大导致幻觉）
 *   - 支持继承、覆盖、合并（base + extension 模式）
 *
 * 用法:
 *   const codingToolset = ToolsetRegistry.get('coding');
 *   const tools = codingToolset.resolve(toolRegistry);
 *   // tools 即 OpenAI Function Calling 格式，传给 LLM
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolsetRegistry = void 0;
exports.getToolsetRegistry = getToolsetRegistry;
exports.resetToolsetRegistry = resetToolsetRegistry;
const Logger_1 = require("../../../utils/Logger");
/**
 * 工具集注册表
 *
 * 管理多个 Toolset 定义，支持:
 *   - 注册/查询 Toolset
 *   - 继承解析（extends 链）
 *   - 与 ToolRegistry 集成（解析为具体工具）
 */
class ToolsetRegistry {
    constructor() {
        this.definitions = new Map();
        this.MAX_DEFINITIONS = 100;
        this.resolvedCache = new Map();
    }
    /**
     * 注册工具集定义
     */
    register(def) {
        if (this.definitions.has(def.id)) {
            Logger_1.Logger.debug(`工具集已存在，覆盖: ${def.id}`, 'ToolsetRegistry');
        }
        else if (this.definitions.size >= this.MAX_DEFINITIONS) {
            const oldestKey = this.definitions.keys().next().value;
            this.definitions.delete(oldestKey);
            this.resolvedCache.delete(oldestKey);
        }
        this.definitions.set(def.id, def);
        this.resolvedCache.delete(def.id);
        Logger_1.Logger.info(`📦 注册工具集: ${def.id} (${def.displayName})`, 'ToolsetRegistry');
    }
    /**
     * 获取工具集定义
     */
    get(id) {
        return this.definitions.get(id);
    }
    /**
     * 列出所有工具集 id
     */
    list() {
        return Array.from(this.definitions.keys());
    }
    /**
     * 解析工具集为具体工具名列表（含继承解析）
     *
     * @param id - 工具集 id
     * @param toolRegistry - 工具注册表（用于校验工具存在性 + 分类展开）
     * @returns 解析后的工具集，若 id 不存在返回 undefined
     */
    resolve(id, toolRegistry) {
        if (this.resolvedCache.has(id)) {
            return this.resolvedCache.get(id);
        }
        const def = this.definitions.get(id);
        if (!def) {
            Logger_1.Logger.warn(`工具集不存在: ${id}`, 'ToolsetRegistry');
            return undefined;
        }
        const resolvedFrom = [];
        const toolNameSet = new Set();
        // 1. 解析父工具集（递归）
        if (def.extends) {
            const parent = this.resolve(def.extends, toolRegistry);
            if (parent) {
                resolvedFrom.push(...parent.resolvedFrom);
                for (const name of parent.toolNames) {
                    toolNameSet.add(name);
                }
            }
        }
        resolvedFrom.push(def.id);
        // 2. 解析本工具集的 includes
        for (const entry of def.includes) {
            if (entry.name) {
                // 精确工具名 — 校验存在性
                if (toolRegistry.has(entry.name)) {
                    toolNameSet.add(entry.name);
                }
                else {
                    Logger_1.Logger.warn(`工具集 ${id} 引用了不存在的工具: ${entry.name}`, 'ToolsetRegistry');
                }
            }
            else if (entry.category) {
                // 整类包含
                const tools = toolRegistry.getByCategory(entry.category);
                for (const t of tools) {
                    toolNameSet.add(t.definition.name);
                }
            }
        }
        // 3. 应用 excludes
        if (def.excludes) {
            for (const name of def.excludes) {
                toolNameSet.delete(name);
            }
        }
        let toolNames = Array.from(toolNameSet);
        // 4. 应用 maxTools 截断（按可靠性排序）
        if (def.maxTools && def.maxTools > 0 && toolNames.length > def.maxTools) {
            const tracker = toolRegistry.getReliabilityTracker();
            toolNames.sort((a, b) => {
                const sa = tracker.getCompositeScore(a);
                const sb = tracker.getCompositeScore(b);
                return sb - sa;
            });
            toolNames = toolNames.slice(0, def.maxTools);
        }
        const resolved = {
            id: def.id,
            displayName: def.displayName,
            toolNames,
            resolvedFrom,
        };
        this.resolvedCache.set(id, resolved);
        return resolved;
    }
    /**
     * 解析为 OpenAI Function Calling 格式（直接传给 LLM）
     */
    resolveToOpenAI(id, toolRegistry) {
        const resolved = this.resolve(id, toolRegistry);
        if (!resolved)
            return [];
        const allOpenAITools = toolRegistry.toOpenAITools();
        const nameSet = new Set(resolved.toolNames);
        return allOpenAITools.filter((t) => t.function?.name ? nameSet.has(t.function.name) : false);
    }
    /**
     * 清除解析缓存（工具注册/注销后调用）
     */
    invalidateCache(id) {
        if (id) {
            this.resolvedCache.delete(id);
        }
        else {
            this.resolvedCache.clear();
        }
    }
}
exports.ToolsetRegistry = ToolsetRegistry;
/** 单例 */
let globalToolsetRegistry = null;
function getToolsetRegistry() {
    if (!globalToolsetRegistry) {
        globalToolsetRegistry = new ToolsetRegistry();
    }
    return globalToolsetRegistry;
}
/**
 * 重置全局实例（测试用）
 */
function resetToolsetRegistry() {
    globalToolsetRegistry = null;
}

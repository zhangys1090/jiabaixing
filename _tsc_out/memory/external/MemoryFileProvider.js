"use strict";
/**
 * 文件型外部记忆提供商
 *
 * 将记忆持久化到本地 JSON 文件。
 * 适用于轻量使用、测试和离线场景。
 * 实现 ExternalMemoryProvider 接口的参考实现。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryFileProvider = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../utils/Logger");
class MemoryFileProvider {
    name = 'memory-file';
    filePath;
    cache = new Map();
    dirty = false;
    saveTimer = null;
    constructor(filePath) {
        this.filePath =
            filePath || path_1.default.join(process.cwd(), 'data', 'memory-file-store.json');
        this.loadFromDisk();
    }
    async store(key, value) {
        try {
            this.cache.set(key, {
                key,
                value,
                timestamp: Date.now(),
            });
            this.dirty = true;
            this.debouncedSave();
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    async retrieve(query, limit = 5) {
        const lowerQuery = query.toLowerCase();
        const results = [];
        for (const entry of this.cache.values()) {
            const score = this.simpleRelevance(entry.value, lowerQuery);
            if (score > 0) {
                results.push({ value: entry.value, score });
            }
        }
        // 按相关性排序
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit).map((r) => r.value);
    }
    async delete(key) {
        if (!this.cache.has(key)) {
            return { success: false, error: `Key not found: ${key}` };
        }
        this.cache.delete(key);
        this.dirty = true;
        this.debouncedSave();
        return { success: true };
    }
    /** 清空所有记忆（管理用途） */
    clear() {
        const count = this.cache.size;
        this.cache.clear();
        this.dirty = true;
        this.debouncedSave();
        return count;
    }
    /** 获取条目数 */
    get size() {
        return this.cache.size;
    }
    /** 立即将内存数据写入磁盘（测试和管理用） */
    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.dirty) {
            this.saveToDisk();
        }
    }
    /** 释放资源（清理定时器） */
    dispose() {
        this.flush();
        this.cache.clear();
    }
    // ==================== 内部方法 ====================
    loadFromDisk() {
        try {
            if (fs_1.default.existsSync(this.filePath)) {
                const raw = fs_1.default.readFileSync(this.filePath, 'utf-8');
                const entries = JSON.parse(raw);
                if (Array.isArray(entries)) {
                    for (const entry of entries) {
                        this.cache.set(entry.key, entry);
                    }
                }
                Logger_1.Logger.info(`📂 记忆文件已加载: ${this.filePath} (${this.cache.size} 条)`, 'MemoryFileProvider');
            }
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 记忆文件加载失败: ${err.message}`, 'MemoryFileProvider');
        }
    }
    saveToDisk() {
        try {
            const dir = path_1.default.dirname(this.filePath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            const entries = Array.from(this.cache.values());
            fs_1.default.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8');
            this.dirty = false;
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 记忆文件保存失败: ${err.message}`, 'MemoryFileProvider');
        }
    }
    debouncedSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            if (this.dirty)
                this.saveToDisk();
        }, 2000);
    }
    /**
     * 简单的关键词相关性评分
     * 将查询中的每个词在记忆中匹配，返回匹配分数
     */
    simpleRelevance(text, query) {
        const words = query.split(/\s+/).filter((w) => w.length > 1);
        if (words.length === 0)
            return 0;
        const lowerText = text.toLowerCase();
        let score = 0;
        for (const word of words) {
            if (lowerText.includes(word)) {
                score += 1;
            }
        }
        return score / words.length;
    }
}
exports.MemoryFileProvider = MemoryFileProvider;

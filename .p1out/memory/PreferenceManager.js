"use strict";
/**
 * 偏好管理器
 * 从用户纠错和反馈中提取、存储偏好，实现快速生效
 * 提供偏好摘要供 system prompt 注入
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceManager = void 0;
const Logger_1 = require("../utils/Logger");
/**
 * 偏好管理器
 * 单例，管理用户偏好的快速记录与查询
 */
class PreferenceManager {
    constructor() {
        this.preferences = new Map();
        this.correctionHistory = [];
    }
    static getInstance() {
        if (!PreferenceManager.instance) {
            PreferenceManager.instance = new PreferenceManager();
        }
        return PreferenceManager.instance;
    }
    /**
     * 处理纠错：提取偏好并立即生效
     */
    applyCorrection(correctionText, category) {
        const entry = this.parseCorrection(correctionText, category);
        if (!entry)
            return null;
        if (this.preferences.size >= this.MAX_PREFERENCES && !this.preferences.has(entry.key)) {
            const oldestKey = this.preferences.keys().next().value;
            this.preferences.delete(oldestKey);
        }
        this.preferences.set(entry.key, entry);
        this.correctionHistory.push(entry);
        if (this.correctionHistory.length > 100) {
            this.correctionHistory = this.correctionHistory.slice(-100);
        }
        Logger_1.Logger.info(`⚡ 偏好已生效: ${entry.key}=${entry.value} (conf: ${entry.confidence})`, 'PreferenceManager');
        return entry;
    }
    /**
     * 批量应用纠错
     */
    applyCorrections(corrections) {
        let count = 0;
        for (const c of corrections) {
            if (this.applyCorrection(c.text, c.category))
                count++;
        }
        return count;
    }
    /**
     * 获取偏好值
     */
    getPreference(key) {
        return this.preferences.get(key);
    }
    /**
     * 按类别获取偏好
     */
    getPreferencesByCategory(category) {
        return Array.from(this.preferences.values()).filter((p) => p.category === category);
    }
    /**
     * 获取所有偏好
     */
    getAllPreferences() {
        return Array.from(this.preferences.values());
    }
    /**
     * 生成偏好摘要（用于 system prompt 注入）
     */
    getSummary() {
        const codingStyle = [];
        const namingRules = [];
        const frameworkPreferences = [];
        const workflowPreferences = [];
        for (const entry of this.preferences.values()) {
            switch (entry.category) {
                case 'coding-style':
                    codingStyle.push(`${entry.key}: ${entry.value}`);
                    break;
                case 'naming':
                    namingRules.push(`${entry.key}: ${entry.value}`);
                    break;
                case 'framework':
                    frameworkPreferences.push(`${entry.key}: ${entry.value}`);
                    break;
                case 'workflow':
                    workflowPreferences.push(`${entry.key}: ${entry.value}`);
                    break;
            }
        }
        const recentCorrections = this.correctionHistory
            .slice(-5)
            .map((e) => `${e.key}=${e.value}`);
        return {
            codingStyle,
            namingRules,
            frameworkPreferences,
            workflowPreferences,
            recentCorrections,
        };
    }
    /**
     * 偏好数量
     */
    get count() {
        return this.preferences.size;
    }
    /**
     * 重置偏好（用于测试）
     */
    reset() {
        this.preferences.clear();
        this.correctionHistory = [];
    }
    parseCorrection(text, category) {
        const lowerText = text.toLowerCase();
        const now = Date.now();
        const words = text.split(/[\s,，、]+/);
        const exactSnakeCase = words.some((w) => w === 'snake_case');
        const exactPascal = words.some((w) => /^[Pp]ascal[Cc]ase$/.test(w));
        if (lowerText.includes('snake_case') ||
            lowerText.includes('下划线') ||
            exactSnakeCase) {
            return {
                key: 'naming_convention',
                value: 'snake_case',
                source: 'correction',
                confidence: 0.9,
                category: category || 'naming',
                createdAt: now,
                updatedAt: now,
            };
        }
        if (lowerText.includes('pascalcase') ||
            (lowerText.includes('pascal') && lowerText.includes('case')) ||
            exactPascal) {
            return {
                key: 'naming_convention',
                value: 'PascalCase',
                source: 'correction',
                confidence: 0.9,
                category: category || 'naming',
                createdAt: now,
                updatedAt: now,
            };
        }
        if (lowerText.includes('camelcase') || lowerText.includes('驼峰')) {
            return {
                key: 'naming_convention',
                value: 'camelCase',
                source: 'correction',
                confidence: 0.9,
                category: category || 'naming',
                createdAt: now,
                updatedAt: now,
            };
        }
        const actionMatch = text.match(/(?:用|改成|改为|使用)\s+([\w-]+)/);
        if (actionMatch) {
            return {
                key: 'preferred_tool',
                value: actionMatch[1],
                source: 'correction',
                confidence: 0.7,
                category: category || 'tool',
                createdAt: now,
                updatedAt: now,
            };
        }
        if (lowerText.includes('单引号') ||
            (lowerText.includes('single') && lowerText.includes('quote'))) {
            return {
                key: 'quote_style',
                value: 'single',
                source: 'correction',
                confidence: 0.8,
                category: category || 'coding-style',
                createdAt: now,
                updatedAt: now,
            };
        }
        if (lowerText.includes('双引号') ||
            (lowerText.includes('double') && lowerText.includes('quote'))) {
            return {
                key: 'quote_style',
                value: 'double',
                source: 'correction',
                confidence: 0.8,
                category: category || 'coding-style',
                createdAt: now,
                updatedAt: now,
            };
        }
        if (lowerText.includes('分号') || lowerText.includes('semicolon')) {
            const hasSemicolon = lowerText.includes('要分号') || lowerText.includes('加分号');
            return {
                key: 'semicolons',
                value: hasSemicolon ? 'true' : 'false',
                source: 'correction',
                confidence: 0.7,
                category: category || 'coding-style',
                createdAt: now,
                updatedAt: now,
            };
        }
        if (/^(不是|不对|错了|不应该)/.test(lowerText)) {
            const negatedTerm = text
                .replace(/^(不是|不对|错了|不应该|不要|不用)\s*/, '')
                .trim();
            if (negatedTerm) {
                return {
                    key: 'avoid',
                    value: negatedTerm,
                    source: 'correction',
                    confidence: 0.6,
                    category: category || 'general',
                    createdAt: now,
                    updatedAt: now,
                };
            }
        }
        return null;
    }
}
exports.PreferenceManager = PreferenceManager;
PreferenceManager.instance = null;

"use strict";
/**
 * SkillUsageTracker — 记录每次 auto-generated skill 的加载和使用情况
 *
 * 功能：
 * 1. trackLoad() — skill 被加载/查看时记录
 * 2. trackUse() — skill 被实际用于任务时记录
 * 3. getStats() — 返回使用统计（谁在用、多久用一次）
 * 4. getLeastUsed() — 返回不常用的 skill，供 EvolutionEngine 参考是否优化
 *
 * 数据持久化到 data/evolution/skill-usage.json
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.skillUsageTracker = exports.SkillUsageTracker = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
const USAGE_FILE = path.resolve(process.cwd(), 'data', 'evolution', 'skill-usage.json');
const STALE_AFTER_DAYS = 30;
class SkillUsageTracker {
    constructor() {
        this.data = this.load();
    }
    load() {
        try {
            if (fs.existsSync(USAGE_FILE)) {
                return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
            }
        }
        catch {
            // 静默失败
        }
        return { skills: {}, lastScanAt: new Date().toISOString() };
    }
    save() {
        try {
            const dir = path.dirname(USAGE_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.data.lastScanAt = new Date().toISOString();
            fs.writeFileSync(USAGE_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
        }
        catch (err) {
            Logger_1.Logger.warn(`SkillUsageTracker 持久化失败: ${err.message}`, 'SkillUsageTracker');
        }
    }
    /**
     * 注册一个新 skill（由 EvolutionEngine.generateSkill 调用）
     */
    register(name, skillPath, qualityScore = 0.7) {
        if (this.data.skills[name])
            return; // 已存在
        this.data.skills[name] = {
            name,
            path: skillPath,
            createdAt: new Date().toISOString(),
            lastLoadedAt: null,
            lastUsedAt: null,
            loadCount: 0,
            useCount: 0,
            qualityScore,
            recentQualityScores: [],
        };
        this.save();
        Logger_1.Logger.info(`📋 Skill 注册到追踪器: ${name}`, 'SkillUsageTracker');
    }
    /**
     * skill 被加载/查看
     */
    trackLoad(name) {
        const record = this.data.skills[name];
        if (!record)
            return;
        record.lastLoadedAt = new Date().toISOString();
        record.loadCount++;
        this.save();
    }
    /**
     * skill 被实际用于任务
     */
    trackUse(name, qualityScore) {
        const record = this.data.skills[name];
        if (!record)
            return;
        record.lastUsedAt = new Date().toISOString();
        record.useCount++;
        if (qualityScore !== undefined) {
            // 移动平均更新 qualityScore
            record.qualityScore =
                (record.qualityScore * (record.useCount - 1) + qualityScore) /
                    record.useCount;
            // 维护最近质量评分队列（最多保留10条）
            record.recentQualityScores = record.recentQualityScores || [];
            record.recentQualityScores.push(qualityScore);
            if (record.recentQualityScores.length > 10) {
                record.recentQualityScores = record.recentQualityScores.slice(-10);
            }
        }
        this.save();
    }
    /**
     * 获取所有已注册 skill 的统计
     */
    getStats() {
        return Object.values(this.data.skills).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    /**
     * 获取不常用的 skill（30天未使用或从未使用）
     */
    getLeastUsed() {
        const now = Date.now();
        const staleThreshold = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
        return Object.values(this.data.skills).filter((s) => {
            if (s.useCount === 0)
                return true;
            if (!s.lastUsedAt)
                return true;
            return now - new Date(s.lastUsedAt).getTime() > staleThreshold;
        });
    }
    /**
     * 获取活跃的 skill（最近30天使用过的）
     */
    getActive() {
        const now = Date.now();
        const activeThreshold = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
        return Object.values(this.data.skills).filter((s) => {
            if (!s.lastUsedAt)
                return false;
            return now - new Date(s.lastUsedAt).getTime() <= activeThreshold;
        });
    }
    /**
     * 扫描目录，注册新发现的 skill 文件
     */
    scanDirectory(skillsDir) {
        if (!fs.existsSync(skillsDir))
            return 0;
        const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
        let newCount = 0;
        for (const file of files) {
            const name = file.replace(/\.md$/, '');
            if (!this.data.skills[name]) {
                this.register(name, path.join(skillsDir, file));
                newCount++;
            }
        }
        return newCount;
    }
    /**
     * 统计数据摘要
     */
    getSummary() {
        const all = Object.values(this.data.skills);
        const now = Date.now();
        const staleThreshold = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
        return {
            total: all.length,
            active: all.filter((s) => s.lastUsedAt &&
                now - new Date(s.lastUsedAt).getTime() <= staleThreshold).length,
            stale: all.filter((s) => !s.lastUsedAt ||
                now - new Date(s.lastUsedAt).getTime() > staleThreshold).length,
        };
    }
    /**
     * 获取指定 skill 的记录
     * @param name - skill 名称
     * @returns skill 使用记录，不存在则返回 undefined
     */
    getRecord(name) {
        return this.data.skills[name];
    }
    /**
     * 获取指定 skill 的最近质量评分
     * @param name - skill 名称
     * @returns 最近的质量评分数组，不存在则返回空数组
     */
    getRecentQualityScores(name) {
        const record = this.data.skills[name];
        if (!record || !record.recentQualityScores)
            return [];
        return [...record.recentQualityScores];
    }
    /**
     * 获取所有已注册的 auto-generated skill 名称
     * @returns skill 名称数组
     */
    getAutoGeneratedSkillNames() {
        return Object.keys(this.data.skills).filter((name) => name.startsWith('auto-'));
    }
    /**
     * 生成技能洞察报告 — 用于与其他 agent 共享
     */
    shareSkillInsights(agentId) {
        const allSkills = Object.values(this.data.skills);
        // 按使用次数排序，取前 10
        const topSkills = allSkills
            .filter((s) => s.useCount > 0)
            .sort((a, b) => b.useCount - a.useCount)
            .slice(0, 10)
            .map((s) => ({
            name: s.name,
            usageCount: s.useCount,
            successRate: s.qualityScore,
            avgQuality: s.qualityScore,
        }));
        // 生成建议
        const recommendations = [];
        for (const skill of topSkills.slice(0, 3)) {
            if (skill.avgQuality < 0.7) {
                recommendations.push(`建议优化 ${skill.name}（质量分 ${skill.avgQuality.toFixed(2)}）`);
            }
            else {
                recommendations.push(`${skill.name} 表现良好，可考虑推广使用`);
            }
        }
        // 添加低使用率技能的建议
        const lowUsageSkills = allSkills.filter((s) => s.useCount === 0 && s.loadCount > 0);
        if (lowUsageSkills.length > 0) {
            recommendations.push(`发现 ${lowUsageSkills.length} 个已加载但未使用的技能，建议评估是否需要`);
        }
        return {
            agentId,
            topSkills,
            recommendations,
            generatedAt: new Date().toISOString(),
        };
    }
    /**
     * 整合外部洞察报告 — 根据其他 agent 的报告调整本地技能质量分
     */
    integrateExternalInsights(report) {
        // 验证报告完整性
        if (!report.agentId ||
            !report.generatedAt ||
            !Array.isArray(report.topSkills)) {
            return 0;
        }
        let integratedCount = 0;
        for (const externalSkill of report.topSkills) {
            const localRecord = this.data.skills[externalSkill.name];
            if (!localRecord) {
                continue;
            }
            // 微调本地质量分：交叉加权平均
            // 本地质量分权重 = 外部使用次数，外部成功率权重 = 本地使用次数
            const localWeight = externalSkill.usageCount;
            const externalWeight = localRecord.useCount;
            if (localWeight + externalWeight > 0) {
                const adjustedScore = (localRecord.qualityScore * localWeight +
                    externalSkill.successRate * externalWeight) /
                    (localWeight + externalWeight);
                localRecord.qualityScore = adjustedScore;
                integratedCount++;
            }
        }
        if (integratedCount > 0) {
            this.save();
        }
        return integratedCount;
    }
}
exports.SkillUsageTracker = SkillUsageTracker;
/** 全局单例 */
exports.skillUsageTracker = new SkillUsageTracker();

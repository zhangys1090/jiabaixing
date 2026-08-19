"use strict";
/**
 * AgentFactory — Agent 工厂
 *
 * 根据场景创建对应的专业化 Agent。
 * 提供 goal → Agent 的智能选择能力。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentFactory = void 0;
const Logger_1 = require("../../utils/Logger");
const CodingAgent_1 = require("./CodingAgent");
const FileAgent_1 = require("./FileAgent");
const DesktopAgent_1 = require("./DesktopAgent");
/** 场景关键词映射 */
const SCENE_KEYWORDS = {
    coding: [
        '代码',
        '编程',
        '编译',
        '重构',
        'debug',
        'bug',
        '测试',
        '接口',
        'API',
        '函数',
        '类',
        '模块',
        'review',
        '修复',
        '生成代码',
        '分析代码',
    ],
    file: [
        '文件',
        '目录',
        '文件夹',
        '打开',
        '搜索',
        '查找',
        '读',
        '写',
        '创建',
        '删除',
        '编辑',
        '列表',
        'grep',
    ],
    desktop: [
        '桌面',
        '截图',
        '点击',
        '窗口',
        '应用',
        '程序',
        '自动化',
        '屏幕',
        '鼠标',
        '键盘',
    ],
};
class AgentFactory {
    /**
     * 根据场景创建 Agent
     * @param scene - 场景类型
     * @returns Agent 实例
     */
    static createAgent(scene) {
        const cacheKey = scene;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }
        let agent;
        switch (scene) {
            case 'coding':
                agent = new CodingAgent_1.CodingAgent();
                break;
            case 'file':
                agent = new FileAgent_1.FileAgent();
                break;
            case 'desktop':
                agent = new DesktopAgent_1.DesktopAgent();
                break;
            default:
                throw new Error(`未知 Agent 场景: ${scene}`);
        }
        this.cache.set(cacheKey, agent);
        Logger_1.Logger.info(`🏭 AgentFactory 创建: ${agent.name}`, 'AgentFactory');
        return agent;
    }
    /**
     * 创建所有 Agent 实例
     * @returns 所有 Agent 实例数组
     */
    static createAllAgents() {
        return [
            this.createAgent('coding'),
            this.createAgent('file'),
            this.createAgent('desktop'),
        ];
    }
    /**
     * 根据目标智能选择 Agent
     * @param goal - 用户目标
     * @returns 最匹配的 Agent 实例
     */
    static selectAgentByGoal(goal) {
        const lowerGoal = goal.toLowerCase();
        const scores = [];
        for (const scene of ['coding', 'file', 'desktop']) {
            const keywords = SCENE_KEYWORDS[scene];
            let matchCount = 0;
            for (const kw of keywords) {
                if (lowerGoal.includes(kw.toLowerCase())) {
                    matchCount++;
                }
            }
            if (matchCount > 0) {
                scores.push({ scene, matchCount });
            }
        }
        if (scores.length > 0) {
            scores.sort((a, b) => b.matchCount - a.matchCount);
            const best = scores[0];
            Logger_1.Logger.info(`🎯 目标匹配场景: ${best.scene} (匹配${best.matchCount}个关键词, goal: ${goal.substring(0, 50)})`, 'AgentFactory');
            return this.createAgent(best.scene);
        }
        Logger_1.Logger.info(`🎯 目标未匹配特定场景，使用默认 CodingAgent`, 'AgentFactory');
        return this.createAgent('coding');
    }
    /** 清除缓存 */
    static clearCache() {
        this.cache.clear();
    }
}
exports.AgentFactory = AgentFactory;
/** 缓存的 Agent 实例 */
AgentFactory.cache = new Map();

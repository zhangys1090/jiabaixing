/**
 * AgentFactory — Agent 工厂
 *
 * 根据场景创建对应的专业化 Agent。
 * 提供 goal → Agent 的智能选择能力。
 */

import { Logger } from '../../utils/Logger';
import { BaseAgent } from './BaseAgent';
import { CodingAgent } from './CodingAgent';
import { FileAgent } from './FileAgent';
import { DesktopAgent } from './DesktopAgent';

/** Agent 场景类型 */
export type AgentScene = 'coding' | 'file' | 'desktop';

/** 场景关键词映射 */
const SCENE_KEYWORDS: Record<AgentScene, string[]> = {
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

export class AgentFactory {
  /** 缓存的 Agent 实例 */
  private static cache: Map<string, BaseAgent> = new Map();

  /**
   * 根据场景创建 Agent
   * @param scene - 场景类型
   * @returns Agent 实例
   */
  static createAgent(scene: AgentScene): BaseAgent {
    const cacheKey = scene;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let agent: BaseAgent;
    switch (scene) {
      case 'coding':
        agent = new CodingAgent();
        break;
      case 'file':
        agent = new FileAgent();
        break;
      case 'desktop':
        agent = new DesktopAgent();
        break;
      default:
        throw new Error(`未知 Agent 场景: ${scene}`);
    }

    this.cache.set(cacheKey, agent);
    Logger.info(`🏭 AgentFactory 创建: ${agent.name}`, 'AgentFactory');
    return agent;
  }

  /**
   * 创建所有 Agent 实例
   * @returns 所有 Agent 实例数组
   */
  static createAllAgents(): BaseAgent[] {
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
  static selectAgentByGoal(goal: string): BaseAgent {
    const lowerGoal = goal.toLowerCase();

    // 按优先级匹配场景
    for (const scene of ['coding', 'file', 'desktop'] as AgentScene[]) {
      const keywords = SCENE_KEYWORDS[scene];
      if (keywords.some((kw) => lowerGoal.includes(kw.toLowerCase()))) {
        Logger.info(
          `🎯 目标匹配场景: ${scene} (goal: ${goal.substring(0, 50)})`,
          'AgentFactory'
        );
        return this.createAgent(scene);
      }
    }

    // 默认返回 CodingAgent
    Logger.info(`🎯 目标未匹配特定场景，使用默认 CodingAgent`, 'AgentFactory');
    return this.createAgent('coding');
  }

  /** 清除缓存 */
  static clearCache(): void {
    this.cache.clear();
  }
}

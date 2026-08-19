/**
 * SceneToToolsetMapper — 场景感知 → 工具集选择
 *
 * 将 ContextManager 的场景检测和 ScenarioAwareScheduler 的环境
 * 感知统一映射为工具集 ID，支持渐进式工具披露。
 *
 * 数据流:
 *   用户输入 + 环境状态
 *     → detectScene() 场景检测
 *     → mapToToolset() 场景→工具集
 *     → applyDisclosureLevel() 渐进式披露
 *     → Executor 使用过滤后的工具集
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../../utils/Logger';

/** 支持的工作场景 */
export type WorkScene =
  | 'coding'
  | 'desktop'
  | 'daily'
  | 'research'
  | 'briefing'
  | 'development'
  | 'work'
  | 'comfort'
  | 'greeting';

/** 环境状态 */
export interface EnvState {
  foregroundApp?: string;
  activeProject?: string;
  gitStatus?: 'clean' | 'modified' | 'unknown';
  idleTimeMs?: number;
}

/** 工具披露等级 */
export type DisclosureLevel = 1 | 2 | 3;
// Level 1: 基础工具（始终暴露）— 记忆/搜索/系统状态
// Level 2: 场景工具（场景匹配时）— 代码工具/桌面工具/网络工具
// Level 3: 高级工具（明确需要时）— 执行/自动化/配置

/** 场景到工具集的映射配置 */
interface SceneToolsetConfig {
  toolsetId: string;
  disclosureLevel: DisclosureLevel;
  tags: string[];
  excludeCategories?: string[];
}

const SCENE_TOOLSET_MAP: Record<string, SceneToolsetConfig> = {
  coding: {
    toolsetId: 'coding',
    disclosureLevel: 3,
    tags: ['code', 'git', 'file', 'shell', 'debug', 'test', 'review'],
    excludeCategories: ['desktop', 'daily'],
  },
  desktop: {
    toolsetId: 'desktop',
    disclosureLevel: 2,
    tags: ['desktop', 'automation', 'screenshot', 'window', 'input'],
    excludeCategories: ['code'],
  },
  development: {
    toolsetId: 'coding',
    disclosureLevel: 3,
    tags: ['code', 'git', 'file', 'shell', 'debug', 'test', 'review', 'deploy'],
    excludeCategories: ['desktop', 'daily'],
  },
  research: {
    toolsetId: 'network',
    disclosureLevel: 2,
    tags: ['search', 'web', 'fetch', 'knowledge', 'analysis'],
  },
  briefing: {
    toolsetId: 'full',
    disclosureLevel: 2,
    tags: ['summary', 'report', 'analysis', 'file', 'search'],
  },
  work: {
    toolsetId: 'full',
    disclosureLevel: 2,
    tags: ['project', 'file', 'search', 'schedule', 'report'],
  },
  daily: {
    toolsetId: 'daily',
    disclosureLevel: 1,
    tags: ['memory', 'note', 'schedule', 'search'],
  },
  comfort: {
    toolsetId: 'minimal',
    disclosureLevel: 1,
    tags: ['memory', 'chat'],
  },
  greeting: {
    toolsetId: 'minimal',
    disclosureLevel: 1,
    tags: ['chat'],
  },
};

/** 场景关键词映射 */
const SCENE_KEYWORDS: Record<string, string[]> = {
  coding: [
    '代码',
    '编程',
    '开发',
    '调试',
    'bug',
    '函数',
    '接口',
    'api',
    '重构',
    '部署',
    'git',
    'commit',
    'test',
    '测试',
    '编译',
    'build',
    'npm',
    'yarn',
    'pnpm',
    'import',
    'export',
    'class',
    '类型',
    'typescript',
    'python',
    'react',
    'node',
    '修复',
    '优化',
    '依赖',
    '包体积',
    '懒加载',
    '缓存',
    '压缩对话',
  ],
  desktop: [
    '桌面',
    '窗口',
    '截图',
    '自动化',
    '鼠标',
    '键盘',
    '点击',
    '打开应用',
    '关闭',
    '最小化',
    '最大化',
    '切换',
  ],
  research: [
    '搜索',
    '查找',
    '研究',
    '了解',
    '调查',
    '比较',
    '分析',
    '有什么',
    '推荐',
    '最新',
    '新闻',
    '资料',
  ],
  briefing: [
    '简报',
    '总结',
    '日报',
    '周报',
    '进度',
    '汇报',
    '报告',
    '生成报告',
    '写总结',
  ],
  work: [
    '工作',
    '项目',
    '排期',
    '会议',
    '汇报',
    '方案',
    '需求',
    '上线',
    '任务',
    '待办',
    'todo',
    '预算',
    'token',
    '消耗',
  ],
  comfort: [
    '难过',
    '烦',
    '累',
    '焦虑',
    '压力',
    '不开心',
    '心情',
    '崩溃',
    '安慰',
  ],
  greeting: ['你好', '早上好', '晚安', '嗨', 'hello', 'hi', 'hey'],
};

export class SceneToToolsetMapper {
  private envState: EnvState = {};
  private toolsetMap: Record<string, SceneToolsetConfig>;
  private keywords: Record<string, string[]>;

  constructor(configPath?: string) {
    // 尝试从外部 JSON 配置文件加载，回退到内置默认值
    const loaded = this._loadConfig(configPath);
    this.toolsetMap = loaded.toolsetMap;
    this.keywords = loaded.keywords;
  }

  /** 从 JSON 文件加载配置，失败时回退默认值 */
  private _loadConfig(configPath?: string): {
    toolsetMap: Record<string, SceneToolsetConfig>;
    keywords: Record<string, string[]>;
  } {
    const jsonPath =
      configPath ||
      path.join(process.cwd(), 'config', 'scene_toolset_map.json');
    try {
      if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.toolsetMap && data.keywords) {
          Logger.info(
            `从 ${jsonPath} 加载场景-工具集映射`,
            'SceneToToolsetMapper'
          );
          return { toolsetMap: data.toolsetMap, keywords: data.keywords };
        }
      }
    } catch (err) {
      Logger.warn(
        `加载场景配置失败 (${jsonPath}): ${(err as Error).message}，使用内置默认值`,
        'SceneToToolsetMapper'
      );
    }
    return { toolsetMap: SCENE_TOOLSET_MAP, keywords: SCENE_KEYWORDS };
  }

  /** 重新加载配置（热更新） */
  reloadConfig(configPath?: string): void {
    const loaded = this._loadConfig(configPath);
    this.toolsetMap = loaded.toolsetMap;
    this.keywords = loaded.keywords;
  }

  /**
   * 从用户输入检测场景
   */
  detectScene(input: string, env?: EnvState): WorkScene {
    // 更新环境状态
    if (env) this.envState = { ...this.envState, ...env };

    const text = input.toLowerCase();

    // 环境感知优先: 如果前台进程是 IDE/编辑器，优先判定为 coding
    if (this.envState.foregroundApp) {
      const app = this.envState.foregroundApp.toLowerCase();
      if (
        [
          'code',
          'vscode',
          'cursor',
          'idea',
          'intellij',
          'terminal',
          'cmd',
          'powershell',
        ].some((a) => app.includes(a))
      ) {
        Logger.debug(
          `环境感知: 前台进程 "${this.envState.foregroundApp}" → coding`,
          'SceneToToolsetMapper'
        );
        return 'coding';
      }
    }

    // 关键词加权匹配
    const scores: Record<string, number> = {};
    for (const [scene, keywords] of Object.entries(this.keywords)) {
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) {
          score += kw.length >= 4 ? 3 : 1; // 长关键词权重更高
        }
      }
      if (score > 0) scores[scene] = score;
    }

    if (Object.keys(scores).length === 0) return 'daily';

    // 返回最高分场景
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    Logger.debug(
      `场景检测: "${text.slice(0, 40)}" → ${best[0]} (score=${best[1]})`,
      'SceneToToolsetMapper'
    );
    return best[0] as WorkScene;
  }

  /**
   * 场景 → 工具集配置
   */
  mapToToolset(scene: WorkScene): SceneToolsetConfig {
    return this.toolsetMap[scene] || this.toolsetMap.daily;
  }

  /**
   * 渐进式披露：根据输入复杂度调整披露等级
   *
   * @param input 用户输入
   * @param baseConfig 场景基础配置
   * @returns 调整后的配置
   */
  applyDisclosureLevel(
    input: string,
    baseConfig: SceneToolsetConfig
  ): SceneToolsetConfig {
    const length = input.length;

    // 复杂度评估
    let complexity = 1; // 简单
    if (length > 50) complexity = 2; // 中等
    if (length > 200) complexity = 3; // 复杂

    // 检查是否包含高级操作词
    const advancedKeywords = [
      '执行',
      '运行',
      '自动化',
      '配置',
      '部署',
      '重构',
      '数据库',
      '迁移',
      '并发',
      '异步',
      '调试',
      '优化',
      'execute',
      'run',
      'deploy',
      'migrate',
    ];
    if (advancedKeywords.some((kw) => input.includes(kw))) {
      complexity = Math.max(complexity, 3);
    }

    // 根据复杂度调整披露等级
    // 简单任务: 只暴露 Level 1 基础上的少量 Level 2 工具
    // 中等任务: 暴露到 Level 2
    // 复杂任务: 暴露到 Level 3
    const adjustedLevel = Math.min(
      baseConfig.disclosureLevel,
      complexity === 1 ? 1 : complexity === 2 ? 2 : 3
    ) as DisclosureLevel;

    const result = {
      ...baseConfig,
      disclosureLevel: adjustedLevel,
    };

    Logger.debug(
      `渐进式披露: complexity=${complexity}, level ${baseConfig.disclosureLevel}→${adjustedLevel}`,
      'SceneToToolsetMapper'
    );

    return result;
  }

  /**
   * 完整映射流程: 输入 → 场景检测 → 工具集配置 → 渐进式披露
   */
  resolve(
    input: string,
    env?: EnvState
  ): {
    toolsetId: string;
    disclosureLevel: DisclosureLevel;
    tags: string[];
    excludeCategories?: string[];
    scene: WorkScene;
  } {
    const scene = this.detectScene(input, env);
    const baseConfig = this.mapToToolset(scene);
    const config = this.applyDisclosureLevel(input, baseConfig);

    return {
      ...config,
      scene,
    };
  }

  /**
   * 根据场景更新环境状态
   */
  updateEnv(env: Partial<EnvState>): void {
    this.envState = { ...this.envState, ...env };
  }

  /**
   * 获取当前环境状态
   */
  getEnv(): EnvState {
    return { ...this.envState };
  }
}

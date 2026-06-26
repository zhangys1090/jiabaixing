/**
 * 桌面技能包系统
 * 参考 Codex / UI-TARS 技能设计
 *
 * 技能包是预定义的复杂任务模板，包含：
 * - 任务匹配规则
 * - 操作步骤序列
 * - 验证点
 * - 错误恢复策略
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';

export interface DesktopSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author?: string;

  // 匹配规则
  matchRules: {
    keywords: string[];
    patterns: RegExp[];
    priority: number; // 0-100，越高优先级越高
  };

  // 技能参数定义
  parameters: {
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    required?: boolean;
    default?: unknown;
  }[];

  // 执行步骤生成器
  generateSteps: (params: Record<string, unknown>) => SkillStep[];

  // 验证函数
  verify?: (params: Record<string, unknown>) => Promise<boolean>;

  // 错误恢复
  errorRecovery?: {
    maxRetries: number;
    onError: (error: string, stepIndex: number) => SkillStep[];
  };

  // 预估时间（秒）
  estimatedTime?: number;

  // 风险等级
  riskLevel: 'low' | 'medium' | 'high';
}

export interface SkillStep {
  id: string;
  type: 'action' | 'wait' | 'verify' | 'screenshot' | 'llm_plan';
  description: string;

  // 动作类型步骤
  action?: {
    type: string;
    params: Record<string, unknown>;
  };

  // 等待类型步骤
  wait?: {
    durationMs: number;
    condition?: string; // 可选的等待条件描述
  };

  // 验证类型步骤
  verify?: {
    type: 'screenshot_match' | 'text_contains' | 'window_exists' | 'custom';
    expected: unknown;
    timeoutMs?: number;
  };

  // 截图类型步骤
  screenshot?: {
    save?: boolean;
    analyze?: boolean;
  };

  // LLM规划类型步骤（动态规划后续步骤）
  llmPlan?: {
    prompt: string;
    context?: Record<string, unknown>;
  };

  // 步骤超时
  timeoutMs?: number;

  // 失败处理
  onFailure?: 'skip' | 'retry' | 'abort' | 'fallback';
  retryCount?: number;
}

export interface SkillExecutionResult {
  success: boolean;
  skillId: string;
  skillName: string;
  stepsCompleted: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  currentStep?: number;
}

export class DesktopSkillRegistry extends EventEmitter {
  private static instance: DesktopSkillRegistry | null = null;
  private skills: Map<string, DesktopSkill> = new Map();
  private categories: Set<string> = new Set();

  private constructor() {
    super();
    this.registerBuiltinSkills();
  }

  public static getInstance(): DesktopSkillRegistry {
    if (!DesktopSkillRegistry.instance) {
      DesktopSkillRegistry.instance = new DesktopSkillRegistry();
    }
    return DesktopSkillRegistry.instance;
  }

  /**
   * 注册技能
   */
  public registerSkill(skill: DesktopSkill): void {
    if (this.skills.has(skill.id)) {
      Logger.warn(`⚠️  技能已存在，将覆盖: ${skill.id}`, 'SkillRegistry');
    }

    this.skills.set(skill.id, skill);
    this.categories.add(skill.category);

    Logger.info(
      `✅ 注册技能: ${skill.name} (${skill.id}) [${skill.category}]`,
      'SkillRegistry'
    );

    this.emit('skill_registered', skill);
  }

  /**
   * 批量注册技能
   */
  public registerSkills(skills: DesktopSkill[]): void {
    skills.forEach((skill) => this.registerSkill(skill));
  }

  /**
   * 获取技能
   */
  public getSkill(id: string): DesktopSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * 获取所有技能
   */
  public getAllSkills(): DesktopSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 按分类获取技能
   */
  public getSkillsByCategory(category: string): DesktopSkill[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.category === category
    );
  }

  /**
   * 获取所有分类
   */
  public getCategories(): string[] {
    return Array.from(this.categories);
  }

  /**
   * 根据用户输入匹配最合适的技能
   */
  public matchSkill(userInput: string): {
    skill: DesktopSkill;
    confidence: number;
    extractedParams: Record<string, string>;
  } | null {
    let bestMatch: {
      skill: DesktopSkill;
      confidence: number;
      extractedParams: Record<string, string>;
    } | null = null;

    for (const skill of this.skills.values()) {
      const result = this.calculateMatchConfidence(skill, userInput);
      if (
        result.confidence > 0 &&
        (!bestMatch || result.confidence > bestMatch.confidence)
      ) {
        bestMatch = {
          skill,
          confidence: result.confidence,
          extractedParams: result.params,
        };
      }
    }

    return bestMatch;
  }

  /**
   * 执行技能
   */
  public async executeSkill(
    skillId: string,
    params: Record<string, unknown>,
    executor: (step: SkillStep) => Promise<boolean>
  ): Promise<SkillExecutionResult> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return {
        success: false,
        skillId,
        skillName: '未知技能',
        stepsCompleted: 0,
        totalSteps: 0,
        durationMs: 0,
        error: `技能不存在: ${skillId}`,
      };
    }

    const startTime = Date.now();
    const steps = skill.generateSteps(params);
    let stepsCompleted = 0;

    Logger.info(
      `🎯 执行技能: ${skill.name}，共 ${steps.length} 步`,
      'SkillRegistry'
    );

    this.emit('skill_start', {
      skillId,
      skillName: skill.name,
      stepsCount: steps.length,
    });

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        Logger.debug(
          `   步骤 ${i + 1}/${steps.length}: ${step.description}`,
          'SkillRegistry'
        );

        this.emit('step_start', { stepIndex: i, step });

        const success = await executor(step);

        if (!success) {
          if (step.onFailure === 'skip') {
            Logger.warn(
              `   ⏭️  步骤失败，跳过: ${step.description}`,
              'SkillRegistry'
            );
            continue;
          } else if (step.onFailure === 'retry' && step.retryCount) {
            let retrySuccess = false;
            for (let r = 0; r < step.retryCount; r++) {
              Logger.warn(
                `   🔄 重试 ${r + 1}/${step.retryCount}: ${step.description}`,
                'SkillRegistry'
              );
              retrySuccess = await executor(step);
              if (retrySuccess) break;
            }
            if (!retrySuccess) {
              throw new Error(
                `步骤失败（重试${step.retryCount}次后）: ${step.description}`
              );
            }
          } else if (step.onFailure === 'abort') {
            throw new Error(`步骤失败，终止任务: ${step.description}`);
          }
        }

        stepsCompleted++;
        this.emit('step_complete', { stepIndex: i, step, success });
      }

      const duration = Date.now() - startTime;
      Logger.info(
        `✅ 技能执行完成: ${skill.name}，耗时 ${duration}ms`,
        'SkillRegistry'
      );

      this.emit('skill_complete', { skillId, success: true });

      return {
        success: true,
        skillId,
        skillName: skill.name,
        stepsCompleted,
        totalSteps: steps.length,
        durationMs: duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = (error as Error).message;

      Logger.error(
        `❌ 技能执行失败: ${skill.name} - ${errorMsg}`,
        error as Error,
        'SkillRegistry'
      );

      this.emit('skill_error', { skillId, error: errorMsg });

      return {
        success: false,
        skillId,
        skillName: skill.name,
        stepsCompleted,
        totalSteps: steps.length,
        durationMs: duration,
        error: errorMsg,
        currentStep: stepsCompleted,
      };
    }
  }

  /**
   * 删除技能
   */
  public unregisterSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;

    this.skills.delete(id);
    Logger.info(`🗑️  卸载技能: ${skill.name} (${id})`, 'SkillRegistry');
    this.emit('skill_unregistered', { id, skill });
    return true;
  }

  /**
   * 计算匹配置信度
   */
  private calculateMatchConfidence(
    skill: DesktopSkill,
    userInput: string
  ): { confidence: number; params: Record<string, string> } {
    let confidence = 0;
    const params: Record<string, string> = {};
    const inputLower = userInput.toLowerCase();

    // 关键词匹配
    let keywordMatches = 0;
    for (const keyword of skill.matchRules.keywords) {
      if (inputLower.includes(keyword.toLowerCase())) {
        keywordMatches++;
      }
    }

    if (keywordMatches > 0) {
      confidence +=
        (keywordMatches / skill.matchRules.keywords.length) *
        50 *
        (skill.matchRules.priority / 100);
    }

    // 正则模式匹配
    for (const pattern of skill.matchRules.patterns) {
      const match = userInput.match(pattern);
      if (match) {
        confidence += 30 * (skill.matchRules.priority / 100);
        // 提取命名分组作为参数
        if (match.groups) {
          Object.assign(params, match.groups);
        }
      }
    }

    // 基础分
    if (confidence > 0) {
      confidence += 20;
    }

    return { confidence: Math.min(confidence, 100), params };
  }

  /**
   * 注册内置技能
   */
  private registerBuiltinSkills(): void {
    // 浏览器技能
    this.registerSkill({
      id: 'browser.search',
      name: '浏览器搜索',
      description: '打开浏览器并搜索指定内容',
      category: '浏览器',
      version: '1.0.0',
      matchRules: {
        keywords: ['搜索', '百度', '谷歌', '浏览器', '查找'],
        patterns: [
          /搜索(?<query>.*)/,
          /百度(?<query>.*)/,
          /用浏览器搜索(?<query>.*)/,
        ],
        priority: 80,
      },
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: '搜索关键词',
          required: true,
        },
        {
          name: 'engine',
          type: 'string',
          description: '搜索引擎',
          default: 'baidu',
        },
      ],
      generateSteps: (params) => [
        {
          id: 'open_browser',
          type: 'action',
          description: '打开浏览器',
          action: { type: 'openApp', params: { app: 'chrome' } },
          onFailure: 'abort',
        },
        {
          id: 'wait_browser',
          type: 'wait',
          description: '等待浏览器启动',
          wait: { durationMs: 2000 },
        },
        {
          id: 'click_address_bar',
          type: 'action',
          description: '点击地址栏',
          action: {
            type: 'click',
            params: { x: 200, y: 50 },
          },
        },
        {
          id: 'type_search_url',
          type: 'action',
          description: '输入搜索URL',
          action: {
            type: 'type',
            params: { text: `https://www.baidu.com/s?wd=${params.query}` },
          },
        },
        {
          id: 'press_enter',
          type: 'action',
          description: '按回车搜索',
          action: { type: 'key', params: { key: 'enter' } },
        },
        {
          id: 'wait_results',
          type: 'wait',
          description: '等待搜索结果',
          wait: { durationMs: 2000 },
        },
        {
          id: 'verify_results',
          type: 'screenshot',
          description: '截图验证结果',
          screenshot: { save: true, analyze: true },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 10,
    });

    // 记事本技能
    this.registerSkill({
      id: 'notepad.write',
      name: '记事本写内容',
      description: '打开记事本并输入指定内容',
      category: '办公',
      version: '1.0.0',
      matchRules: {
        keywords: ['记事本', '写下来', '记录', '笔记'],
        patterns: [/打开记事本.*输入(?<text>.*)/, /用记事本记录(?<text>.*)/],
        priority: 70,
      },
      parameters: [
        {
          name: 'text',
          type: 'string',
          description: '要输入的文本',
          required: true,
        },
      ],
      generateSteps: (params) => [
        {
          id: 'open_notepad',
          type: 'action',
          description: '打开记事本',
          action: { type: 'openApp', params: { app: 'notepad' } },
          onFailure: 'abort',
        },
        {
          id: 'wait_notepad',
          type: 'wait',
          description: '等待记事本启动',
          wait: { durationMs: 1500 },
        },
        {
          id: 'type_text',
          type: 'action',
          description: '输入文本内容',
          action: { type: 'type', params: { text: params.text as string } },
        },
        {
          id: 'save_file',
          type: 'action',
          description: '保存文件',
          action: { type: 'key_combo', params: { keys: ['ctrl', 's'] } },
        },
        {
          id: 'wait_save_dialog',
          type: 'wait',
          description: '等待保存对话框',
          wait: { durationMs: 1000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 8,
    });

    // 截图技能
    this.registerSkill({
      id: 'screenshot.full',
      name: '全屏截图',
      description: '截取当前全屏并保存',
      category: '工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['截图', '截屏', '屏幕快照'],
        patterns: [/截图/, /截屏/],
        priority: 90,
      },
      parameters: [
        {
          name: 'save',
          type: 'boolean',
          description: '是否保存',
          default: true,
        },
      ],
      generateSteps: () => [
        {
          id: 'take_screenshot',
          type: 'screenshot',
          description: '截取全屏',
          screenshot: { save: true, analyze: false },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 1,
    });

    // 窗口管理技能
    this.registerSkill({
      id: 'window.maximize',
      name: '最大化窗口',
      description: '最大化当前或指定窗口',
      category: '窗口管理',
      version: '1.0.0',
      matchRules: {
        keywords: ['最大化', '全屏', '窗口放大'],
        patterns: [/最大化(?<title>.*)窗口/, /把(?<title>.*)最大化/],
        priority: 75,
      },
      parameters: [
        {
          name: 'title',
          type: 'string',
          description: '窗口标题',
          required: false,
        },
      ],
      generateSteps: (params) => [
        {
          id: 'activate_window',
          type: 'action',
          description: '激活目标窗口',
          action: {
            type: 'activateWindow',
            params: { title: params.title || '' },
          },
          onFailure: 'skip',
        },
        {
          id: 'maximize',
          type: 'action',
          description: '最大化窗口',
          action: {
            type: 'key_combo',
            params: { keys: ['win', 'up'] },
          },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 2,
    });

    // ========== 新增技能包 ==========

    // 最小化窗口
    this.registerSkill({
      id: 'window.minimize',
      name: '最小化窗口',
      description: '最小化当前或指定窗口',
      category: '窗口管理',
      version: '1.0.0',
      matchRules: {
        keywords: ['最小化', '最小化窗口', '收起窗口'],
        patterns: [/最小化(?<title>.*)窗口/, /把(?<title>.*)最小化/],
        priority: 75,
      },
      parameters: [
        {
          name: 'title',
          type: 'string',
          description: '窗口标题',
          required: false,
        },
      ],
      generateSteps: (params) => [
        {
          id: 'activate_window',
          type: 'action',
          description: '激活目标窗口',
          action: {
            type: 'activateWindow',
            params: { title: params.title || '' },
          },
          onFailure: 'skip',
        },
        {
          id: 'minimize',
          type: 'action',
          description: '最小化窗口',
          action: {
            type: 'key_combo',
            params: { keys: ['win', 'down'] },
          },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 2,
    });

    // 关闭窗口
    this.registerSkill({
      id: 'window.close',
      name: '关闭窗口',
      description: '关闭当前或指定窗口',
      category: '窗口管理',
      version: '1.0.0',
      matchRules: {
        keywords: ['关闭窗口', '关掉窗口', '关闭'],
        patterns: [/关闭(?<title>.*)窗口/, /关掉(?<title>.*)/],
        priority: 70,
      },
      parameters: [
        {
          name: 'title',
          type: 'string',
          description: '窗口标题',
          required: false,
        },
      ],
      generateSteps: (params) => [
        {
          id: 'activate_window',
          type: 'action',
          description: '激活目标窗口',
          action: {
            type: 'activateWindow',
            params: { title: params.title || '' },
          },
          onFailure: 'skip',
        },
        {
          id: 'close',
          type: 'action',
          description: '关闭窗口',
          action: {
            type: 'key_combo',
            params: { keys: ['alt', 'f4'] },
          },
        },
      ],
      riskLevel: 'medium',
      estimatedTime: 2,
    });

    // 打开文件资源管理器
    this.registerSkill({
      id: 'system.open_explorer',
      name: '打开文件资源管理器',
      description: '打开Windows文件资源管理器',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: [
          '文件管理器',
          '资源管理器',
          '我的电脑',
          '此电脑',
          '打开文件夹',
        ],
        patterns: [/打开文件管理器/, /打开资源管理器/, /打开我的电脑/],
        priority: 80,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_explorer',
          type: 'action',
          description: '打开文件资源管理器',
          action: {
            type: 'key_combo',
            params: { keys: ['win', 'e'] },
          },
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待资源管理器启动',
          wait: { durationMs: 1500 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 2,
    });

    // 打开计算器
    this.registerSkill({
      id: 'system.calculator',
      name: '打开计算器',
      description: '打开Windows计算器',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['计算器', '计算一下', '算一下'],
        patterns: [/打开计算器/, /用计算器/],
        priority: 80,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_calc',
          type: 'action',
          description: '打开计算器',
          action: { type: 'openApp', params: { app: 'calc' } },
          onFailure: 'abort',
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待计算器启动',
          wait: { durationMs: 1500 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 2,
    });

    // 打开任务管理器
    this.registerSkill({
      id: 'system.task_manager',
      name: '打开任务管理器',
      description: '打开Windows任务管理器',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['任务管理器', '进程管理', '看进程'],
        patterns: [/打开任务管理器/, /任务管理器/],
        priority: 80,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_taskmgr',
          type: 'action',
          description: '打开任务管理器',
          action: {
            type: 'key_combo',
            params: { keys: ['ctrl', 'shift', 'escape'] },
          },
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待任务管理器启动',
          wait: { durationMs: 1500 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 2,
    });

    // 打开画图
    this.registerSkill({
      id: 'system.paint',
      name: '打开画图',
      description: '打开Windows画图工具',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['画图', '画笔', '打开画图'],
        patterns: [/打开画图/, /用画图画/],
        priority: 70,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_paint',
          type: 'action',
          description: '打开画图',
          action: { type: 'openApp', params: { app: 'mspaint' } },
          onFailure: 'abort',
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待画图启动',
          wait: { durationMs: 2000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 3,
    });

    // 打开设置
    this.registerSkill({
      id: 'system.settings',
      name: '打开系统设置',
      description: '打开Windows系统设置',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['设置', '系统设置', '打开设置'],
        patterns: [/打开设置/, /系统设置/],
        priority: 75,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_settings',
          type: 'action',
          description: '打开系统设置',
          action: {
            type: 'key_combo',
            params: { keys: ['win', 'i'] },
          },
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待设置启动',
          wait: { durationMs: 2000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 3,
    });

    // 浏览器打开指定网页
    this.registerSkill({
      id: 'browser.open_url',
      name: '打开网页',
      description: '在浏览器中打开指定网址',
      category: '浏览器',
      version: '1.0.0',
      matchRules: {
        keywords: ['打开网页', '访问', '网址', '网站'],
        patterns: [/打开(?<url>https?:\/\/\S+)/, /访问(?<url>https?:\/\/\S+)/],
        priority: 75,
      },
      parameters: [
        {
          name: 'url',
          type: 'string',
          description: '要打开的网址',
          required: true,
        },
      ],
      generateSteps: (params) => [
        {
          id: 'open_browser',
          type: 'action',
          description: '打开浏览器',
          action: {
            type: 'openApp',
            params: { app: 'chrome', args: [params.url as string] },
          },
          onFailure: 'abort',
        },
        {
          id: 'wait_load',
          type: 'wait',
          description: '等待页面加载',
          wait: { durationMs: 3000 },
        },
        {
          id: 'verify',
          type: 'screenshot',
          description: '截图验证',
          screenshot: { save: true, analyze: false },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 5,
    });

    // 浏览器刷新
    this.registerSkill({
      id: 'browser.refresh',
      name: '刷新页面',
      description: '刷新当前浏览器页面',
      category: '浏览器',
      version: '1.0.0',
      matchRules: {
        keywords: ['刷新', '刷新页面', '重新加载'],
        patterns: [/刷新/, /重新加载/],
        priority: 70,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'refresh',
          type: 'action',
          description: '刷新页面',
          action: { type: 'key', params: { key: 'f5' } },
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待刷新完成',
          wait: { durationMs: 2000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 3,
    });

    // 打开VS Code
    this.registerSkill({
      id: 'app.vscode',
      name: '打开VS Code',
      description: '打开Visual Studio Code',
      category: '常用应用',
      version: '1.0.0',
      matchRules: {
        keywords: ['vscode', 'vs code', '打开代码编辑器', '打开vscode'],
        patterns: [/打开vscode/i, /打开vs code/i, /用vscode/],
        priority: 75,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_vscode',
          type: 'action',
          description: '打开VS Code',
          action: { type: 'openApp', params: { app: 'code' } },
          onFailure: 'abort',
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待VS Code启动',
          wait: { durationMs: 3000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 4,
    });

    // 打开微信
    this.registerSkill({
      id: 'app.wechat',
      name: '打开微信',
      description: '打开微信客户端',
      category: '常用应用',
      version: '1.0.0',
      matchRules: {
        keywords: ['微信', '打开微信', 'wechat'],
        patterns: [/打开微信/, /微信/],
        priority: 80,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_wechat',
          type: 'action',
          description: '打开微信',
          action: { type: 'openApp', params: { app: 'wechat' } },
          onFailure: 'abort',
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待微信启动',
          wait: { durationMs: 3000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 4,
    });

    // 打开钉钉
    this.registerSkill({
      id: 'app.dingtalk',
      name: '打开钉钉',
      description: '打开钉钉客户端',
      category: '常用应用',
      version: '1.0.0',
      matchRules: {
        keywords: ['钉钉', '打开钉钉', 'dingtalk'],
        patterns: [/打开钉钉/, /钉钉/],
        priority: 80,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_dingtalk',
          type: 'action',
          description: '打开钉钉',
          action: { type: 'openApp', params: { app: 'dingtalk' } },
          onFailure: 'abort',
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待钉钉启动',
          wait: { durationMs: 3000 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 4,
    });

    // 复制粘贴文本
    this.registerSkill({
      id: 'edit.copy_paste',
      name: '复制粘贴',
      description: '复制当前选中内容并粘贴',
      category: '编辑操作',
      version: '1.0.0',
      matchRules: {
        keywords: ['复制粘贴', '复制一下', '粘贴'],
        patterns: [/复制粘贴/, /复制一下/],
        priority: 70,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'copy',
          type: 'action',
          description: '复制选中内容',
          action: { type: 'key_combo', params: { keys: ['ctrl', 'c'] } },
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待复制完成',
          wait: { durationMs: 300 },
        },
        {
          id: 'paste',
          type: 'action',
          description: '粘贴内容',
          action: { type: 'key_combo', params: { keys: ['ctrl', 'v'] } },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 1,
    });

    // 全选
    this.registerSkill({
      id: 'edit.select_all',
      name: '全选',
      description: '全选当前内容',
      category: '编辑操作',
      version: '1.0.0',
      matchRules: {
        keywords: ['全选', '全部选中', '选中全部'],
        patterns: [/全选/, /全部选中/],
        priority: 75,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'select_all',
          type: 'action',
          description: '全选',
          action: { type: 'key_combo', params: { keys: ['ctrl', 'a'] } },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 1,
    });

    // 撤销
    this.registerSkill({
      id: 'edit.undo',
      name: '撤销',
      description: '撤销上一步操作',
      category: '编辑操作',
      version: '1.0.0',
      matchRules: {
        keywords: ['撤销', '撤回', 'undo'],
        patterns: [/撤销/, /撤回/],
        priority: 75,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'undo',
          type: 'action',
          description: '撤销',
          action: { type: 'key_combo', params: { keys: ['ctrl', 'z'] } },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 1,
    });

    // 显示桌面
    this.registerSkill({
      id: 'system.show_desktop',
      name: '显示桌面',
      description: '最小化所有窗口，显示桌面',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['显示桌面', '回到桌面', '最小化所有窗口', '看桌面'],
        patterns: [/显示桌面/, /回到桌面/],
        priority: 80,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'show_desktop',
          type: 'action',
          description: '显示桌面',
          action: {
            type: 'key_combo',
            params: { keys: ['win', 'd'] },
          },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 1,
    });

    // 运行对话框
    this.registerSkill({
      id: 'system.run',
      name: '打开运行',
      description: '打开运行对话框',
      category: '系统工具',
      version: '1.0.0',
      matchRules: {
        keywords: ['运行', '打开运行', 'run'],
        patterns: [/打开运行/, /运行对话框/],
        priority: 70,
      },
      parameters: [],
      generateSteps: () => [
        {
          id: 'open_run',
          type: 'action',
          description: '打开运行对话框',
          action: {
            type: 'key_combo',
            params: { keys: ['win', 'r'] },
          },
        },
        {
          id: 'wait',
          type: 'wait',
          description: '等待运行对话框',
          wait: { durationMs: 500 },
        },
      ],
      riskLevel: 'low',
      estimatedTime: 1,
    });

    Logger.info(
      `📦 内置技能注册完成，共 ${this.skills.size} 个技能`,
      'SkillRegistry'
    );
  }
}

// 便捷导出
export const skillRegistry = DesktopSkillRegistry.getInstance();

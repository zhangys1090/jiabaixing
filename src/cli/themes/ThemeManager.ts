/**
 * CLI 皮肤与主题管理器
 *
 * 支持自定义横幅颜色、加载动画、响应框标签、品牌文字等
 * 设计参考: Hermes Agent 皮肤与主题系统
 */

import { Logger } from '../../utils/Logger';

/** 主题定义 */
export interface Theme {
  /** 主题名称 */
  name: string;
  /** 主题显示名称 */
  displayName: string;
  /** 横幅颜色（ANSI 颜色码） */
  bannerColor: string;
  /** 加载动画图标 */
  loadingIcon: string;
  /** 加载动词 */
  loadingVerb: string;
  /** 响应框标签 */
  responseLabel: string;
  /** 品牌文字 */
  brandText: string;
  /** 工具活动前缀 */
  toolPrefix: string;
  /** 错误颜色 */
  errorColor: string;
  /** 成功颜色 */
  successColor: string;
  /** 警告颜色 */
  warningColor: string;
}

/** 预定义主题 */
const DEFAULT_THEME: Theme = {
  name: 'default',
  displayName: '默认主题',
  bannerColor: '\x1b[36m', // cyan
  loadingIcon: '⏳',
  loadingVerb: '思考中',
  responseLabel: '家百星',
  brandText: '家百星 V5.0',
  toolPrefix: '🔧',
  errorColor: '\x1b[31m', // red
  successColor: '\x1b[32m', // green
  warningColor: '\x1b[33m', // yellow
};

const DARK_THEME: Theme = {
  name: 'dark',
  displayName: '暗黑主题',
  bannerColor: '\x1b[35m', // magenta
  loadingIcon: '🌑',
  loadingVerb: '处理中',
  responseLabel: 'Agent',
  brandText: 'Jiabaixing V5',
  toolPrefix: '⚡',
  errorColor: '\x1b[91m', // bright red
  successColor: '\x1b[92m', // bright green
  warningColor: '\x1b[93m', // bright yellow
};

const MINIMAL_THEME: Theme = {
  name: 'minimal',
  displayName: '极简主题',
  bannerColor: '\x1b[37m', // white
  loadingIcon: '…',
  loadingVerb: 'loading',
  responseLabel: '',
  brandText: '',
  toolPrefix: '>',
  errorColor: '\x1b[31m',
  successColor: '\x1b[32m',
  warningColor: '\x1b[33m',
};

const COLORFUL_THEME: Theme = {
  name: 'colorful',
  displayName: '缤纷主题',
  bannerColor: '\x1b[95m', // bright magenta
  loadingIcon: '🎨',
  loadingVerb: '创作中',
  responseLabel: '✨ 星助手',
  brandText: '家百星 ✨',
  toolPrefix: '🎯',
  errorColor: '\x1b[91m',
  successColor: '\x1b[92m',
  warningColor: '\x1b[93m',
};

const PREDEFINED_THEMES: Theme[] = [
  DEFAULT_THEME,
  DARK_THEME,
  MINIMAL_THEME,
  COLORFUL_THEME,
];

export class ThemeManager {
  private themes: Map<string, Theme> = new Map();
  private activeThemeName: string;

  constructor() {
    // 注册预定义主题
    for (const theme of PREDEFINED_THEMES) {
      this.themes.set(theme.name, theme);
    }
    this.activeThemeName = 'default';
  }

  /**
   * 获取指定主题
   * @param name - 主题名称
   * @returns 主题对象，不存在则返回 undefined
   */
  getTheme(name: string): Theme | undefined {
    return this.themes.get(name);
  }

  /**
   * 获取当前激活主题
   * @returns 当前激活的主题对象
   */
  getActiveTheme(): Theme {
    return this.themes.get(this.activeThemeName) ?? DEFAULT_THEME;
  }

  /**
   * 设置当前激活主题
   * @param name - 主题名称
   * @returns 是否切换成功
   */
  setActiveTheme(name: string): boolean {
    if (!this.themes.has(name)) {
      Logger.warn(`主题 ${name} 不存在`, 'ThemeManager');
      return false;
    }
    this.activeThemeName = name;
    Logger.info(`主题已切换为: ${name}`, 'ThemeManager');
    return true;
  }

  /**
   * 注册自定义主题
   * @param name - 主题名称
   * @param partial - 部分主题属性，未指定的属性继承默认值
   */
  setTheme(name: string, partial: Partial<Theme>): void {
    const base = this.themes.get(name) ?? { ...DEFAULT_THEME };
    const custom: Theme = { ...base, ...partial, name };
    this.themes.set(name, custom);
    Logger.info(`自定义主题已注册: ${name}`, 'ThemeManager');
  }

  /**
   * 列出所有可用主题
   * @returns 主题名称与显示名称列表
   */
  listThemes(): Array<{ name: string; displayName: string }> {
    return Array.from(this.themes.values()).map((t) => ({
      name: t.name,
      displayName: t.displayName,
    }));
  }

  /**
   * 格式化横幅文字
   * @returns 带颜色的品牌文字
   */
  formatBanner(): string {
    const theme = this.getActiveTheme();
    const reset = '\x1b[0m';
    return `${theme.bannerColor}${theme.brandText}${reset}`;
  }

  /**
   * 格式化加载文字
   * @returns 加载图标与动词组合
   */
  formatLoading(): string {
    const theme = this.getActiveTheme();
    return `${theme.loadingIcon} ${theme.loadingVerb}...`;
  }

  /**
   * 格式化响应标签
   * @returns 方括号包裹的响应标签，空标签返回空字符串
   */
  formatResponseLabel(): string {
    const theme = this.getActiveTheme();
    return theme.responseLabel ? `[${theme.responseLabel}]` : '';
  }

  /**
   * 格式化工具活动
   * @param toolName - 工具名称
   * @returns 带前缀的工具活动文字
   */
  formatToolActivity(toolName: string): string {
    const theme = this.getActiveTheme();
    return `${theme.toolPrefix} ${toolName}`;
  }
}

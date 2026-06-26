/**
 * i18n 国际化管理器
 *
 * 轻量级国际化方案：
 * - 消息模板支持变量插值 {{var}}
 * - 语言包热加载
 * - fallback 到默认语言
 * - 集成到系统主循环
 */

import { Logger } from '../utils/Logger';

export type Locale = string;

export interface MessageTemplate {
  key: string;
  message: string;
  description?: string;
}

export interface LanguagePack {
  locale: Locale;
  name: string;
  messages: Record<string, string>;
}

const DEFAULT_LOCALE: Locale = 'zh-CN';

const BUILT_IN_ZH_CN: LanguagePack = {
  locale: 'zh-CN',
  name: '简体中文',
  messages: {
    'system.starting': '系统启动中...',
    'system.ready': '系统已就绪',
    'system.shutdown': '系统关闭中...',
    'system.error': '系统错误: {{error}}',
    'session.created': '会话已创建: {{sessionId}}',
    'session.ended': '会话已结束: {{sessionId}}',
    'session.not_found': '会话未找到: {{sessionId}}',
    'tool.executing': '正在执行工具: {{toolName}}',
    'tool.completed': '工具执行完成: {{toolName}} (耗时 {{duration}}ms)',
    'tool.failed': '工具执行失败: {{toolName}} - {{error}}',
    'cron.registered': '定时任务已注册: {{jobName}}',
    'cron.unregistered': '定时任务已移除: {{jobName}}',
    'cron.blocked': '定时任务被安全扫描拦截: {{jobName}}',
    'skill.registered': '技能已注册: {{skillName}}',
    'skill.executed': '技能已执行: {{skillName}}',
    'skill.not_found': '技能未找到: {{skillName}}',
    'security.url_blocked': 'URL 被安全策略拦截: {{url}}',
    'security.ssl_warning': 'SSL 证书警告: {{host}}',
    'security.sensitive_detected': '检测到敏感信息，已脱敏处理',
    'lsp.connected': 'LSP 服务器已连接: {{language}}',
    'lsp.disconnected': 'LSP 服务器已断开: {{language}}',
    'lsp.diagnostics': '收到 {{count}} 条诊断信息 ({{language}})',
    'harness.initialized': 'Agent Harness 已初始化',
    'harness.shutdown': 'Agent Harness 已关闭',
    'message.filtered': '消息被过滤: {{reason}}',
    'message.rate_limited': '消息被限流',
    'message.expired': '消息已过期',
    'error.generic': '操作失败: {{error}}',
    'error.timeout': '操作超时 ({{timeout}}ms)',
    'error.not_implemented': '功能未实现: {{feature}}',
  },
};

const BUILT_IN_EN: LanguagePack = {
  locale: 'en',
  name: 'English',
  messages: {
    'system.starting': 'System starting...',
    'system.ready': 'System ready',
    'system.shutdown': 'System shutting down...',
    'system.error': 'System error: {{error}}',
    'session.created': 'Session created: {{sessionId}}',
    'session.ended': 'Session ended: {{sessionId}}',
    'session.not_found': 'Session not found: {{sessionId}}',
    'tool.executing': 'Executing tool: {{toolName}}',
    'tool.completed': 'Tool completed: {{toolName}} ({{duration}}ms)',
    'tool.failed': 'Tool failed: {{toolName}} - {{error}}',
    'cron.registered': 'Cron job registered: {{jobName}}',
    'cron.unregistered': 'Cron job removed: {{jobName}}',
    'cron.blocked': 'Cron job blocked by security: {{jobName}}',
    'skill.registered': 'Skill registered: {{skillName}}',
    'skill.executed': 'Skill executed: {{skillName}}',
    'skill.not_found': 'Skill not found: {{skillName}}',
    'security.url_blocked': 'URL blocked by security: {{url}}',
    'security.ssl_warning': 'SSL certificate warning: {{host}}',
    'security.sensitive_detected':
      'Sensitive information detected and redacted',
    'lsp.connected': 'LSP server connected: {{language}}',
    'lsp.disconnected': 'LSP server disconnected: {{language}}',
    'lsp.diagnostics': 'Received {{count}} diagnostics ({{language}})',
    'harness.initialized': 'Agent Harness initialized',
    'harness.shutdown': 'Agent Harness shutdown',
    'message.filtered': 'Message filtered: {{reason}}',
    'message.rate_limited': 'Message rate limited',
    'message.expired': 'Message expired',
    'error.generic': 'Operation failed: {{error}}',
    'error.timeout': 'Operation timed out ({{timeout}}ms)',
    'error.not_implemented': 'Not implemented: {{feature}}',
  },
};

export class I18nManager {
  private static instance: I18nManager | null = null;

  private currentLocale: Locale = DEFAULT_LOCALE;
  private packs: Map<Locale, LanguagePack> = new Map();
  private fallbackLocale: Locale = DEFAULT_LOCALE;

  private constructor() {
    this.registerPack(BUILT_IN_ZH_CN);
    this.registerPack(BUILT_IN_EN);
  }

  static getInstance(): I18nManager {
    if (!I18nManager.instance) {
      I18nManager.instance = new I18nManager();
    }
    return I18nManager.instance;
  }

  static resetInstance(): void {
    I18nManager.instance = null;
  }

  registerPack(pack: LanguagePack): void {
    this.packs.set(pack.locale, pack);
    Logger.debug(
      `i18n 语言包已注册: ${pack.locale} (${pack.name}, ${Object.keys(pack.messages).length} 条消息)`,
      'I18nManager'
    );
  }

  setLocale(locale: Locale): void {
    if (!this.packs.has(locale)) {
      Logger.warn(
        `i18n 语言包不存在: ${locale}, 回退到 ${this.fallbackLocale}`,
        'I18nManager'
      );
      return;
    }
    this.currentLocale = locale;
  }

  getLocale(): Locale {
    return this.currentLocale;
  }

  getAvailableLocales(): Array<{
    locale: Locale;
    name: string;
    messageCount: number;
  }> {
    return Array.from(this.packs.entries()).map(([locale, pack]) => ({
      locale,
      name: pack.name,
      messageCount: Object.keys(pack.messages).length,
    }));
  }

  t(key: string, params?: Record<string, string | number>): string {
    const message = this.resolveMessage(key);
    if (!params) return message;
    return this.interpolate(message, params);
  }

  has(key: string, locale?: Locale): boolean {
    const loc = locale ?? this.currentLocale;
    const pack = this.packs.get(loc);
    if (pack && pack.messages[key]) return true;
    if (loc !== this.fallbackLocale) {
      const fallback = this.packs.get(this.fallbackLocale);
      return !!fallback?.messages[key];
    }
    return false;
  }

  getStats(): {
    currentLocale: Locale;
    availableLocales: number;
    totalKeys: number;
    registeredPacks: string[];
  } {
    const allKeys = new Set<string>();
    for (const pack of this.packs.values()) {
      for (const key of Object.keys(pack.messages)) {
        allKeys.add(key);
      }
    }
    return {
      currentLocale: this.currentLocale,
      availableLocales: this.packs.size,
      totalKeys: allKeys.size,
      registeredPacks: Array.from(this.packs.keys()),
    };
  }

  private resolveMessage(key: string): string {
    const currentPack = this.packs.get(this.currentLocale);
    if (currentPack?.messages[key]) {
      return currentPack.messages[key];
    }

    if (this.currentLocale !== this.fallbackLocale) {
      const fallbackPack = this.packs.get(this.fallbackLocale);
      if (fallbackPack?.messages[key]) {
        return fallbackPack.messages[key];
      }
    }

    return key;
  }

  private interpolate(
    template: string,
    params: Record<string, string | number>
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      if (varName in params) {
        return String(params[varName]);
      }
      return match;
    });
  }
}

export function t(
  key: string,
  params?: Record<string, string | number>
): string {
  return I18nManager.getInstance().t(key, params);
}

/**
 * Provider 配置系统
 * 
 * 管理 LLM Provider 的注册、存储、切换
 * 取代原有的 .env 环境变量方式
 * 
 * 配置文件: data/providers.json
 * 支持多 provider 并行注册，每个 provider 可选为主模型或备用
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';

export interface ProviderConfig {
  /** 唯一标识符，如 'xiaomi', 'deepseek', 'zhipu' */
  name: string;
  /** 显示名称，如 '小米 MiMo', 'DeepSeek V4' */
  displayName: string;
  /** OpenAI 兼容的基础 URL */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 模型名称 */
  model: string;
  /** 是否启用 */
  enabled: boolean;
  /** 优先级（数字越小优先级越高，0=主模型）*/
  priority: number;
  /** 额外参数 */
  extra?: Record<string, unknown>;
  /** 最近一次健康检查时间戳 */
  lastHealthCheck?: number;
  /** 最近一次健康检查是否通过 */
  healthy?: boolean;
}

export interface ProviderConfigStore {
  providers: ProviderConfig[];
  /** 当前主模型 provider name */
  primary: string | null;
  /** 是否启用 routing（根据任务复杂度自动切换模型） */
  routingEnabled: boolean;
  /** 路由规则 */
  routing: {
    /** 简单任务使用的 provider 列表（按优先级） */
    simpleTaskProviders: string[];
    /** 复杂任务使用的 provider 列表（按优先级） */
    complexTaskProviders: string[];
    /** 简单任务的判定阈值（基于输入长度和关键词） */
    simpleTaskMaxLength: number;
  };
}

const DEFAULT_CONFIG: ProviderConfigStore = {
  providers: [],
  primary: null,
  routingEnabled: false,
  routing: {
    simpleTaskProviders: [],
    complexTaskProviders: [],
    simpleTaskMaxLength: 200,
  },
};

export class ProviderManager {
  private configPath: string;
  private store: ProviderConfigStore;

  constructor(dataDir?: string) {
    const dir = dataDir || path.join(process.cwd(), 'data');
    this.configPath = path.join(dir, 'providers.json');
    this.store = this.load();
  }

  private load(): ProviderConfigStore {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch (e) {
      Logger.warn(`Provider 配置文件加载失败: ${(e as Error).message}`, 'ProviderManager');
    }
    return { ...DEFAULT_CONFIG };
  }

  private save(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (e) {
      Logger.error(`Provider 配置保存失败`, e as Error, 'ProviderManager');
    }
  }

  /** 从 .env 导入已有配置（仅当 providers 为空时） */
  importFromEnv(): void {
    if (this.store.providers.length > 0) return; // 已有配置，不覆盖
    const providers: ProviderConfig[] = [];

    // 小米 MiMo
    if (process.env.XIAOMI_API_KEY && process.env.XIAOMI_API_KEY !== '***' && process.env.XIAOMI_API_KEY !== '...') {
      providers.push({
        name: 'xiaomi',
        displayName: '小米 MiMo',
        baseUrl: process.env.XIAOMI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: process.env.XIAOMI_API_KEY,
        model: process.env.XIAOMI_MODEL || 'mimo-v2.5-pro',
        enabled: true,
        priority: 0,
      });
    }

    // DeepSeek
    const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (deepseekKey && deepseekKey !== '***' && deepseekKey !== '...' && deepseekKey !== 'your_z...here') {
      providers.push({
        name: 'deepseek',
        displayName: 'DeepSeek',
        baseUrl: process.env.OPENAI_API_BASE || 'https://api.deepseek.com',
        apiKey: deepseekKey,
        model: process.env.LLM_MODEL || 'deepseek-v4-flash',
        enabled: true,
        priority: 1,
        extra: {
          thinkingMode: (process.env.DEEPSEEK_THINKING_MODE as string) || 'disabled',
          reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || 'high',
        },
      });
    }

    // 智谱 GLM
    if (process.env.ZHIPU_API_KEY && process.env.ZHIPU_API_KEY !== 'your_z...here') {
      providers.push({
        name: 'zhipu',
        displayName: '智谱 GLM',
        baseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: process.env.ZHIPU_API_KEY,
        model: process.env.ZHIPU_MODEL || 'glm-4.5-air',
        enabled: true,
        priority: 2,
      });
    }

    // 本地 LLM
    if (process.env.LLM_SERVER_API_KEY && process.env.LLM_SERVER_BASE_URL) {
      providers.push({
        name: 'local',
        displayName: '本地 LLM',
        baseUrl: process.env.LLM_SERVER_BASE_URL,
        apiKey: process.env.LLM_SERVER_API_KEY || 'not-required',
        model: process.env.LLM_SERVER_MODEL || 'qwen2.5:3b',
        enabled: true,
        priority: 3,
      });
    }

    if (providers.length > 0) {
      this.store.providers = providers;
      this.store.primary = providers[0].name;
      if (providers.length >= 2) {
        this.store.routingEnabled = true;
        this.store.routing.simpleTaskProviders = [providers[providers.length - 1].name];
        this.store.routing.complexTaskProviders = [providers[0].name];
      }
      this.save();
      Logger.info(
        `从 .env 导入 ${providers.length} 个 Provider: ${providers.map(p => p.displayName).join(', ')}`,
        'ProviderManager'
      );
    }
  }

  /** 注册一个新的 Provider */
  register(config: Omit<ProviderConfig, 'enabled' | 'healthy'>): void {
    const existing = this.store.providers.findIndex(p => p.name === config.name);
    const entry: ProviderConfig = { ...config, enabled: true };
    if (existing >= 0) {
      this.store.providers[existing] = entry;
    } else {
      this.store.providers.push(entry);
    }
    if (!this.store.primary) {
      this.store.primary = config.name;
    }
    this.save();
  }

  /** 获取所有 Provider */
  getAll(): ProviderConfig[] {
    return this.store.providers.filter(p => p.enabled);
  }

  /** 按 name 获取 Provider */
  get(name: string): ProviderConfig | undefined {
    return this.store.providers.find(p => p.name === name);
  }

  /** 获取主模型 Provider */
  getPrimary(): ProviderConfig | undefined {
    if (this.store.primary) {
      return this.get(this.store.primary);
    }
    return this.store.providers.find(p => p.priority === 0) || this.store.providers[0];
  }

  /** 设置主模型 */
  setPrimary(name: string): boolean {
    const p = this.get(name);
    if (!p) return false;
    this.store.primary = name;
    this.save();
    return true;
  }

  /** 启用/禁用 Provider */
  setEnabled(name: string, enabled: boolean): boolean {
    const p = this.store.providers.find(p => p.name === name);
    if (!p) return false;
    p.enabled = enabled;
    this.save();
    return true;
  }

  /** 更新健康状态 */
  updateHealth(name: string, healthy: boolean): void {
    const p = this.store.providers.find(p => p.name === name);
    if (!p) return;
    p.healthy = healthy;
    p.lastHealthCheck = Date.now();
    this.save();
  }

  /** 获取路由配置 */
  getRouting() {
    return {
      ...this.store.routing,
      enabled: this.store.routingEnabled,
    };
  }

  /** 判断是否为简单任务（用于 routing） */
  isSimpleTask(input: string): boolean {
    const len = input.length;
    const maxLen = this.store.routing.simpleTaskMaxLength;

    // 短文本大概率是简单任务
    if (len < maxLen) return true;

    // 包含以下关键词认为是简单任务
    const simpleKeywords = ['你好', 'hi', 'hello', '再见', 'bye', '谢谢',
      '时间', '天气', '日期', '现在几点', '/help', '/status'];
    for (const kw of simpleKeywords) {
      if (input.trim().toLowerCase().startsWith(kw)) return true;
    }

    // 包含以下关键词认为是复杂任务
    const complexKeywords = ['代码', '代码审查', '重构', '分析', '写一个',
      '编写', '修改', 'debug', '规划', '计划', '设计'];
    for (const kw of complexKeywords) {
      if (input.includes(kw)) return false;
    }

    return len < 50;
  }

  /** 根据任务复杂度获取应使用的 provider 列表 */
  getProvidersForInput(input: string): ProviderConfig[] {
    if (!this.store.routingEnabled) {
      const primary = this.getPrimary();
      return primary ? [primary] : this.getAll();
    }

    const isSimple = this.isSimpleTask(input);
    const names = isSimple
      ? this.store.routing.simpleTaskProviders
      : this.store.routing.complexTaskProviders;

    const providers = names
      .map(n => this.get(n))
      .filter((p): p is ProviderConfig => p !== undefined && p.enabled);

    // 如果指定列表为空，fallback 到已启用的所有 provider
    return providers.length > 0 ? providers : this.getAll();
  }

  /** 导出为 API 友好的格式 */
  toJSON(): ProviderConfigStore {
    return { ...this.store, providers: this.store.providers.map(p => ({ ...p, apiKey: '***' })) };
  }
}

// 单例
let _instance: ProviderManager | null = null;
export function getProviderManager(dataDir?: string): ProviderManager {
  if (!_instance) {
    _instance = new ProviderManager(dataDir);
    // 启动时自动从 .env 导入（兼容已有配置）
    _instance.importFromEnv();
  }
  return _instance;
}

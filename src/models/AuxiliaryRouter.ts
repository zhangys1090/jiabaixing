/**
 * AuxiliaryRouter — 辅助模型路由
 *
 * 为不同辅助任务（视觉、压缩、搜索摘要）分配独立的模型/provider。
 * 参考 Hermes agent/auxiliary_client.py 设计。
 *
 * 用法:
 *   const router = new AuxiliaryRouter();
 *   const config = router.resolve('compression');
 *   // → { model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", ... }
 */

import { ProviderManager } from './ProviderManager';

/** 辅助任务类型 */
export type AuxiliaryTask =
  | 'vision'
  | 'compression'
  | 'search'
  | 'memory'
  | 'default';

/** 辅助任务配置 */
export interface AuxiliaryConfig {
  /** 使用的模型名称，null = 使用主模型 */
  model?: string | null;
  /** 使用的 provider 名称，null = 使用主模型 provider */
  provider?: string | null;
  /** 自定义 baseUrl */
  baseUrl?: string;
}

/** 解析后的辅助模型配置 */
export interface ResolvedAuxiliaryConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  providerName: string;
}

/** 默认辅助任务配置（环境变量驱动） */
const DEFAULT_AUX_CONFIG: Record<AuxiliaryTask, AuxiliaryConfig> = {
  vision: {
    model: process.env.AUX_VISION_MODEL || null,
    provider: process.env.AUX_VISION_PROVIDER || null,
  },
  compression: {
    model: process.env.AUX_COMPRESSION_MODEL || null,
    provider: process.env.AUX_COMPRESSION_PROVIDER || null,
  },
  search: {
    model: process.env.AUX_SEARCH_MODEL || null,
    provider: process.env.AUX_SEARCH_PROVIDER || null,
  },
  memory: {
    model: process.env.AUX_MEMORY_MODEL || null,
    provider: process.env.AUX_MEMORY_PROVIDER || null,
  },
  default: {
    model: null,
    provider: null,
  },
};

export class AuxiliaryRouter {
  private overrides: Partial<Record<AuxiliaryTask, AuxiliaryConfig>> = {};
  private providerManager: ProviderManager | null = null;

  constructor(providerManager?: ProviderManager) {
    this.providerManager = providerManager || null;
  }

  /** 设置自定义辅助配置（覆盖环境变量） */
  setConfig(task: AuxiliaryTask, config: AuxiliaryConfig): void {
    this.overrides[task] = config;
  }

  /** 获取辅助任务配置 */
  getConfig(task: AuxiliaryTask): AuxiliaryConfig {
    return { ...DEFAULT_AUX_CONFIG[task], ...this.overrides[task] };
  }

  /**
   * 解析辅助任务的完整模型配置
   *
   * 优先级:
   *   1. 任务的显式配置 (model/provider)
   *   2. 主模型
   */
  resolve(task: AuxiliaryTask = 'default'): ResolvedAuxiliaryConfig {
    const config = this.getConfig(task);

    // 如果有显式配置，使用它
    if (config.model && config.provider) {
      const pm = this.providerManager || this.getProviderManager();
      const provider = pm.get(config.provider);
      if (provider) {
        return {
          model: config.model,
          baseUrl: config.baseUrl || provider.baseUrl,
          apiKey: provider.apiKey,
          providerName: provider.name,
        };
      }
    }

    // 如果有显式 model 但没有 provider，用主模型的 provider
    if (config.model) {
      const pm = this.providerManager || this.getProviderManager();
      const primary = pm.getPrimary();
      if (primary) {
        return {
          model: config.model,
          baseUrl: config.baseUrl || primary.baseUrl,
          apiKey: primary.apiKey,
          providerName: primary.name,
        };
      }
      // 回退到默认
      return {
        model: config.model,
        baseUrl: 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        providerName: 'deepseek',
      };
    }

    // 无显式配置 → 使用主模型
    const pm = this.providerManager || this.getProviderManager();
    const primary = pm.getPrimary();
    if (primary) {
      return {
        model: primary.model,
        baseUrl: primary.baseUrl,
        apiKey: primary.apiKey,
        providerName: primary.name,
      };
    }

    // 最终回退
    return {
      model: process.env.LLM_MODEL || 'deepseek-v4-flash',
      baseUrl: process.env.OPENAI_API_BASE || 'https://api.deepseek.com',
      apiKey: process.env.OPENAI_API_KEY || '',
      providerName: 'default',
    };
  }

  private getProviderManager(): ProviderManager {
    if (this.providerManager) return this.providerManager;
    const { getProviderManager } = require('./ProviderManager');
    this.providerManager = getProviderManager();
    return this.providerManager as ProviderManager;
  }
}

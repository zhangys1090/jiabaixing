/**
 * YAML 配置解析器 - 支持环境变量覆盖与热重载
 *
 * 参考 Hermes 的 config.yaml 分层架构：
 *   - YAML 主配置 + .env 环境变量 + 运行时覆盖
 *   - 文件变更自动重载
 *   - 结构化类型安全访问
 */

import * as fs from 'fs';
import * as path from 'path';
import { defaultConfig, DefaultConfig } from './default.config';
import { Logger } from '../utils/Logger';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

let yamlModule: typeof import('js-yaml');

/**
 * 递归展开对象中的 ${ENV_VAR} 占位符
 */
function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? obj);
  }
  if (Array.isArray(obj)) return obj.map(expandEnvVars);
  if (obj != null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = expandEnvVars(v);
    }
    return result;
  }
  return obj;
}

/**
 * 深度合并两个对象，b 优先于 a
 */
function deepMerge<T extends Record<string, unknown>>(
  a: T,
  b: DeepPartial<T>
): T {
  const result = { ...a } as Record<string, unknown>;
  for (const [key, val] of Object.entries(b)) {
    if (
      val != null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      result[key] != null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val as unknown as (typeof result)[string];
    }
  }
  return result as T;
}

export interface YamlConfigOptions {
  /** YAML 配置文件路径，默认为 ./config.yaml */
  configPath?: string;
  /** .env 文件路径 */
  envPath?: string;
  /** 是否启用文件监听热重载 */
  watch?: boolean;
}

export class YamlConfigParser {
  private static instance: YamlConfigParser | null = null;
  private mergedConfig: DefaultConfig;
  private configPath: string;
  private envPath: string;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<() => void> = [];
  private lastMtime: number = 0;

  private constructor(options: YamlConfigOptions = {}) {
    this.configPath =
      options.configPath ?? path.join(process.cwd(), 'config.yaml');
    this.envPath = options.envPath ?? path.join(process.cwd(), '.env');
    this.mergedConfig = { ...defaultConfig } as DefaultConfig;
    this.load();
    if (options.watch) {
      this.startWatching();
    }
  }

  /** 单例入口 */
  public static getInstance(opts?: YamlConfigOptions): YamlConfigParser {
    if (!YamlConfigParser.instance) {
      YamlConfigParser.instance = new YamlConfigParser(opts);
    }
    return YamlConfigParser.instance;
  }

  /** 重置单例（用于测试） */
  public static resetInstance(): void {
    if (YamlConfigParser.instance) {
      YamlConfigParser.instance.stopWatching();
      YamlConfigParser.instance = null;
    }
  }

  /** 订阅配置变更 */
  public onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** 获取完整合并后的配置 */
  public getConfig(): DefaultConfig {
    return this.mergedConfig;
  }

  /** 按路径获取配置片段（"server.port" -> 3111） */
  public get<T = unknown>(dotPath: string): T {
    const keys = dotPath.split('.');
    let current: unknown = this.mergedConfig;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') return undefined as T;
      current = (current as Record<string, unknown>)[key];
    }
    return current as T;
  }

  /** 运行时动态覆盖某个路径的值 */
  public set(dotPath: string, value: unknown): void {
    const keys = dotPath.split('.');
    let current: Record<string, unknown> = this.mergedConfig as Record<
      string,
      unknown
    >;
    for (let i = 0; i < keys.length - 1; i++) {
      current = current[keys[i]] ??= {};
    }
    current[keys[keys.length - 1]] = value;
    this.notifyListeners();
  }

  // ---- 内部方法 ----

  private load(): void {
    const yaml = yamlModule;

    // 1. 基础 = 默认配置
    let merged = { ...defaultConfig } as Record<string, unknown>;

    // 2. 合并 .env
    try {
      if (fs.existsSync(this.envPath)) {
        const envContent = fs.readFileSync(this.envPath, 'utf-8');
        for (const line of envContent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx <= 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          // 去掉引号
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("\'") && val.endsWith("\'"))
          ) {
            val = val.slice(1, -1);
          }
          // 将 KEY=VAL 映射到 dot-path
          this.applyEnvToConfig(merged, key, val);
        }
      }
    } catch (err) {
      Logger.warn(
        `[YamlConfigParser] Failed to load .env: ${(err as Error).message}`
      );
    }

    // 3. 合并 YAML 配置
    if (yaml && fs.existsSync(this.configPath)) {
      try {
        const yamlContent = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = yaml.load(yamlContent) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          merged = deepMerge(merged, parsed);
        }
      } catch (err) {
        Logger.warn(
          `[YamlConfigParser] Failed to parse YAML: ${(err as Error).message}`
        );
      }
    }

    // 4. 环境变量覆盖（优先级最高）
    merged = expandEnvVars(merged);

    this.mergedConfig = merged;
    try {
      this.lastMtime = fs.statSync(this.configPath).mtimeMs;
    } catch {
      /* ignore */
    }
    Logger.info('[YamlConfigParser] Configuration loaded and merged');
  }

  /**
   * 将 KEY=VALUE 形式的 env 变量映射到嵌套配置路径
   * 例如 LLM_MODEL=claude-3 -> model.defaultModel = "claude-3"
   * DATABASE_HOST=db.local -> database.host = "db.local"
   */
  private applyEnvToConfig(
    config: Record<string, any>,
    envKey: string,
    value: string
  ): void {
    // 直接匹配顶层键
    if (envKey in config) {
      config[envKey] = this.coerceValue(value);
      return;
    }

    // 尝试映射: LLM_MODEL -> model.defaultModel
    const mappings: Record<string, string> = {
      LLM_MODEL: 'model.defaultModel',
      LLM_BASE_URL: 'model.baseUrl',
      LLM_API_KEY: 'model.apiKey',
      LLM_MAX_TOKENS: 'model.maxTokens',
      LLM_TEMPERATURE: 'model.temperature',
      SERVER_PORT: 'server.port',
      SERVER_HOST: 'server.host',
      DB_STORAGE_PATH: 'database.storagePath',
      MEMORY_SHORT_MAX_SIZE: 'memory.shortTerm.maxSize',
      MEMORY_LONG_ENABLED: 'memory.longTerm.enabled',
      EVOLUTION_ENABLED: 'evolution.enabled',
      EVOLUTION_AUTO_OPTIMIZE: 'evolution.autoOptimize',
      SKILLS_MAX_CONCURRENT: 'skills.maxConcurrent',
      TOOLS_SANDBOX_ENABLED: 'tools.sandbox.enabled',
      LOGGING_LEVEL: 'logging.level',
      FRONTEND_THEME: 'frontend.ui.theme',
      FRONTEND_LANGUAGE: 'frontend.ui.language',
    };

    const dotPath = mappings[envKey];
    if (dotPath) {
      const keys = dotPath.split('.');
      let current = config;
      for (const key of keys) {
        if (!(key in current)) current[key] = {};
        current = current[key];
      }
      current[keys[keys.length - 1]] = this.coerceValue(value);
    }
  }

  private coerceValue(val: string): string | number | boolean {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (/^\d+$/.test(val)) return Number(val);
    return val;
  }

  private startWatching(): void {
    this.stopWatching();
    this.watchTimer = setInterval(() => {
      try {
        const stat = fs.statSync(this.configPath);
        if (stat.mtimeMs !== this.lastMtime) {
          this.load();
          Logger.info('[YamlConfigParser] Config file changed, hot-reloaded');
        }
      } catch {
        // File may not exist yet; ignore
      }
    }, 5000);
  }

  private stopWatching(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private notifyListeners(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        Logger.error('监听器执行失败', err as Error, 'YamlConfigParser');
      }
    }
  }

  /** 清理资源 */
  public dispose(): void {
    this.stopWatching();
    this.listeners = [];
  }
}

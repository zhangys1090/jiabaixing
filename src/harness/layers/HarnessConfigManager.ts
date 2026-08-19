/**
 * HarnessConfig — 配置驱动组合的核心
 *
 * 解析 harness.config.yaml（或 .json），声明各层使用的实现。
 * 运行时由 HarnessComposer 根据配置组装层实例。
 *
 * 配置结构：
 *   harness:
 *     version: 1
 *     layers:
 *       tools:
 *         implementation: builtin          # builtin | custom | plugin:xxx
 *         config: { ... }
 *       context:
 *         implementation: unified-pipeline
 *         config: { ... }
 *       persistence:
 *         implementation: event-sourcing   # legacy | event-sourcing | plugin:xxx
 *         config: { ... }
 *       verification:
 *         implementation: builtin
 *         config: { ... }
 *       constraints:
 *         implementation: builtin
 *         config: { ... }
 *       loop:
 *         implementation: python-backend   # local | python-backend | plugin:xxx
 *         config: { ... }
 *     plugins:
 *       - name: my-plugin
 *         path: ./plugins/my-plugin
 *     overrides:
 *       AGENT_BACKEND: python
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';
import type { LayerName } from './interfaces';

export type LayerImplementation = string;

export interface LayerConfig {
  implementation: LayerImplementation;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PluginConfig {
  name: string;
  path: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface HarnessConfigFile {
  version: number;
  layers: Partial<Record<LayerName, LayerConfig>>;
  plugins: PluginConfig[];
  overrides: Record<string, string>;
  metadata: {
    createdAt: number;
    updatedAt: number;
    description?: string;
  };
}

const DEFAULT_LAYER_CONFIGS: Record<LayerName, LayerConfig> = {
  tools: { implementation: 'builtin', enabled: true, config: {} },
  context: { implementation: 'unified-pipeline', enabled: true, config: {} },
  persistence: { implementation: 'event-sourcing', enabled: true, config: {} },
  verification: { implementation: 'builtin', enabled: true, config: {} },
  constraints: { implementation: 'builtin', enabled: true, config: {} },
  loop: { implementation: 'python-backend', enabled: true, config: {} },
};

const DEFAULT_CONFIG: HarnessConfigFile = {
  version: 1,
  layers: DEFAULT_LAYER_CONFIGS,
  plugins: [],
  overrides: {},
  metadata: {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    description: 'Default harness configuration',
  },
};

export class HarnessConfigManager {
  private config: HarnessConfigFile;
  private configPath: string | null = null;
  private watchers: Array<{ close: () => void }> = [];

  constructor(configPath?: string) {
    this.config = { ...DEFAULT_CONFIG };
    if (configPath) {
      this.configPath = configPath;
    }
  }

  load(configPath?: string): HarnessConfigFile {
    const resolvedPath = configPath ?? this.configPath ?? this.findConfigFile();

    if (!resolvedPath) {
      Logger.info('HarnessConfig: 未找到配置文件，使用默认配置', 'HarnessConfig');
      return this.config;
    }

    this.configPath = resolvedPath;

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const ext = path.extname(resolvedPath).toLowerCase();

      let parsed: Partial<HarnessConfigFile>;

      if (ext === '.json') {
        parsed = JSON.parse(content);
      } else if (ext === '.yaml' || ext === '.yml') {
        parsed = this.parseYaml(content);
      } else {
        Logger.warn(`HarnessConfig: 不支持的配置文件格式: ${ext}`, 'HarnessConfig');
        return this.config;
      }

      this.config = this.mergeWithDefaults(parsed);
      Logger.info(`HarnessConfig: 已加载配置 ${resolvedPath}`, 'HarnessConfig');
    } catch (error) {
      Logger.warn(
        `HarnessConfig: 加载配置失败，使用默认配置: ${(error as Error).message}`,
        'HarnessConfig'
      );
    }

    return this.config;
  }

  save(configPath?: string): void {
    const resolvedPath = configPath ?? this.configPath ?? this.getDefaultConfigPath();

    try {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.config.metadata.updatedAt = Date.now();

      const ext = path.extname(resolvedPath).toLowerCase();
      let content: string;

      if (ext === '.yaml' || ext === '.yml') {
        content = this.serializeYaml(this.config);
      } else {
        content = JSON.stringify(this.config, null, 2);
      }

      fs.writeFileSync(resolvedPath, content, 'utf-8');
      Logger.info(`HarnessConfig: 配置已保存到 ${resolvedPath}`, 'HarnessConfig');
    } catch (error) {
      Logger.error('HarnessConfig: 保存配置失败', error as Error, 'HarnessConfig');
    }
  }

  getConfig(): HarnessConfigFile {
    return this.config;
  }

  getLayerConfig(layerName: LayerName): LayerConfig {
    return this.config.layers[layerName] ?? DEFAULT_LAYER_CONFIGS[layerName];
  }

  setLayerConfig(layerName: LayerName, config: Partial<LayerConfig>): void {
    const current = this.getLayerConfig(layerName);
    this.config.layers[layerName] = {
      ...current,
      ...config,
      config: { ...current.config, ...(config.config ?? {}) },
    };
    this.config.metadata.updatedAt = Date.now();
  }

  getLayerImplementation(layerName: LayerName): LayerImplementation {
    return this.getLayerConfig(layerName).implementation;
  }

  isLayerEnabled(layerName: LayerName): boolean {
    return this.getLayerConfig(layerName).enabled;
  }

  getPlugins(): PluginConfig[] {
    return this.config.plugins.filter((p) => p.enabled);
  }

  addPlugin(plugin: PluginConfig): void {
    const existing = this.config.plugins.findIndex((p) => p.name === plugin.name);
    if (existing >= 0) {
      this.config.plugins[existing] = plugin;
    } else {
      this.config.plugins.push(plugin);
    }
    this.config.metadata.updatedAt = Date.now();
  }

  removePlugin(name: string): boolean {
    const index = this.config.plugins.findIndex((p) => p.name === name);
    if (index >= 0) {
      this.config.plugins.splice(index, 1);
      this.config.metadata.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  getOverrides(): Record<string, string> {
    return this.config.overrides;
  }

  applyOverrides(): void {
    for (const [key, value] of Object.entries(this.config.overrides)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  watch(callback: (config: HarnessConfigFile) => void): () => void {
    const resolvedPath = this.configPath ?? this.getDefaultConfigPath();

    if (!fs.existsSync(resolvedPath)) {
      return () => {};
    }

    try {
      const watcher = fs.watch(resolvedPath, (eventType) => {
        if (eventType === 'change') {
          Logger.info('HarnessConfig: 检测到配置文件变更', 'HarnessConfig');
          const newConfig = this.load();
          callback(newConfig);
        }
      });

      this.watchers.push(watcher);
      return () => watcher.close();
    } catch {
      return () => {};
    }
  }

  destroy(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private findConfigFile(): string | null {
    const searchPaths = [
      path.join(process.cwd(), 'harness.config.yaml'),
      path.join(process.cwd(), 'harness.config.yml'),
      path.join(process.cwd(), 'harness.config.json'),
      path.join(process.cwd(), 'config', 'harness.config.yaml'),
      path.join(process.cwd(), 'config', 'harness.config.json'),
    ];

    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  private getDefaultConfigPath(): string {
    return path.join(process.cwd(), 'harness.config.yaml');
  }

  private mergeWithDefaults(partial: Partial<HarnessConfigFile>): HarnessConfigFile {
    const layers: Partial<Record<LayerName, LayerConfig>> = {};

    for (const [name, defaultConfig] of Object.entries(DEFAULT_LAYER_CONFIGS)) {
      const layerName = name as LayerName;
      const partialLayer = partial.layers?.[layerName];
      layers[layerName] = {
        ...defaultConfig,
        ...partialLayer,
        config: { ...defaultConfig.config, ...(partialLayer?.config ?? {}) },
      };
    }

    return {
      version: partial.version ?? DEFAULT_CONFIG.version,
      layers,
      plugins: partial.plugins ?? DEFAULT_CONFIG.plugins,
      overrides: partial.overrides ?? DEFAULT_CONFIG.overrides,
      metadata: {
        ...DEFAULT_CONFIG.metadata,
        ...partial.metadata,
        updatedAt: Date.now(),
      },
    };
  }

  private parseYaml(content: string): Partial<HarnessConfigFile> {
    try {
      const lines = content.split('\n');
      const result: Record<string, unknown> = {};
      const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
        { obj: result, indent: -1 },
      ];

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const indent = line.length - line.trimStart().length;
        const match = trimmed.match(/^(\s*)([\w_-]+):\s*(.*)$/);
        if (!match) continue;

        const key = match[2];
        const value = match[3].trim();

        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }

        const current = stack[stack.length - 1].obj;

        if (value === '' || value === '|' || value === '>') {
          const newObj: Record<string, unknown> = {};
          current[key] = newObj;
          stack.push({ obj: newObj, indent });
        } else {
          current[key] = this.parseYamlValue(value);
        }
      }

      return result as unknown as Partial<HarnessConfigFile>;
    } catch (error) {
      Logger.warn(
        `HarnessConfig: YAML 解析失败: ${(error as Error).message}`,
        'HarnessConfig'
      );
      return {};
    }
  }

  private parseYamlValue(value: string): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value.startsWith('[')) {
      try { return JSON.parse(value); } catch { return value; }
    }
    if (value.startsWith('{')) {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }

  private serializeYaml(config: HarnessConfigFile): string {
    const lines: string[] = [
      `# Harness Configuration - Auto-generated`,
      `# Updated: ${new Date(config.metadata.updatedAt).toISOString()}`,
      ``,
      `version: ${config.version}`,
      ``,
      `layers:`,
    ];

    for (const [name, layerConfig] of Object.entries(config.layers)) {
      if (!layerConfig) continue;
      lines.push(`  ${name}:`);
      lines.push(`    implementation: ${layerConfig.implementation}`);
      lines.push(`    enabled: ${layerConfig.enabled}`);
      if (Object.keys(layerConfig.config).length > 0) {
        lines.push(`    config: ${JSON.stringify(layerConfig.config)}`);
      }
    }

    if (config.plugins.length > 0) {
      lines.push('', 'plugins:');
      for (const plugin of config.plugins) {
        lines.push(`  - name: ${plugin.name}`);
        lines.push(`    path: ${plugin.path}`);
        lines.push(`    enabled: ${plugin.enabled}`);
      }
    }

    if (Object.keys(config.overrides).length > 0) {
      lines.push('', 'overrides:');
      for (const [key, value] of Object.entries(config.overrides)) {
        lines.push(`  ${key}: "${value}"`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  static createDefaultConfig(): HarnessConfigFile {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

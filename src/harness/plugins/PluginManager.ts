/**
 * PluginManager — 插件生命周期管理
 *
 * Phase 4: plugin install/list/remove
 * - 从本地路径/npm/git/marketplace 安装插件
 * - 插件列表查询（按状态/来源/分类过滤）
 * - 插件卸载与清理
 * - 依赖解析与冲突检测
 * - 与现有 PluginRegistry 集成
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';
import {
  JiabaixingPluginSpec,
  type JiabaixingPluginDescriptor,
  type PluginSource,
  type PluginStatus,
} from './JiabaixingPluginSpec';
import { PluginRegistry } from './pluginRegistry';
import type { PluginLifecycle, PluginManifest } from './pluginTypes';

export interface InstalledPlugin {
  descriptor: JiabaixingPluginDescriptor;
  status: PluginStatus;
  installedAt: number;
  installedFrom: PluginSource;
  installPath: string;
  lastActivatedAt?: number;
  error?: string;
}

export interface InstallOptions {
  source: PluginSource;
  sourceUrl?: string;
  force?: boolean;
  enableSandbox?: boolean;
  skipDependencies?: boolean;
}

export interface InstallResult {
  success: boolean;
  pluginId: string;
  message: string;
  warnings: string[];
}

export interface PluginListFilter {
  status?: PluginStatus;
  source?: PluginSource;
  category?: string;
  hasPermission?: string;
}

const DEFAULT_PLUGIN_DIR = '.jiabaixing/plugins';

export class PluginManager {
  private pluginDir: string;
  private installed: Map<string, InstalledPlugin> = new Map();
  private registry: PluginRegistry;
  private lifecycleCache: Map<string, PluginLifecycle> = new Map();

  constructor(registry: PluginRegistry, pluginDir?: string) {
    this.registry = registry;
    this.pluginDir = pluginDir ?? path.join(process.cwd(), DEFAULT_PLUGIN_DIR);
    this.ensurePluginDir();
  }

  async install(
    descriptorOrPath: string | JiabaixingPluginDescriptor,
    options: InstallOptions
  ): Promise<InstallResult> {
    let descriptor: JiabaixingPluginDescriptor;

    if (typeof descriptorOrPath === 'string') {
      const loaded = this.loadDescriptorFromPath(descriptorOrPath);
      if (!loaded) {
        return {
          success: false,
          pluginId: '',
          message: `无法从路径加载插件描述符: ${descriptorOrPath}`,
          warnings: [],
        };
      }
      descriptor = loaded;
    } else {
      descriptor = descriptorOrPath;
    }

    descriptor.source = options.source;
    if (options.sourceUrl) {
      descriptor.sourceUrl = options.sourceUrl;
    }

    const validation = JiabaixingPluginSpec.validate(descriptor);
    if (!validation.valid) {
      const errorMessages = validation.errors
        .filter((e) => e.severity === 'error')
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ');

      return {
        success: false,
        pluginId: descriptor.id,
        message: `插件描述符验证失败: ${errorMessages}`,
        warnings: validation.warnings,
      };
    }

    if (this.installed.has(descriptor.id) && !options.force) {
      const existing = this.installed.get(descriptor.id)!;
      if (existing.descriptor.version === descriptor.version) {
        return {
          success: false,
          pluginId: descriptor.id,
          message: `插件 ${descriptor.id}@${descriptor.version} 已安装`,
          warnings: [],
        };
      }
    }

    if (!options.skipDependencies) {
      const depResult = this.checkDependencies(descriptor);
      if (!depResult.satisfied) {
        return {
          success: false,
          pluginId: descriptor.id,
          message: `依赖不满足: ${depResult.missing.join(', ')}`,
          warnings: [],
        };
      }
    }

    const installPath = path.join(this.pluginDir, descriptor.id);
    this.saveDescriptor(descriptor, installPath);

    if (options.enableSandbox || descriptor.sandbox?.enabled) {
      descriptor.sandbox = {
        ...descriptor.sandbox,
        enabled: true,
        permissions: descriptor.sandbox?.permissions ?? descriptor.permissions,
        maxMemoryMB: descriptor.sandbox?.maxMemoryMB ?? 128,
        maxCpuMs: descriptor.sandbox?.maxCpuMs ?? 30000,
        networkAccess: descriptor.sandbox?.networkAccess ?? false,
        filesystemPaths: descriptor.sandbox?.filesystemPaths ?? [installPath],
      };
    }

    const installedPlugin: InstalledPlugin = {
      descriptor,
      status: 'installed',
      installedAt: Date.now(),
      installedFrom: options.source,
      installPath,
    };

    this.installed.set(descriptor.id, installedPlugin);

    Logger.info(
      `📦 插件已安装: ${descriptor.id}@${descriptor.version} (来源: ${options.source})`,
      'PluginManager'
    );

    return {
      success: true,
      pluginId: descriptor.id,
      message: `插件 ${descriptor.id}@${descriptor.version} 安装成功`,
      warnings: validation.warnings,
    };
  }

  async load(pluginId: string): Promise<boolean> {
    const installed = this.installed.get(pluginId);
    if (!installed) {
      Logger.warn(`插件 ${pluginId} 未安装`, 'PluginManager');
      return false;
    }

    if (installed.status === 'active') {
      return true;
    }

    try {
      const manifest = this.convertToManifest(installed.descriptor);
      const lifecycle = await this.loadLifecycle(installed.installPath, installed.descriptor);

      const success = await this.registry.loadPlugin(manifest, lifecycle ?? undefined);

      if (success) {
        installed.status = 'active';
        installed.lastActivatedAt = Date.now();
        if (lifecycle) {
          this.lifecycleCache.set(pluginId, lifecycle);
        }
        Logger.info(`🔌 插件已加载: ${pluginId}`, 'PluginManager');
      } else {
        installed.status = 'error';
        installed.error = 'loadPlugin 返回 false';
      }

      return success;
    } catch (error) {
      installed.status = 'error';
      installed.error = (error as Error).message;
      Logger.error(
        `插件 ${pluginId} 加载失败: ${(error as Error).message}`,
        error as Error,
        'PluginManager'
      );
      return false;
    }
  }

  async unload(pluginId: string): Promise<boolean> {
    const installed = this.installed.get(pluginId);
    if (!installed) return false;

    const success = await this.registry.unloadPlugin(pluginId);
    if (success) {
      installed.status = 'installed';
      this.lifecycleCache.delete(pluginId);
    }
    return success;
  }

  async remove(pluginId: string): Promise<boolean> {
    const installed = this.installed.get(pluginId);
    if (!installed) {
      Logger.warn(`插件 ${pluginId} 未安装`, 'PluginManager');
      return false;
    }

    if (installed.status === 'active' || installed.status === 'loaded') {
      await this.unload(pluginId);
    }

    const dependents = this.findDependents(pluginId);
    if (dependents.length > 0) {
      Logger.warn(
        `插件 ${pluginId} 被以下插件依赖: ${dependents.join(', ')}，请先卸载依赖方`,
        'PluginManager'
      );
      return false;
    }

    try {
      this.cleanupInstallDir(installed.installPath);
    } catch (error) {
      Logger.warn(
        `清理插件目录失败: ${(error as Error).message}`,
        'PluginManager'
      );
    }

    this.installed.delete(pluginId);
    this.lifecycleCache.delete(pluginId);

    Logger.info(`🗑️ 插件已移除: ${pluginId}`, 'PluginManager');
    return true;
  }

  list(filter?: PluginListFilter): InstalledPlugin[] {
    let result = Array.from(this.installed.values());

    if (filter?.status) {
      result = result.filter((p) => p.status === filter.status);
    }
    if (filter?.source) {
      result = result.filter((p) => p.descriptor.source === filter.source);
    }
    if (filter?.category) {
      result = result.filter((p) => p.descriptor.category === filter.category);
    }
    if (filter?.hasPermission) {
      result = result.filter((p) =>
        p.descriptor.permissions.includes(filter.hasPermission! as any)
      );
    }

    return result;
  }

  get(pluginId: string): InstalledPlugin | null {
    return this.installed.get(pluginId) ?? null;
  }

  getStatus(pluginId: string): PluginStatus | null {
    return this.installed.get(pluginId)?.status ?? null;
  }

  async loadAll(): Promise<{ loaded: number; failed: number }> {
    let loaded = 0;
    let failed = 0;

    const sortedPlugins = this.topologicalSort();

    for (const pluginId of sortedPlugins) {
      const installed = this.installed.get(pluginId);
      if (!installed || installed.status === 'active') continue;

      const success = await this.load(pluginId);
      if (success) {
        loaded++;
      } else {
        failed++;
      }
    }

    Logger.info(
      `🔌 批量加载完成: ${loaded} 成功, ${failed} 失败`,
      'PluginManager'
    );

    return { loaded, failed };
  }

  async unloadAll(): Promise<void> {
    for (const [pluginId, installed] of this.installed) {
      if (installed.status === 'active') {
        await this.unload(pluginId);
      }
    }
  }

  scanAndInstall(): number {
    let count = 0;

    if (!fs.existsSync(this.pluginDir)) return 0;

    const entries = fs.readdirSync(this.pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(
        this.pluginDir,
        entry.name,
        'jiabaixing.plugin.json'
      );

      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const descriptor = JSON.parse(content) as JiabaixingPluginDescriptor;

          if (!this.installed.has(descriptor.id)) {
            this.installed.set(descriptor.id, {
              descriptor,
              status: 'installed',
              installedAt: Date.now(),
              installedFrom: descriptor.source ?? 'local',
              installPath: path.join(this.pluginDir, entry.name),
            });
            count++;
          }
        } catch (error) {
          Logger.warn(
            `扫描插件 ${entry.name} 失败: ${(error as Error).message}`,
            'PluginManager'
          );
        }
      }
    }

    if (count > 0) {
      Logger.info(`📦 扫描发现 ${count} 个新插件`, 'PluginManager');
    }

    return count;
  }

  private ensurePluginDir(): void {
    if (!fs.existsSync(this.pluginDir)) {
      try {
        fs.mkdirSync(this.pluginDir, { recursive: true });
      } catch {
        Logger.warn(`无法创建插件目录: ${this.pluginDir}`, 'PluginManager');
      }
    }
  }

  private loadDescriptorFromPath(pluginPath: string): JiabaixingPluginDescriptor | null {
    const manifestFiles = [
      'jiabaixing.plugin.json',
      'plugin.json',
      'manifest.json',
      'package.json',
    ];

    for (const file of manifestFiles) {
      const fullPath = path.join(pluginPath, file);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const raw = JSON.parse(content);

          if (file === 'package.json') {
            return {
              specVersion: 1,
              id: raw.name ?? path.basename(pluginPath),
              name: raw.name ?? path.basename(pluginPath),
              version: raw.version ?? '0.0.0',
              description: raw.description ?? '',
              author: raw.author,
              homepage: raw.homepage,
              main: raw.main ?? 'index.js',
              source: 'local',
              permissions: [],
              provides: {},
              sandbox: { enabled: false, permissions: [] },
            };
          }

          return raw as JiabaixingPluginDescriptor;
        } catch (error) {
          Logger.warn(
            `读取 ${fullPath} 失败: ${(error as Error).message}`,
            'PluginManager'
          );
        }
      }
    }

    return null;
  }

  private saveDescriptor(descriptor: JiabaixingPluginDescriptor, installPath: string): void {
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }

    const manifestPath = path.join(installPath, 'jiabaixing.plugin.json');
    fs.writeFileSync(manifestPath, JSON.stringify(descriptor, null, 2), 'utf-8');
  }

  private convertToManifest(descriptor: JiabaixingPluginDescriptor): PluginManifest {
    return {
      id: descriptor.id,
      name: descriptor.name,
      version: descriptor.version,
      description: descriptor.description,
      author: descriptor.author,
      homepage: descriptor.homepage,
      main: descriptor.main,
      icon: descriptor.icon,
      permissions: descriptor.permissions,
      hooks: descriptor.provides.hooks as any,
      settings: descriptor.settings,
    };
  }

  private async loadLifecycle(installPath: string, descriptor: JiabaixingPluginDescriptor): Promise<PluginLifecycle | null> {
    const mainPath = path.join(installPath, descriptor.main);
    if (!fs.existsSync(mainPath)) {
      Logger.debug(`插件入口不存在: ${mainPath}`, 'PluginManager');
      return null;
    }

    try {
      const module = await import(mainPath);
      if (typeof module === 'function') {
        return module as unknown as PluginLifecycle;
      }
      if (module && typeof module === 'object') {
        return (module.default ?? module) as PluginLifecycle;
      }
      return null;
    } catch (error) {
      Logger.warn(
        `加载插件模块 ${mainPath} 失败: ${(error as Error).message}`,
        'PluginManager'
      );
      return null;
    }
  }

  private checkDependencies(descriptor: JiabaixingPluginDescriptor): {
    satisfied: boolean;
    missing: string[];
  } {
    const missing: string[] = [];

    if (descriptor.dependencies) {
      for (const dep of descriptor.dependencies) {
        const installed = this.installed.get(dep.pluginId);
        if (!installed && !dep.optional) {
          missing.push(dep.pluginId);
        }
      }
    }

    return { satisfied: missing.length === 0, missing };
  }

  private findDependents(pluginId: string): string[] {
    const dependents: string[] = [];

    for (const [id, installed] of this.installed) {
      if (id === pluginId) continue;
      if (installed.descriptor.dependencies?.some((d) => d.pluginId === pluginId)) {
        dependents.push(id);
      }
    }

    return dependents;
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const installed = this.installed.get(id);
      if (installed?.descriptor.dependencies) {
        for (const dep of installed.descriptor.dependencies) {
          if (this.installed.has(dep.pluginId)) {
            visit(dep.pluginId);
          }
        }
      }

      result.push(id);
    };

    for (const id of this.installed.keys()) {
      visit(id);
    }

    return result;
  }

  private cleanupInstallDir(installPath: string): void {
    if (fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
  }
}

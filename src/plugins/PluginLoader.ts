/**
 * PluginLoader — 插件发现与加载器
 *
 * 扫描 data/plugins/ 目录，解析 plugin.yaml，动态加载 index.ts。
 * 支持 requires_env 检查、按平台启用/禁用。
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger';
import { PluginContext } from './PluginContext';

/** plugin.yaml 结构 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  requires_env?: Array<
    | string
    | { name: string; description?: string; url?: string; secret?: boolean }
  >;
  provides_tools?: string[];
  provides_hooks?: string[];
  provides_commands?: string[];
}

/** 已加载的插件实例 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  context: PluginContext;
  /** 是否因环境变量缺失被禁用 */
  disabled?: boolean;
  /** 禁用原因 */
  disableReason?: string;
}

/** 错误码 */
const ERR_MODULE_NOT_FOUND = 'MODULE_NOT_FOUND';

export class PluginLoader {
  private pluginsDir: string;
  private loaded = new Map<string, LoadedPlugin>();

  constructor(pluginsDir?: string) {
    this.pluginsDir =
      pluginsDir || path.resolve(process.cwd(), 'data', 'plugins');
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  /** 扫描并加载所有插件 */
  async loadAll(): Promise<LoadedPlugin[]> {
    const results: LoadedPlugin[] = [];

    // 扫描一级目录: data/plugins/<name>/
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    } catch {
      Logger.warn(`⚠️ 无法扫描插件目录: ${this.pluginsDir}`, 'PluginLoader');
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const pluginDir = path.join(this.pluginsDir, entry.name);
      const loaded = await this.loadPlugin(pluginDir);
      if (loaded) {
        results.push(loaded);
        this.loaded.set(loaded.manifest.name, loaded);
      }
    }

    Logger.info(
      `🔌 插件加载完成: ${results.filter((p) => !p.disabled).length} 个活跃, ${results.filter((p) => p.disabled).length} 个禁用`,
      'PluginLoader'
    );
    return results;
  }

  /** 加载单个插件 */
  async loadPlugin(pluginDir: string): Promise<LoadedPlugin | null> {
    const manifestPath = path.join(pluginDir, 'plugin.yaml');
    if (!fs.existsSync(manifestPath)) {
      return null; // 没有 plugin.yaml 就跳过
    }

    // 解析 manifest
    let manifest: PluginManifest;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      manifest = this.parseYaml(raw);
    } catch {
      Logger.warn(`⚠️ 插件清单解析失败: ${pluginDir}`, 'PluginLoader');
      return null;
    }

    if (!manifest.name) {
      Logger.warn(`⚠️ 插件缺少 name 字段: ${pluginDir}`, 'PluginLoader');
      return null;
    }

    // 检查环境变量
    const envCheck = this.checkEnvRequirements(manifest);
    if (!envCheck.ok) {
      Logger.info(
        `🔌 插件 ${manifest.name} 已禁用 (${envCheck.reason})`,
        'PluginLoader'
      );
      return {
        manifest,
        context: new PluginContext(manifest.name, manifest.version || '0.0.0'),
        disabled: true,
        disableReason: envCheck.reason,
      };
    }

    // 动态加载 index.ts
    const ctx = new PluginContext(manifest.name, manifest.version || '0.0.0');
    const indexPath = path.join(pluginDir, 'index.ts');

    if (!fs.existsSync(indexPath)) {
      Logger.warn(`⚠️ 插件 ${manifest.name} 缺少 index.ts`, 'PluginLoader');
      return {
        manifest,
        context: ctx,
        disabled: true,
        disableReason: '缺少 index.ts',
      };
    }

    try {
      // 动态 import — tsx 支持运行时加载 .ts 文件
      const mod = await this.dynamicImport(indexPath);

      if (typeof mod.register === 'function') {
        await mod.register(ctx);
        Logger.info(
          `🔌 插件已加载: ${manifest.name} v${manifest.version || '0.0.0'} (${ctx.getRegisteredTools().length} 工具, ${ctx.getRegisteredHooks().length} 钩子, ${ctx.getRegisteredCommands().length} 命令)`,
          'PluginLoader'
        );
      } else {
        Logger.warn(
          `⚠️ 插件 ${manifest.name} 的 index.ts 未导出 register 函数`,
          'PluginLoader'
        );
        return {
          manifest,
          context: ctx,
          disabled: true,
          disableReason: '未导出 register 函数',
        };
      }
    } catch (err: unknown) {
      // MODULE_NOT_FOUND 可能因为 tsx 未就绪
      if ((err as NodeJS.ErrnoException).code === ERR_MODULE_NOT_FOUND) {
        Logger.warn(
          `⚠️ 插件 ${manifest.name} 加载失败，依赖可能缺失。尝试直接加载 JS 版本。`,
          'PluginLoader'
        );
        // 回退到 .js
        try {
          const jsPath = path.join(pluginDir, 'index.js');
          if (fs.existsSync(jsPath)) {
            const mod = require(jsPath);
            if (typeof mod.register === 'function') {
              await mod.register(ctx);
              Logger.info(
                `🔌 插件已加载 (JS): ${manifest.name}`,
                'PluginLoader'
              );
            }
          }
        } catch (jsErr) {
          Logger.error(
            `❌ 插件加载失败: ${manifest.name}`,
            jsErr as Error,
            'PluginLoader'
          );
          return null;
        }
        return {
          manifest,
          context: ctx,
          disabled: true,
          disableReason: `加载失败: ${(err as Error).message}`,
        };
      }

      Logger.error(
        `❌ 插件加载失败: ${manifest.name}`,
        err as Error,
        'PluginLoader'
      );
      return {
        manifest,
        context: ctx,
        disabled: true,
        disableReason: `异常: ${(err as Error).message}`,
      };
    }

    return { manifest, context: ctx };
  }

  /** 绑定系统服务到已加载的插件 */
  bindServices(): void {
    const { ToolRegistry } = require('../harness/tools/registry/ToolRegistry');
    const { HookManager } = require('../harness/hooks/HookManager');
    const { IntegrationManager } = require('../integration/IntegrationManager');

    const toolRegistry = ToolRegistry.getInstance();
    const hookManager = HookManager.getInstance();
    const im = IntegrationManager.getInstance();
    const slashRegistry = im.getSlashCommandRegistry();

    for (const [, plugin] of this.loaded) {
      if (plugin.disabled) continue;
      plugin.context.setToolRegistry(toolRegistry);
      plugin.context.setHookManager(hookManager);
      plugin.context.setSlashRegistry(slashRegistry);

      // 重新注册工具（这次会进入 ToolRegistry）
      for (const tool of plugin.context.getRegisteredTools()) {
        plugin.context.registerTool(tool);
      }
      // 重新注册钩子
      for (const hook of plugin.context.getRegisteredHooks()) {
        plugin.context.registerHook(hook);
      }
      // 重新注册命令
      for (const cmd of plugin.context.getRegisteredCommands()) {
        plugin.context.registerCommand(cmd);
      }
    }
  }

  /** 获取已加载的插件列表 */
  getLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.loaded.values());
  }

  /** 按名称获取插件 */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.loaded.get(name);
  }

  // ==================== 内部方法 ====================

  /** 简易 YAML 解析（仅支持 plugin.yaml 需要的子集） */
  private parseYaml(raw: string): PluginManifest {
    const result: any = {};
    const lines = raw.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // 标量值: key: value
      const scalarMatch = trimmed.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (scalarMatch) {
        const key = scalarMatch[1];
        let value: any = scalarMatch[2].trim();
        // 去掉引号
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        result[key] = value;
        continue;
      }

      // 列表项: - value
      const listMatch = trimmed.match(/^-\s+(.*)$/);
      if (listMatch) {
        if (!result.provides_tools) result.provides_tools = [];
        // 需要根据上下文判断是 tools, hooks 还是 env
        // 简化为统一处理
        continue;
      }
    }

    // 手动处理多行结构 (requires_env, provides_tools 等)
    result.provides_tools = this.parseListField(raw, 'provides_tools');
    result.provides_hooks = this.parseListField(raw, 'provides_hooks');
    result.provides_commands = this.parseListField(raw, 'provides_commands');
    result.requires_env = this.parseRequiresEnv(raw);

    return result as PluginManifest;
  }

  private parseListField(raw: string, field: string): string[] {
    const regex = new RegExp(`${field}:`);
    if (!regex.test(raw)) return [];

    const results: string[] = [];
    const lines = raw.split('\n');
    let inField = false;

    for (const line of lines) {
      if (line.trim().startsWith(`${field}:`)) {
        inField = true;
        continue;
      }
      if (inField) {
        const itemMatch = line.trim().match(/^-\s+(.*)$/);
        if (itemMatch) {
          results.push(itemMatch[1].trim());
        } else if (line.trim().startsWith('#') || line.trim() === '') {
          continue;
        } else if (/^[\w_-]+:/.test(line.trim())) {
          inField = false; // 下一个字段
        } else {
          inField = false;
        }
      }
    }
    return results;
  }

  private parseRequiresEnv(
    raw: string
  ): Array<
    | string
    | { name: string; description?: string; url?: string; secret?: boolean }
  > {
    if (!/requires_env:/.test(raw)) return [];

    const results: Array<
      | string
      | { name: string; description?: string; url?: string; secret?: boolean }
    > = [];
    const lines = raw.split('\n');
    let inField = false;

    for (const line of lines) {
      if (line.trim().startsWith('requires_env:')) {
        inField = true;
        continue;
      }
      if (inField) {
        const trimmed = line.trim();
        // 简单格式: - NAME
        const simpleMatch = trimmed.match(/^-\s+(\w+)$/);
        if (simpleMatch) {
          results.push(simpleMatch[1]);
          continue;
        }
        // 富格式: - name: NAME
        const richMatch = trimmed.match(/^-\s+name:\s*['"]?(\w+)['"]?$/);
        if (richMatch) {
          results.push({ name: richMatch[1] });
          continue;
        }
        if (trimmed.startsWith('#') || trimmed === '') continue;
        if (/^[\w_-]+:/.test(trimmed) && !trimmed.startsWith('-')) {
          inField = false;
        }
      }
    }
    return results;
  }

  /** 检查环境变量要求 */
  private checkEnvRequirements(manifest: PluginManifest): {
    ok: boolean;
    reason?: string;
  } {
    if (!manifest.requires_env || manifest.requires_env.length === 0) {
      return { ok: true };
    }

    const missing: string[] = [];
    for (const req of manifest.requires_env) {
      const name = typeof req === 'string' ? req : req.name;
      if (!process.env[name]) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      return {
        ok: false,
        reason: `缺少环境变量: ${missing.join(', ')}`,
      };
    }
    return { ok: true };
  }

  /** 动态加载模块（支持 .ts 和 .js） */
  private async dynamicImport(filePath: string): Promise<any> {
    // 对于 .ts 文件，如果 tsx/jiti 可用则用，否则回退到 require
    try {
      return await import(filePath);
    } catch {
      // 回退到 require
      return require(filePath);
    }
  }
}

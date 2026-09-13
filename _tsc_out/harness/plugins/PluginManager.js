"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../utils/Logger");
const JiabaixingPluginSpec_1 = require("./JiabaixingPluginSpec");
const DEFAULT_PLUGIN_DIR = '.jiabaixing/plugins';
class PluginManager {
    pluginDir;
    installed = new Map();
    registry;
    lifecycleCache = new Map();
    constructor(registry, pluginDir) {
        this.registry = registry;
        this.pluginDir = pluginDir ?? path_1.default.join(process.cwd(), DEFAULT_PLUGIN_DIR);
        this.ensurePluginDir();
    }
    async install(descriptorOrPath, options) {
        let descriptor;
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
        }
        else {
            descriptor = descriptorOrPath;
        }
        descriptor.source = options.source;
        if (options.sourceUrl) {
            descriptor.sourceUrl = options.sourceUrl;
        }
        const validation = JiabaixingPluginSpec_1.JiabaixingPluginSpec.validate(descriptor);
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
            const existing = this.installed.get(descriptor.id);
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
        const installPath = path_1.default.join(this.pluginDir, descriptor.id);
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
        const installedPlugin = {
            descriptor,
            status: 'installed',
            installedAt: Date.now(),
            installedFrom: options.source,
            installPath,
        };
        this.installed.set(descriptor.id, installedPlugin);
        Logger_1.Logger.info(`📦 插件已安装: ${descriptor.id}@${descriptor.version} (来源: ${options.source})`, 'PluginManager');
        return {
            success: true,
            pluginId: descriptor.id,
            message: `插件 ${descriptor.id}@${descriptor.version} 安装成功`,
            warnings: validation.warnings,
        };
    }
    async load(pluginId) {
        const installed = this.installed.get(pluginId);
        if (!installed) {
            Logger_1.Logger.warn(`插件 ${pluginId} 未安装`, 'PluginManager');
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
                Logger_1.Logger.info(`🔌 插件已加载: ${pluginId}`, 'PluginManager');
            }
            else {
                installed.status = 'error';
                installed.error = 'loadPlugin 返回 false';
            }
            return success;
        }
        catch (error) {
            installed.status = 'error';
            installed.error = error.message;
            Logger_1.Logger.error(`插件 ${pluginId} 加载失败: ${error.message}`, error, 'PluginManager');
            return false;
        }
    }
    async unload(pluginId) {
        const installed = this.installed.get(pluginId);
        if (!installed)
            return false;
        const success = await this.registry.unloadPlugin(pluginId);
        if (success) {
            installed.status = 'installed';
            this.lifecycleCache.delete(pluginId);
        }
        return success;
    }
    async remove(pluginId) {
        const installed = this.installed.get(pluginId);
        if (!installed) {
            Logger_1.Logger.warn(`插件 ${pluginId} 未安装`, 'PluginManager');
            return false;
        }
        if (installed.status === 'active' || installed.status === 'loaded') {
            await this.unload(pluginId);
        }
        const dependents = this.findDependents(pluginId);
        if (dependents.length > 0) {
            Logger_1.Logger.warn(`插件 ${pluginId} 被以下插件依赖: ${dependents.join(', ')}，请先卸载依赖方`, 'PluginManager');
            return false;
        }
        try {
            this.cleanupInstallDir(installed.installPath);
        }
        catch (error) {
            Logger_1.Logger.warn(`清理插件目录失败: ${error.message}`, 'PluginManager');
        }
        this.installed.delete(pluginId);
        this.lifecycleCache.delete(pluginId);
        Logger_1.Logger.info(`🗑️ 插件已移除: ${pluginId}`, 'PluginManager');
        return true;
    }
    list(filter) {
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
            result = result.filter((p) => p.descriptor.permissions.includes(filter.hasPermission));
        }
        return result;
    }
    get(pluginId) {
        return this.installed.get(pluginId) ?? null;
    }
    getStatus(pluginId) {
        return this.installed.get(pluginId)?.status ?? null;
    }
    async loadAll() {
        let loaded = 0;
        let failed = 0;
        const sortedPlugins = this.topologicalSort();
        for (const pluginId of sortedPlugins) {
            const installed = this.installed.get(pluginId);
            if (!installed || installed.status === 'active')
                continue;
            const success = await this.load(pluginId);
            if (success) {
                loaded++;
            }
            else {
                failed++;
            }
        }
        Logger_1.Logger.info(`🔌 批量加载完成: ${loaded} 成功, ${failed} 失败`, 'PluginManager');
        return { loaded, failed };
    }
    async unloadAll() {
        for (const [pluginId, installed] of this.installed) {
            if (installed.status === 'active') {
                await this.unload(pluginId);
            }
        }
    }
    scanAndInstall() {
        let count = 0;
        if (!fs_1.default.existsSync(this.pluginDir))
            return 0;
        const entries = fs_1.default.readdirSync(this.pluginDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const manifestPath = path_1.default.join(this.pluginDir, entry.name, 'jiabaixing.plugin.json');
            if (fs_1.default.existsSync(manifestPath)) {
                try {
                    const content = fs_1.default.readFileSync(manifestPath, 'utf-8');
                    const descriptor = JSON.parse(content);
                    if (!this.installed.has(descriptor.id)) {
                        this.installed.set(descriptor.id, {
                            descriptor,
                            status: 'installed',
                            installedAt: Date.now(),
                            installedFrom: descriptor.source ?? 'local',
                            installPath: path_1.default.join(this.pluginDir, entry.name),
                        });
                        count++;
                    }
                }
                catch (error) {
                    Logger_1.Logger.warn(`扫描插件 ${entry.name} 失败: ${error.message}`, 'PluginManager');
                }
            }
        }
        if (count > 0) {
            Logger_1.Logger.info(`📦 扫描发现 ${count} 个新插件`, 'PluginManager');
        }
        return count;
    }
    ensurePluginDir() {
        if (!fs_1.default.existsSync(this.pluginDir)) {
            try {
                fs_1.default.mkdirSync(this.pluginDir, { recursive: true });
            }
            catch {
                Logger_1.Logger.warn(`无法创建插件目录: ${this.pluginDir}`, 'PluginManager');
            }
        }
    }
    loadDescriptorFromPath(pluginPath) {
        const resolved = path_1.default.resolve(pluginPath);
        const projectRoot = path_1.default.resolve(process.cwd());
        if (!resolved.startsWith(projectRoot)) {
            Logger_1.Logger.warn(`插件路径超出项目范围: ${pluginPath}`, 'PluginManager');
            return null;
        }
        const manifestFiles = [
            'jiabaixing.plugin.json',
            'plugin.json',
            'manifest.json',
            'package.json',
        ];
        for (const file of manifestFiles) {
            const fullPath = path_1.default.join(pluginPath, file);
            if (fs_1.default.existsSync(fullPath)) {
                try {
                    const content = fs_1.default.readFileSync(fullPath, 'utf-8');
                    const raw = JSON.parse(content);
                    if (file === 'package.json') {
                        return {
                            specVersion: 1,
                            id: raw.name ?? path_1.default.basename(pluginPath),
                            name: raw.name ?? path_1.default.basename(pluginPath),
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
                    return raw;
                }
                catch (error) {
                    Logger_1.Logger.warn(`读取 ${fullPath} 失败: ${error.message}`, 'PluginManager');
                }
            }
        }
        return null;
    }
    saveDescriptor(descriptor, installPath) {
        if (!fs_1.default.existsSync(installPath)) {
            fs_1.default.mkdirSync(installPath, { recursive: true });
        }
        const manifestPath = path_1.default.join(installPath, 'jiabaixing.plugin.json');
        fs_1.default.writeFileSync(manifestPath, JSON.stringify(descriptor, null, 2), 'utf-8');
    }
    convertToManifest(descriptor) {
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
            hooks: descriptor.provides.hooks,
            settings: descriptor.settings,
        };
    }
    async loadLifecycle(installPath, descriptor) {
        const mainPath = path_1.default.join(installPath, descriptor.main);
        if (!fs_1.default.existsSync(mainPath)) {
            Logger_1.Logger.debug(`插件入口不存在: ${mainPath}`, 'PluginManager');
            return null;
        }
        try {
            const module = await Promise.resolve(`${mainPath}`).then(s => __importStar(require(s)));
            if (typeof module === 'function') {
                return module;
            }
            if (module && typeof module === 'object') {
                return (module.default ?? module);
            }
            return null;
        }
        catch (error) {
            Logger_1.Logger.warn(`加载插件模块 ${mainPath} 失败: ${error.message}`, 'PluginManager');
            return null;
        }
    }
    checkDependencies(descriptor) {
        const missing = [];
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
    findDependents(pluginId) {
        const dependents = [];
        for (const [id, installed] of this.installed) {
            if (id === pluginId)
                continue;
            if (installed.descriptor.dependencies?.some((d) => d.pluginId === pluginId)) {
                dependents.push(id);
            }
        }
        return dependents;
    }
    topologicalSort() {
        const visited = new Set();
        const result = [];
        const visit = (id) => {
            if (visited.has(id))
                return;
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
    cleanupInstallDir(installPath) {
        if (fs_1.default.existsSync(installPath)) {
            fs_1.default.rmSync(installPath, { recursive: true, force: true });
        }
    }
}
exports.PluginManager = PluginManager;

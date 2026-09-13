"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HarnessConfigManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../utils/Logger");
const DEFAULT_LAYER_CONFIGS = {
    tools: { implementation: 'builtin', enabled: true, config: {} },
    context: { implementation: 'unified-pipeline', enabled: true, config: {} },
    persistence: { implementation: 'event-sourcing', enabled: true, config: {} },
    verification: { implementation: 'builtin', enabled: true, config: {} },
    constraints: { implementation: 'builtin', enabled: true, config: {} },
    loop: { implementation: 'python-backend', enabled: true, config: {} },
};
const DEFAULT_CONFIG = {
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
class HarnessConfigManager {
    config;
    configPath = null;
    watchers = [];
    constructor(configPath) {
        this.config = { ...DEFAULT_CONFIG };
        if (configPath) {
            this.configPath = configPath;
        }
    }
    load(configPath) {
        const resolvedPath = configPath ?? this.configPath ?? this.findConfigFile();
        if (!resolvedPath) {
            Logger_1.Logger.info('HarnessConfig: 未找到配置文件，使用默认配置', 'HarnessConfig');
            return this.config;
        }
        this.configPath = resolvedPath;
        try {
            const content = fs_1.default.readFileSync(resolvedPath, 'utf-8');
            const ext = path_1.default.extname(resolvedPath).toLowerCase();
            let parsed;
            if (ext === '.json') {
                parsed = JSON.parse(content);
            }
            else if (ext === '.yaml' || ext === '.yml') {
                parsed = this.parseYaml(content);
            }
            else {
                Logger_1.Logger.warn(`HarnessConfig: 不支持的配置文件格式: ${ext}`, 'HarnessConfig');
                return this.config;
            }
            this.config = this.mergeWithDefaults(parsed);
            Logger_1.Logger.info(`HarnessConfig: 已加载配置 ${resolvedPath}`, 'HarnessConfig');
        }
        catch (error) {
            Logger_1.Logger.warn(`HarnessConfig: 加载配置失败，使用默认配置: ${error.message}`, 'HarnessConfig');
        }
        return this.config;
    }
    save(configPath) {
        const resolvedPath = configPath ?? this.configPath ?? this.getDefaultConfigPath();
        try {
            const dir = path_1.default.dirname(resolvedPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            this.config.metadata.updatedAt = Date.now();
            const ext = path_1.default.extname(resolvedPath).toLowerCase();
            let content;
            if (ext === '.yaml' || ext === '.yml') {
                content = this.serializeYaml(this.config);
            }
            else {
                content = JSON.stringify(this.config, null, 2);
            }
            fs_1.default.writeFileSync(resolvedPath, content, 'utf-8');
            Logger_1.Logger.info(`HarnessConfig: 配置已保存到 ${resolvedPath}`, 'HarnessConfig');
        }
        catch (error) {
            Logger_1.Logger.error('HarnessConfig: 保存配置失败', error, 'HarnessConfig');
        }
    }
    getConfig() {
        return this.config;
    }
    getLayerConfig(layerName) {
        return this.config.layers[layerName] ?? DEFAULT_LAYER_CONFIGS[layerName];
    }
    setLayerConfig(layerName, config) {
        const current = this.getLayerConfig(layerName);
        this.config.layers[layerName] = {
            ...current,
            ...config,
            config: { ...current.config, ...(config.config ?? {}) },
        };
        this.config.metadata.updatedAt = Date.now();
    }
    getLayerImplementation(layerName) {
        return this.getLayerConfig(layerName).implementation;
    }
    isLayerEnabled(layerName) {
        return this.getLayerConfig(layerName).enabled;
    }
    getPlugins() {
        return this.config.plugins.filter((p) => p.enabled);
    }
    addPlugin(plugin) {
        const existing = this.config.plugins.findIndex((p) => p.name === plugin.name);
        if (existing >= 0) {
            this.config.plugins[existing] = plugin;
        }
        else {
            this.config.plugins.push(plugin);
        }
        this.config.metadata.updatedAt = Date.now();
    }
    removePlugin(name) {
        const index = this.config.plugins.findIndex((p) => p.name === name);
        if (index >= 0) {
            this.config.plugins.splice(index, 1);
            this.config.metadata.updatedAt = Date.now();
            return true;
        }
        return false;
    }
    getOverrides() {
        return this.config.overrides;
    }
    applyOverrides() {
        for (const [key, value] of Object.entries(this.config.overrides)) {
            if (process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    }
    watch(callback) {
        const resolvedPath = this.configPath ?? this.getDefaultConfigPath();
        if (!fs_1.default.existsSync(resolvedPath)) {
            return () => { };
        }
        try {
            const watcher = fs_1.default.watch(resolvedPath, (eventType) => {
                if (eventType === 'change') {
                    Logger_1.Logger.info('HarnessConfig: 检测到配置文件变更', 'HarnessConfig');
                    const newConfig = this.load();
                    callback(newConfig);
                }
            });
            this.watchers.push(watcher);
            return () => watcher.close();
        }
        catch {
            return () => { };
        }
    }
    destroy() {
        for (const watcher of this.watchers) {
            watcher.close();
        }
        this.watchers = [];
    }
    findConfigFile() {
        const searchPaths = [
            path_1.default.join(process.cwd(), 'harness.config.yaml'),
            path_1.default.join(process.cwd(), 'harness.config.yml'),
            path_1.default.join(process.cwd(), 'harness.config.json'),
            path_1.default.join(process.cwd(), 'config', 'harness.config.yaml'),
            path_1.default.join(process.cwd(), 'config', 'harness.config.json'),
        ];
        for (const p of searchPaths) {
            if (fs_1.default.existsSync(p)) {
                return p;
            }
        }
        return null;
    }
    getDefaultConfigPath() {
        return path_1.default.join(process.cwd(), 'harness.config.yaml');
    }
    mergeWithDefaults(partial) {
        const layers = {};
        for (const [name, defaultConfig] of Object.entries(DEFAULT_LAYER_CONFIGS)) {
            const layerName = name;
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
    parseYaml(content) {
        try {
            const lines = content.split('\n');
            const result = {};
            const stack = [
                { obj: result, indent: -1 },
            ];
            for (const line of lines) {
                const trimmed = line.trimEnd();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                const indent = line.length - line.trimStart().length;
                const match = trimmed.match(/^(\s*)([\w_-]+):\s*(.*)$/);
                if (!match)
                    continue;
                const key = match[2];
                const value = match[3].trim();
                while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
                    stack.pop();
                }
                const current = stack[stack.length - 1].obj;
                if (value === '' || value === '|' || value === '>') {
                    const newObj = {};
                    current[key] = newObj;
                    stack.push({ obj: newObj, indent });
                }
                else {
                    current[key] = this.parseYamlValue(value);
                }
            }
            return result;
        }
        catch (error) {
            Logger_1.Logger.warn(`HarnessConfig: YAML 解析失败: ${error.message}`, 'HarnessConfig');
            return {};
        }
    }
    parseYamlValue(value) {
        if (value === 'true')
            return true;
        if (value === 'false')
            return false;
        if (value === 'null' || value === '~')
            return null;
        if (/^-?\d+$/.test(value))
            return parseInt(value, 10);
        if (/^-?\d+\.\d+$/.test(value))
            return parseFloat(value);
        if (value.startsWith('"') && value.endsWith('"'))
            return value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'"))
            return value.slice(1, -1);
        if (value.startsWith('[')) {
            try {
                return JSON.parse(value);
            }
            catch {
                return value;
            }
        }
        if (value.startsWith('{')) {
            try {
                return JSON.parse(value);
            }
            catch {
                return value;
            }
        }
        return value;
    }
    serializeYaml(config) {
        const lines = [
            `# Harness Configuration - Auto-generated`,
            `# Updated: ${new Date(config.metadata.updatedAt).toISOString()}`,
            ``,
            `version: ${config.version}`,
            ``,
            `layers:`,
        ];
        for (const [name, layerConfig] of Object.entries(config.layers)) {
            if (!layerConfig)
                continue;
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
    static createDefaultConfig() {
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
}
exports.HarnessConfigManager = HarnessConfigManager;

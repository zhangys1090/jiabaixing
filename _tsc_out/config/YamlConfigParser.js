"use strict";
/**
 * YAML 配置解析器 - 支持环境变量覆盖与热重载
 *
 * 参考 Hermes 的 config.yaml 分层架构：
 *   - YAML 主配置 + .env 环境变量 + 运行时覆盖
 *   - 文件变更自动重载
 *   - 结构化类型安全访问
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.YamlConfigParser = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
const default_config_1 = require("./default.config");
let yamlModule;
/** 懒加载 js-yaml 模块（可选依赖） */
function getYamlModule() {
    if (yamlModule !== undefined)
        return yamlModule ?? null;
    try {
        // 同步 require，避免在 load() 中引入异步
        yamlModule = require('js-yaml');
    }
    catch {
        yamlModule = null;
    }
    return yamlModule ?? null;
}
/**
 * 递归展开对象中的 ${ENV_VAR} 占位符
 */
function expandEnvVars(obj) {
    if (typeof obj === 'string') {
        return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? obj);
    }
    if (Array.isArray(obj))
        return obj.map(expandEnvVars);
    if (obj != null && typeof obj === 'object') {
        const result = {};
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
function deepMerge(a, b) {
    const result = { ...a };
    for (const [key, val] of Object.entries(b)) {
        if (val != null &&
            typeof val === 'object' &&
            !Array.isArray(val) &&
            result[key] != null &&
            typeof result[key] === 'object' &&
            !Array.isArray(result[key])) {
            result[key] = deepMerge(result[key], val);
        }
        else {
            result[key] = val;
        }
    }
    return result;
}
class YamlConfigParser {
    static instance = null;
    mergedConfig;
    configPath;
    envPath;
    watchTimer = null;
    listeners = [];
    lastMtime = 0;
    constructor(options = {}) {
        this.configPath =
            options.configPath ?? path.join(process.cwd(), 'config.yaml');
        this.envPath = options.envPath ?? path.join(process.cwd(), '.env');
        this.mergedConfig = { ...default_config_1.defaultConfig };
        this.load();
        if (options.watch) {
            this.startWatching();
        }
    }
    /** 单例入口 */
    static getInstance(opts) {
        if (!YamlConfigParser.instance) {
            YamlConfigParser.instance = new YamlConfigParser(opts);
        }
        return YamlConfigParser.instance;
    }
    /** 重置单例（用于测试） */
    static resetInstance() {
        if (YamlConfigParser.instance) {
            YamlConfigParser.instance.stopWatching();
            YamlConfigParser.instance = null;
        }
    }
    /** 订阅配置变更 */
    onChange(fn) {
        this.listeners.push(fn);
    }
    /** 获取完整合并后的配置 */
    getConfig() {
        return this.mergedConfig;
    }
    /** 按路径获取配置片段（"server.port" -> 3111） */
    get(dotPath) {
        const keys = dotPath.split('.');
        let current = this.mergedConfig;
        for (const key of keys) {
            if (current == null || typeof current !== 'object')
                return undefined;
            current = current[key];
        }
        return current;
    }
    /** 运行时动态覆盖某个路径的值 */
    set(dotPath, value) {
        const keys = dotPath.split('.');
        let current = this.mergedConfig;
        for (let i = 0; i < keys.length - 1; i++) {
            const next = current[keys[i]];
            if (!next || typeof next !== 'object') {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;
        this.notifyListeners();
    }
    // ---- 内部方法 ----
    load() {
        const yaml = getYamlModule();
        // 1. 基础 = 默认配置
        let merged = { ...default_config_1.defaultConfig };
        // 2. 合并 .env
        try {
            if (fs.existsSync(this.envPath)) {
                const envContent = fs.readFileSync(this.envPath, 'utf-8');
                for (const line of envContent.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#'))
                        continue;
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx <= 0)
                        continue;
                    const key = trimmed.slice(0, eqIdx).trim();
                    let val = trimmed.slice(eqIdx + 1).trim();
                    // 去掉引号
                    if ((val.startsWith('"') && val.endsWith('"')) ||
                        (val.startsWith("\'") && val.endsWith("\'"))) {
                        val = val.slice(1, -1);
                    }
                    // 将 KEY=VAL 映射到 dot-path
                    this.applyEnvToConfig(merged, key, val);
                }
            }
        }
        catch (err) {
            Logger_1.Logger.warn(`[YamlConfigParser] Failed to load .env: ${err.message}`);
        }
        // 3. 合并 YAML 配置
        if (yaml && fs.existsSync(this.configPath)) {
            try {
                const yamlContent = fs.readFileSync(this.configPath, 'utf-8');
                const parsed = yaml.safeLoad(yamlContent);
                if (parsed && typeof parsed === 'object') {
                    merged = deepMerge(merged, parsed);
                }
            }
            catch (err) {
                Logger_1.Logger.warn(`[YamlConfigParser] Failed to parse YAML: ${err.message}`);
            }
        }
        // 4. 环境变量覆盖（优先级最高）
        merged = expandEnvVars(merged);
        this.mergedConfig = merged;
        try {
            this.lastMtime = fs.statSync(this.configPath).mtimeMs;
        }
        catch {
            /* ignore */
        }
        Logger_1.Logger.info('[YamlConfigParser] Configuration loaded and merged');
    }
    /**
     * 将 KEY=VALUE 形式的 env 变量映射到嵌套配置路径
     * 例如 LLM_MODEL=claude-3 -> model.defaultModel = "claude-3"
     * DATABASE_HOST=db.local -> database.host = "db.local"
     */
    applyEnvToConfig(config, envKey, value) {
        // 直接匹配顶层键
        if (envKey in config) {
            config[envKey] = this.coerceValue(value);
            return;
        }
        // 尝试映射: LLM_MODEL -> model.defaultModel
        const mappings = {
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
                if (!(key in current))
                    current[key] = {};
                current = current[key];
            }
            current[keys[keys.length - 1]] = this.coerceValue(value);
        }
    }
    coerceValue(val) {
        if (val === 'true')
            return true;
        if (val === 'false')
            return false;
        if (/^\d+$/.test(val))
            return Number(val);
        return val;
    }
    startWatching() {
        this.stopWatching();
        this.watchTimer = setInterval(() => {
            try {
                const stat = fs.statSync(this.configPath);
                if (stat.mtimeMs !== this.lastMtime) {
                    this.load();
                    Logger_1.Logger.info('[YamlConfigParser] Config file changed, hot-reloaded');
                }
            }
            catch {
                // File may not exist yet; ignore
            }
        }, 5000);
    }
    stopWatching() {
        if (this.watchTimer) {
            clearInterval(this.watchTimer);
            this.watchTimer = null;
        }
    }
    notifyListeners() {
        for (const fn of this.listeners) {
            try {
                fn();
            }
            catch (err) {
                Logger_1.Logger.error('监听器执行失败', err, 'YamlConfigParser');
            }
        }
    }
    /** 清理资源 */
    dispose() {
        this.stopWatching();
        this.listeners = [];
    }
}
exports.YamlConfigParser = YamlConfigParser;

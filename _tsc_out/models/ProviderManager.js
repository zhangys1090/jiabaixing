"use strict";
/**
 * Provider 配置系统
 *
 * 管理 LLM Provider 的注册、存储、切换
 * 取代原有的 .env 环境变量方式
 *
 * 配置文件: data/providers.json
 * 支持多 provider 并行注册，每个 provider 可选为主模型或备用
 *
 * @deprecated 已迁移到 Python agent/llm/router.py。当 AGENT_BACKEND=python（默认）时不再使用此文件。
 *   回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现。
 *   迁移日期：2026-06-22
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
exports.CredentialPool = exports.ProviderManager = void 0;
exports.getProviderManager = getProviderManager;
const deprecationWarning_1 = require("../shared/deprecationWarning");
(0, deprecationWarning_1.emitDeprecationWarning)('ProviderManager', 'Python agent/llm/router.py (AGENT_BACKEND=python)', 'V6.0');
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
class ProviderManager {
    configPath;
    store;
    constructor(dataDir) {
        const dir = dataDir || path.join(process.cwd(), 'data');
        this.configPath = path.join(dir, 'providers.json');
        this.store = this.load();
    }
    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf-8');
                const parsed = JSON.parse(raw);
                return {
                    providers: parsed.providers ?? [],
                    primary: parsed.primary ?? null,
                    routingEnabled: parsed.routingEnabled ?? false,
                    routing: {
                        simpleTaskProviders: parsed.routing?.simpleTaskProviders ?? [],
                        complexTaskProviders: parsed.routing?.complexTaskProviders ?? [],
                        simpleTaskMaxLength: parsed.routing?.simpleTaskMaxLength ?? 200,
                    },
                    blockedProviders: parsed.blockedProviders ?? [],
                    sortStrategy: parsed.sortStrategy ?? 'priority',
                };
            }
        }
        catch (e) {
            Logger_1.Logger.warn(`Provider 配置文件加载失败: ${e.message}`, 'ProviderManager');
        }
        return {
            providers: [],
            primary: null,
            routingEnabled: false,
            routing: {
                simpleTaskProviders: [],
                complexTaskProviders: [],
                simpleTaskMaxLength: 200,
            },
            blockedProviders: [],
            sortStrategy: 'priority',
        };
    }
    save() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configPath, JSON.stringify(this.store, null, 2), 'utf-8');
        }
        catch (e) {
            Logger_1.Logger.error(`Provider 配置保存失败`, e, 'ProviderManager');
        }
    }
    /** 从 .env 导入已有配置（仅当 providers 为空时） */
    importFromEnv() {
        if (this.store.providers.length > 0)
            return; // 已有配置，不覆盖
        const providers = [];
        // 小米 MiMo
        if (process.env.XIAOMI_API_KEY &&
            process.env.XIAOMI_API_KEY !== '***' &&
            process.env.XIAOMI_API_KEY !== '...') {
            providers.push({
                name: 'xiaomi',
                displayName: '小米 MiMo',
                baseUrl: process.env.XIAOMI_BASE_URL ||
                    'https://token-plan-cn.xiaomimimo.com/v1',
                apiKey: process.env.XIAOMI_API_KEY,
                model: process.env.XIAOMI_MODEL || 'mimo-v2.5-pro',
                enabled: true,
                priority: 0,
            });
        }
        // DeepSeek
        const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
        if (deepseekKey &&
            deepseekKey !== '***' &&
            deepseekKey !== '...' &&
            deepseekKey !== 'your_z...here') {
            providers.push({
                name: 'deepseek',
                displayName: 'DeepSeek',
                baseUrl: process.env.OPENAI_API_BASE || 'https://api.deepseek.com',
                apiKey: deepseekKey,
                model: process.env.LLM_MODEL || 'deepseek-v4-flash',
                enabled: true,
                priority: 1,
                extra: {
                    thinkingMode: process.env.DEEPSEEK_THINKING_MODE || 'disabled',
                    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || 'high',
                },
            });
        }
        // 智谱 GLM
        if (process.env.ZHIPU_API_KEY &&
            process.env.ZHIPU_API_KEY !== 'your_z...here') {
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
                this.store.routing.simpleTaskProviders = [
                    providers[providers.length - 1].name,
                ];
                this.store.routing.complexTaskProviders = [providers[0].name];
            }
            this.save();
            Logger_1.Logger.info(`从 .env 导入 ${providers.length} 个 Provider: ${providers.map((p) => p.displayName).join(', ')}`, 'ProviderManager');
        }
    }
    /** 注册一个新的 Provider */
    register(config) {
        const existing = this.store.providers.findIndex((p) => p.name === config.name);
        const entry = { ...config, enabled: true };
        if (existing >= 0) {
            this.store.providers[existing] = entry;
        }
        else {
            this.store.providers.push(entry);
        }
        if (!this.store.primary) {
            this.store.primary = config.name;
        }
        this.save();
    }
    /** 获取所有 Provider */
    getAll() {
        return this.store.providers.filter((p) => p.enabled);
    }
    /** 按 name 获取 Provider */
    get(name) {
        return this.store.providers.find((p) => p.name === name);
    }
    /** 获取主模型 Provider */
    getPrimary() {
        if (this.store.primary) {
            return this.get(this.store.primary);
        }
        return (this.store.providers.find((p) => p.priority === 0) ||
            this.store.providers[0]);
    }
    /** 设置主模型 */
    setPrimary(name) {
        const p = this.get(name);
        if (!p)
            return false;
        this.store.primary = name;
        this.save();
        return true;
    }
    /** 启用/禁用 Provider */
    setEnabled(name, enabled) {
        const p = this.store.providers.find((p) => p.name === name);
        if (!p)
            return false;
        p.enabled = enabled;
        this.save();
        return true;
    }
    /** 封禁 Provider（已封禁返回 false） */
    blockProvider(name) {
        const p = this.store.providers.find((p) => p.name === name);
        if (!p)
            return false;
        if (this.store.blockedProviders.includes(name))
            return false;
        this.store.blockedProviders.push(name);
        this.save();
        return true;
    }
    /** 解封 Provider */
    unblockProvider(name) {
        const idx = this.store.blockedProviders.indexOf(name);
        if (idx === -1)
            return false;
        this.store.blockedProviders.splice(idx, 1);
        this.save();
        return true;
    }
    /** 获取被封禁的 provider 名称列表 */
    getBlockedProviders() {
        return [...this.store.blockedProviders];
    }
    /** 设置排序策略 */
    setSortStrategy(strategy) {
        this.store.sortStrategy = strategy;
        this.save();
    }
    /** 更新健康状态 */
    updateHealth(name, healthy) {
        const p = this.store.providers.find((p) => p.name === name);
        if (!p)
            return;
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
    isSimpleTask(input) {
        const len = input.length;
        const maxLen = this.store.routing.simpleTaskMaxLength;
        // 短文本大概率是简单任务
        if (len < maxLen)
            return true;
        // 包含以下关键词认为是简单任务
        const simpleKeywords = [
            '你好',
            'hi',
            'hello',
            '再见',
            'bye',
            '谢谢',
            '时间',
            '天气',
            '日期',
            '现在几点',
            '/help',
            '/status',
        ];
        for (const kw of simpleKeywords) {
            if (input.trim().toLowerCase().startsWith(kw))
                return true;
        }
        // 包含以下关键词认为是复杂任务
        const complexKeywords = [
            '代码',
            '代码审查',
            '重构',
            '分析',
            '写一个',
            '编写',
            '修改',
            'debug',
            '规划',
            '计划',
            '设计',
        ];
        for (const kw of complexKeywords) {
            if (input.includes(kw))
                return false;
        }
        return len < 50;
    }
    /** 根据任务复杂度获取应使用的 provider 列表 */
    getProvidersForInput(input) {
        if (!this.store.routingEnabled) {
            const primary = this.getPrimary();
            if (primary && !this.store.blockedProviders.includes(primary.name)) {
                return [primary];
            }
            // 主模型被封禁，fallback 到其他已启用的 provider
            return this.getAll().filter((p) => p.enabled && !this.store.blockedProviders.includes(p.name));
        }
        const isSimple = this.isSimpleTask(input);
        const names = isSimple
            ? this.store.routing.simpleTaskProviders
            : this.store.routing.complexTaskProviders;
        const providers = names
            .map((n) => this.get(n))
            .filter((p) => p !== undefined &&
            p.enabled &&
            !this.store.blockedProviders.includes(p.name));
        // 如果指定列表为空，fallback 到已启用的所有 provider（排除封禁）
        return providers.length > 0
            ? providers
            : this.getAll().filter((p) => p.enabled && !this.store.blockedProviders.includes(p.name));
    }
    /** 导出为 API 友好的格式 */
    toJSON() {
        return {
            ...this.store,
            providers: this.store.providers.map((p) => ({ ...p, apiKey: '***' })),
        };
    }
    // ===== Tool Gateway 配置（Nous Portal 集成） =====
    getToolGatewayStatus() {
        const gateway = this.store.toolGateway;
        const toolNames = ['web', 'imageGen', 'tts', 'browser'];
        return {
            hasToken: !!gateway?.userToken,
            tools: toolNames.map((name) => ({
                name,
                useGateway: gateway?.tools?.[name]?.useGateway ?? false,
                backend: gateway?.tools?.[name]?.backend ?? 'default',
            })),
        };
    }
    updateToolGateway(config) {
        const store = this.store;
        if (!store.toolGateway) {
            store.toolGateway = { userToken: '', tools: {} };
        }
        if (config.userToken !== undefined) {
            store.toolGateway.userToken = config.userToken;
        }
        if (config.tools) {
            store.toolGateway.tools = { ...store.toolGateway.tools, ...config.tools };
        }
        this.save();
    }
    updateToolGatewayTool(toolName, config) {
        const store = this.store;
        if (!store.toolGateway) {
            store.toolGateway = { userToken: '', tools: {} };
        }
        if (!store.toolGateway.tools) {
            store.toolGateway.tools = {};
        }
        const existing = store.toolGateway.tools[toolName] || {};
        store.toolGateway.tools[toolName] = {
            useGateway: config.useGateway ?? existing.useGateway ?? false,
            backend: config.backend ?? existing.backend ?? 'default',
        };
        this.save();
    }
}
exports.ProviderManager = ProviderManager;
// 单例
let _instance = null;
function getProviderManager(dataDir) {
    if (!_instance) {
        _instance = new ProviderManager(dataDir);
        // 启动时自动从 .env 导入（兼容已有配置）
        _instance.importFromEnv();
    }
    return _instance;
}
/**
 * 凭证池
 *
 * 管理同一 provider 的多个 API Key，支持：
 * - 加权轮换
 * - 速率限制自动切换
 * - 故障自动标记不可用
 * - 成功后重置失败计数
 * - 全部不可用时强制重置
 */
class CredentialPool {
    providerName;
    states = [];
    nextIndex = 0;
    constructor(providerName, entries) {
        this.providerName = providerName;
        this.states = entries.map((entry) => ({
            entry,
            failureCount: 0,
            rateLimitedUntil: null,
        }));
    }
    /**
     * 获取下一个可用凭证
     * @returns 可用凭证
     */
    getNext() {
        const available = this.getAvailableCredentials();
        if (available.length === 0) {
            // 全部不可用时强制重置
            this.states.forEach((s) => {
                s.failureCount = 0;
                s.rateLimitedUntil = null;
            });
            return this.states[0].entry;
        }
        // 加权轮换：按权重选择
        const totalWeight = available.reduce((sum, c) => sum + c.weight, 0);
        let r = Math.random() * totalWeight;
        for (const c of available) {
            r -= c.weight;
            if (r <= 0) {
                return c;
            }
        }
        return available[0];
    }
    /**
     * 获取所有可用凭证
     */
    getAvailableCredentials() {
        const now = Date.now();
        return this.states
            .filter((s) => {
            if (s.failureCount >= 3)
                return false;
            if (s.rateLimitedUntil !== null && s.rateLimitedUntil > now)
                return false;
            return true;
        })
            .map((s) => s.entry);
    }
    /**
     * 报告速率限制
     * @param key - 被限制的凭证
     * @param expiryTime - 限制到期时间戳（可选，默认 60 秒后）
     */
    reportRateLimit(key, expiryTime) {
        const state = this.states.find((s) => s.entry.key === key);
        if (state) {
            state.rateLimitedUntil = expiryTime ?? Date.now() + 60000;
        }
    }
    /**
     * 报告失败
     */
    reportFailure(key) {
        const state = this.states.find((s) => s.entry.key === key);
        if (state) {
            state.failureCount++;
        }
    }
    /**
     * 报告成功，重置失败计数
     */
    reportSuccess(key) {
        const state = this.states.find((s) => s.entry.key === key);
        if (state) {
            state.failureCount = 0;
            state.rateLimitedUntil = null;
        }
    }
    /**
     * 凭证总数
     */
    get size() {
        return this.states.length;
    }
    /**
     * 可用凭证数
     */
    get availableSize() {
        return this.getAvailableCredentials().length;
    }
}
exports.CredentialPool = CredentialPool;

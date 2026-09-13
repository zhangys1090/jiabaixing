"use strict";
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
exports.getMigrationMap = getMigrationMap;
exports.getMigrationStats = getMigrationStats;
exports.registerCoreDependencies = registerCoreDependencies;
exports.registerLLMProvider = registerLLMProvider;
exports.registerEventBus = registerEventBus;
exports.registerSingleton = registerSingleton;
exports.resolveMemoryLeakGuard = resolveMemoryLeakGuard;
exports.resolveSessionTokenQuota = resolveSessionTokenQuota;
exports.getContainer = getContainer;
exports.createTestContainer = createTestContainer;
exports.bootstrapContainer = bootstrapContainer;
const Logger_1 = require("../utils/Logger");
const DIContainer_1 = require("./DIContainer");
const SINGLETON_MIGRATION_MAP = [
    {
        className: 'TimerManager',
        token: DIContainer_1.DI_TOKENS.TIMER_MANAGER,
        module: '../utils/TimerManager',
        tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        priority: 0,
        migrated: true,
    },
    {
        className: 'MemoryLeakGuard',
        token: DIContainer_1.DI_TOKENS.MEMORY_LEAK_GUARD,
        module: '../utils/MemoryLeakGuard',
        tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        dependencies: [DIContainer_1.DI_TOKENS.TIMER_MANAGER],
        priority: 1,
        migrated: true,
    },
    {
        className: 'EnvironmentManager',
        token: DIContainer_1.DI_TOKENS.ENVIRONMENT_MANAGER,
        module: '../utils/EnvironmentManager',
        tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        priority: 0,
        migrated: true,
    },
    {
        className: 'ConfigLoader',
        token: DIContainer_1.DI_TOKENS.CONFIG_LOADER,
        module: '../config/ConfigLoader',
        tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        priority: 0,
        migrated: true,
    },
    {
        className: 'EventBus',
        token: DIContainer_1.DI_TOKENS.EVENT_BUS,
        module: '../shared/EventBus',
        tags: [DIContainer_1.DI_TAGS.CORE],
        priority: 0,
        migrated: true,
    },
    {
        className: 'SessionTokenQuotaManager',
        token: DIContainer_1.DI_TOKENS.SESSION_TOKEN_QUOTA,
        module: '../harness/constraints/SessionTokenQuota',
        tags: [DIContainer_1.DI_TAGS.CONSTRAINTS],
        priority: 2,
        migrated: true,
    },
    {
        className: 'SecurityPolicyEngine',
        token: DIContainer_1.DI_TOKENS.SECURITY_POLICY_ENGINE,
        module: '../security/SecurityPolicyEngine',
        tags: [DIContainer_1.DI_TAGS.SECURITY],
        priority: 1,
        migrated: true,
    },
    {
        className: 'SecurityGuard',
        token: DIContainer_1.DI_TOKENS.SECURITY_GUARD,
        module: '../security/SecurityGuard',
        tags: [DIContainer_1.DI_TAGS.SECURITY],
        dependencies: [DIContainer_1.DI_TOKENS.SECURITY_POLICY_ENGINE],
        priority: 2,
        migrated: true,
    },
    {
        className: 'UrlSafetyChecker',
        token: DIContainer_1.DI_TOKENS.URL_SAFETY_CHECKER,
        module: '../security/UrlSafetyChecker',
        tags: [DIContainer_1.DI_TAGS.SECURITY],
        priority: 1,
        migrated: true,
    },
    {
        className: 'ShellHooks',
        token: DIContainer_1.DI_TOKENS.SHELL_HOOKS,
        module: '../security/ShellHooks',
        tags: [DIContainer_1.DI_TAGS.SECURITY],
        priority: 1,
        migrated: true,
    },
    {
        className: 'ModelManager',
        token: DIContainer_1.DI_TOKENS.MODEL_MANAGER,
        module: '../models/ModelManager',
        tags: [DIContainer_1.DI_TAGS.MODEL],
        priority: 1,
        migrated: true,
    },
    {
        className: 'ModelSelector',
        token: DIContainer_1.DI_TOKENS.MODEL_SELECTOR,
        module: '../models/ModelSelector',
        tags: [DIContainer_1.DI_TAGS.MODEL],
        priority: 1,
        migrated: true,
    },
    {
        className: 'MessageSanitizer',
        token: DIContainer_1.DI_TOKENS.MESSAGE_SANITIZER,
        module: '../models/MessageSanitizer',
        tags: [DIContainer_1.DI_TAGS.MODEL],
        priority: 1,
        migrated: true,
    },
    {
        className: 'PreferenceManager',
        token: DIContainer_1.DI_TOKENS.PREFERENCE_MANAGER,
        module: '../memory/PreferenceManager',
        tags: [DIContainer_1.DI_TAGS.MEMORY],
        priority: 1,
        migrated: true,
    },
    {
        className: 'FileSystem',
        token: DIContainer_1.DI_TOKENS.FILE_SYSTEM,
        module: '../io/FileSystem',
        tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        priority: 0,
        migrated: true,
    },
    {
        className: 'MCPToolBridge',
        token: DIContainer_1.DI_TOKENS.MCP_TOOL_BRIDGE,
        module: '../harness/tools/registry/MCPToolBridge',
        tags: [DIContainer_1.DI_TAGS.TOOL],
        priority: 2,
        migrated: true,
    },
    {
        className: 'LspClientManager',
        token: DIContainer_1.DI_TOKENS.LSP_CLIENT_MANAGER,
        module: '../harness/lsp/LspClientManager',
        tags: [DIContainer_1.DI_TAGS.TOOL],
        priority: 2,
        migrated: true,
    },
    {
        className: 'UnifiedContextBuilder',
        token: DIContainer_1.DI_TOKENS.UNIFIED_CONTEXT_BUILDER,
        module: '../harness/context/UnifiedContextBuilder',
        tags: [DIContainer_1.DI_TAGS.HARNESS],
        priority: 2,
        migrated: true,
    },
    {
        className: 'SkillRegistry',
        token: DIContainer_1.DI_TOKENS.SKILL_REGISTRY,
        module: '../skills/SkillRegistry',
        tags: [DIContainer_1.DI_TAGS.HARNESS],
        priority: 2,
        migrated: true,
    },
    {
        className: 'ACPActivityTracker',
        token: DIContainer_1.DI_TOKENS.ACP_ACTIVITY_TRACKER,
        module: '../ide/ACPActivityTracker',
        tags: [DIContainer_1.DI_TAGS.CORE],
        priority: 1,
        migrated: true,
    },
    {
        className: 'EvolutionOrchestrator',
        token: DIContainer_1.DI_TOKENS.EVOLUTION_ENGINE,
        module: '../evolution/EvolutionOrchestrator',
        tags: [DIContainer_1.DI_TAGS.EVOLUTION],
        priority: 3,
        migrated: true,
    },
    {
        className: 'ImplicitFeedbackCollector',
        token: DIContainer_1.DI_TOKENS.IMPLICIT_FEEDBACK_COLLECTOR,
        module: '../evolution/ImplicitFeedbackCollector',
        tags: [DIContainer_1.DI_TAGS.EVOLUTION],
        priority: 3,
        migrated: true,
    },
    {
        className: 'OptimizationResultDispatcher',
        token: DIContainer_1.DI_TOKENS.OPTIMIZATION_RESULT_DISPATCHER,
        module: '../evolution/OptimizationResultDispatcher',
        tags: [DIContainer_1.DI_TAGS.EVOLUTION],
        priority: 3,
        migrated: true,
    },
    {
        className: 'OptimizationAdvisor',
        token: DIContainer_1.DI_TOKENS.OPTIMIZATION_ADVISOR,
        module: '../evolution/decision/OptimizationAdvisor',
        tags: [DIContainer_1.DI_TAGS.EVOLUTION],
        priority: 3,
        migrated: true,
    },
    {
        className: 'CronJobScheduler',
        token: DIContainer_1.DI_TOKENS.CRON_SCHEDULER,
        module: '../cron/CronJobScheduler',
        tags: [DIContainer_1.DI_TAGS.CORE],
        priority: 2,
        migrated: true,
    },
    {
        className: 'ProfileTrendAnalyzer',
        token: DIContainer_1.DI_TOKENS.PROFILE_TREND_ANALYZER,
        module: '../user/ProfileTrendAnalyzer',
        tags: [DIContainer_1.DI_TAGS.CORE],
        priority: 2,
        migrated: true,
    },
    {
        className: 'MessageProcessor',
        token: DIContainer_1.DI_TOKENS.MESSAGE_PROCESSOR,
        module: '../shared/MessageProcessor',
        tags: [DIContainer_1.DI_TAGS.CORE],
        priority: 1,
        migrated: true,
    },
    {
        className: 'I18nManager',
        token: DIContainer_1.DI_TOKENS.I18N_MANAGER,
        module: '../shared/I18nManager',
        tags: [DIContainer_1.DI_TAGS.CORE],
        priority: 1,
        migrated: true,
    },
    {
        className: 'SystemInitState',
        token: DIContainer_1.DI_TOKENS.SYSTEM_INIT_STATE,
        module: '../server/SystemInitState',
        tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        priority: 0,
        migrated: true,
    },
    {
        className: 'DeviceDiscovery',
        token: DIContainer_1.DI_TOKENS.DEVICE_DISCOVERY,
        module: '../hardware/DeviceDiscovery',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 2,
        migrated: true,
    },
    {
        className: 'DesktopActionExecutor',
        token: DIContainer_1.DI_TOKENS.DESKTOP_ACTION_EXECUTOR,
        module: '../desktop/DesktopActionExecutor',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 3,
        migrated: true,
    },
    {
        className: 'DesktopMCPServer',
        token: DIContainer_1.DI_TOKENS.DESKTOP_MCP_SERVER,
        module: '../desktop/DesktopMCPServer',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 3,
        migrated: true,
    },
    {
        className: 'WindowManager',
        token: DIContainer_1.DI_TOKENS.WINDOW_MANAGER,
        module: '../desktop/WindowManager',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 2,
        migrated: true,
    },
    {
        className: 'SystemInput',
        token: DIContainer_1.DI_TOKENS.SYSTEM_INPUT,
        module: '../desktop/SystemInput',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 2,
        migrated: true,
    },
    {
        className: 'UIElementParser',
        token: DIContainer_1.DI_TOKENS.UI_ELEMENT_PARSER,
        module: '../desktop/ui/UIElementParser',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 2,
        migrated: true,
    },
    {
        className: 'ScreenCapture',
        token: DIContainer_1.DI_TOKENS.SCREEN_CAPTURE,
        module: '../desktop/ScreenCapture',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 2,
        migrated: true,
    },
    {
        className: 'NormalizedCoordinateSystem',
        token: DIContainer_1.DI_TOKENS.NORMALIZED_COORDINATES,
        module: '../desktop/NormalizedCoordinates',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 2,
        migrated: true,
    },
    {
        className: 'DesktopSkillRegistry',
        token: DIContainer_1.DI_TOKENS.DESKTOP_SKILL_REGISTRY,
        module: '../desktop/DesktopSkillRegistry',
        tags: [DIContainer_1.DI_TAGS.DESKTOP],
        priority: 3,
        migrated: true,
    },
];
function getMigrationMap() {
    return [...SINGLETON_MIGRATION_MAP];
}
function getMigrationStats() {
    const total = SINGLETON_MIGRATION_MAP.length;
    const migrated = SINGLETON_MIGRATION_MAP.filter((e) => e.migrated).length;
    const byTag = {};
    for (const entry of SINGLETON_MIGRATION_MAP) {
        for (const tag of entry.tags) {
            if (!byTag[tag])
                byTag[tag] = { total: 0, migrated: 0 };
            byTag[tag].total++;
            if (entry.migrated)
                byTag[tag].migrated++;
        }
    }
    return { total, migrated, pending: total - migrated, byTag };
}
async function registerCoreDependencies() {
    const container = DIContainer_1.DIContainer.getInstance();
    if (!container.has(DIContainer_1.DI_TOKENS.TIMER_MANAGER)) {
        const { TimerManager } = await Promise.resolve().then(() => __importStar(require('../utils/TimerManager')));
        container.register(DIContainer_1.DI_TOKENS.TIMER_MANAGER, () => TimerManager.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.MEMORY_LEAK_GUARD)) {
        const { MemoryLeakGuard } = await Promise.resolve().then(() => __importStar(require('../utils/MemoryLeakGuard')));
        container.register(DIContainer_1.DI_TOKENS.MEMORY_LEAK_GUARD, async () => {
            const tm = await container.resolve(DIContainer_1.DI_TOKENS.TIMER_MANAGER);
            return MemoryLeakGuard.create(tm);
        }, {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
            dependencies: [DIContainer_1.DI_TOKENS.TIMER_MANAGER],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.ENVIRONMENT_MANAGER)) {
        const { EnvironmentManager } = await Promise.resolve().then(() => __importStar(require('../utils/EnvironmentManager')));
        container.register(DIContainer_1.DI_TOKENS.ENVIRONMENT_MANAGER, () => EnvironmentManager.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.CONFIG_LOADER)) {
        const { ConfigLoader } = await Promise.resolve().then(() => __importStar(require('../config/ConfigLoader')));
        container.register(DIContainer_1.DI_TOKENS.CONFIG_LOADER, () => ConfigLoader.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.EVENT_BUS)) {
        const { JiabaixingEventBus } = await Promise.resolve().then(() => __importStar(require('./EventBus')));
        container.register(DIContainer_1.DI_TOKENS.EVENT_BUS, () => JiabaixingEventBus.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.CORE],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.SYSTEM_INIT_STATE)) {
        const { SystemInitState } = await Promise.resolve().then(() => __importStar(require('../server/SystemInitState')));
        container.register(DIContainer_1.DI_TOKENS.SYSTEM_INIT_STATE, () => SystemInitState.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.SESSION_TOKEN_QUOTA)) {
        const { SessionTokenQuotaManager } = await Promise.resolve().then(() => __importStar(require('../harness/constraints/SessionTokenQuota')));
        container.register(DIContainer_1.DI_TOKENS.SESSION_TOKEN_QUOTA, () => SessionTokenQuotaManager.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.CONSTRAINTS] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.SECURITY_POLICY_ENGINE)) {
        const { SecurityPolicyEngine } = await Promise.resolve().then(() => __importStar(require('../security/SecurityPolicyEngine')));
        container.register(DIContainer_1.DI_TOKENS.SECURITY_POLICY_ENGINE, () => SecurityPolicyEngine.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.SECURITY] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.SECURITY_GUARD)) {
        const { SecurityGuard } = await Promise.resolve().then(() => __importStar(require('../security/SecurityGuard')));
        container.register(DIContainer_1.DI_TOKENS.SECURITY_GUARD, () => SecurityGuard.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.SECURITY],
            dependencies: [DIContainer_1.DI_TOKENS.SECURITY_POLICY_ENGINE],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.URL_SAFETY_CHECKER)) {
        const { UrlSafetyChecker } = await Promise.resolve().then(() => __importStar(require('../security/UrlSafetyChecker')));
        container.register(DIContainer_1.DI_TOKENS.URL_SAFETY_CHECKER, () => UrlSafetyChecker.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.SECURITY] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.SHELL_HOOKS)) {
        const { ShellHooks } = await Promise.resolve().then(() => __importStar(require('../security/ShellHooks')));
        container.register(DIContainer_1.DI_TOKENS.SHELL_HOOKS, () => ShellHooks.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.SECURITY],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.MODEL_SELECTOR)) {
        const { ModelSelector } = await Promise.resolve().then(() => __importStar(require('../models/ModelSelector')));
        container.register(DIContainer_1.DI_TOKENS.MODEL_SELECTOR, () => ModelSelector.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.MODEL],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.MESSAGE_SANITIZER)) {
        const { MessageSanitizer } = await Promise.resolve().then(() => __importStar(require('../models/MessageSanitizer')));
        container.register(DIContainer_1.DI_TOKENS.MESSAGE_SANITIZER, () => MessageSanitizer.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.MODEL] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.PREFERENCE_MANAGER)) {
        const { PreferenceManager } = await Promise.resolve().then(() => __importStar(require('../memory/PreferenceManager')));
        container.register(DIContainer_1.DI_TOKENS.PREFERENCE_MANAGER, () => PreferenceManager.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.MEMORY] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.FILE_SYSTEM)) {
        const { FileSystem } = await Promise.resolve().then(() => __importStar(require('../io/FileSystem')));
        container.register(DIContainer_1.DI_TOKENS.FILE_SYSTEM, () => FileSystem.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.INFRASTRUCTURE],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.MESSAGE_PROCESSOR)) {
        const { MessageProcessor } = await Promise.resolve().then(() => __importStar(require('../shared/MessageProcessor')));
        container.register(DIContainer_1.DI_TOKENS.MESSAGE_PROCESSOR, () => MessageProcessor.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.CORE] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.I18N_MANAGER)) {
        const { I18nManager } = await Promise.resolve().then(() => __importStar(require('../shared/I18nManager')));
        container.register(DIContainer_1.DI_TOKENS.I18N_MANAGER, () => I18nManager.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.CORE],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.ACP_ACTIVITY_TRACKER)) {
        const { ACPActivityTracker } = await Promise.resolve().then(() => __importStar(require('../ide/ACPActivityTracker')));
        container.register(DIContainer_1.DI_TOKENS.ACP_ACTIVITY_TRACKER, () => ACPActivityTracker.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.CORE] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.MCP_TOOL_BRIDGE)) {
        const { MCPToolBridge } = await Promise.resolve().then(() => __importStar(require('../harness/tools/registry/MCPToolBridge')));
        container.register(DIContainer_1.DI_TOKENS.MCP_TOOL_BRIDGE, () => MCPToolBridge.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.TOOL] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.LSP_CLIENT_MANAGER)) {
        const { LspClientManager } = await Promise.resolve().then(() => __importStar(require('../harness/lsp/LspClientManager')));
        container.register(DIContainer_1.DI_TOKENS.LSP_CLIENT_MANAGER, () => LspClientManager.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.TOOL] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.UNIFIED_CONTEXT_BUILDER)) {
        const { UnifiedContextBuilder } = await Promise.resolve().then(() => __importStar(require('../harness/context/UnifiedContextBuilder')));
        container.register(DIContainer_1.DI_TOKENS.UNIFIED_CONTEXT_BUILDER, () => UnifiedContextBuilder.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.HARNESS] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.SKILL_REGISTRY)) {
        const { SkillRegistry } = await Promise.resolve().then(() => __importStar(require('../skills/SkillRegistry')));
        container.register(DIContainer_1.DI_TOKENS.SKILL_REGISTRY, () => SkillRegistry.create(), {
            lifecycle: 'singleton',
            tags: [DIContainer_1.DI_TAGS.HARNESS],
        });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.CRON_SCHEDULER)) {
        const { CronJobScheduler } = await Promise.resolve().then(() => __importStar(require('../cron/CronJobScheduler')));
        container.register(DIContainer_1.DI_TOKENS.CRON_SCHEDULER, () => CronJobScheduler.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.CORE] });
    }
    if (!container.has(DIContainer_1.DI_TOKENS.PROFILE_TREND_ANALYZER)) {
        const { ProfileTrendAnalyzer } = await Promise.resolve().then(() => __importStar(require('../user/ProfileTrendAnalyzer')));
        container.register(DIContainer_1.DI_TOKENS.PROFILE_TREND_ANALYZER, () => ProfileTrendAnalyzer.create(), { lifecycle: 'singleton', tags: [DIContainer_1.DI_TAGS.CORE] });
    }
    Logger_1.Logger.info(`DI: 核心依赖已注册 (${container.size} 项)`, 'DependencyRegistry');
}
function registerLLMProvider(llm) {
    const container = DIContainer_1.DIContainer.getInstance();
    container.registerValue(DIContainer_1.DI_TOKENS.LLM_PROVIDER, llm, {
        tags: [DIContainer_1.DI_TAGS.MODEL],
    });
}
function registerEventBus(eventBus) {
    const container = DIContainer_1.DIContainer.getInstance();
    container.registerValue(DIContainer_1.DI_TOKENS.EVENT_BUS, eventBus, {
        tags: [DIContainer_1.DI_TAGS.CORE],
    });
}
function registerSingleton(token, getInstance, options) {
    const container = DIContainer_1.DIContainer.getInstance();
    if (!container.has(token)) {
        container.register(token, getInstance, {
            lifecycle: 'singleton',
            ...options,
        });
    }
}
async function resolveMemoryLeakGuard() {
    return DIContainer_1.DIContainer.getInstance().resolve(DIContainer_1.DI_TOKENS.MEMORY_LEAK_GUARD);
}
async function resolveSessionTokenQuota() {
    return DIContainer_1.DIContainer.getInstance().resolve(DIContainer_1.DI_TOKENS.SESSION_TOKEN_QUOTA);
}
function getContainer() {
    return DIContainer_1.DIContainer.getInstance();
}
function createTestContainer() {
    return DIContainer_1.DIContainer.create();
}
async function bootstrapContainer(container, tokens) {
    const validation = container.validate();
    if (!validation.valid) {
        Logger_1.Logger.warn(`DI: 依赖校验发现问题:\n${validation.errors.join('\n')}`, 'DependencyRegistry');
    }
    await container.bootstrap(tokens);
    container.freeze();
    Logger_1.Logger.info(`DI: 容器已引导并冻结 (${container.size} 项)`, 'DependencyRegistry');
}

"use strict";
/**
 * 配置加载器
 * 从.trae/config.json加载配置
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
exports.ConfigLoader = void 0;
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
class ConfigLoader {
    static instance = null;
    config = null;
    configPath;
    constructor() {
        this.configPath = path.join(process.cwd(), '.trae', 'config.json');
    }
    static create() {
        return new ConfigLoader();
    }
    static getInstance() {
        if (!ConfigLoader.instance) {
            ConfigLoader.instance = new ConfigLoader();
        }
        return ConfigLoader.instance;
    }
    async loadConfig() {
        try {
            if (!(await fs.pathExists(this.configPath))) {
                Logger_1.Logger.warn(`配置文件不存在: ${this.configPath}，使用默认配置`, 'ConfigLoader');
                return this.getDefaultConfig();
            }
            const configContent = await fs.readFile(this.configPath, 'utf-8');
            this.config = JSON.parse(configContent);
            Logger_1.Logger.info(`✅ 配置文件已加载: ${this.configPath}`, 'ConfigLoader');
            return this.config;
        }
        catch (error) {
            Logger_1.Logger.error('配置文件加载失败，使用默认配置', error, 'ConfigLoader');
            return this.getDefaultConfig();
        }
    }
    getConfig() {
        return this.config;
    }
    async saveConfig(config) {
        try {
            await fs.ensureDir(path.dirname(this.configPath));
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
            this.config = config;
            Logger_1.Logger.info(`✅ 配置文件已保存: ${this.configPath}`, 'ConfigLoader');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error('配置文件保存失败', error, 'ConfigLoader');
            return false;
        }
    }
    getDefaultConfig() {
        return {
            mcpServers: {
                filesystem: {
                    command: 'npx',
                    args: ['@modelcontextprotocol/server-filesystem', process.cwd()],
                    description: '文件系统操作服务器',
                },
                sqlite: {
                    command: 'npx',
                    args: ['@modelcontextprotocol/server-sqlite', '--db-path', './data'],
                    description: 'SQLite数据库操作服务器',
                },
            },
            skills: {
                enabled: [
                    'CodeGeneratorSkill',
                    'CodeAnalysisSkill',
                    'FileSkill',
                    'CommandSkill',
                    'SearchSkill',
                    'ProjectAnalyzerSkill',
                ],
                priority: {
                    security: 1,
                    memory: 2,
                    code: 3,
                    file: 4,
                    search: 5,
                },
                autoDiscovery: true,
                skillCacheEnabled: true,
            },
            context: {
                maxMemoryItems: 1000,
                contextWindow: 8000,
                refreshInterval: 3600000,
                memoryTypes: ['conversation', 'event', 'task', 'learning', 'emotion'],
                timelineEnabled: true,
                userProfileEnabled: true,
            },
            performance: {
                parallelExecution: true,
                cachingEnabled: true,
                lazyLoading: true,
                maxConcurrentTasks: 5,
                taskTimeout: 30000,
                memoryThreshold: 512,
            },
            security: {
                enableSandbox: true,
                commandWhitelist: ['git', 'npm', 'node', 'ls', 'cd', 'cat'],
                fileAccessWhitelist: [process.cwd()],
                enableAuditLog: true,
                maxFileSize: 10485760,
            },
            monitoring: {
                enableMetrics: true,
                logLevel: 'info',
                alertThresholds: {
                    responseTime: 3000,
                    memoryUsage: 512,
                    errorRate: 0.05,
                },
                performanceTracking: true,
            },
            development: {
                autoReload: true,
                debugMode: false,
                verboseLogging: false,
                testMode: false,
            },
        };
    }
    getMCPServerConfig(serverName) {
        return this.config?.mcpServers[serverName];
    }
    getEnabledSkills() {
        return this.config?.skills.enabled || [];
    }
    getSkillPriority(skillName) {
        return this.config?.skills.priority[skillName] || 999;
    }
    isMonitoringEnabled() {
        return this.config?.monitoring.enableMetrics || false;
    }
    getMonitoringConfig() {
        return this.config?.monitoring;
    }
}
exports.ConfigLoader = ConfigLoader;
exports.default = ConfigLoader;

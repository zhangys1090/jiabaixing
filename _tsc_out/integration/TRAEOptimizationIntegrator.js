"use strict";
/**
 * TRAE优化系统集成器
 * 将所有效率优化功能集成到jiabaixing系统中
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRAEOptimizationIntegrator = void 0;
const events_1 = require("events");
const ConfigLoader_1 = require("../config/ConfigLoader");
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const PerformanceMonitor_1 = require("../monitoring/PerformanceMonitor");
const SkillRegistry_1 = require("../skills/SkillRegistry");
const Logger_1 = require("../utils/Logger");
class TRAEOptimizationIntegrator extends events_1.EventEmitter {
    static instance = null;
    config;
    performanceMonitor = null;
    configLoader = null;
    skillRegistry = null;
    optimizationInterval = null;
    healthCheckInterval = null;
    initialized = false;
    constructor(config) {
        super();
        this.config = {
            enableMCP: true,
            enablePerformanceMonitoring: true,
            enableSecurityAudit: true,
            enableAutoOptimization: true,
            monitoringInterval: 60000,
            autoOptimizationInterval: 3600000,
            ...config,
        };
    }
    static getInstance(config) {
        if (!TRAEOptimizationIntegrator.instance) {
            TRAEOptimizationIntegrator.instance = new TRAEOptimizationIntegrator(config);
        }
        return TRAEOptimizationIntegrator.instance;
    }
    async initialize() {
        if (this.initialized) {
            Logger_1.Logger.warn('TRAE优化系统集成器已初始化', 'TRAEOptimizationIntegrator');
            return;
        }
        Logger_1.Logger.info('🚀 开始初始化TRAE优化系统集成器...', 'TRAEOptimizationIntegrator');
        try {
            await this.initializeConfig();
            await this.initializeSkillRegistry();
            await this.initializeMCP();
            await this.initializePerformanceMonitoring();
            await this.registerOptimizedSkills();
            await this.startHealthChecks();
            await this.startAutoOptimization();
            this.initialized = true;
            Logger_1.Logger.info('✅ TRAE优化系统集成器初始化完成', 'TRAEOptimizationIntegrator');
            this.emit('initialized');
        }
        catch (error) {
            Logger_1.Logger.error('TRAE优化系统集成器初始化失败', error, 'TRAEOptimizationIntegrator');
            throw error;
        }
    }
    async initializeConfig() {
        Logger_1.Logger.info('📋 初始化配置管理...', 'TRAEOptimizationIntegrator');
        this.configLoader = ConfigLoader_1.ConfigLoader.getInstance();
        const config = await this.configLoader.loadConfig();
        if (config?.monitoring?.enableMetrics) {
            this.config.enablePerformanceMonitoring = true;
        }
        Logger_1.Logger.info('✅ 配置管理初始化完成', 'TRAEOptimizationIntegrator');
    }
    async initializeSkillRegistry() {
        Logger_1.Logger.info('🔧 初始化技能注册中心...', 'TRAEOptimizationIntegrator');
        this.skillRegistry = SkillRegistry_1.SkillRegistry.getInstance();
        const skillCount = this.skillRegistry.getSkillCount();
        Logger_1.Logger.info(`✅ 技能注册中心初始化完成，已注册 ${skillCount} 个技能`, 'TRAEOptimizationIntegrator');
    }
    async initializeMCP() {
        if (!this.config.enableMCP) {
            Logger_1.Logger.info('⏭️ MCP集成已禁用', 'TRAEOptimizationIntegrator');
            return;
        }
        Logger_1.Logger.info('🌐 初始化MCP服务器管理器...', 'TRAEOptimizationIntegrator');
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (!bridge) {
            Logger_1.Logger.warn('⚠️ Python 后端未连接，跳过 MCP 服务器初始化', 'TRAEOptimizationIntegrator');
            return;
        }
        if (this.configLoader) {
            const mcpServers = this.configLoader.getConfig()?.mcpServers || {};
            for (const [name, serverConfig] of Object.entries(mcpServers)) {
                await bridge.registerMcpServer({
                    name,
                    command: serverConfig.command,
                    args: serverConfig.args,
                    description: serverConfig.description,
                    enabled: true,
                });
            }
        }
        await bridge.startAllMcpServers();
        const runningCount = await bridge.getRunningMcpServerCount();
        Logger_1.Logger.info(`✅ MCP服务器管理器初始化完成，${runningCount} 个服务器运行中`, 'TRAEOptimizationIntegrator');
    }
    async initializePerformanceMonitoring() {
        if (!this.config.enablePerformanceMonitoring) {
            Logger_1.Logger.info('⏭️ 性能监控已禁用', 'TRAEOptimizationIntegrator');
            return;
        }
        Logger_1.Logger.info('📊 初始化性能监控...', 'TRAEOptimizationIntegrator');
        let monitoringConfig = {};
        if (this.configLoader) {
            const config = this.configLoader.getConfig();
            if (config?.monitoring) {
                monitoringConfig = {
                    enableMetrics: config.monitoring.enableMetrics,
                    logLevel: config.monitoring.logLevel,
                    alertThresholds: config.monitoring.alertThresholds,
                    performanceTracking: config.monitoring.performanceTracking,
                };
            }
        }
        this.performanceMonitor = PerformanceMonitor_1.PerformanceMonitor.getInstance(monitoringConfig);
        this.performanceMonitor.startMonitoring(this.config.monitoringInterval);
        this.performanceMonitor.on('performanceAlert', (alert) => {
            Logger_1.Logger.warn(`⚠️ 性能告警: ${alert.message}`, 'TRAEOptimizationIntegrator');
            this.emit('performanceAlert', alert);
        });
        Logger_1.Logger.info('✅ 性能监控初始化完成', 'TRAEOptimizationIntegrator');
    }
    async registerOptimizedSkills() {
        Logger_1.Logger.info('🎯 优化技能已由 Harness ToolRegistry 统一管理', 'TRAEOptimizationIntegrator');
    }
    async startHealthChecks() {
        Logger_1.Logger.info('🏥 启动健康检查...', 'TRAEOptimizationIntegrator');
        this.healthCheckInterval = setInterval(() => {
            void this.performHealthCheck();
        }, 120000);
        Logger_1.Logger.info('✅ 健康检查已启动 (每2分钟)', 'TRAEOptimizationIntegrator');
    }
    async startAutoOptimization() {
        if (!this.config.enableAutoOptimization) {
            Logger_1.Logger.info('⏭️ 自动优化已禁用', 'TRAEOptimizationIntegrator');
            return;
        }
        Logger_1.Logger.info('⚡ 启动自动优化...', 'TRAEOptimizationIntegrator');
        this.optimizationInterval = setInterval(() => {
            void this.performAutoOptimization();
        }, this.config.autoOptimizationInterval);
        Logger_1.Logger.info(`✅ 自动优化已启动 (每${this.config.autoOptimizationInterval / 60000}分钟)`, 'TRAEOptimizationIntegrator');
    }
    async performHealthCheck() {
        const status = {
            status: 'healthy',
            mcpServers: { running: 0, total: 0 },
            performance: { responseTime: 0, memoryUsage: 0, errorRate: 0 },
            skills: { registered: 0, active: 0 },
            security: { lastAudit: '', issues: 0 },
            timestamp: Date.now(),
        };
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            status.mcpServers.running = await bridge.getRunningMcpServerCount();
            status.mcpServers.total = await bridge.getMcpServerCount();
        }
        if (this.performanceMonitor) {
            const summary = this.performanceMonitor.getSummary();
            status.performance = {
                responseTime: summary.averageResponseTime,
                memoryUsage: summary.currentMemoryUsage,
                errorRate: summary.currentErrorRate,
            };
        }
        if (this.skillRegistry) {
            status.skills.registered = this.skillRegistry.getSkillCount();
            status.skills.active = status.skills.registered;
        }
        if (this.configLoader?.getMonitoringConfig()?.alertThresholds) {
            const monitoringConfig = this.configLoader.getMonitoringConfig();
            if (monitoringConfig?.alertThresholds) {
                const thresholds = monitoringConfig.alertThresholds;
                if (status.performance.responseTime > thresholds.responseTime ||
                    status.performance.memoryUsage > thresholds.memoryUsage ||
                    status.performance.errorRate > thresholds.errorRate) {
                    status.status = 'degraded';
                }
                if (status.performance.responseTime > thresholds.responseTime * 2 ||
                    status.performance.memoryUsage > thresholds.memoryUsage * 2) {
                    status.status = 'critical';
                }
            }
        }
        this.emit('healthCheck', status);
        if (status.status !== 'healthy') {
            Logger_1.Logger.warn(`⚠️ 系统健康状态: ${status.status}`, 'TRAEOptimizationIntegrator');
        }
        return status;
    }
    async performAutoOptimization() {
        Logger_1.Logger.info('🔧 执行自动优化...', 'TRAEOptimizationIntegrator');
        try {
            if (this.config.enableSecurityAudit && this.skillRegistry) {
                await this.runSecurityAudit();
            }
            if (this.performanceMonitor) {
                const metrics = this.performanceMonitor.getCurrentMetrics();
                if (metrics && metrics.errorRate > 0.1) {
                    Logger_1.Logger.warn('检测到高错误率，建议检查系统状态', 'TRAEOptimizationIntegrator');
                }
            }
            this.emit('autoOptimizationCompleted');
            Logger_1.Logger.info('✅ 自动优化完成', 'TRAEOptimizationIntegrator');
        }
        catch (error) {
            Logger_1.Logger.error('自动优化失败', error, 'TRAEOptimizationIntegrator');
        }
    }
    async runSecurityAudit() {
        if (!this.skillRegistry)
            return;
        try {
            const result = await this.skillRegistry.executeSkill('security_audit', {
                target: './src',
                auditType: 'code',
            });
            if (result.success && result.output) {
                const auditData = result.output;
                Logger_1.Logger.info(`安全审计完成: ${auditData.summary || '完成'}`, 'TRAEOptimizationIntegrator');
            }
        }
        catch (error) {
            Logger_1.Logger.error('安全审计失败', error, 'TRAEOptimizationIntegrator');
        }
    }
    getSystemHealth() {
        return {
            status: 'healthy',
            mcpServers: { running: 0, total: 0 },
            performance: { responseTime: 0, memoryUsage: 0, errorRate: 0 },
            skills: { registered: 0, active: 0 },
            security: { lastAudit: '', issues: 0 },
            timestamp: Date.now(),
        };
    }
    getPerformanceMetrics() {
        return this.performanceMonitor?.getCurrentMetrics();
    }
    async getMCPStatus() {
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        return bridge ? await bridge.getMcpServersStatus() : {};
    }
    getSkillStatus() {
        return {
            registered: this.skillRegistry?.getSkillCount() || 0,
            categories: this.skillRegistry?.getCategories() || [],
        };
    }
    async executeOptimizedSkill(skillName, params) {
        if (!this.skillRegistry) {
            throw new Error('技能注册中心未初始化');
        }
        const startTime = Date.now();
        const result = await this.skillRegistry.executeSkill(skillName, params);
        const responseTime = Date.now() - startTime;
        if (this.performanceMonitor) {
            this.performanceMonitor.recordRequest(responseTime, result.success);
        }
        return result;
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        Logger_1.Logger.info('配置已更新', 'TRAEOptimizationIntegrator');
    }
    async shutdown() {
        Logger_1.Logger.info('🛑 关闭TRAE优化系统集成器...', 'TRAEOptimizationIntegrator');
        if (this.optimizationInterval) {
            clearInterval(this.optimizationInterval);
            this.optimizationInterval = null;
        }
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        if (this.performanceMonitor) {
            this.performanceMonitor.stopMonitoring();
        }
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (bridge) {
            await bridge.stopAllMcpServers();
        }
        this.initialized = false;
        Logger_1.Logger.info('✅ TRAE优化系统集成器已关闭', 'TRAEOptimizationIntegrator');
    }
}
exports.TRAEOptimizationIntegrator = TRAEOptimizationIntegrator;
exports.default = TRAEOptimizationIntegrator;

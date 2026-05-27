/**
 * TRAE优化系统集成器
 * 将所有效率优化功能集成到jiabaixing系统中
 */

import { EventEmitter } from 'events';
import { ConfigLoader } from '../config/ConfigLoader';
import { MCPServerManager } from '../mcp/MCPServerManager';
import { PerformanceMonitor } from '../monitoring/PerformanceMonitor';
import { SkillRegistry } from '../skills/SkillRegistry';
import { Logger } from '../utils/Logger';

export interface TRAEOptimizationConfig {
  enableMCP: boolean;
  enablePerformanceMonitoring: boolean;
  enableSecurityAudit: boolean;
  enableAutoOptimization: boolean;
  monitoringInterval: number;
  autoOptimizationInterval: number;
}

export interface SystemHealthStatus {
  status: 'healthy' | 'degraded' | 'critical';
  mcpServers: { running: number; total: number };
  performance: {
    responseTime: number;
    memoryUsage: number;
    errorRate: number;
  };
  skills: { registered: number; active: number };
  security: { lastAudit: string; issues: number };
  timestamp: number;
}

export class TRAEOptimizationIntegrator extends EventEmitter {
  private static instance: TRAEOptimizationIntegrator | null = null;
  private config: TRAEOptimizationConfig;
  private mcpManager: MCPServerManager | null = null;
  private performanceMonitor: PerformanceMonitor | null = null;
  private configLoader: ConfigLoader | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private optimizationInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  private constructor(config?: Partial<TRAEOptimizationConfig>) {
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

  public static getInstance(
    config?: Partial<TRAEOptimizationConfig>
  ): TRAEOptimizationIntegrator {
    if (!TRAEOptimizationIntegrator.instance) {
      TRAEOptimizationIntegrator.instance = new TRAEOptimizationIntegrator(
        config
      );
    }
    return TRAEOptimizationIntegrator.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      Logger.warn('TRAE优化系统集成器已初始化', 'TRAEOptimizationIntegrator');
      return;
    }

    Logger.info(
      '🚀 开始初始化TRAE优化系统集成器...',
      'TRAEOptimizationIntegrator'
    );

    try {
      await this.initializeConfig();
      await this.initializeSkillRegistry();
      await this.initializeMCP();
      await this.initializePerformanceMonitoring();
      await this.registerOptimizedSkills();
      await this.startHealthChecks();
      await this.startAutoOptimization();

      this.initialized = true;
      Logger.info(
        '✅ TRAE优化系统集成器初始化完成',
        'TRAEOptimizationIntegrator'
      );
      this.emit('initialized');
    } catch (error) {
      Logger.error(
        'TRAE优化系统集成器初始化失败',
        error as Error,
        'TRAEOptimizationIntegrator'
      );
      throw error;
    }
  }

  private async initializeConfig(): Promise<void> {
    Logger.info('📋 初始化配置管理...', 'TRAEOptimizationIntegrator');

    this.configLoader = ConfigLoader.getInstance();
    const config = await this.configLoader.loadConfig();

    if (config?.monitoring?.enableMetrics) {
      this.config.enablePerformanceMonitoring = true;
    }

    Logger.info('✅ 配置管理初始化完成', 'TRAEOptimizationIntegrator');
  }

  private async initializeSkillRegistry(): Promise<void> {
    Logger.info('🔧 初始化技能注册中心...', 'TRAEOptimizationIntegrator');

    this.skillRegistry = SkillRegistry.getInstance();
    const skillCount = this.skillRegistry.getSkillCount();

    Logger.info(
      `✅ 技能注册中心初始化完成，已注册 ${skillCount} 个技能`,
      'TRAEOptimizationIntegrator'
    );
  }

  private async initializeMCP(): Promise<void> {
    if (!this.config.enableMCP) {
      Logger.info('⏭️ MCP集成已禁用', 'TRAEOptimizationIntegrator');
      return;
    }

    Logger.info('🌐 初始化MCP服务器管理器...', 'TRAEOptimizationIntegrator');

    this.mcpManager = MCPServerManager.getInstance();

    if (this.configLoader) {
      const mcpServers = this.configLoader.getConfig()?.mcpServers || {};
      Object.entries(mcpServers).forEach(
        ([name, serverConfig]: [string, any]) => {
          this.mcpManager?.registerServer({
            name,
            command: serverConfig._command,
            args: serverConfig._args,
            description: serverConfig._description,
            enabled: true,
          });
        }
      );
    }

    await this.mcpManager.startAllServers();

    const runningCount = this.mcpManager.getRunningServerCount();
    Logger.info(
      `✅ MCP服务器管理器初始化完成，${runningCount} 个服务器运行中`,
      'TRAEOptimizationIntegrator'
    );
  }

  private async initializePerformanceMonitoring(): Promise<void> {
    if (!this.config.enablePerformanceMonitoring) {
      Logger.info('⏭️ 性能监控已禁用', 'TRAEOptimizationIntegrator');
      return;
    }

    Logger.info('📊 初始化性能监控...', 'TRAEOptimizationIntegrator');

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

    this.performanceMonitor = PerformanceMonitor.getInstance(monitoringConfig);
    this.performanceMonitor.startMonitoring(this.config.monitoringInterval);

    this.performanceMonitor.on('performanceAlert', (alert) => {
      Logger.warn(
        `⚠️ 性能告警: ${alert.message}`,
        'TRAEOptimizationIntegrator'
      );
      this.emit('performanceAlert', alert);
    });

    Logger.info('✅ 性能监控初始化完成', 'TRAEOptimizationIntegrator');
  }

  private async registerOptimizedSkills(): Promise<void> {
    Logger.info('🎯 优化技能已由 Harness ToolRegistry 统一管理', 'TRAEOptimizationIntegrator');
  }

  private async startHealthChecks(): Promise<void> {
    Logger.info('🏥 启动健康检查...', 'TRAEOptimizationIntegrator');

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 120000);

    Logger.info('✅ 健康检查已启动 (每2分钟)', 'TRAEOptimizationIntegrator');
  }

  private async startAutoOptimization(): Promise<void> {
    if (!this.config.enableAutoOptimization) {
      Logger.info('⏭️ 自动优化已禁用', 'TRAEOptimizationIntegrator');
      return;
    }

    Logger.info('⚡ 启动自动优化...', 'TRAEOptimizationIntegrator');

    this.optimizationInterval = setInterval(() => {
      this.performAutoOptimization();
    }, this.config.autoOptimizationInterval);

    Logger.info(
      `✅ 自动优化已启动 (每${this.config.autoOptimizationInterval / 60000}分钟)`,
      'TRAEOptimizationIntegrator'
    );
  }

  private async performHealthCheck(): Promise<SystemHealthStatus> {
    const status: SystemHealthStatus = {
      status: 'healthy',
      mcpServers: { running: 0, total: 0 },
      performance: { responseTime: 0, memoryUsage: 0, errorRate: 0 },
      skills: { registered: 0, active: 0 },
      security: { lastAudit: '', issues: 0 },
      timestamp: Date.now(),
    };

    if (this.mcpManager) {
      status.mcpServers.running = this.mcpManager.getRunningServerCount();
      status.mcpServers.total = this.mcpManager.getServerCount();
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

        if (
          status.performance.responseTime > thresholds.responseTime ||
          status.performance.memoryUsage > thresholds.memoryUsage ||
          status.performance.errorRate > thresholds.errorRate
        ) {
          status.status = 'degraded';
        }

        if (
          status.performance.responseTime > thresholds.responseTime * 2 ||
          status.performance.memoryUsage > thresholds.memoryUsage * 2
        ) {
          status.status = 'critical';
        }
      }
    }

    this.emit('healthCheck', status);

    if (status.status !== 'healthy') {
      Logger.warn(
        `⚠️ 系统健康状态: ${status.status}`,
        'TRAEOptimizationIntegrator'
      );
    }

    return status;
  }

  private async performAutoOptimization(): Promise<void> {
    Logger.info('🔧 执行自动优化...', 'TRAEOptimizationIntegrator');

    try {
      if (this.config.enableSecurityAudit && this.skillRegistry) {
        await this.runSecurityAudit();
      }

      if (this.performanceMonitor) {
        const metrics = this.performanceMonitor.getCurrentMetrics();
        if (metrics && metrics.errorRate > 0.1) {
          Logger.warn(
            '检测到高错误率，建议检查系统状态',
            'TRAEOptimizationIntegrator'
          );
        }
      }

      this.emit('autoOptimizationCompleted');
      Logger.info('✅ 自动优化完成', 'TRAEOptimizationIntegrator');
    } catch (error) {
      Logger.error(
        '自动优化失败',
        error as Error,
        'TRAEOptimizationIntegrator'
      );
    }
  }

  private async runSecurityAudit(): Promise<void> {
    if (!this.skillRegistry) return;

    try {
      const result = await this.skillRegistry.executeSkill('security_audit', {
        target: './src',
        auditType: 'code',
      });

      if (result.success && result.output) {
        const auditData = result.output as { summary?: string };
        Logger.info(
          `安全审计完成: ${auditData.summary || '完成'}`,
          'TRAEOptimizationIntegrator'
        );
      }
    } catch (error) {
      Logger.error(
        '安全审计失败',
        error as Error,
        'TRAEOptimizationIntegrator'
      );
    }
  }

  public getSystemHealth(): SystemHealthStatus {
    return {
      status: 'healthy',
      mcpServers: { running: 0, total: 0 },
      performance: { responseTime: 0, memoryUsage: 0, errorRate: 0 },
      skills: { registered: 0, active: 0 },
      security: { lastAudit: '', issues: 0 },
      timestamp: Date.now(),
    };
  }

  public getPerformanceMetrics() {
    return this.performanceMonitor?.getCurrentMetrics();
  }

  public getMCPStatus() {
    return this.mcpManager?.getAllServerStatus();
  }

  public getSkillStatus() {
    return {
      registered: this.skillRegistry?.getSkillCount() || 0,
      categories: this.skillRegistry?.getCategories() || [],
    };
  }

  public async executeOptimizedSkill(
    skillName: string,
    params: Record<string, unknown>
  ) {
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

  public updateConfig(config: Partial<TRAEOptimizationConfig>): void {
    this.config = { ...this.config, ...config };
    Logger.info('配置已更新', 'TRAEOptimizationIntegrator');
  }

  public shutdown(): void {
    Logger.info('🛑 关闭TRAE优化系统集成器...', 'TRAEOptimizationIntegrator');

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

    if (this.mcpManager) {
      this.mcpManager.stopAllServers();
    }

    this.initialized = false;
    Logger.info('✅ TRAE优化系统集成器已关闭', 'TRAEOptimizationIntegrator');
  }
}

export default TRAEOptimizationIntegrator;

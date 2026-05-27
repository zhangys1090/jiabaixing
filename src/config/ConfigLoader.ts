/**
 * 配置加载器
 * 从.trae/config.json加载配置
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from '../utils/Logger';

export interface TraeConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      description?: string;
    }
  >;
  skills: {
    enabled: string[];
    priority: Record<string, number>;
    autoDiscovery: boolean;
    skillCacheEnabled: boolean;
  };
  context: {
    maxMemoryItems: number;
    contextWindow: number;
    refreshInterval: number;
    memoryTypes: string[];
    timelineEnabled: boolean;
    userProfileEnabled: boolean;
  };
  performance: {
    parallelExecution: boolean;
    cachingEnabled: boolean;
    lazyLoading: boolean;
    maxConcurrentTasks: number;
    taskTimeout: number;
    memoryThreshold: number;
  };
  security: {
    enableSandbox: boolean;
    commandWhitelist: string[];
    fileAccessWhitelist: string[];
    enableAuditLog: boolean;
    maxFileSize: number;
  };
  monitoring: {
    enableMetrics: boolean;
    logLevel: string;
    alertThresholds: {
      responseTime: number;
      memoryUsage: number;
      errorRate: number;
    };
    performanceTracking: boolean;
  };
  development: {
    autoReload: boolean;
    debugMode: boolean;
    verboseLogging: boolean;
    testMode: boolean;
  };
}

export class ConfigLoader {
  private static instance: ConfigLoader | null = null;
  private config: TraeConfig | null = null;
  private configPath: string;

  private constructor() {
    this.configPath = path.join(process.cwd(), '.trae', 'config.json');
  }

  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  public async loadConfig(): Promise<TraeConfig> {
    try {
      if (!(await fs.pathExists(this.configPath))) {
        Logger.warn(
          `配置文件不存在: ${this.configPath}，使用默认配置`,
          'ConfigLoader'
        );
        return this.getDefaultConfig();
      }

      const configContent = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(configContent) as TraeConfig;

      Logger.info(`✅ 配置文件已加载: ${this.configPath}`, 'ConfigLoader');
      return this.config;
    } catch (error) {
      Logger.error(
        '配置文件加载失败，使用默认配置',
        error as Error,
        'ConfigLoader'
      );
      return this.getDefaultConfig();
    }
  }

  public getConfig(): TraeConfig | null {
    return this.config;
  }

  public async saveConfig(config: TraeConfig): Promise<boolean> {
    try {
      await fs.ensureDir(path.dirname(this.configPath));
      await fs.writeFile(
        this.configPath,
        JSON.stringify(config, null, 2),
        'utf-8'
      );
      this.config = config;
      Logger.info(`✅ 配置文件已保存: ${this.configPath}`, 'ConfigLoader');
      return true;
    } catch (error) {
      Logger.error('配置文件保存失败', error as Error, 'ConfigLoader');
      return false;
    }
  }

  private getDefaultConfig(): TraeConfig {
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

  public getMCPServerConfig(serverName: string): unknown {
    return this.config?.mcpServers[serverName];
  }

  public getEnabledSkills(): string[] {
    return this.config?.skills.enabled || [];
  }

  public getSkillPriority(skillName: string): number {
    return this.config?.skills.priority[skillName] || 999;
  }

  public isMonitoringEnabled(): boolean {
    return this.config?.monitoring.enableMetrics || false;
  }

  public getMonitoringConfig() {
    return this.config?.monitoring;
  }
}

export default ConfigLoader;

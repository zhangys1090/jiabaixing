/**
 * 环境变量管理工具
 * 安全地加载和管理环境变量，确保敏感信息不被暴露
 */

import * as dotenv from 'dotenv';
import { Logger } from './Logger';

/**
 * 环境变量配置接口
 */
export interface EnvironmentConfig {
  // 服务器配置
  PORT: number;
  HOST: string;
  NODE_ENV: string;

  // 安全配置
  SECRET_KEY: string;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;

  // LLM 配置
  OPENAI_API_BASE: string;
  OPENAI_API_KEY: string;
  LLM_MODEL: string;
  EMBEDDING_MODEL: string;

  // 数据库配置
  CHROMA_HOST: string;
  CHROMA_PORT: number;

  // 日志配置
  LOG_LEVEL: string;
  LOG_FILE: string;

  // 速率限制配置
  RATE_LIMIT: number;
  RATE_LIMIT_WINDOW: number;

  // CORS配置
  ALLOWED_ORIGINS: string[];

  // 安全配置
  SECURITY_HEADERS: boolean;
  XSS_PROTECTION: boolean;
  CSP_ENABLED: boolean;

  // 监控配置
  SENTRY_DSN: string;
  NEW_RELIC_LICENSE_KEY: string;

  // 邮件配置
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASS: string;
  FROM_EMAIL: string;
}

/**
 * 环境变量管理类
 */
export class EnvironmentManager {
  private static instance: EnvironmentManager;
  private config: EnvironmentConfig = {} as EnvironmentConfig;
  private sensitiveKeys: string[] = [
    'SECRET_KEY',
    'ENCRYPTION_KEY',
    'JWT_SECRET',
    'SMTP_PASS',
    'SENTRY_DSN',
    'NEW_RELIC_LICENSE_KEY',
  ];

  private constructor() {
    this.loadEnvironment();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): EnvironmentManager {
    if (!EnvironmentManager.instance) {
      EnvironmentManager.instance = new EnvironmentManager();
    }
    return EnvironmentManager.instance;
  }

  /**
   * 加载环境变量
   */
  private loadEnvironment(): void {
    try {
      // 加载 .env 文件
      const result = dotenv.config();

      if (result.error) {
        Logger.warn(
          '⚠️ 无法加载 .env 文件，使用默认配置',
          result.error.message
        );
      }

      // 构建配置
      this.config = {
        // 服务器配置
        PORT: this.getNumber('_PORT', 3101),
        HOST: this.getString('_HOST', '0.0.0.0'),
        NODE_ENV: this.getString('_NODE_ENV', 'development'),

        // 安全配置
        SECRET_KEY: this.getString('_SECRET_KEY', ''),
        ENCRYPTION_KEY: this.getString('_ENCRYPTION_KEY', ''),
        JWT_SECRET: this.getString('_JWT_SECRET', ''),

        // LLM 配置
        OPENAI_API_BASE: this.getString(
          'OPENAI_API_BASE',
          'http://127.0.0.1:8001/v1'
        ),
        OPENAI_API_KEY: this.getString('_OPENAI_API_KEY', 'not-needed'),
        LLM_MODEL: this.getString('_LLM_MODEL', 'qwen2.5-vl'),
        EMBEDDING_MODEL: this.getString(
          'EMBEDDING_MODEL',
          'text-embedding-3-small'
        ),

        // 数据库配置
        CHROMA_HOST: this.getString('_CHROMA_HOST', 'localhost'),
        CHROMA_PORT: this.getNumber('_CHROMA_PORT', 8000),

        // 日志配置
        LOG_LEVEL: this.getString('_LOG_LEVEL', 'info'),
        LOG_FILE: this.getString('_LOG_FILE', 'logs/combined.log'),

        // 速率限制配置
        RATE_LIMIT: this.getNumber('RATE_LIMIT', 60),
        RATE_LIMIT_WINDOW: this.getNumber('_RATE_LIMIT_WINDOW', 60000),

        // CORS配置
        ALLOWED_ORIGINS: this.getArray('_ALLOWED_ORIGINS', [
          'http://localhost:3000',
          'http://localhost:3101',
        ]),

        // 安全配置
        SECURITY_HEADERS: this.getBoolean('_SECURITY_HEADERS', true),
        XSS_PROTECTION: this.getBoolean('_XSS_PROTECTION', true),
        CSP_ENABLED: this.getBoolean('_CSP_ENABLED', true),

        // 监控配置
        SENTRY_DSN: this.getString('_SENTRY_DSN', ''),
        NEW_RELIC_LICENSE_KEY: this.getString('_NEW_RELIC_LICENSE_KEY', ''),

        // 邮件配置
        SMTP_HOST: this.getString('_SMTP_HOST', ''),
        SMTP_PORT: this.getNumber('_SMTP_PORT', 587),
        SMTP_USER: this.getString('_SMTP_USER', ''),
        SMTP_PASS: this.getString('_SMTP_PASS', ''),
        FROM_EMAIL: this.getString('_FROM_EMAIL', ''),
      };

      // 验证必要的环境变量
      this.validateEnvironment();

      Logger.info('✅ 环境变量加载完成');
    } catch (error) {
      Logger.error('❌ 环境变量加载失败:', error as Error);
      throw error;
    }
  }

  /**
   * 获取字符串类型的环境变量
   * @param key 环境变量键
   * @param defaultValue 默认值
   */
  private getString(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
  }

  /**
   * 获取数字类型的环境变量
   * @param key 环境变量键
   * @param defaultValue 默认值
   */
  private getNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (value) {
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? defaultValue : parsed;
    }
    return defaultValue;
  }

  /**
   * 获取布尔类型的环境变量
   * @param key 环境变量键
   * @param defaultValue 默认值
   */
  private getBoolean(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (value) {
      return value.toLowerCase() === 'true' || value === '1';
    }
    return defaultValue;
  }

  /**
   * 获取数组类型的环境变量
   * @param key 环境变量键
   * @param defaultValue 默认值
   */
  private getArray(key: string, defaultValue: string[]): string[] {
    const value = process.env[key];
    if (value) {
      return value.split(',').map((item) => item.trim());
    }
    return defaultValue;
  }

  /**
   * 验证必要的环境变量
   */
  private validateEnvironment(): void {
    const requiredKeys = ['SECRET_KEY', 'ENCRYPTION_KEY', 'JWT_SECRET'];

    for (const key of requiredKeys) {
      if (!this.config[key as keyof EnvironmentConfig]) {
        Logger.warn(`⚠️ 环境变量 ${key} 未设置，使用默认值`);
      }
    }
  }

  /**
   * 获取配置
   */
  public getConfig(): EnvironmentConfig {
    return { ...this.config };
  }

  /**
   * 获取单个配置值
   * @param key 配置键
   */
  public get<T extends keyof EnvironmentConfig>(key: T): EnvironmentConfig[T] {
    return this.config[key];
  }

  /**
   * 安全获取敏感配置值（返回掩码）
   * @param key 配置键
   */
  public getSecure<T extends keyof EnvironmentConfig>(key: T): string {
    if (this.sensitiveKeys.includes(key)) {
      const value = this.config[key] as string;
      if (value) {
        return (
          value.substring(0, 4) + '****' + value.substring(value.length - 4)
        );
      }
      return '****';
    }
    return String(this.config[key]);
  }

  /**
   * 检查是否为开发环境
   */
  public isDevelopment(): boolean {
    return this.config.NODE_ENV === 'development';
  }

  /**
   * 检查是否为生产环境
   */
  public isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  /**
   * 检查是否为测试环境
   */
  public isTest(): boolean {
    return this.config.NODE_ENV === 'test';
  }

  /**
   * 打印配置（敏感信息会被掩码）
   */
  public printConfig(): void {
    Logger.info('📋 环境配置:');

    Object.entries(this.config).forEach(([key, value]) => {
      if (this.sensitiveKeys.includes(key)) {
        Logger.info(
          `  ${key}: ${this.getSecure(key as keyof EnvironmentConfig)}`
        );
      } else if (Array.isArray(value)) {
        Logger.info(`  ${key}: [${value.join(', ')}]`);
      } else {
        Logger.info(`  ${key}: ${value}`);
      }
    });
  }

  /**
   * 重新加载环境变量
   */
  public reload(): void {
    this.loadEnvironment();
  }

  /**
   * 检查环境变量是否安全（没有使用空值或默认值）
   */
  public checkSecurity(): boolean {
    let isSecure = true;

    // 检查敏感配置是否为空（未设置）
    const sensitiveKeys: Array<keyof EnvironmentConfig> = [
      'SECRET_KEY',
      'ENCRYPTION_KEY',
      'JWT_SECRET',
    ];

    for (const key of sensitiveKeys) {
      const value = this.config[key];
      if (!value || value === '') {
        Logger.warn(`⚠️ 敏感配置 ${key} 未设置，请在 .env 文件中配置`);
        isSecure = false;
      }
    }

    return isSecure;
  }
}

// 导出单例实例

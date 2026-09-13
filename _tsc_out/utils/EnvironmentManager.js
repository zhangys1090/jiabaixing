"use strict";
/**
 * 环境变量管理工具
 * 安全地加载和管理环境变量，确保敏感信息不被暴露
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
exports.EnvironmentManager = void 0;
const dotenv = __importStar(require("dotenv"));
const Logger_1 = require("./Logger");
/**
 * 环境变量管理类
 */
class EnvironmentManager {
    static instance;
    config = {};
    sensitiveKeys = [
        'SECRET_KEY',
        'ENCRYPTION_KEY',
        'JWT_SECRET',
        'SMTP_PASS',
        'SENTRY_DSN',
        'NEW_RELIC_LICENSE_KEY',
    ];
    constructor() {
        this.loadEnvironment();
    }
    static create() {
        return new EnvironmentManager();
    }
    static getInstance() {
        if (!EnvironmentManager.instance) {
            EnvironmentManager.instance = new EnvironmentManager();
        }
        return EnvironmentManager.instance;
    }
    /**
     * 加载环境变量
     */
    loadEnvironment() {
        try {
            // 加载 .env 文件
            const result = dotenv.config();
            if (result.error) {
                Logger_1.Logger.warn('⚠️ 无法加载 .env 文件，使用默认配置', result.error.message);
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
                OPENAI_API_BASE: this.getString('OPENAI_API_BASE', 'http://127.0.0.1:8001/v1'),
                OPENAI_API_KEY: this.getString('_OPENAI_API_KEY', 'not-needed'),
                LLM_MODEL: this.getString('_LLM_MODEL', 'deepseek-v4-flash'),
                EMBEDDING_MODEL: this.getString('EMBEDDING_MODEL', 'text-embedding-3-small'),
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
            Logger_1.Logger.info('✅ 环境变量加载完成');
        }
        catch (error) {
            Logger_1.Logger.error('❌ 环境变量加载失败:', error);
            throw error;
        }
    }
    /**
     * 获取字符串类型的环境变量
     * @param key 环境变量键
     * @param defaultValue 默认值
     */
    getString(key, defaultValue) {
        return process.env[key] || defaultValue;
    }
    /**
     * 获取数字类型的环境变量
     * @param key 环境变量键
     * @param defaultValue 默认值
     */
    getNumber(key, defaultValue) {
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
    getBoolean(key, defaultValue) {
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
    getArray(key, defaultValue) {
        const value = process.env[key];
        if (value) {
            return value.split(',').map((item) => item.trim());
        }
        return defaultValue;
    }
    /**
     * 验证必要的环境变量
     */
    validateEnvironment() {
        const requiredKeys = ['SECRET_KEY', 'ENCRYPTION_KEY', 'JWT_SECRET'];
        for (const key of requiredKeys) {
            if (!this.config[key]) {
                Logger_1.Logger.warn(`⚠️ 环境变量 ${key} 未设置，使用默认值`);
            }
        }
    }
    /**
     * 获取配置
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * 获取单个配置值
     * @param key 配置键
     */
    get(key) {
        return this.config[key];
    }
    /**
     * 安全获取敏感配置值（返回掩码）
     * @param key 配置键
     */
    getSecure(key) {
        if (this.sensitiveKeys.includes(key)) {
            const value = this.config[key];
            if (value) {
                return (value.substring(0, 4) + '****' + value.substring(value.length - 4));
            }
            return '****';
        }
        return String(this.config[key]);
    }
    /**
     * 检查是否为开发环境
     */
    isDevelopment() {
        return this.config.NODE_ENV === 'development';
    }
    /**
     * 检查是否为生产环境
     */
    isProduction() {
        return this.config.NODE_ENV === 'production';
    }
    /**
     * 检查是否为测试环境
     */
    isTest() {
        return this.config.NODE_ENV === 'test';
    }
    /**
     * 打印配置（敏感信息会被掩码）
     */
    printConfig() {
        Logger_1.Logger.info('📋 环境配置:');
        Object.entries(this.config).forEach(([key, value]) => {
            if (this.sensitiveKeys.includes(key)) {
                Logger_1.Logger.info(`  ${key}: ${this.getSecure(key)}`);
            }
            else if (Array.isArray(value)) {
                Logger_1.Logger.info(`  ${key}: [${value.join(', ')}]`);
            }
            else {
                Logger_1.Logger.info(`  ${key}: ${value}`);
            }
        });
    }
    /**
     * 重新加载环境变量
     */
    reload() {
        this.loadEnvironment();
    }
    /**
     * 检查环境变量是否安全（没有使用空值或默认值）
     */
    checkSecurity() {
        let isSecure = true;
        // 检查敏感配置是否为空（未设置）
        const sensitiveKeys = [
            'SECRET_KEY',
            'ENCRYPTION_KEY',
            'JWT_SECRET',
        ];
        for (const key of sensitiveKeys) {
            const value = this.config[key];
            if (!value || value === '') {
                Logger_1.Logger.warn(`⚠️ 敏感配置 ${key} 未设置，请在 .env 文件中配置`);
                isSecure = false;
            }
        }
        return isSecure;
    }
}
exports.EnvironmentManager = EnvironmentManager;
// 导出单例实例

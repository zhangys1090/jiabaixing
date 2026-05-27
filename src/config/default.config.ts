/**
 * 默认配置文件
 * 定义系统所有模块的默认配置值
 */

export const defaultConfig = {
  server: {
    port: 3111,
    host: '0.0.0.0',
    corsOrigins: ['http://localhost:3000', 'http://localhost:3100'],
    websocket: {
      enabled: true,
      heartbeatInterval: 30000,
      maxConnections: 100,
    },
    rateLimit: {
      windowMs: 60000,
      maxRequests: 100,
    },
    compression: {
      enabled: true,
      threshold: 1024,
    },
    cache: {
      enabled: true,
      ttl: 30000,
      maxSize: 100,
    },
  },

  database: {
    storagePath: './data',
    journalMode: 'WAL',
    synchronous: 'NORMAL',
    cacheSize: -64000,
    backup: {
      enabled: true,
      interval: 86400000,
      maxBackups: 7,
    },
  },

  model: {
    defaultModel: 'qwen2.5:3b',
    baseUrl: 'http://127.0.0.1:8001/v1',
    apiKey: 'not-needed',
    timeout: 60000,
    maxTokens: 4096,
    temperature: 0.7,
    fallbackModels: [
      {
        name: 'zhipu',
        displayName: '智谱 GLM',
        priority: 2,
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelName: 'glm-4.5-air',
        enabled: true,
      },
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        priority: 3,
        baseUrl: 'https://api.deepseek.com/v1',
        modelName: 'deepseek-chat',
        enabled: true,
      },
    ],
    healthCheck: {
      enabled: true,
      interval: 60000,
      timeout: 5000,
    },
  },

  memory: {
    shortTerm: {
      maxSize: 100,
      ttl: 3600000,
    },
    longTerm: {
      enabled: true,
      vectorStore: {
        provider: 'chroma',
        collectionName: 'jiabaixing_memories',
        dimension: 1536,
      },
    },
    autoExtraction: {
      enabled: true,
      minConfidence: 0.7,
    },
  },

  evolution: {
    enabled: true,
    autoOptimize: true,
    schedule: {
      healingInterval: 3600000,
      refactorInterval: 86400000,
      enhancementInterval: 604800000,
    },
    thresholds: {
      errorRate: 0.1,
      performanceDegradation: 0.2,
      codeSmellScore: 50,
    },
  },

  security: {
    encryption: {
      algorithm: 'aes-256-gcm',
      keyRotationDays: 30,
    },
    jwt: {
      expiresIn: '24h',
      refreshExpiresIn: '7d',
    },
    rateLimit: {
      windowMs: 900000,
      maxRequests: 100,
    },
    cors: {
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    },
  },

  logging: {
    level: 'info',
    format: 'json',
    console: true,
    file: {
      enabled: true,
      dir: './logs',
      maxSize: '10m',
      maxFiles: 10,
    },
    audit: {
      enabled: true,
      sensitiveFields: ['password', 'apiKey', 'token', 'secret'],
    },
  },

  frontend: {
    apiUrl: 'http://localhost:3111',
    wsUrl: 'ws://localhost:3111',
    features: {
      voiceInput: true,
      fileUpload: true,
      skillConsole: true,
      evolutionPanel: true,
      agentExecutionPanel: true,
    },
    ui: {
      theme: 'light',
      language: 'zh-CN',
      messagePageSize: 50,
    },
  },

  skills: {
    autoRegister: true,
    timeout: 30000,
    maxConcurrent: 5,
    retryAttempts: 3,
    categories: [
      'utility',
      'analysis',
      'creative',
      'automation',
      'communication',
    ],
  },

  tools: {
    autoRegister: true,
    sandbox: {
      enabled: true,
      timeout: 10000,
      memoryLimit: 256 * 1024 * 1024,
    },
    validation: {
      enabled: true,
      strictMode: false,
    },
  },
};

export type DefaultConfig = typeof defaultConfig;
export default defaultConfig;

# jiabaixing深度整合实施指南

## 📋 实施概述

本指南提供了jiabaixing系统深度整合的详细实施步骤，包括代码实现、测试策略和部署方案。

---

## 🎯 阶段一：基础设施层整合（2周）

### 任务1.1：增强ServiceContainer

**目标**：实现自动依赖注入、生命周期管理、健康检查

**实现步骤**：

#### 1.1.1 创建增强的服务容器

```typescript
// src/shared/EnhancedServiceContainer.ts

import { Logger } from '../utils/Logger';
import { EventBus } from './EventBus';

export interface LifecycleHook {
  onInitialize?: () => Promise<void> | void;
  onStart?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onDestroy?: () => Promise<void> | void;
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

export interface ServiceDefinition {
  name: string;
  factory: () => unknown;
  singleton?: boolean;
  lazy?: boolean;
  dependencies?: string[];
  lifecycleHooks?: LifecycleHook;
  healthCheck?: () => Promise<ServiceHealth> | ServiceHealth;
}

interface ServiceEntry {
  definition: ServiceDefinition;
  instance?: unknown;
  initialized: boolean;
  started: boolean;
  error?: Error;
}

export class EnhancedServiceContainer {
  private static instance: EnhancedServiceContainer;
  private services: Map<string, ServiceEntry> = new Map();
  private dependencyGraph: Map<string, string[]> = new Map();
  private eventBus: EventBus;
  private initialized = false;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus || EventBus;
  }

  static getInstance(eventBus?: EventBus): EnhancedServiceContainer {
    if (!EnhancedServiceContainer.instance) {
      EnhancedServiceContainer.instance = new EnhancedServiceContainer(
        eventBus
      );
    }
    return EnhancedServiceContainer.instance;
  }

  async register(definition: ServiceDefinition): Promise<void> {
    if (this.services.has(definition.name)) {
      Logger.warn(
        `服务 "${definition.name}" 已存在，将被覆盖`,
        'EnhancedServiceContainer'
      );
    }

    this.services.set(definition.name, {
      definition,
      initialized: false,
      started: false,
    });

    if (definition.dependencies) {
      this.dependencyGraph.set(definition.name, definition.dependencies);
    }

    this.eventBus.emit('service_registered', { name: definition.name });

    if (!definition.lazy) {
      await this.initialize(definition.name);
    }
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const result: string[] = [];

    const visit = (name: string): void => {
      if (temp.has(name)) {
        throw new Error(`检测到循环依赖: ${name}`);
      }
      if (visited.has(name)) return;

      temp.add(name);
      const dependencies = this.dependencyGraph.get(name) || [];
      for (const dep of dependencies) {
        visit(dep);
      }
      temp.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (const name of this.services.keys()) {
      visit(name);
    }

    return result;
  }

  async initialize(name: string): Promise<void> {
    const entry = this.services.get(name);
    if (!entry) {
      throw new Error(`服务 "${name}" 未注册`);
    }

    if (entry.initialized) return;

    const dependencies = this.dependencyGraph.get(name) || [];
    for (const dep of dependencies) {
      await this.initialize(dep);
    }

    try {
      this.eventBus.emit('service_initializing', { name });

      if (entry.definition.lifecycleHooks?.onInitialize) {
        await entry.definition.lifecycleHooks.onInitialize();
      }

      if (!entry.definition.singleton || !entry.instance) {
        entry.instance = entry.definition.factory();
      }

      entry.initialized = true;
      this.eventBus.emit('service_initialized', { name });

      Logger.info(`✅ 服务 "${name}" 初始化成功`, 'EnhancedServiceContainer');
    } catch (error) {
      entry.error = error as Error;
      this.eventBus.emit('service_initialization_failed', {
        name,
        error: (error as Error).message,
      });
      Logger.error(
        `❌ 服务 "${name}" 初始化失败`,
        error as Error,
        'EnhancedServiceContainer'
      );
      throw error;
    }
  }

  async initializeAll(): Promise<void> {
    if (this.initialized) return;

    const sorted = this.topologicalSort();
    Logger.info(
      `🚀 开始初始化 ${sorted.length} 个服务...`,
      'EnhancedServiceContainer'
    );

    for (const name of sorted) {
      await this.initialize(name);
    }

    this.initialized = true;
    Logger.info(`✅ 所有服务初始化完成`, 'EnhancedServiceContainer');
  }

  async start(name: string): Promise<void> {
    const entry = this.services.get(name);
    if (!entry) {
      throw new Error(`服务 "${name}" 未注册`);
    }

    if (!entry.initialized) {
      await this.initialize(name);
    }

    if (entry.started) return;

    try {
      this.eventBus.emit('service_starting', { name });

      if (entry.definition.lifecycleHooks?.onStart) {
        await entry.definition.lifecycleHooks.onStart();
      }

      entry.started = true;
      this.eventBus.emit('service_started', { name });

      Logger.info(`▶️ 服务 "${name}" 启动成功`, 'EnhancedServiceContainer');
    } catch (error) {
      this.eventBus.emit('service_start_failed', {
        name,
        error: (error as Error).message,
      });
      Logger.error(
        `❌ 服务 "${name}" 启动失败`,
        error as Error,
        'EnhancedServiceContainer'
      );
      throw error;
    }
  }

  async startAll(): Promise<void> {
    const sorted = this.topologicalSort();
    Logger.info(
      `🚀 开始启动 ${sorted.length} 个服务...`,
      'EnhancedServiceContainer'
    );

    for (const name of sorted) {
      await this.start(name);
    }

    Logger.info(`✅ 所有服务启动完成`, 'EnhancedServiceContainer');
  }

  async stop(name: string): Promise<void> {
    const entry = this.services.get(name);
    if (!entry || !entry.started) return;

    try {
      this.eventBus.emit('service_stopping', { name });

      if (entry.definition.lifecycleHooks?.onStop) {
        await entry.definition.lifecycleHooks.onStop();
      }

      entry.started = false;
      this.eventBus.emit('service_stopped', { name });

      Logger.info(`⏸️ 服务 "${name}" 停止成功`, 'EnhancedServiceContainer');
    } catch (error) {
      Logger.error(
        `❌ 服务 "${name}" 停止失败`,
        error as Error,
        'EnhancedServiceContainer'
      );
    }
  }

  async stopAll(): Promise<void> {
    const sorted = this.topologicalSort().reverse();
    Logger.info(
      `🛑 开始停止 ${sorted.length} 个服务...`,
      'EnhancedServiceContainer'
    );

    for (const name of sorted) {
      await this.stop(name);
    }

    Logger.info(`✅ 所有服务停止完成`, 'EnhancedServiceContainer');
  }

  async destroy(name: string): Promise<void> {
    await this.stop(name);

    const entry = this.services.get(name);
    if (!entry) return;

    try {
      this.eventBus.emit('service_destroying', { name });

      if (entry.definition.lifecycleHooks?.onDestroy) {
        await entry.definition.lifecycleHooks.onDestroy();
      }

      if (
        entry.instance &&
        typeof (entry.instance as Record<string, unknown>).destroy ===
          'function'
      ) {
        (await (entry.instance as Record<string, unknown>)
          .destroy) as () => Promise<void>;
      }

      this.services.delete(name);
      this.dependencyGraph.delete(name);
      this.eventBus.emit('service_destroyed', { name });

      Logger.info(`🗑️ 服务 "${name}" 销毁成功`, 'EnhancedServiceContainer');
    } catch (error) {
      Logger.error(
        `❌ 服务 "${name}" 销毁失败`,
        error as Error,
        'EnhancedServiceContainer'
      );
    }
  }

  async destroyAll(): Promise<void> {
    const sorted = this.topologicalSort().reverse();
    Logger.info(
      `🗑️ 开始销毁 ${sorted.length} 个服务...`,
      'EnhancedServiceContainer'
    );

    for (const name of sorted) {
      await this.destroy(name);
    }

    this.initialized = false;
    Logger.info(`✅ 所有服务销毁完成`, 'EnhancedServiceContainer');
  }

  get<T>(name: string): T {
    const entry = this.services.get(name);
    if (!entry) {
      throw new Error(`服务 "${name}" 未注册`);
    }

    if (!entry.initialized) {
      throw new Error(`服务 "${name}" 未初始化`);
    }

    return entry.instance as T;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  async healthCheck(name: string): Promise<ServiceHealth> {
    const entry = this.services.get(name);
    if (!entry) {
      return {
        name,
        status: 'unhealthy',
        message: '服务未注册',
        timestamp: Date.now(),
      };
    }

    if (!entry.initialized) {
      return {
        name,
        status: 'unhealthy',
        message: '服务未初始化',
        timestamp: Date.now(),
      };
    }

    if (entry.error) {
      return {
        name,
        status: 'unhealthy',
        message: entry.error.message,
        timestamp: Date.now(),
      };
    }

    if (entry.definition.healthCheck) {
      try {
        return await entry.definition.healthCheck();
      } catch (error) {
        return {
          name,
          status: 'unhealthy',
          message: (error as Error).message,
          timestamp: Date.now(),
        };
      }
    }

    return {
      name,
      status: 'healthy',
      timestamp: Date.now(),
    };
  }

  async healthCheckAll(): Promise<ServiceHealth[]> {
    const results: ServiceHealth[] = [];
    for (const name of this.services.keys()) {
      const health = await this.healthCheck(name);
      results.push(health);
    }
    return results;
  }

  getStatus(): Array<{
    name: string;
    initialized: boolean;
    started: boolean;
    singleton: boolean;
    hasError: boolean;
    error?: string;
  }> {
    return Array.from(this.services.entries()).map(([name, entry]) => ({
      name,
      initialized: entry.initialized,
      started: entry.started,
      singleton: entry.definition.singleton || false,
      hasError: !!entry.error,
      error: entry.error?.message,
    }));
  }

  getDependencyGraph(): Record<string, string[]> {
    return Object.fromEntries(this.dependencyGraph);
  }
}

export const enhancedServiceContainer = EnhancedServiceContainer.getInstance();
```

#### 1.1.2 创建测试文件

```typescript
// tests/shared/enhanced-service-container.test.ts

import { EnhancedServiceContainer } from '../../src/shared/EnhancedServiceContainer';
import { EventBus } from '../../src/shared/EventBus';

describe('EnhancedServiceContainer', () => {
  let container: EnhancedServiceContainer;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    container = new EnhancedServiceContainer(eventBus);
  });

  afterEach(async () => {
    await container.destroyAll();
  });

  describe('服务注册', () => {
    it('应该成功注册服务', async () => {
      await container.register({
        name: 'testService',
        factory: () => ({ value: 42 }),
      });

      expect(container.has('testService')).toBe(true);
    });

    it('应该处理依赖关系', async () => {
      await container.register({
        name: 'dependencyService',
        factory: () => ({ value: 10 }),
      });

      await container.register({
        name: 'dependentService',
        factory: () => ({ value: 20 }),
        dependencies: ['dependencyService'],
      });

      await container.initializeAll();

      expect(container.has('dependencyService')).toBe(true);
      expect(container.has('dependentService')).toBe(true);
    });

    it('应该检测循环依赖', async () => {
      await container.register({
        name: 'serviceA',
        factory: () => ({}),
        dependencies: ['serviceB'],
      });

      await container.register({
        name: 'serviceB',
        factory: () => ({}),
        dependencies: ['serviceA'],
      });

      await expect(container.initializeAll()).rejects.toThrow('循环依赖');
    });
  });

  describe('生命周期管理', () => {
    it('应该执行初始化钩子', async () => {
      let initialized = false;

      await container.register({
        name: 'testService',
        factory: () => ({}),
        lifecycleHooks: {
          onInitialize: async () => {
            initialized = true;
          },
        },
      });

      await container.initialize('testService');

      expect(initialized).toBe(true);
    });

    it('应该执行启动钩子', async () => {
      let started = false;

      await container.register({
        name: 'testService',
        factory: () => ({}),
        lifecycleHooks: {
          onStart: async () => {
            started = true;
          },
        },
      });

      await container.start('testService');

      expect(started).toBe(true);
    });

    it('应该执行停止钩子', async () => {
      let stopped = false;

      await container.register({
        name: 'testService',
        factory: () => ({}),
        lifecycleHooks: {
          onStop: async () => {
            stopped = true;
          },
        },
      });

      await container.start('testService');
      await container.stop('testService');

      expect(stopped).toBe(true);
    });

    it('应该执行销毁钩子', async () => {
      let destroyed = false;

      await container.register({
        name: 'testService',
        factory: () => ({
          destroy: async () => {
            destroyed = true;
          },
        }),
      });

      await container.initialize('testService');
      await container.destroy('testService');

      expect(destroyed).toBe(true);
    });
  });

  describe('健康检查', () => {
    it('应该检查服务健康状态', async () => {
      await container.register({
        name: 'testService',
        factory: () => ({}),
        healthCheck: () => ({
          name: 'testService',
          status: 'healthy',
          timestamp: Date.now(),
        }),
      });

      await container.initialize('testService');

      const health = await container.healthCheck('testService');

      expect(health.status).toBe('healthy');
    });

    it('应该检查所有服务健康状态', async () => {
      await container.register({
        name: 'service1',
        factory: () => ({}),
      });

      await container.register({
        name: 'service2',
        factory: () => ({}),
      });

      await container.initializeAll();

      const healthResults = await container.healthCheckAll();

      expect(healthResults).toHaveLength(2);
      expect(healthResults.every((h) => h.status === 'healthy')).toBe(true);
    });
  });

  describe('依赖图', () => {
    it('应该构建依赖图', async () => {
      await container.register({
        name: 'serviceA',
        factory: () => ({}),
        dependencies: ['serviceB', 'serviceC'],
      });

      await container.register({
        name: 'serviceB',
        factory: () => ({}),
      });

      await container.register({
        name: 'serviceC',
        factory: () => ({}),
      });

      const graph = container.getDependencyGraph();

      expect(graph.serviceA).toEqual(['serviceB', 'serviceC']);
      expect(graph.serviceB).toBeUndefined();
      expect(graph.serviceC).toBeUndefined();
    });

    it('应该按拓扑顺序初始化', async () => {
      const initOrder: string[] = [];

      await container.register({
        name: 'serviceA',
        factory: () => ({}),
        dependencies: ['serviceB'],
        lifecycleHooks: {
          onInitialize: async () => {
            initOrder.push('A');
          },
        },
      });

      await container.register({
        name: 'serviceB',
        factory: () => ({}),
        dependencies: ['serviceC'],
        lifecycleHooks: {
          onInitialize: async () => {
            initOrder.push('B');
          },
        },
      });

      await container.register({
        name: 'serviceC',
        factory: () => ({}),
        lifecycleHooks: {
          onInitialize: async () => {
            initOrder.push('C');
          },
        },
      });

      await container.initializeAll();

      expect(initOrder).toEqual(['C', 'B', 'A']);
    });
  });
});
```

### 任务1.2：优化EventBus

**目标**：实现事件优先级队列、事件过滤和路由、事件重试机制

**实现步骤**：

#### 1.2.1 创建优化的EventBus

```typescript
// src/shared/OptimizedEventBus.ts

import { Logger } from '../utils/Logger';

export interface PriorityEvent {
  id: string;
  type: string;
  payload: unknown;
  priority: number;
  timestamp: number;
  retryCount?: number;
  maxRetries?: number;
}

export interface EventFilter {
  eventType?: string;
  source?: string;
  target?: string;
  predicate?: (event: PriorityEvent) => boolean;
}

export interface EventRoute {
  pattern: RegExp | string;
  target: string;
  transform?: (event: PriorityEvent) => PriorityEvent;
}

export class OptimizedEventBus {
  private static instance: OptimizedEventBus;
  private listeners: Map<string, Array<(data: unknown) => void>> = new Map();
  private priorityQueue: PriorityEvent[] = [];
  private filters: EventFilter[] = [];
  private routes: EventRoute[] = [];
  private processing = false;
  private maxQueueSize = 1000;

  private constructor() {
    this.startProcessing();
  }

  static getInstance(): OptimizedEventBus {
    if (!OptimizedEventBus.instance) {
      OptimizedEventBus.instance = new OptimizedEventBus();
    }
    return OptimizedEventBus.instance;
  }

  private startProcessing(): void {
    setInterval(() => {
      this.processQueue();
    }, 100);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.priorityQueue.length === 0) return;

    this.processing = true;

    try {
      while (this.priorityQueue.length > 0) {
        const event = this.priorityQueue.shift()!;

        if (this.shouldFilter(event)) {
          Logger.debug(`事件被过滤: ${event.type}`, 'OptimizedEventBus');
          continue;
        }

        const routedEvent = this.routeEvent(event);
        await this.emitEvent(routedEvent);
      }
    } catch (error) {
      Logger.error('处理事件队列失败', error as Error, 'OptimizedEventBus');
    } finally {
      this.processing = false;
    }
  }

  private shouldFilter(event: PriorityEvent): boolean {
    return this.filters.some((filter) => {
      if (filter.eventType && filter.eventType !== event.type) return false;
      if (filter.predicate && !filter.predicate(event)) return false;
      return true;
    });
  }

  private routeEvent(event: PriorityEvent): PriorityEvent {
    for (const route of this.routes) {
      if (typeof route.pattern === 'string') {
        if (event.type === route.pattern) {
          return route.transform ? route.transform(event) : event;
        }
      } else if (route.pattern.test(event.type)) {
        return route.transform ? route.transform(event) : event;
      }
    }
    return event;
  }

  private async emitEvent(event: PriorityEvent): Promise<void> {
    const listeners = this.listeners.get(event.type) || [];

    for (const listener of listeners) {
      try {
        await listener(event.payload);
      } catch (error) {
        Logger.error(
          `事件监听器执行失败: ${event.type}`,
          error as Error,
          'OptimizedEventBus'
        );

        if (event.retryCount && event.retryCount < (event.maxRetries || 3)) {
          event.retryCount++;
          this.priorityQueue.push(event);
          this.priorityQueue.sort((a, b) => b.priority - a.priority);
        }
      }
    }
  }

  emit(type: string, payload: unknown, priority: number = 0): void {
    const event: PriorityEvent = {
      id: `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      payload,
      priority,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: 3,
    };

    if (this.priorityQueue.length >= this.maxQueueSize) {
      Logger.warn('事件队列已满，丢弃最旧的事件', 'OptimizedEventBus');
      this.priorityQueue.shift();
    }

    this.priorityQueue.push(event);
    this.priorityQueue.sort((a, b) => b.priority - a.priority);
  }

  on(type: string, listener: (data: unknown) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }

    this.listeners.get(type)!.push(listener);

    return () => {
      const listeners = this.listeners.get(type);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    };
  }

  addFilter(filter: EventFilter): void {
    this.filters.push(filter);
  }

  removeFilter(filter: EventFilter): void {
    const index = this.filters.indexOf(filter);
    if (index > -1) {
      this.filters.splice(index, 1);
    }
  }

  addRoute(route: EventRoute): void {
    this.routes.push(route);
  }

  removeRoute(route: EventRoute): void {
    const index = this.routes.indexOf(route);
    if (index > -1) {
      this.routes.splice(index, 1);
    }
  }

  getQueueSize(): number {
    return this.priorityQueue.length;
  }

  clearQueue(): void {
    this.priorityQueue = [];
  }

  getMaxQueueSize(): number {
    return this.maxQueueSize;
  }

  setMaxQueueSize(size: number): void {
    this.maxQueueSize = Math.max(100, size);
  }
}

export const optimizedEventBus = OptimizedEventBus.getInstance();
```

### 任务1.3：完善IntegrationStandard

**目标**：统一错误处理、日志格式、监控指标、配置管理标准

**实现步骤**：

#### 1.3.1 创建增强的集成标准

```typescript
// src/shared/EnhancedIntegrationStandard.ts

import { Logger } from '../utils/Logger';

export enum ErrorCategory {
  SYSTEM = 'SYSTEM',
  NETWORK = 'NETWORK',
  DATABASE = 'DATABASE',
  VALIDATION = 'VALIDATION',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  BUSINESS = 'BUSINESS',
  EXTERNAL = 'EXTERNAL',
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface StandardError {
  code: string;
  message: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  details?: Record<string, unknown>;
  stack?: string;
  timestamp: number;
  traceId: string;
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  module: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

export interface ConfigValue {
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  default?: unknown;
  validator?: (value: unknown) => boolean;
  description?: string;
}

export interface ConfigSchema {
  [key: string]: ConfigValue;
}

export class EnhancedIntegrationStandard {
  private static instance: EnhancedIntegrationStandard;

  private constructor() {}

  static getInstance(): EnhancedIntegrationStandard {
    if (!EnhancedIntegrationStandard.instance) {
      EnhancedIntegrationStandard.instance = new EnhancedIntegrationStandard();
    }
    return EnhancedIntegrationStandard.instance;
  }

  createError(
    code: string,
    message: string,
    category: ErrorCategory,
    severity: ErrorSeverity,
    details?: Record<string, unknown>,
    traceId?: string
  ): StandardError {
    const error = new Error(message) as StandardError;
    error.code = code;
    error.message = message;
    error.category = category;
    error.severity = severity;
    error.details = details;
    error.timestamp = Date.now();
    error.traceId = traceId || this.generateTraceId();

    return error;
  }

  createLogEntry(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    module: string,
    traceId?: string,
    metadata?: Record<string, unknown>
  ): LogEntry {
    return {
      timestamp: Date.now(),
      level,
      message,
      module,
      traceId,
      metadata,
    };
  }

  createMetric(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): Metric {
    return {
      name,
      value,
      timestamp: Date.now(),
      labels,
    };
  }

  validateConfig(
    schema: ConfigSchema,
    config: Record<string, unknown>
  ): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    for (const [key, schemaValue] of Object.entries(schema)) {
      const value = config[key];

      if (schemaValue.required && value === undefined) {
        errors.push(`配置项 "${key}" 是必需的`);
        continue;
      }

      if (value !== undefined && schemaValue.validator) {
        if (!schemaValue.validator(value)) {
          errors.push(`配置项 "${key}" 验证失败`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  formatError(error: StandardError): string {
    return `[${error.code}] ${error.message} (${error.category}/${error.severity})`;
  }

  formatLogEntry(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    const traceId = entry.traceId ? `[${entry.traceId}]` : '';
    const metadata = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '';
    return `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.module}]${traceId} ${entry.message}${metadata}`;
  }

  formatMetric(metric: Metric): string {
    const labels = metric.labels
      ? `{${Object.entries(metric.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',')}}`
      : '';
    return `${metric.name}${labels} ${metric.value} ${metric.timestamp}`;
  }
}

export const enhancedIntegrationStandard =
  EnhancedIntegrationStandard.getInstance();
```

---

## 🎯 阶段二：核心引擎层整合（3周）

### 任务2.1：整合推理引擎

**目标**：整合CoreReasoningEngine、SimplifiedCoreReasoningEngine、AdvancedReasoningEngine

**实现步骤**：

#### 2.1.1 创建统一推理引擎接口

```typescript
// src/core/UnifiedReasoningEngine.ts

import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';
import { CoreReasoningEngine } from './CoreReasoningEngine';
import { SimplifiedCoreReasoningEngine } from './SimplifiedCoreReasoningEngine';
import {
  AdvancedReasoningEngine,
  Decision,
  DecisionContext,
} from './AdvancedReasoningEngine';

export interface ReasoningConfig {
  mode: 'simple' | 'advanced' | 'auto';
  enableCaching: boolean;
  enableMonitoring: boolean;
  cacheSize: number;
}

export interface ReasoningResult {
  success: boolean;
  decision?: Decision;
  intent?: string;
  confidence?: number;
  reasoning?: string;
  metadata?: {
    mode: string;
    duration: number;
    cacheHit: boolean;
  };
  error?: string;
}

export class UnifiedReasoningEngine {
  private simpleEngine: SimplifiedCoreReasoningEngine;
  private advancedEngine: AdvancedReasoningEngine;
  private eventBus: EventBus;
  private config: ReasoningConfig;
  private cache: Map<string, ReasoningResult> = new Map();

  constructor(config?: Partial<ReasoningConfig>) {
    this.config = {
      mode: 'auto',
      enableCaching: true,
      enableMonitoring: true,
      cacheSize: 1000,
      ...config,
    };

    this.eventBus = EventBus;
    this.simpleEngine = new SimplifiedCoreReasoningEngine();
    this.advancedEngine = new AdvancedReasoningEngine();
  }

  async reason(
    input: string,
    context?: DecisionContext
  ): Promise<ReasoningResult> {
    const startTime = Date.now();
    const traceId = Logger.generateTraceId();

    this.eventBus.startTrace(traceId, 'reasoning', { input });

    try {
      const cacheKey = this.generateCacheKey(input, context);

      if (this.config.enableCaching) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          Logger.debug(`推理缓存命中: ${cacheKey}`, 'UnifiedReasoningEngine');
          this.eventBus.completeTrace(traceId, true);
          return {
            ...cached,
            metadata: {
              ...cached.metadata,
              cacheHit: true,
              duration: Date.now() - startTime,
            },
          };
        }
      }

      const mode = this.selectReasoningMode(input, context);
      let result: ReasoningResult;

      if (mode === 'simple') {
        result = await this.reasonSimple(input, context);
      } else {
        result = await this.reasonAdvanced(input, context);
      }

      result.metadata = {
        mode,
        duration: Date.now() - startTime,
        cacheHit: false,
      };

      if (this.config.enableCaching && result.success) {
        this.cache.set(cacheKey, result);
        this.trimCache();
      }

      this.eventBus.completeTrace(traceId, true);

      return result;
    } catch (error) {
      this.eventBus.failTrace(traceId, (error as Error).message);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private selectReasoningMode(
    input: string,
    context?: DecisionContext
  ): 'simple' | 'advanced' {
    if (this.config.mode !== 'auto') {
      return this.config.mode;
    }

    if (context && context.objectives && context.objectives.length > 1) {
      return 'advanced';
    }

    if (input.length > 200) {
      return 'advanced';
    }

    return 'simple';
  }

  private async reasonSimple(
    input: string,
    context?: DecisionContext
  ): Promise<ReasoningResult> {
    const result = await this.simpleEngine.process(input, context);

    return {
      success: true,
      intent: result.intent,
      confidence: result.confidence,
      reasoning: result.reasoning,
    };
  }

  private async reasonAdvanced(
    input: string,
    context?: DecisionContext
  ): Promise<ReasoningResult> {
    const decision = await this.advancedEngine.makeDecision(input, context);

    return {
      success: true,
      decision,
      confidence: decision.confidence,
      reasoning: decision.expectedOutcomes.map((o) => o.description).join('; '),
    };
  }

  private generateCacheKey(input: string, context?: DecisionContext): string {
    const contextStr = context ? JSON.stringify(context) : '';
    return `${input}_${contextStr}`.substring(0, 100);
  }

  private trimCache(): void {
    if (this.cache.size > this.config.cacheSize) {
      const keys = Array.from(this.cache.keys());
      const removeCount = this.cache.size - this.config.cacheSize;
      for (let i = 0; i < removeCount; i++) {
        this.cache.delete(keys[i]);
      }
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
```

---

## 📊 测试策略

### 单元测试

每个模块都需要有完整的单元测试覆盖：

```typescript
// 示例测试结构
describe('UnifiedReasoningEngine', () => {
  let engine: UnifiedReasoningEngine;

  beforeEach(() => {
    engine = new UnifiedReasoningEngine();
  });

  afterEach(() => {
    engine.clearCache();
  });

  describe('基础推理', () => {
    it('应该成功处理简单输入', async () => {
      const result = await engine.reason('你好');

      expect(result.success).toBe(true);
      expect(result.intent).toBeDefined();
    });

    it('应该使用缓存提高性能', async () => {
      const input = '测试缓存';

      const firstResult = await engine.reason(input);
      const secondResult = await engine.reason(input);

      expect(firstResult.metadata?.cacheHit).toBe(false);
      expect(secondResult.metadata?.cacheHit).toBe(true);
    });
  });

  describe('高级推理', () => {
    it('应该处理多目标决策', async () => {
      const context: DecisionContext = {
        objectives: [
          { id: 'obj1', name: '目标1', weight: 0.5, minimize: false },
          { id: 'obj2', name: '目标2', weight: 0.5, minimize: true },
        ],
        constraints: [],
        availableResources: [],
        timeHorizon: 1000,
        riskTolerance: 'medium',
      };

      const result = await engine.reason('复杂决策', context);

      expect(result.success).toBe(true);
      expect(result.decision).toBeDefined();
    });
  });
});
```

### 集成测试

测试模块间的整合：

```typescript
describe('系统集成测试', () => {
  let container: EnhancedServiceContainer;
  let reasoningEngine: UnifiedReasoningEngine;

  beforeAll(async () => {
    container = new EnhancedServiceContainer();

    await container.register({
      name: 'reasoningEngine',
      factory: () => new UnifiedReasoningEngine(),
    });

    await container.initializeAll();

    reasoningEngine = container.get<UnifiedReasoningEngine>('reasoningEngine');
  });

  afterAll(async () => {
    await container.destroyAll();
  });

  it('应该成功通过服务容器获取推理引擎', () => {
    expect(reasoningEngine).toBeDefined();
  });

  it('应该成功执行推理', async () => {
    const result = await reasoningEngine.reason('测试推理');

    expect(result.success).toBe(true);
  });
});
```

### 性能测试

测试系统性能：

```typescript
describe('性能测试', () => {
  let engine: UnifiedReasoningEngine;

  beforeEach(() => {
    engine = new UnifiedReasoningEngine();
  });

  it('应该在合理时间内完成推理', async () => {
    const startTime = Date.now();
    const result = await engine.reason('性能测试');
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(duration).toBeLessThan(1000);
  });

  it('应该处理并发请求', async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      engine.reason(`并发测试${i}`)
    );

    const startTime = Date.now();
    const results = await Promise.all(requests);
    const duration = Date.now() - startTime;

    expect(results.every((r) => r.success)).toBe(true);
    expect(duration).toBeLessThan(5000);
  });
});
```

---

## 🎯 部署方案

### 开发环境

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 启动开发服务器
npm run dev
```

### 生产环境

```bash
# 构建项目
npm run build

# 启动生产服务器
npm run start

# 监控日志
npm run logs
```

### Docker部署

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  jiabaixing:
    build: .
    ports:
      - '3000:3000'
    environment:
      - NODE_ENV=production
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

---

## 🎯 总结

本实施指南提供了jiabaixing系统深度整合的详细步骤，包括：

1. **基础设施层整合**：增强ServiceContainer、优化EventBus、完善IntegrationStandard
2. **核心引擎层整合**：创建统一推理引擎接口
3. **测试策略**：单元测试、集成测试、性能测试
4. **部署方案**：开发环境、生产环境、Docker部署

通过按照本指南逐步实施，可以将jiabaixing系统的40+个模块有机整合，实现统一、智能、高效的系统架构。

---

**文档版本**: v1.0
**创建日期**: 2026-05-17
**预计完成**: 2026-09-17

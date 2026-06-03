/**
 * ServiceContainer 增强功能测试
 */

import { ServiceContainer } from '../../src/shared/ServiceContainer';

describe('ServiceContainer 增强功能测试', () => {
  let container: ServiceContainer;

  beforeEach(() => {
    container = ServiceContainer.getInstance();
  });

  afterEach(async () => {
    await container.destroyAll();
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
        lifecycleHooks: {
          onDestroy: async () => {
            destroyed = true;
          },
        },
      });

      await container.initialize('testService');
      await container.destroy('testService');

      expect(destroyed).toBe(true);
    });

    it('应该按拓扑顺序初始化服务', async () => {
      const testContainer = ServiceContainer.getInstance();
      const initOrder: string[] = [];

      testContainer.register({
        name: 'serviceA',
        factory: () => ({}),
        dependencies: ['serviceB'],
        lifecycleHooks: {
          onInitialize: async () => {
            initOrder.push('A');
          },
        },
      });

      testContainer.register({
        name: 'serviceB',
        factory: () => ({}),
        dependencies: ['serviceC'],
        lifecycleHooks: {
          onInitialize: async () => {
            initOrder.push('B');
          },
        },
      });

      testContainer.register({
        name: 'serviceC',
        factory: () => ({}),
        lifecycleHooks: {
          onInitialize: async () => {
            initOrder.push('C');
          },
        },
      });

      await testContainer.initializeAll();

      expect(initOrder).toEqual(['C', 'B', 'A']);
    });

    it('应该检测循环依赖', async () => {
      const testContainer = ServiceContainer.getInstance();

      testContainer.register({
        name: 'serviceA',
        factory: () => ({}),
        dependencies: ['serviceB'],
      });

      testContainer.register({
        name: 'serviceB',
        factory: () => ({}),
        dependencies: ['serviceA'],
      });

      await expect(testContainer.initializeAll()).rejects.toThrow('循环依赖');
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

    it('应该返回未注册服务的健康状态', async () => {
      const health = await container.healthCheck('nonExistent');

      expect(health.status).toBe('unhealthy');
      expect(health.message).toBe('服务未注册');
    });

    it('应该返回未初始化服务的健康状态', async () => {
      await container.register({
        name: 'lazyService',
        factory: () => ({}),
        lazy: true,
      });

      const health = await container.healthCheck('lazyService');

      expect(health.status).toBe('unhealthy');
      expect(health.message).toBe('服务未初始化');
    });
  });

  describe('依赖图管理', () => {
    it('应该构建依赖图', () => {
      const testContainer = ServiceContainer.getInstance();

      testContainer.register({
        name: 'serviceA',
        factory: () => ({}),
        dependencies: ['serviceB', 'serviceC'],
      });

      testContainer.register({
        name: 'serviceB',
        factory: () => ({}),
      });

      testContainer.register({
        name: 'serviceC',
        factory: () => ({}),
      });

      const graph = testContainer.getDependencyGraph();

      expect(graph.serviceA).toEqual(['serviceB', 'serviceC']);
      expect(graph.serviceB).toBeUndefined();
      expect(graph.serviceC).toBeUndefined();
    });
  });

  describe('服务状态', () => {
    it('应该返回服务状态', async () => {
      const testContainer = ServiceContainer.getInstance();

      testContainer.register({
        name: 'testService',
        factory: () => ({}),
        singleton: true,
      });

      await testContainer.initialize('testService');
      await testContainer.start('testService');

      const status = testContainer.getStatus();

      expect(status).toHaveLength(1);
      expect(status[0].name).toBe('testService');
      expect(status[0].initialized).toBe(true);
      expect(status[0].started).toBe(true);
      expect(status[0].singleton).toBe(true);
    });
  });
});

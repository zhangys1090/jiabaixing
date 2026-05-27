/**
 * 协调器管理器测试
 */

import { CoordinatorManager } from '../../src/coordination/CoordinatorManager';
import { Phase2CoordinatorAdapter } from '../../src/coordination/adapters/Phase2CoordinatorAdapter';
import { Phase3CoordinatorAdapter } from '../../src/coordination/adapters/Phase3CoordinatorAdapter';
import { Phase4CoordinatorAdapter } from '../../src/coordination/adapters/Phase4CoordinatorAdapter';

describe.skip('协调器管理器测试', () => {
  let manager: CoordinatorManager;
  let phase2Adapter: Phase2CoordinatorAdapter;
  let phase3Adapter: Phase3CoordinatorAdapter;
  let phase4Adapter: Phase4CoordinatorAdapter;

  beforeEach(() => {
    manager = CoordinatorManager.getInstance();
    phase2Adapter = new Phase2CoordinatorAdapter();
    phase3Adapter = new Phase3CoordinatorAdapter();
    phase4Adapter = new Phase4CoordinatorAdapter();
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  describe('协调器注册', () => {
    it('应该成功注册协调器', () => {
      manager.registerCoordinator(phase2Adapter);

      const coordinator = manager.getCoordinator(
        'Phase2IntelligenceCoordinator'
      );
      expect(coordinator).toBeDefined();
      expect(coordinator?.name).toBe('Phase2IntelligenceCoordinator');
    });

    it('应该覆盖已存在的协调器', () => {
      manager.registerCoordinator(phase2Adapter);
      const newAdapter = new Phase2CoordinatorAdapter();
      manager.registerCoordinator(newAdapter);

      const coordinator = manager.getCoordinator(
        'Phase2IntelligenceCoordinator'
      );
      expect(coordinator).toBeDefined();
    });

    it('应该注销协调器', () => {
      manager.registerCoordinator(phase2Adapter);
      manager.unregisterCoordinator('Phase2IntelligenceCoordinator');

      const coordinator = manager.getCoordinator(
        'Phase2IntelligenceCoordinator'
      );
      expect(coordinator).toBeUndefined();
    });

    it('应该获取所有协调器', () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);
      manager.registerCoordinator(phase4Adapter);

      const coordinators = manager.getAllCoordinators();
      expect(coordinators).toHaveLength(3);
    });

    it('应该获取协调器信息', () => {
      manager.registerCoordinator(phase2Adapter);

      const info = manager.getCoordinatorInfo('Phase2IntelligenceCoordinator');
      expect(info).toBeDefined();
      expect(info?.name).toBe('Phase2IntelligenceCoordinator');
      expect(info?.phase).toBe(2);
      expect(info?.version).toBe('2.0.0');
    });

    it('应该获取所有协调器信息', () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      const infos = manager.getAllCoordinatorInfo();
      expect(infos).toHaveLength(2);
      expect(infos[0].name).toBe('Phase2IntelligenceCoordinator');
      expect(infos[1].name).toBe('Phase3AutonomyCoordinator');
    });
  });

  describe('协调器生命周期', () => {
    it('应该启动协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      await manager.startCoordinator('Phase2IntelligenceCoordinator');

      const info = manager.getCoordinatorInfo('Phase2IntelligenceCoordinator');
      expect(info?.state.started).toBe(true);
    });

    it('应该停止协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      await manager.startCoordinator('Phase2IntelligenceCoordinator');
      await manager.stopCoordinator('Phase2IntelligenceCoordinator');

      const info = manager.getCoordinatorInfo('Phase2IntelligenceCoordinator');
      expect(info?.state.started).toBe(false);
    });

    it('应该暂停协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      await manager.startCoordinator('Phase2IntelligenceCoordinator');
      await manager.pauseCoordinator('Phase2IntelligenceCoordinator');

      const info = manager.getCoordinatorInfo('Phase2IntelligenceCoordinator');
      expect(info?.state.paused).toBe(true);
    });

    it('应该恢复协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      await manager.startCoordinator('Phase2IntelligenceCoordinator');
      await manager.pauseCoordinator('Phase2IntelligenceCoordinator');
      await manager.resumeCoordinator('Phase2IntelligenceCoordinator');

      const info = manager.getCoordinatorInfo('Phase2IntelligenceCoordinator');
      expect(info?.state.paused).toBe(false);
    });

    it('应该启动所有协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);
      manager.registerCoordinator(phase4Adapter);

      await manager.startAllCoordinators();

      const infos = manager.getAllCoordinatorInfo();
      infos.forEach((info: any) => {
        expect(info.state.started).toBe(true);
      });
    });

    it('应该停止所有协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      await manager.startAllCoordinators();
      await manager.stopAllCoordinators();

      const infos = manager.getAllCoordinatorInfo();
      infos.forEach((info: any) => {
        expect(info.state.started).toBe(false);
      });
    });
  });

  describe('协调器优化', () => {
    it('应该优化单个协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      await manager.startCoordinator('Phase2IntelligenceCoordinator');

      const result = await manager.optimizeCoordinator(
        'Phase2IntelligenceCoordinator'
      );
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it('应该优化所有协调器', async () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      await manager.startAllCoordinators();

      const results = await manager.optimizeAllCoordinators();
      expect(results.size).toBe(2);
      expect(results.get('Phase2IntelligenceCoordinator')?.success).toBe(true);
      expect(results.get('Phase3AutonomyCoordinator')?.success).toBe(true);
    });
  });

  describe('协调器指标', () => {
    it('应该获取整体指标', async () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      await manager.startAllCoordinators();

      const metrics = manager.getOverallMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.overallPerformance).toBeDefined();
    });

    it('应该获取健康状态', async () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      await manager.startAllCoordinators();

      const healthStatus = manager.getHealthStatus();
      expect(healthStatus.size).toBe(2);
      expect(healthStatus.get('Phase2IntelligenceCoordinator')).toBe(true);
      expect(healthStatus.get('Phase3AutonomyCoordinator')).toBe(true);
    });

    it('应该获取协调器数量', () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      expect(manager.getCoordinatorCount()).toBe(2);
    });

    it('应该获取活跃协调器数量', async () => {
      manager.registerCoordinator(phase2Adapter);
      manager.registerCoordinator(phase3Adapter);

      expect(manager.getActiveCoordinatorCount()).toBe(0);

      await manager.startCoordinator('Phase2IntelligenceCoordinator');
      expect(manager.getActiveCoordinatorCount()).toBe(1);

      await manager.startCoordinator('Phase3AutonomyCoordinator');
      expect(manager.getActiveCoordinatorCount()).toBe(2);
    });
  });

  describe('协调器适配器功能', () => {
    it('Phase2适配器应该提供原始协调器访问', () => {
      const coordinator = phase2Adapter.getPhase2Coordinator();
      expect(coordinator).toBeDefined();
    });

    it('Phase2适配器应该获取配置', () => {
      const config = phase2Adapter.getPhase2Config();
      expect(config).toBeDefined();
      expect(config.enableMemoryOptimization).toBe(true);
    });

    it('Phase3适配器应该提供原始协调器访问', () => {
      const coordinator = phase3Adapter.getPhase3Coordinator();
      expect(coordinator).toBeDefined();
    });

    it('Phase3适配器应该获取配置', () => {
      const config = phase3Adapter.getPhase3Config();
      expect(config).toBeDefined();
      expect(config.enableAutonomousLearning).toBe(true);
    });

    it('Phase4适配器应该提供原始协调器访问', () => {
      const coordinator = phase4Adapter.getPhase4Coordinator();
      expect(coordinator).toBeDefined();
    });

    it('Phase4适配器应该获取配置', () => {
      const config = phase4Adapter.getPhase4Config();
      expect(config).toBeDefined();
      expect(config.enableMultiModalInteraction).toBe(true);
    });
  });
});

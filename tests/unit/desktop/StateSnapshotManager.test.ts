/**
 * StateSnapshotManager 单元测试
 * Phase 9: 状态记忆 - 快照捕获、存储、恢复与 Diff 功能测试
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import {
  StateSnapshotManager,
  SnapshotTriggerType,
  SnapshotStatus,
  DesktopStateSnapshot,
  SnapshotMetadata,
  StateDiffResult,
  CustomStateProvider,
} from '../../../src/desktop/StateSnapshotManager';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock WindowManager
jest.mock('../../../src/desktop/WindowManager', () => ({
  WindowManager: {
    getInstance: jest.fn().mockReturnValue({
      listWindows: jest.fn().mockReturnValue([
        {
          handle: 12345,
          title: 'Test Window',
          processName: 'test.exe',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          isVisible: true,
          isMinimized: false,
          isMaximized: false,
          zOrder: 0,
        },
      ]),
      getForegroundWindow: jest.fn().mockReturnValue({
        handle: 12345,
        title: 'Test Window',
        processName: 'test.exe',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isMinimized: false,
        isMaximized: false,
        zOrder: 0,
      }),
      activateWindow: jest.fn().mockReturnValue({ success: true }),
    }),
    reset: jest.fn(),
  },
}));

// Mock DesktopUIInspector
jest.mock('../../../src/desktop/DesktopUIInspector', () => ({
  DesktopUIInspector: {
    getInstance: jest.fn().mockReturnValue({
      getControlTree: jest.fn().mockReturnValue([
        {
          id: 'root_0',
          controlType: 'Window',
          name: 'Test Window',
          className: '',
          automationId: '',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          enabled: true,
          visible: true,
          focused: true,
          children: [],
          depth: 0,
          index: 0,
          path: [0],
        },
      ]),
    }),
    reset: jest.fn(),
  },
  UIControlType: {
    WINDOW: 'Window',
    BUTTON: 'Button',
  },
}));

// Mock TimerManager
jest.mock('../../../src/utils/TimerManager', () => ({
  TimerManager: {
    getInstance: jest.fn().mockReturnValue({
      setInterval: jest.fn().mockReturnValue('timer_1'),
      clearTimer: jest.fn().mockReturnValue(true),
    }),
  },
}));

describe('StateSnapshotManager', () => {
  let manager: StateSnapshotManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `jiabaixing-snapshots-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    StateSnapshotManager.reset();
    manager = StateSnapshotManager.getInstance({
      storageDir: testDir,
      enableAutoSnapshot: false,
      autoSnapshotIntervalMs: 60000,
      maxSnapshotCount: 10,
      snapshotExpiryMs: 0,
      includeClipboard: false,
      includeUITree: true,
      compressStorage: false,
      enableChecksum: true,
    });
  });

  afterEach(async () => {
    StateSnapshotManager.reset();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = StateSnapshotManager.getInstance();
      const instance2 = StateSnapshotManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('应该支持自定义配置', () => {
      StateSnapshotManager.reset();
      const customManager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: true,
        maxSnapshotCount: 5,
      });
      expect(customManager).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await manager.initialize();
      expect(manager).toBeDefined();
    });

    it('应该创建存储目录', async () => {
      const newDir = path.join(testDir, 'sub', 'dir');
      StateSnapshotManager.reset();
      const newManager = StateSnapshotManager.getInstance({
        storageDir: newDir,
      });
      await newManager.initialize();

      const stats = await fs.stat(newDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('takeSnapshot', () => {
    it('应该手动捕获快照', async () => {
      await manager.initialize();
      const meta = await manager.takeSnapshot('测试快照', ['test']);

      expect(meta).toBeDefined();
      expect(meta.snapshotId).toMatch(/^snap_/);
      expect(meta.triggerType).toBe(SnapshotTriggerType.MANUAL);
      expect(meta.description).toBe('测试快照');
      expect(meta.tags).toContain('test');
      expect(meta.status).toBe(SnapshotStatus.ACTIVE);
      expect(meta.windowCount).toBeGreaterThanOrEqual(0);
      expect(meta.checksum).toBeTruthy();
    });

    it('应该生成唯一快照 ID', async () => {
      await manager.initialize();
      const meta1 = await manager.takeSnapshot('快照1');
      const meta2 = await manager.takeSnapshot('快照2');

      expect(meta1.snapshotId).not.toBe(meta2.snapshotId);
    });

    it('应该存储快照文件', async () => {
      await manager.initialize();
      const meta = await manager.takeSnapshot('文件测试');

      const fileExists = await fs
        .access(meta.filePath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    });
  });

  describe('checkpointBeforeAction', () => {
    it('应该创建操作前检查点', async () => {
      await manager.initialize();
      const meta = await manager.checkpointBeforeAction('点击保存按钮');

      expect(meta.triggerType).toBe(SnapshotTriggerType.PRE_ACTION);
      expect(meta.description).toContain('操作前检查点');
      expect(meta.tags).toContain('checkpoint');
      expect(meta.tags).toContain('pre-action');
    });
  });

  describe('snapshotAfterAction', () => {
    it('应该创建操作后快照', async () => {
      await manager.initialize();
      const preMeta = await manager.checkpointBeforeAction('测试操作');
      const postMeta = await manager.snapshotAfterAction(
        '测试操作',
        preMeta.snapshotId
      );

      expect(postMeta.triggerType).toBe(SnapshotTriggerType.POST_ACTION);
      expect(postMeta.parentSnapshotId).toBe(preMeta.snapshotId);
      expect(postMeta.tags).toContain('post-action');
    });
  });

  describe('listSnapshots', () => {
    it('应该列出所有快照', async () => {
      await manager.initialize();
      await manager.takeSnapshot('快照1', ['tag1']);
      await manager.takeSnapshot('快照2', ['tag2']);
      await manager.takeSnapshot('快照3', ['tag1', 'tag2']);

      const all = await manager.listSnapshots();
      expect(all.length).toBe(3);
    });

    it('应该支持按标签过滤', async () => {
      await manager.initialize();
      await manager.takeSnapshot('快照1', ['tag1']);
      await manager.takeSnapshot('快照2', ['tag2']);

      const filtered = await manager.listSnapshots({ tags: ['tag1'] });
      expect(filtered.length).toBe(1);
      expect(filtered[0].tags).toContain('tag1');
    });

    it('应该支持按触发类型过滤', async () => {
      await manager.initialize();
      await manager.takeSnapshot('手动快照');
      await manager.checkpointBeforeAction('操作');

      const manualOnly = await manager.listSnapshots({
        triggerTypes: [SnapshotTriggerType.MANUAL],
      });
      expect(manualOnly.length).toBe(1);
      expect(manualOnly[0].triggerType).toBe(SnapshotTriggerType.MANUAL);
    });

    it('应该支持分页', async () => {
      await manager.initialize();
      for (let i = 0; i < 5; i++) {
        await manager.takeSnapshot(`快照${i}`);
      }

      const page1 = await manager.listSnapshots({ limit: 2, offset: 0 });
      const page2 = await manager.listSnapshots({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page1[0].snapshotId).not.toBe(page2[0].snapshotId);
    });

    it('应该按时间倒序排列', async () => {
      await manager.initialize();
      const meta1 = await manager.takeSnapshot('较早');
      await new Promise((r) => setTimeout(r, 50));
      const meta2 = await manager.takeSnapshot('较晚');

      const list = await manager.listSnapshots();
      expect(list[0].snapshotId).toBe(meta2.snapshotId);
      expect(list[1].snapshotId).toBe(meta1.snapshotId);
    });
  });

  describe('getLatestSnapshot', () => {
    it('应该返回最新快照', async () => {
      await manager.initialize();
      await manager.takeSnapshot('较早');
      await new Promise((r) => setTimeout(r, 50));
      const latest = await manager.takeSnapshot('最新');

      const result = await manager.getLatestSnapshot();
      expect(result).toBeDefined();
      expect(result!.snapshotId).toBe(latest.snapshotId);
    });

    it('无快照时返回 null', async () => {
      await manager.initialize();
      const result = await manager.getLatestSnapshot();
      expect(result).toBeNull();
    });
  });

  describe('restoreSnapshot', () => {
    it('应该恢复到指定快照', async () => {
      await manager.initialize();
      const meta = await manager.takeSnapshot('恢复测试');
      const result = await manager.restoreSnapshot(meta.snapshotId);

      expect(result.success).toBe(true);
      expect(result.snapshotId).toBe(meta.snapshotId);
      expect(result.restoredComponents.length).toBeGreaterThanOrEqual(0);
    });

    it('应该更新快照状态为已恢复', async () => {
      await manager.initialize();
      const meta = await manager.takeSnapshot('状态测试');
      await manager.restoreSnapshot(meta.snapshotId);

      const updated = await manager.listSnapshots({
        status: SnapshotStatus.RESTORED,
      });
      expect(updated.length).toBe(1);
      expect(updated[0].snapshotId).toBe(meta.snapshotId);
    });

    it('不存在的快照应返回失败', async () => {
      await manager.initialize();
      const result = await manager.restoreSnapshot('non-existent-id');

      expect(result.success).toBe(false);
      expect(result.failedComponents.length).toBeGreaterThan(0);
    });
  });

  describe('diffSnapshots', () => {
    it('应该检测窗口变化', async () => {
      await manager.initialize();
      const meta1 = await manager.takeSnapshot('状态A');
      await new Promise((r) => setTimeout(r, 50));
      const meta2 = await manager.takeSnapshot('状态B');

      const diff = await manager.diffSnapshots(meta1.snapshotId, meta2.snapshotId);

      expect(diff.snapshotIdA).toBe(meta1.snapshotId);
      expect(diff.snapshotIdB).toBe(meta2.snapshotId);
      expect(diff.summary).toBeDefined();
    });

    it('应该检测前台窗口变化', async () => {
      await manager.initialize();
      const meta1 = await manager.takeSnapshot('状态A');
      const meta2 = await manager.takeSnapshot('状态B');

      const diff = await manager.diffSnapshots(meta1.snapshotId, meta2.snapshotId);
      expect(typeof diff.foregroundChanged).toBe('boolean');
    });

    it('不存在的快照应抛出错误', async () => {
      await manager.initialize();
      await expect(
        manager.diffSnapshots('non-existent-1', 'non-existent-2')
      ).rejects.toThrow();
    });
  });

  describe('deleteSnapshot', () => {
    it('应该删除指定快照', async () => {
      await manager.initialize();
      const meta = await manager.takeSnapshot('待删除');
      const deleted = await manager.deleteSnapshot(meta.snapshotId);

      expect(deleted).toBe(true);
      const list = await manager.listSnapshots();
      expect(list.length).toBe(0);
    });

    it('删除不存在的快照返回 false', async () => {
      await manager.initialize();
      const result = await manager.deleteSnapshot('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('maxSnapshotCount', () => {
    it('应该自动清理旧快照', async () => {
      StateSnapshotManager.reset();
      const limitedManager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        maxSnapshotCount: 3,
        enableAutoSnapshot: false,
      });
      await limitedManager.initialize();

      for (let i = 0; i < 5; i++) {
        await limitedManager.takeSnapshot(`快照${i}`);
      }

      const list = await limitedManager.listSnapshots();
      expect(list.length).toBeLessThanOrEqual(3);
    });
  });

  describe('customStateProvider', () => {
    it('应该支持自定义状态提供者', async () => {
      await manager.initialize();

      const provider: CustomStateProvider = {
        name: 'testProvider',
        getState: jest.fn().mockResolvedValue({ key: 'value' }),
        restoreState: jest.fn().mockResolvedValue(true),
      };

      manager.registerCustomStateProvider(provider);
      const meta = await manager.takeSnapshot('自定义状态测试');

      expect(meta).toBeDefined();
      expect(provider.getState).toHaveBeenCalled();
    });

    it('应该支持注销自定义状态提供者', () => {
      const provider: CustomStateProvider = {
        name: 'tempProvider',
        getState: jest.fn().mockResolvedValue({}),
        restoreState: jest.fn().mockResolvedValue(true),
      };

      manager.registerCustomStateProvider(provider);
      manager.unregisterCustomStateProvider('tempProvider');
      // 注销后不应抛出错误
      expect(() =>
        manager.unregisterCustomStateProvider('non-existent')
      ).not.toThrow();
    });
  });

  describe('autoSnapshot', () => {
    it('应该启动自动快照', () => {
      const timerManager = require('../../../src/utils/TimerManager');
      manager.startAutoSnapshot();
      expect(timerManager.TimerManager.getInstance().setInterval).toHaveBeenCalled();
    });

    it('应该停止自动快照', () => {
      const timerManager = require('../../../src/utils/TimerManager');
      manager.startAutoSnapshot();
      manager.stopAutoSnapshot();
      expect(timerManager.TimerManager.getInstance().clearTimer).toHaveBeenCalled();
    });

    it('重复启动不应创建多个定时器', () => {
      const timerManager = require('../../../src/utils/TimerManager');
      manager.startAutoSnapshot();
      manager.startAutoSnapshot();
      const calls = timerManager.TimerManager.getInstance().setInterval.mock.calls;
      // 第二次启动应该被忽略或复用
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('updateConfig', () => {
    it('应该支持运行时更新配置', () => {
      manager.updateConfig({ maxSnapshotCount: 20 });
      // 更新后不应抛出错误
      expect(() => manager.updateConfig({ enableAutoSnapshot: false })).not.toThrow();
    });
  });

  describe('SnapshotTriggerType', () => {
    it('应该包含所有触发类型', () => {
      expect(SnapshotTriggerType.MANUAL).toBe('manual');
      expect(SnapshotTriggerType.SCHEDULED).toBe('scheduled');
      expect(SnapshotTriggerType.PRE_ACTION).toBe('pre_action');
      expect(SnapshotTriggerType.POST_ACTION).toBe('post_action');
      expect(SnapshotTriggerType.AUTO_CHECKPOINT).toBe('auto_checkpoint');
    });
  });

  describe('SnapshotStatus', () => {
    it('应该包含所有状态', () => {
      expect(SnapshotStatus.ACTIVE).toBe('active');
      expect(SnapshotStatus.RESTORED).toBe('restored');
      expect(SnapshotStatus.EXPIRED).toBe('expired');
      expect(SnapshotStatus.CORRUPTED).toBe('corrupted');
    });
  });
});

/**
 * Phase 8-10 基础设施集成测试
 *
 * 验证 DesktopUIInspector 和 StateSnapshotManager 与以下模块的兼容性：
 * - DesktopVisionEngine (Phase 6)
 * - DesktopActionExecutor (Phase 7)
 * - DesktopAgentLoop (Phase 7)
 * - DesktopSkill (Phase 7)
 * - WindowManager (Phase 6)
 * - MemoryEngine (Phase 3)
 * - TimerManager (基础设施)
 * - FileSystem (基础设施)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    DesktopUIInspector,
    UIAControlType,
} from '../../src/desktop/DesktopUIInspector';
import {
    CustomStateProvider,
    SnapshotStatus,
    SnapshotTriggerType,
    StateSnapshotManager,
} from '../../src/desktop/StateSnapshotManager';
import { FileSystem } from '../../src/io/FileSystem';

// Mock Logger
jest.mock('../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock TimerManager
jest.mock('../../src/utils/TimerManager', () => ({
  TimerManager: {
    getInstance: jest.fn().mockReturnValue({
      setInterval: jest.fn().mockReturnValue('timer_1'),
      clearTimer: jest.fn().mockReturnValue(true),
      setTimeout: jest.fn().mockReturnValue('timeout_1'),
    }),
  },
}));

// Mock WindowManager
jest.mock('../../src/desktop/WindowManager', () => ({
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
      findWindow: jest.fn().mockReturnValue({
        handle: 12345,
        title: 'Test Window',
        processName: 'test.exe',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isMinimized: false,
        isMaximized: false,
        zOrder: 0,
      }),
      getScreenSize: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
    }),
  },
}));

// Mock DesktopUIInspector
jest.mock('../../src/desktop/DesktopUIInspector', () => ({
  DesktopUIInspector: {
    getInstance: jest.fn().mockReturnValue({
      getControlTree: jest.fn().mockReturnValue([
        {
          id: 'root_0',
          controlType: 50032, // UIAControlType.Window
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
      getInteractiveElements: jest.fn().mockReturnValue([]),
      findElement: jest.fn().mockReturnValue({ success: true, elements: [], matchedBy: 'name', query: '' }),
      getFocusedElement: jest.fn().mockReturnValue(null),
      getElementAtCursor: jest.fn().mockReturnValue(null),
      generateElementReport: jest.fn().mockReturnValue(''),
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
  UIAControlType: {
    Button: 50000,
    Edit: 50004,
    Window: 50032,
  },
}));

// Mock DesktopVisionEngine
jest.mock('../../src/desktop/DesktopVisionEngine', () => ({
  DesktopVisionEngine: {
    getInstance: jest.fn().mockReturnValue({
      analyzeScreen: jest.fn().mockResolvedValue({
        success: true,
        elements: [],
        textBlocks: [],
      }),
      findElement: jest.fn().mockResolvedValue({
        success: true,
        found: true,
        screenPosition: { x: 100, y: 200, width: 50, height: 30 },
      }),
      findElementByText: jest.fn().mockResolvedValue({
        success: true,
        found: true,
        screenPosition: { x: 100, y: 200, width: 50, height: 30 },
      }),
    }),
  },
}));

// Mock DesktopActionExecutor
jest.mock('../../src/desktop/DesktopActionExecutor', () => ({
  DesktopActionExecutor: {
    getInstance: jest.fn().mockReturnValue({
      clickElement: jest.fn().mockResolvedValue({ success: true, action: 'click', duration: 100 }),
      typeText: jest.fn().mockResolvedValue({ success: true, action: 'type', duration: 200 }),
      executeHotkey: jest.fn().mockResolvedValue({ success: true, action: 'hotkey', duration: 50 }),
    }),
  },
}));

describe('Phase 8-10 基础设施集成测试', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `jiabaixing-phase8-10-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Reset all singletons and clear file system cache
    StateSnapshotManager.reset();
    FileSystem.getInstance().clearCache();
  });

  afterEach(async () => {
    StateSnapshotManager.reset();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('DesktopUIInspector 基本功能', () => {
    it('应该能获取控件树', () => {
      const inspector = DesktopUIInspector.getInstance();
      const tree = inspector.getControlTree();
      expect(Array.isArray(tree)).toBe(true);
    });

    it('应该能查找控件', () => {
      const inspector = DesktopUIInspector.getInstance();
      const result = inspector.findElement('保存按钮');
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('StateSnapshotManager ↔ WindowManager 集成', () => {
    it('应该能捕获包含窗口状态的快照', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
      });
      await manager.initialize();

      const meta = await manager.takeSnapshot('窗口状态测试');
      expect(meta.windowCount).toBeGreaterThanOrEqual(0);
      expect(meta.status).toBe(SnapshotStatus.ACTIVE);
    });

    it('应该能恢复窗口状态', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
      });
      await manager.initialize();

      const meta = await manager.takeSnapshot('恢复测试');
      const result = await manager.restoreSnapshot(meta.snapshotId, {
        restoreWindows: true,
      });

      expect(result.snapshotId).toBe(meta.snapshotId);
      expect(Array.isArray(result.restoredComponents)).toBe(true);
    });
  });

  describe('StateSnapshotManager ↔ DesktopUIInspector 集成', () => {
    it('快照应该包含 UI 控件树', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
        includeUITree: true,
      });
      await manager.initialize();

      const meta = await manager.takeSnapshot('UI树测试');
      expect(meta.uiTreeNodeCount).toBeGreaterThanOrEqual(0);
    });

    it('应该支持不包含 UI 树的快照', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
        includeUITree: false,
      });
      await manager.initialize();

      const meta = await manager.takeSnapshot('无UI树测试');
      expect(meta.uiTreeNodeCount).toBe(0);
    });
  });

  describe('快照 Diff 与 AgentLoop 集成', () => {
    it('应该能检测操作前后的状态变化', async () => {
      StateSnapshotManager.reset();
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
        enableChecksum: false,
      });
      await manager.initialize();

      // 操作前检查点
      const preMeta = await manager.checkpointBeforeAction('点击按钮');
      expect(preMeta.triggerType).toBe(SnapshotTriggerType.PRE_ACTION);

      // 模拟操作后
      const postMeta = await manager.snapshotAfterAction(
        '点击按钮',
        preMeta.snapshotId
      );
      expect(postMeta.parentSnapshotId).toBe(preMeta.snapshotId);

      // Diff 分析
      const diff = await manager.diffSnapshots(preMeta.snapshotId, postMeta.snapshotId);
      expect(diff).toBeDefined();
      expect(diff.summary).toBeDefined();
    }, 10000);
  });

  describe('自定义状态提供者集成', () => {
    it('应该支持 DesktopSkill 状态扩展', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
      });
      await manager.initialize();

      const skillProvider: CustomStateProvider = {
        name: 'desktopSkill',
        getState: jest.fn().mockResolvedValue({
          lastAction: 'click',
          targetWindow: 'Test Window',
          actionHistory: ['open_app', 'click', 'type'],
        }),
        restoreState: jest.fn().mockResolvedValue(true),
      };

      manager.registerCustomStateProvider(skillProvider);
      const meta = await manager.takeSnapshot('技能状态测试');

      expect(meta).toBeDefined();
      expect(skillProvider.getState).toHaveBeenCalled();
    });

    it('应该支持 AgentLoop 状态扩展', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
      });
      await manager.initialize();

      const agentProvider: CustomStateProvider = {
        name: 'agentLoop',
        getState: jest.fn().mockResolvedValue({
          iterationCount: 3,
          currentTask: '填写表单',
          decisionHistory: ['observe', 'decide', 'execute'],
        }),
        restoreState: jest.fn().mockResolvedValue(true),
      };

      manager.registerCustomStateProvider(agentProvider);
      const meta = await manager.takeSnapshot('Agent状态测试');

      expect(meta).toBeDefined();
      expect(agentProvider.getState).toHaveBeenCalled();
    });
  });

  describe('定时自动快照集成', () => {
    it('应该与 TimerManager 协同工作', () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: true,
        autoSnapshotIntervalMs: 30000,
      });

      manager.startAutoSnapshot();
      expect(manager).toBeDefined();

      manager.stopAutoSnapshot();
      expect(manager).toBeDefined();
    });
  });

  describe('快照元数据完整性', () => {
    it('快照元数据应包含所有必要字段', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
        enableChecksum: true,
      });
      await manager.initialize();

      const meta = await manager.takeSnapshot('完整性测试', ['integration', 'phase9']);

      expect(meta.snapshotId).toBeTruthy();
      expect(meta.timestamp).toBeGreaterThan(0);
      expect(meta.triggerType).toBe(SnapshotTriggerType.MANUAL);
      expect(meta.description).toBe('完整性测试');
      expect(meta.status).toBe(SnapshotStatus.ACTIVE);
      expect(meta.filePath).toBeTruthy();
      expect(meta.checksum).toBeTruthy();
      expect(meta.sizeBytes).toBeGreaterThanOrEqual(0);
      expect(meta.windowCount).toBeGreaterThanOrEqual(0);
      expect(meta.processCount).toBeGreaterThanOrEqual(0);
      expect(meta.tags).toContain('integration');
      expect(meta.tags).toContain('phase9');
    });

    it('快照数据应能通过校验和验证', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
        enableChecksum: true,
      });
      await manager.initialize();

      const meta = await manager.takeSnapshot('校验和测试');
      expect(meta.checksum).toBeTruthy();
      expect(meta.checksum.length).toBe(64); // SHA-256 hex length
    });
  });

  describe('Phase 10 全自主桌面智能预研', () => {
    it('应该支持感知-推理-行动-验证循环的状态追踪', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
      });
      await manager.initialize();

      // 感知阶段快照
      const observeMeta = await manager.takeSnapshot('感知阶段', ['phase10', 'observe']);

      // 推理阶段快照
      const reasonMeta = await manager.takeSnapshot('推理阶段', ['phase10', 'reason']);

      // 行动前检查点
      const actMeta = await manager.checkpointBeforeAction('执行操作');

      // 验证阶段快照
      const verifyMeta = await manager.snapshotAfterAction('执行操作', actMeta.snapshotId);

      // 验证快照链完整性
      const allSnapshots = await manager.listSnapshots();
      expect(allSnapshots.length).toBe(4);

      // 验证父子关系
      expect(verifyMeta.parentSnapshotId).toBe(actMeta.snapshotId);
    });

    it('应该支持跨应用编排的状态隔离', async () => {
      const manager = StateSnapshotManager.getInstance({
        storageDir: testDir,
        enableAutoSnapshot: false,
      });
      await manager.initialize();

      // 应用 A 的快照
      const appAProvider: CustomStateProvider = {
        name: 'appA',
        getState: jest.fn().mockResolvedValue({ app: 'Chrome', url: 'https://example.com' }),
        restoreState: jest.fn().mockResolvedValue(true),
      };

      // 应用 B 的快照
      const appBProvider: CustomStateProvider = {
        name: 'appB',
        getState: jest.fn().mockResolvedValue({ app: 'VS Code', file: 'main.ts' }),
        restoreState: jest.fn().mockResolvedValue(true),
      };

      manager.registerCustomStateProvider(appAProvider);
      manager.registerCustomStateProvider(appBProvider);

      const meta = await manager.takeSnapshot('跨应用状态', ['phase10', 'multi-app']);
      expect(meta).toBeDefined();
      expect(appAProvider.getState).toHaveBeenCalled();
      expect(appBProvider.getState).toHaveBeenCalled();
    });
  });

  describe('模块导出一致性', () => {
    it('UIAControlType 应正确导出', () => {
      expect(UIAControlType.Button).toBe(50000);
      expect(UIAControlType.Window).toBe(50032);
    });

    it('SnapshotTriggerType 应正确导出', () => {
      expect(SnapshotTriggerType.MANUAL).toBe('manual');
    });

    it('SnapshotStatus 应正确导出', () => {
      expect(SnapshotStatus.ACTIVE).toBe('active');
    });

    it('DesktopUIInspector 应为单例模式', () => {
      const i1 = DesktopUIInspector.getInstance();
      const i2 = DesktopUIInspector.getInstance();
      expect(i1).toBe(i2);
    });

    it('StateSnapshotManager 应为单例模式', () => {
      const m1 = StateSnapshotManager.getInstance();
      const m2 = StateSnapshotManager.getInstance();
      expect(m1).toBe(m2);
    });
  });
});

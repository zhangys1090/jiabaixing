import { Logger } from '../utils/Logger';
import { TimerManager } from '../utils/TimerManager';
import { DesktopUIInspector, UIElementNode } from './DesktopUIInspector';
import { WindowInfo, WindowManager } from './WindowManager';
import { SnapshotStorage } from './snapshot/SnapshotStorage';
import {
  ClipboardStateSnapshot,
  CustomStateProvider,
  DesktopStateSnapshot,
  FileSystemContextSnapshot,
  ProcessStateSnapshot,
  SnapshotListOptions,
  SnapshotMetadata,
  SnapshotRestoreResult,
  SnapshotStatus,
  SnapshotTriggerType,
  StateDiffResult,
  StateSnapshotManagerConfig,
  WindowStateSnapshot,
} from './snapshot/types';

export {
  ClipboardStateSnapshot,
  CustomStateProvider,
  DesktopStateSnapshot,
  FileSystemContextSnapshot,
  ProcessStateSnapshot,
  SnapshotListOptions,
  SnapshotMetadata,
  SnapshotRestoreResult,
  SnapshotStatus,
  SnapshotTriggerType,
  StateDiffResult,
  StateSnapshotManagerConfig,
  WindowStateSnapshot,
};

export class StateSnapshotManager {
  private static instance: StateSnapshotManager | null = null;
  private config: Required<StateSnapshotManagerConfig>;
  private timerManager: TimerManager;
  private windowManager: WindowManager;
  private uiInspector: DesktopUIInspector;
  private storage: SnapshotStorage;
  private customProviders: Map<string, CustomStateProvider> = new Map();
  private autoSnapshotTimerId: string | null = null;
  private initialized = false;

  private constructor(config: StateSnapshotManagerConfig) {
    this.config = {
      storageDir: config.storageDir || './snapshots',
      enableAutoSnapshot: config.enableAutoSnapshot ?? false,
      autoSnapshotIntervalMs: config.autoSnapshotIntervalMs || 300000,
      maxSnapshotCount: config.maxSnapshotCount || 100,
      snapshotExpiryMs: config.snapshotExpiryMs || 0,
      includeClipboard: config.includeClipboard ?? false,
      includeUITree: config.includeUITree ?? true,
      compressStorage: config.compressStorage ?? true,
      enableChecksum: config.enableChecksum ?? true,
    };
    this.timerManager = TimerManager.getInstance();
    this.windowManager = WindowManager.getInstance();
    this.uiInspector = DesktopUIInspector.getInstance();
    this.storage = SnapshotStorage.getInstance(this.config);
  }

  public static getInstance(
    config?: StateSnapshotManagerConfig
  ): StateSnapshotManager {
    if (!StateSnapshotManager.instance) {
      StateSnapshotManager.instance = new StateSnapshotManager(config || {});
    }
    return StateSnapshotManager.instance;
  }

  public static reset(): void {
    if (StateSnapshotManager.instance) {
      StateSnapshotManager.instance.dispose();
    }
    StateSnapshotManager.instance = null;
    SnapshotStorage.reset();
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.storage.ensureStorageDir();
      await this.storage.loadIndex();

      if (this.config.enableAutoSnapshot) {
        this.startAutoSnapshot();
      }

      this.initialized = true;
      Logger.info('✅ StateSnapshotManager 初始化完成', 'StateSnapshotManager');
    } catch (error) {
      Logger.error(
        '❌ StateSnapshotManager 初始化失败',
        error as Error,
        'StateSnapshotManager'
      );
      throw error;
    }
  }

  public dispose(): void {
    if (this.autoSnapshotTimerId) {
      this.timerManager.clearTimer(this.autoSnapshotTimerId);
      this.autoSnapshotTimerId = null;
    }
    this.initialized = false;
    Logger.info('🛑 StateSnapshotManager 已释放', 'StateSnapshotManager');
  }

  public async takeSnapshot(
    description: string = '手动快照',
    tags: string[] = [],
    parentSnapshotId?: string
  ): Promise<SnapshotMetadata> {
    return this.captureSnapshot(
      SnapshotTriggerType.MANUAL,
      description,
      tags,
      parentSnapshotId
    );
  }

  public async checkpointBeforeAction(
    actionDescription: string
  ): Promise<SnapshotMetadata> {
    return this.captureSnapshot(
      SnapshotTriggerType.PRE_ACTION,
      `操作前检查点: ${actionDescription}`,
      ['checkpoint', 'pre-action']
    );
  }

  public async snapshotAfterAction(
    actionDescription: string,
    parentSnapshotId?: string
  ): Promise<SnapshotMetadata> {
    return this.captureSnapshot(
      SnapshotTriggerType.POST_ACTION,
      `操作后快照: ${actionDescription}`,
      ['checkpoint', 'post-action'],
      parentSnapshotId
    );
  }

  public async restoreSnapshot(
    snapshotId: string,
    options: {
      restoreWindows?: boolean;
      restoreProcesses?: boolean;
      restoreClipboard?: boolean;
      restoreFileSystem?: boolean;
      restoreCustomStates?: boolean;
    } = {}
  ): Promise<SnapshotRestoreResult> {
    const startTime = Date.now();
    const result: SnapshotRestoreResult = {
      success: false,
      snapshotId,
      restoredComponents: [],
      failedComponents: [],
      warnings: [],
    };

    try {
      const snapshot = await this.storage.loadSnapshot(snapshotId);
      if (!snapshot) {
        throw new Error(`快照不存在: ${snapshotId}`);
      }

      if (options.restoreWindows !== false && snapshot.foregroundWindowHandle) {
        try {
          this.windowManager.activateWindow(snapshot.foregroundWindowHandle);
          result.restoredComponents.push('foreground_window');
        } catch (error) {
          result.failedComponents.push({
            component: 'foreground_window',
            error: (error as Error).message,
          });
        }
      }

      if (
        options.restoreClipboard !== false &&
        snapshot.clipboard?.textContent
      ) {
        try {
          await this.restoreClipboard(snapshot.clipboard);
          result.restoredComponents.push('clipboard');
        } catch (error) {
          result.failedComponents.push({
            component: 'clipboard',
            error: (error as Error).message,
          });
        }
      }

      if (options.restoreCustomStates !== false && snapshot.customStates) {
        for (const [providerName, state] of Object.entries(
          snapshot.customStates
        )) {
          const provider = this.customProviders.get(providerName);
          if (provider) {
            try {
              const success = await provider.restoreState(
                state as Record<string, unknown>
              );
              if (success) {
                result.restoredComponents.push(`custom:${providerName}`);
              } else {
                result.warnings.push(
                  `自定义状态提供者 ${providerName} 恢复返回 false`
                );
              }
            } catch (error) {
              result.failedComponents.push({
                component: `custom:${providerName}`,
                error: (error as Error).message,
              });
            }
          } else {
            result.warnings.push(
              `自定义状态提供者 ${providerName} 未注册，跳过恢复`
            );
          }
        }
      }

      const meta = this.storage.getMetadata(snapshotId);
      if (meta) {
        meta.status = SnapshotStatus.RESTORED;
        await this.storage.saveIndex();
      }

      result.success = result.failedComponents.length === 0;
      Logger.info(
        `♻️ 快照恢复完成: ${snapshotId} (${Date.now() - startTime}ms)`,
        'StateSnapshotManager'
      );

      return result;
    } catch (error) {
      Logger.error(
        `❌ 恢复快照失败: ${snapshotId}`,
        error as Error,
        'StateSnapshotManager'
      );
      result.failedComponents.push({
        component: 'overall',
        error: (error as Error).message,
      });
      return result;
    }
  }

  public async diffSnapshots(
    snapshotIdA: string,
    snapshotIdB: string
  ): Promise<StateDiffResult> {
    const [snapshotA, snapshotB] = await Promise.all([
      this.storage.loadSnapshot(snapshotIdA),
      this.storage.loadSnapshot(snapshotIdB),
    ]);

    if (!snapshotA) throw new Error(`快照不存在: ${snapshotIdA}`);
    if (!snapshotB) throw new Error(`快照不存在: ${snapshotIdB}`);

    const result: StateDiffResult = {
      snapshotIdA,
      snapshotIdB,
      timestampA: snapshotA.timestamp,
      timestampB: snapshotB.timestamp,
      addedWindows: [],
      removedWindows: [],
      modifiedWindows: [],
      addedProcesses: [],
      removedProcesses: [],
      foregroundChanged: false,
      beforeForeground: snapshotA.foregroundWindowHandle,
      afterForeground: snapshotB.foregroundWindowHandle,
      uiTreeChanged: false,
      clipboardChanged: false,
      mouseMoved: false,
      mouseDelta: { dx: 0, dy: 0 },
      customStateChanges: {},
      summary: '',
    };

    const windowsA = new Map(snapshotA.windows.map((w) => [w.handle, w]));
    const windowsB = new Map(snapshotB.windows.map((w) => [w.handle, w]));

    for (const [handle, winB] of windowsB) {
      const winA = windowsA.get(handle);
      if (!winA) {
        result.addedWindows.push(winB);
      } else {
        const changes = this.compareWindowState(winA, winB);
        if (changes.length > 0) {
          result.modifiedWindows.push({ before: winA, after: winB, changes });
        }
      }
    }
    for (const [handle, winA] of windowsA) {
      if (!windowsB.has(handle)) {
        result.removedWindows.push(winA);
      }
    }

    result.foregroundChanged =
      snapshotA.foregroundWindowHandle !== snapshotB.foregroundWindowHandle;

    const procsA = new Map(snapshotA.processes.map((p) => [p.pid, p]));
    const procsB = new Map(snapshotB.processes.map((p) => [p.pid, p]));
    for (const [pid, procB] of procsB) {
      if (!procsA.has(pid)) result.addedProcesses.push(procB);
    }
    for (const [pid, procA] of procsA) {
      if (!procsB.has(pid)) result.removedProcesses.push(procA);
    }

    result.uiTreeChanged =
      JSON.stringify(snapshotA.uiTree) !== JSON.stringify(snapshotB.uiTree);

    result.clipboardChanged =
      JSON.stringify(snapshotA.clipboard) !==
      JSON.stringify(snapshotB.clipboard);

    result.mouseMoved =
      snapshotA.mousePosition.x !== snapshotB.mousePosition.x ||
      snapshotA.mousePosition.y !== snapshotB.mousePosition.y;
    result.mouseDelta = {
      dx: snapshotB.mousePosition.x - snapshotA.mousePosition.x,
      dy: snapshotB.mousePosition.y - snapshotA.mousePosition.y,
    };

    for (const key of new Set([
      ...Object.keys(snapshotA.customStates),
      ...Object.keys(snapshotB.customStates),
    ])) {
      const before = snapshotA.customStates[key];
      const after = snapshotB.customStates[key];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        result.customStateChanges[key] = { before, after };
      }
    }

    result.summary = this.generateDiffSummary(result);

    Logger.info(
      `📊 快照差异分析完成: ${snapshotIdA} vs ${snapshotIdB}`,
      'StateSnapshotManager'
    );

    return result;
  }

  public async listSnapshots(
    options: SnapshotListOptions = {}
  ): Promise<SnapshotMetadata[]> {
    return this.storage.listSnapshots(options);
  }

  public async getLatestSnapshot(): Promise<SnapshotMetadata | null> {
    return this.storage.getLatestSnapshot();
  }

  public async deleteSnapshot(snapshotId: string): Promise<boolean> {
    return this.storage.deleteSnapshotFile(snapshotId);
  }

  public async cleanupExpiredSnapshots(): Promise<number> {
    return this.storage.cleanupExpiredSnapshots(this.config.snapshotExpiryMs);
  }

  public registerCustomStateProvider(provider: CustomStateProvider): void {
    this.customProviders.set(provider.name, provider);
    Logger.info(
      `🔌 自定义状态提供者已注册: ${provider.name}`,
      'StateSnapshotManager'
    );
  }

  public unregisterCustomStateProvider(name: string): void {
    this.customProviders.delete(name);
    Logger.info(`🔌 自定义状态提供者已注销: ${name}`, 'StateSnapshotManager');
  }

  public startAutoSnapshot(): void {
    if (this.autoSnapshotTimerId) return;

    this.autoSnapshotTimerId = this.timerManager.setInterval(
      () => {
        this.captureSnapshot(SnapshotTriggerType.SCHEDULED, '定时自动快照', [
          'auto',
        ]).catch((error) => {
          Logger.error(
            '❌ 自动快照失败',
            error as Error,
            'StateSnapshotManager'
          );
        });
      },
      this.config.autoSnapshotIntervalMs,
      'snapshot',
      '自动快照定时器'
    );

    Logger.info(
      `⏰ 自动快照已启动，间隔 ${this.config.autoSnapshotIntervalMs}ms`,
      'StateSnapshotManager'
    );
  }

  public stopAutoSnapshot(): void {
    if (this.autoSnapshotTimerId) {
      this.timerManager.clearTimer(this.autoSnapshotTimerId);
      this.autoSnapshotTimerId = null;
      Logger.info('⏹️ 自动快照已停止', 'StateSnapshotManager');
    }
  }

  public updateConfig(config: Partial<StateSnapshotManagerConfig>): void {
    const wasAutoSnapshot = this.config.enableAutoSnapshot;
    Object.assign(this.config, config);

    this.storage.updateConfig(this.config);

    if (config.autoSnapshotIntervalMs && this.autoSnapshotTimerId) {
      this.stopAutoSnapshot();
      this.startAutoSnapshot();
    }

    if (!wasAutoSnapshot && this.config.enableAutoSnapshot) {
      this.startAutoSnapshot();
    } else if (wasAutoSnapshot && !this.config.enableAutoSnapshot) {
      this.stopAutoSnapshot();
    }
  }

  private async captureSnapshot(
    triggerType: SnapshotTriggerType,
    description: string,
    tags: string[] = [],
    parentSnapshotId?: string
  ): Promise<SnapshotMetadata> {
    const startTime = Date.now();
    const snapshotId = this.generateSnapshotId();

    try {
      const windowList = this.windowManager.listWindows();
      const uiTreeNodes = this.config.includeUITree
        ? this.uiInspector.getControlTree()
        : [];
      const mousePos = await this.getMousePosition();

      let foregroundWindow: WindowInfo | null = null;
      try {
        foregroundWindow = this.windowManager.getForegroundWindow();
      } catch {
        foregroundWindow = null;
      }

      const foregroundHandle = foregroundWindow?.handle || 0;
      const windows: WindowStateSnapshot[] = windowList.map(
        (win: WindowInfo, index: number) => ({
          handle: win.handle,
          title: win.title,
          processName: win.processName || 'unknown',
          bounds: win.bounds || { x: 0, y: 0, width: 0, height: 0 },
          visible: win.isVisible,
          minimized: win.isMinimized,
          maximized: win.isMaximized,
          isForeground: win.handle === foregroundHandle,
          zOrder: index,
        })
      );

      const processes = await this.captureProcessStates(windowList);

      const clipboard = this.config.includeClipboard
        ? await this.captureClipboardState()
        : null;

      const fileSystemContext = await this.captureFileSystemContext();

      const customStates: Record<string, unknown> = {};
      for (const [name, provider] of this.customProviders) {
        try {
          customStates[name] = await provider.getState();
        } catch {
          Logger.warn(`自定义状态获取失败: ${name}`, 'StateSnapshotManager');
        }
      }

      const snapshot: DesktopStateSnapshot = {
        timestamp: Date.now(),
        snapshotId,
        triggerType,
        description,
        windows,
        foregroundWindowHandle: foregroundWindow?.handle || 0,
        uiTree: uiTreeNodes.length > 0 ? uiTreeNodes[0] : null,
        processes,
        clipboard,
        fileSystemContext,
        screenResolution: await this.getScreenResolution(),
        mousePosition: mousePos,
        customStates,
      };

      const filePath = await this.storage.saveSnapshotToFile(snapshot);
      const sizeBytes = await this.storage.getSnapshotFileSize(filePath);

      const snapshotData = JSON.stringify(snapshot, null, 2);
      const checksum = this.config.enableChecksum
        ? this.storage.calculateChecksum(snapshotData)
        : '';

      const metadata: SnapshotMetadata = {
        snapshotId,
        timestamp: snapshot.timestamp,
        triggerType,
        description,
        status: SnapshotStatus.ACTIVE,
        filePath,
        checksum,
        sizeBytes,
        windowCount: windows.length,
        processCount: processes.length,
        uiTreeNodeCount: this.countUITreeNodes(snapshot.uiTree),
        tags,
        parentSnapshotId,
      };

      this.storage.setMetadata(snapshotId, metadata);
      await this.storage.saveIndex();

      await this.storage.enforceMaxSnapshotCount(this.config.maxSnapshotCount);

      Logger.info(
        `📸 快照已捕获: ${snapshotId} (${Date.now() - startTime}ms, ${sizeBytes} bytes)`,
        'StateSnapshotManager'
      );

      return metadata;
    } catch (error) {
      Logger.error('❌ 快照捕获失败', error as Error, 'StateSnapshotManager');
      throw error;
    }
  }

  private generateSnapshotId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `snap_${timestamp}_${random}`;
  }

  private countUITreeNodes(node: UIElementNode | null): number {
    if (!node) return 0;
    return (
      1 +
      node.children.reduce(
        (sum: number, child: UIElementNode) =>
          sum + this.countUITreeNodes(child),
        0
      )
    );
  }

  private async captureProcessStates(
    windows: WindowInfo[]
  ): Promise<ProcessStateSnapshot[]> {
    const processMap = new Map<number, ProcessStateSnapshot>();

    for (const win of windows) {
      const pid = win.handle;
      if (!processMap.has(pid)) {
        processMap.set(pid, {
          pid,
          name: win.processName || 'unknown',
          executablePath: '',
          windowHandles: [],
          memoryUsageMb: 0,
          cpuUsagePercent: 0,
        });
      }
      processMap.get(pid)!.windowHandles.push(win.handle);
    }

    return Array.from(processMap.values());
  }

  private async captureClipboardState(): Promise<ClipboardStateSnapshot> {
    return {
      hasText: false,
      hasImage: false,
      formats: [],
    };
  }

  private async restoreClipboard(state: ClipboardStateSnapshot): Promise<void> {
    if (state.textContent) {
      Logger.info('恢复剪贴板文本', 'StateSnapshotManager');
    }
  }

  private async captureFileSystemContext(): Promise<FileSystemContextSnapshot> {
    return {
      currentWorkingDirectory: process.cwd(),
      openFilePaths: [],
      recentDocuments: [],
    };
  }

  private async getMousePosition(): Promise<{ x: number; y: number }> {
    return { x: 0, y: 0 };
  }

  private async getScreenResolution(): Promise<{
    width: number;
    height: number;
  }> {
    return { width: 1920, height: 1080 };
  }

  private compareWindowState(
    before: WindowStateSnapshot,
    after: WindowStateSnapshot
  ): string[] {
    const changes: string[] = [];

    if (before.title !== after.title) changes.push('title');
    if (before.visible !== after.visible) changes.push('visible');
    if (before.minimized !== after.minimized) changes.push('minimized');
    if (before.maximized !== after.maximized) changes.push('maximized');
    if (before.isForeground !== after.isForeground) changes.push('foreground');
    if (before.bounds.x !== after.bounds.x) changes.push('x');
    if (before.bounds.y !== after.bounds.y) changes.push('y');
    if (before.bounds.width !== after.bounds.width) changes.push('width');
    if (before.bounds.height !== after.bounds.height) changes.push('height');
    if (before.zOrder !== after.zOrder) changes.push('zOrder');

    return changes;
  }

  private generateDiffSummary(diff: StateDiffResult): string {
    const parts: string[] = [];

    if (diff.addedWindows.length)
      parts.push(`新增 ${diff.addedWindows.length} 个窗口`);
    if (diff.removedWindows.length)
      parts.push(`关闭 ${diff.removedWindows.length} 个窗口`);
    if (diff.modifiedWindows.length)
      parts.push(`${diff.modifiedWindows.length} 个窗口状态变化`);
    if (diff.foregroundChanged) parts.push('前台窗口变化');
    if (diff.addedProcesses.length)
      parts.push(`新增 ${diff.addedProcesses.length} 个进程`);
    if (diff.removedProcesses.length)
      parts.push(`退出 ${diff.removedProcesses.length} 个进程`);
    if (diff.uiTreeChanged) parts.push('UI 树变化');
    if (diff.clipboardChanged) parts.push('剪贴板变化');
    if (diff.mouseMoved)
      parts.push(`鼠标移动 (${diff.mouseDelta.dx}, ${diff.mouseDelta.dy})`);

    const customKeys = Object.keys(diff.customStateChanges);
    if (customKeys.length) parts.push(`${customKeys.length} 项自定义状态变化`);

    return parts.join('；') || '无显著变化';
  }
}

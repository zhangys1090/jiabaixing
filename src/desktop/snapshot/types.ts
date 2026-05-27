import { UIElementNode } from '../DesktopUIInspector';

export enum SnapshotTriggerType {
  MANUAL = 'manual',
  SCHEDULED = 'scheduled',
  PRE_ACTION = 'pre_action',
  POST_ACTION = 'post_action',
  AUTO_CHECKPOINT = 'auto_checkpoint',
}

export enum SnapshotStatus {
  ACTIVE = 'active',
  RESTORED = 'restored',
  EXPIRED = 'expired',
  CORRUPTED = 'corrupted',
}

export interface WindowStateSnapshot {
  handle: number;
  title: string;
  processName: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  isForeground: boolean;
  zOrder: number;
}

export interface ProcessStateSnapshot {
  pid: number;
  name: string;
  executablePath: string;
  windowHandles: number[];
  memoryUsageMb: number;
  cpuUsagePercent: number;
}

export interface ClipboardStateSnapshot {
  hasText: boolean;
  textContent?: string;
  hasImage: boolean;
  imageSize?: { width: number; height: number };
  formats: string[];
}

export interface FileSystemContextSnapshot {
  currentWorkingDirectory: string;
  openFilePaths: string[];
  recentDocuments: string[];
}

export interface DesktopStateSnapshot {
  timestamp: number;
  snapshotId: string;
  triggerType: SnapshotTriggerType;
  description: string;
  windows: WindowStateSnapshot[];
  foregroundWindowHandle: number;
  uiTree: UIElementNode | null;
  processes: ProcessStateSnapshot[];
  clipboard: ClipboardStateSnapshot | null;
  fileSystemContext: FileSystemContextSnapshot;
  screenResolution: { width: number; height: number };
  mousePosition: { x: number; y: number };
  customStates: Record<string, unknown>;
}

export interface SnapshotMetadata {
  snapshotId: string;
  timestamp: number;
  triggerType: SnapshotTriggerType;
  description: string;
  status: SnapshotStatus;
  filePath: string;
  checksum: string;
  sizeBytes: number;
  windowCount: number;
  processCount: number;
  uiTreeNodeCount: number;
  tags: string[];
  parentSnapshotId?: string;
}

export interface StateDiffResult {
  snapshotIdA: string;
  snapshotIdB: string;
  timestampA: number;
  timestampB: number;
  addedWindows: WindowStateSnapshot[];
  removedWindows: WindowStateSnapshot[];
  modifiedWindows: Array<{
    before: WindowStateSnapshot;
    after: WindowStateSnapshot;
    changes: string[];
  }>;
  addedProcesses: ProcessStateSnapshot[];
  removedProcesses: ProcessStateSnapshot[];
  foregroundChanged: boolean;
  beforeForeground: number;
  afterForeground: number;
  uiTreeChanged: boolean;
  clipboardChanged: boolean;
  mouseMoved: boolean;
  mouseDelta: { dx: number; dy: number };
  customStateChanges: Record<string, { before: unknown; after: unknown }>;
  summary: string;
}

export interface StateSnapshotManagerConfig {
  storageDir?: string;
  enableAutoSnapshot?: boolean;
  autoSnapshotIntervalMs?: number;
  maxSnapshotCount?: number;
  snapshotExpiryMs?: number;
  includeClipboard?: boolean;
  includeUITree?: boolean;
  compressStorage?: boolean;
  enableChecksum?: boolean;
}

export interface SnapshotRestoreResult {
  success: boolean;
  snapshotId: string;
  restoredComponents: string[];
  failedComponents: Array<{ component: string; error: string }>;
  warnings: string[];
}

export interface SnapshotListOptions {
  startTime?: number;
  endTime?: number;
  triggerTypes?: SnapshotTriggerType[];
  tags?: string[];
  status?: SnapshotStatus;
  limit?: number;
  offset?: number;
}

export interface CustomStateProvider {
  name: string;
  getState(): Promise<Record<string, unknown>>;
  restoreState(state: Record<string, unknown>): Promise<boolean>;
}

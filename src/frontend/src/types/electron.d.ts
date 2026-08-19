/**
 * Electron IPC 通道类型定义
 *
 * 前后端共享的类型契约，确保类型安全
 */

// ============================================================
// 窗口控制通道
// ============================================================
export type WindowChannel = 'window:minimize' | 'window:maximize' | 'window:close' | 'window:fullscreen';

// ============================================================
// 系统信息通道
// ============================================================
export type SystemChannel = 'system:get-info' | 'system:get-path';

export interface SystemInfo {
  platform: string;
  arch: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  appVersion: string;
  appName: string;
}

export type SystemPathName = 'home' | 'appData' | 'userData' | 'desktop' | 'documents' | 'downloads';

// ============================================================
// 文件操作通道
// ============================================================
export type FileChannel = 'file:open-dialog' | 'file:save-dialog' | 'file:read' | 'file:write';

export interface FileDialogOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultPath?: string;
}

export interface FileDialogResult {
  canceled: boolean;
  filePaths: string[];
  filePath?: string;
}

// ============================================================
// 外部链接通道
// ============================================================
export type ShellChannel = 'shell:open-url' | 'shell:open-path';

// ============================================================
// 服务通信通道
// ============================================================
export type ServiceChannel = 'service:send-message' | 'service:get-status' | 'service:message-received';

export interface ServiceStatus {
  backendUrl: string;
  isRunning: boolean;
}

export interface ServiceMessage {
  type: 'chat' | 'command' | 'status';
  payload: unknown;
  timestamp: number;
}

// ============================================================
// 应用控制通道
// ============================================================
export type AppChannel = 'app:quit' | 'app:reload' | 'app:toggle-devtools';

// ============================================================
// 更新通道
// ============================================================
export type UpdateChannel =
  | 'update:check'
  | 'update:download'
  | 'update:install'
  | 'update:progress'
  | 'update:available'
  | 'update:not-available'
  | 'update:error';

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

export interface UpdateProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

// ============================================================
// 通知通道
// ============================================================
export type NotificationChannel = 'notification:show' | 'notification:click' | 'notification:close';

export interface NotificationData {
  title: string;
  body: string;
  icon?: string;
  silent?: boolean;
}

// ============================================================
// 快捷键通道
// ============================================================
export type ShortcutChannel = 'shortcuts:register' | 'shortcuts:unregister' | 'shortcuts:triggered';

export interface ShortcutRegistration {
  accelerator: string;
  callbackId: string;
}

// ============================================================
// 托盘通道
// ============================================================
export type TrayChannel = 'tray:status' | 'tray:show-window' | 'tray:hide-window';

export interface TrayStatus {
  visible: boolean;
  windowVisible: boolean;
}

// ============================================================
// Electron API 声明（渲染进程使用）
// ============================================================
export interface ElectronAPI {
  // --- 窗口控制 ---
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    toggleFullscreen: () => void;
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
  };

  // --- 系统信息 ---
  system: {
    getInfo: () => Promise<SystemInfo>;
    getPath: (name: SystemPathName) => Promise<string | null>;
  };

  // --- 文件操作 ---
  file: {
    openDialog: (options?: FileDialogOptions) => Promise<FileDialogResult>;
    saveDialog: (options?: FileDialogOptions) => Promise<FileDialogResult>;
    read: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    write: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  };

  // --- 外部链接 ---
  shell: {
    openURL: (url: string) => void;
    openPath: (path: string) => Promise<{ success: boolean; error?: string }>;
  };

  // --- 服务通信 ---
  service: {
    sendMessage: (data: ServiceMessage) => void;
    getStatus: () => Promise<ServiceStatus>;
    onMessage: (callback: (data: ServiceMessage) => void) => () => void;
  };

  // --- 应用控制 ---
  app: {
    quit: () => void;
    reload: () => void;
    toggleDevTools: () => void;
  };

  // --- 托盘管理 ---
  tray: {
    showWindow: () => void;
    hideWindow: () => void;
    getStatus: () => Promise<TrayStatus>;
  };

  // --- 自动更新 ---
  update: {
    checkForUpdates: () => void;
    downloadUpdate: () => void;
    installUpdate: () => void;
    onAvailable: (callback: (info: UpdateInfo) => void) => () => void;
    onNotAvailable: (callback: () => void) => () => void;
    onProgress: (callback: (progress: UpdateProgress) => void) => () => void;
    onDownloaded: (callback: () => void) => () => void;
    onError: (callback: (error: Error) => void) => () => void;
  };

  // --- 通知系统 ---
  notification: {
    show: (data: NotificationData) => void;
    onClick: (callback: () => void) => () => void;
  };

  // --- 快捷键 ---
  shortcuts: {
    register: (accelerator: string, callbackId: string) => Promise<{ success: boolean }>;
    unregister: (callbackId: string) => void;
    onTriggered: (callback: (callbackId: string) => void) => () => void;
  };

  // --- 平台信息 ---
  platform: string;
}

// ============================================================
// 全局类型声明
// ============================================================
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};

/**
 * DesktopBridge - 安全的Electron API封装
 *
 * 为前端React组件提供统一的桌面能力接口
 *
 * 安全设计：
 * 1. 所有调用通过preload.js白名单通道
 * 2. 数据传递经过序列化验证
 * 3. 提供优雅降级（Web模式下返回模拟数据）
 */

import type {
  ElectronAPI,
  FileDialogOptions,
  NotificationData,
  ServiceStatus,
  SystemInfo,
  SystemPathName,
  TrayStatus,
  UpdateInfo,
  UpdateProgress,
} from '../types/electron';

function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}

export interface FileDialogResult {
  canceled: boolean;
  filePaths?: string[];
  filePath?: string;
}

export interface FileReadResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface FileWriteResult {
  success: boolean;
  error?: string;
}

export interface ShellOpenPathResult {
  success: boolean;
  error?: string;
}

class DesktopBridge {
  private electronAPI: ElectronAPI | null = null;
  private isElectronEnv: boolean;

  constructor() {
    this.isElectronEnv = isElectron();
    if (this.isElectronEnv) {
      this.electronAPI = window.electronAPI!;
    }
  }

  get platform(): string {
    return this.electronAPI?.platform || (typeof navigator !== 'undefined' ? navigator.platform : 'unknown');
  }

  get isElectron(): boolean {
    return this.isElectronEnv;
  }

  // ============================================================
  // 窗口控制
  // ============================================================
  minimize(): void {
    this.electronAPI?.window.minimize();
  }

  maximize(): void {
    this.electronAPI?.window.maximize();
  }

  close(): void {
    this.electronAPI?.window.close();
  }

  toggleFullscreen(): void {
    this.electronAPI?.window.toggleFullscreen();
  }

  onMaximizeChange(callback: (isMaximized: boolean) => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.window.onMaximizeChange(callback);
    }
    return () => {};
  }

  // ============================================================
  // 系统信息
  // ============================================================
  async getSystemInfo(): Promise<SystemInfo | null> {
    if (this.electronAPI) {
      return await this.electronAPI.system.getInfo();
    }
    return {
      platform: navigator.platform,
      arch: 'unknown',
      electronVersion: 'N/A',
      nodeVersion: 'N/A',
      chromeVersion: 'N/A',
      appVersion: 'web',
      appName: 'jiabaixing (Web)',
    };
  }

  async getSystemPath(name: SystemPathName): Promise<string | null> {
    return (await this.electronAPI?.system.getPath(name)) ?? null;
  }

  // ============================================================
  // 文件操作
  // ============================================================
  async openFileDialog(options?: FileDialogOptions): Promise<FileDialogResult> {
    if (this.electronAPI) {
      const result = await this.electronAPI.file.openDialog(options);
      return {
        canceled: result.canceled,
        filePaths: result.filePaths,
      };
    }
    return { canceled: true, filePaths: [] };
  }

  async saveFileDialog(options?: FileDialogOptions): Promise<FileDialogResult> {
    if (this.electronAPI) {
      const result = await this.electronAPI.file.saveDialog(options);
      return {
        canceled: result.canceled,
        filePath: result.filePath,
      };
    }
    return { canceled: true };
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    if (this.electronAPI) {
      return await this.electronAPI.file.read(filePath);
    }
    return { success: false, error: 'Not in Electron environment' };
  }

  async writeFile(filePath: string, content: string): Promise<FileWriteResult> {
    if (this.electronAPI) {
      return await this.electronAPI.file.write(filePath, content);
    }
    return { success: false, error: 'Not in Electron environment' };
  }

  // ============================================================
  // 外部链接
  // ============================================================
  openExternalURL(url: string): void {
    if (this.electronAPI) {
      this.electronAPI.shell.openURL(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  async openLocalPath(path: string): Promise<ShellOpenPathResult> {
    if (this.electronAPI) {
      return await this.electronAPI.shell.openPath(path);
    }
    return { success: false, error: 'Not in Electron environment' };
  }

  // ============================================================
  // 服务通信
  // ============================================================
  async getServiceStatus(): Promise<ServiceStatus | null> {
    return (await this.electronAPI?.service.getStatus()) ?? null;
  }

  sendServiceMessage(data: unknown): void {
    this.electronAPI?.service.sendMessage({
      type: 'chat',
      payload: data,
      timestamp: Date.now(),
    });
  }

  onServiceMessage(callback: (data: unknown) => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.service.onMessage((msg) => callback(msg.payload));
    }
    return () => {};
  }

  // ============================================================
  // 应用控制
  // ============================================================
  quit(): void {
    this.electronAPI?.app.quit();
  }

  reload(): void {
    this.electronAPI?.app.reload();
  }

  toggleDevTools(): void {
    this.electronAPI?.app.toggleDevTools();
  }

  // ============================================================
  // 托盘管理
  // ============================================================
  showWindow(): void {
    this.electronAPI?.tray.showWindow();
  }

  hideWindow(): void {
    this.electronAPI?.tray.hideWindow();
  }

  async getTrayStatus(): Promise<TrayStatus | null> {
    if (this.electronAPI) {
      return await this.electronAPI.tray.getStatus();
    }
    return null;
  }

  // ============================================================
  // 自动更新
  // ============================================================
  checkForUpdates(): void {
    this.electronAPI?.update.checkForUpdates();
  }

  downloadUpdate(): void {
    this.electronAPI?.update.downloadUpdate();
  }

  installUpdate(): void {
    this.electronAPI?.update.installUpdate();
  }

  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.update.onAvailable(callback);
    }
    return () => {};
  }

  onUpdateNotAvailable(callback: () => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.update.onNotAvailable(callback);
    }
    return () => {};
  }

  onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.update.onProgress(callback);
    }
    return () => {};
  }

  onUpdateDownloaded(callback: () => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.update.onDownloaded(callback);
    }
    return () => {};
  }

  onUpdateError(callback: (error: Error) => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.update.onError(callback);
    }
    return () => {};
  }

  // ============================================================
  // 通知系统
  // ============================================================
  showNotification(data: NotificationData): void {
    this.electronAPI?.notification.show(data);
  }

  onNotificationClick(callback: () => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.notification.onClick(callback);
    }
    return () => {};
  }

  // ============================================================
  // 快捷键
  // ============================================================
  async registerShortcut(accelerator: string, callbackId: string): Promise<boolean> {
    if (this.electronAPI) {
      const result = await this.electronAPI.shortcuts.register(accelerator, callbackId);
      return result.success;
    }
    return false;
  }

  unregisterShortcut(callbackId: string): void {
    this.electronAPI?.shortcuts.unregister(callbackId);
  }

  onShortcutTriggered(callback: (callbackId: string) => void): () => void {
    if (this.electronAPI) {
      return this.electronAPI.shortcuts.onTriggered(callback);
    }
    return () => {};
  }
}

export const desktopBridge = new DesktopBridge();
export default desktopBridge;

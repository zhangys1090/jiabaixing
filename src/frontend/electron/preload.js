/**
 * Electron Preload 脚本
 *
 * 安全桥接：通过 contextBridge 将主进程能力安全暴露给渲染进程
 *
 * 设计原则：
 * 1. 仅暴露白名单API，不暴露完整ipcRenderer
 * 2. 所有方法通过 channel 验证，防止任意IPC调用
 * 3. 数据在传递前经过序列化/反序列化，防止原型污染
 * 4. Channel 使用 channels.js 集中管理
 */

const { contextBridge, ipcRenderer } = require('electron');
const channels = require('./ipc/channels');

// ============================================================
// IPC 通道白名单（从 channels.js 模块引用）
// ============================================================
const ALLOWED_SEND_CHANNELS = [
  channels.WINDOW.MINIMIZE,
  channels.WINDOW.MAXIMIZE,
  channels.WINDOW.CLOSE,
  channels.WINDOW.FULLSCREEN,
  channels.SHELL.OPEN_URL,
  channels.SERVICE.SEND_MESSAGE,
  channels.APP.QUIT,
  channels.APP.RELOAD,
  channels.APP.TOGGLE_DEVTOOLS,
  channels.TRAY.SHOW_WINDOW,
  channels.TRAY.HIDE_WINDOW,
  channels.UPDATE.CHECK,
  channels.UPDATE.DOWNLOAD,
  channels.UPDATE.INSTALL,
  channels.NOTIFICATION.SHOW,
  channels.NOTIFICATION.CLOSE,
  channels.SHORTCUTS.REGISTER,
  channels.SHORTCUTS.UNREGISTER,
];

const ALLOWED_INVOKE_CHANNELS = [
  channels.SYSTEM.GET_INFO,
  channels.SYSTEM.GET_PATH,
  channels.FILE.OPEN_DIALOG,
  channels.FILE.SAVE_DIALOG,
  channels.FILE.READ,
  channels.FILE.WRITE,
  channels.SERVICE.GET_STATUS,
  channels.TRAY.STATUS,
  channels.SHELL.OPEN_PATH,
];

const ALLOWED_RECEIVE_CHANNELS = [
  channels.SERVICE.MESSAGE_RECEIVED,
  channels.WINDOW.MAXIMIZE_CHANGE,
  channels.UPDATE.CHECK,
  channels.UPDATE.AVAILABLE,
  channels.UPDATE.NOT_AVAILABLE,
  channels.UPDATE.PROGRESS,
  channels.UPDATE.DOWNLOAD,
  channels.UPDATE.ERROR,
  channels.NOTIFICATION.SHOW,
  channels.NOTIFICATION.CLICK,
  channels.NOTIFICATION.CLOSE,
  channels.SHORTCUTS.TRIGGERED,
];

// ============================================================
// 安全校验函数
// ============================================================
function isAllowedChannel(channel, whitelist) {
  return whitelist.includes(channel);
}

// ============================================================
// 日志安全写入（避免打包后 stdout 不可用导致崩溃）
// ============================================================
const safeWarn = (msg) => {
  try {
    console.warn(msg);
  } catch {
    /* ignore */
  }
};

// ============================================================
// 安全IPC封装
// ============================================================
const secureIPC = {
  /**
   * 单向发送消息到主进程（无需返回值）
   */
  send: (channel, ...args) => {
    if (isAllowedChannel(channel, ALLOWED_SEND_CHANNELS)) {
      ipcRenderer.send(channel, ...args);
    } else {
      safeWarn(`[Preload] Blocked send to disallowed channel: ${channel}`);
    }
  },

  /**
   * 调用主进程方法并等待返回值（Promise）
   */
  invoke: async (channel, ...args) => {
    if (isAllowedChannel(channel, ALLOWED_INVOKE_CHANNELS)) {
      return await ipcRenderer.invoke(channel, ...args);
    } else {
      safeWarn(`[Preload] Blocked invoke to disallowed channel: ${channel}`);
      return null;
    }
  },

  /**
   * 监听主进程发来的消息
   * 使用包装回调模式，避免 removeAllListeners 影响其他监听器
   */
  on: (channel, callback) => {
    if (isAllowedChannel(channel, ALLOWED_RECEIVE_CHANNELS)) {
      const wrappedCallback = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, wrappedCallback);
      return () => ipcRenderer.removeListener(channel, wrappedCallback);
    } else {
      safeWarn(`[Preload] Blocked listen to disallowed channel: ${channel}`);
      return () => {};
    }
  },

  /**
   * 移除消息监听
   */
  off: (channel, callback) => {
    if (isAllowedChannel(channel, ALLOWED_RECEIVE_CHANNELS)) {
      ipcRenderer.removeListener(channel, callback);
    }
  },
};

// ============================================================
// 暴露到渲染进程的API
// ============================================================
contextBridge.exposeInMainWorld('electronAPI', {
  // --- 窗口控制 ---
  window: {
    minimize: () => secureIPC.send(channels.WINDOW.MINIMIZE),
    maximize: () => secureIPC.send(channels.WINDOW.MAXIMIZE),
    close: () => secureIPC.send(channels.WINDOW.CLOSE),
    toggleFullscreen: () => secureIPC.send(channels.WINDOW.FULLSCREEN),
    onMaximizeChange: (callback) => {
      secureIPC.on(channels.WINDOW.MAXIMIZE_CHANGE, callback);
      return () => secureIPC.off(channels.WINDOW.MAXIMIZE_CHANGE, callback);
    },
  },

  // --- 系统信息 ---
  system: {
    getInfo: () => secureIPC.invoke(channels.SYSTEM.GET_INFO),
    getPath: (name) => secureIPC.invoke(channels.SYSTEM.GET_PATH, name),
  },

  // --- 文件操作 ---
  file: {
    openDialog: (options) => secureIPC.invoke(channels.FILE.OPEN_DIALOG, options),
    saveDialog: (options) => secureIPC.invoke(channels.FILE.SAVE_DIALOG, options),
    read: (filePath) => secureIPC.invoke(channels.FILE.READ, filePath),
    write: (filePath, content) => secureIPC.invoke(channels.FILE.WRITE, filePath, content),
  },

  // --- 外部链接 ---
  shell: {
    openURL: (url) => secureIPC.send(channels.SHELL.OPEN_URL, url),
    openPath: (path) => secureIPC.invoke(channels.SHELL.OPEN_PATH, path),
  },

  // --- 服务通信 ---
  service: {
    sendMessage: (data) => secureIPC.send(channels.SERVICE.SEND_MESSAGE, data),
    getStatus: () => secureIPC.invoke(channels.SERVICE.GET_STATUS),
    onMessage: (callback) => {
      secureIPC.on(channels.SERVICE.MESSAGE_RECEIVED, callback);
      return () => secureIPC.off(channels.SERVICE.MESSAGE_RECEIVED, callback);
    },
  },

  // --- 应用控制 ---
  app: {
    quit: () => secureIPC.send(channels.APP.QUIT),
    reload: () => secureIPC.send(channels.APP.RELOAD),
    toggleDevTools: () => secureIPC.send(channels.APP.TOGGLE_DEVTOOLS),
  },

  // --- 托盘 ---
  tray: {
    showWindow: () => secureIPC.send(channels.TRAY.SHOW_WINDOW),
    hideWindow: () => secureIPC.send(channels.TRAY.HIDE_WINDOW),
    getStatus: () => secureIPC.invoke(channels.TRAY.STATUS),
  },

  // --- 更新 ---
  update: {
    checkForUpdates: () => secureIPC.send(channels.UPDATE.CHECK),
    downloadUpdate: () => secureIPC.send(channels.UPDATE.DOWNLOAD),
    installUpdate: () => secureIPC.send(channels.UPDATE.INSTALL),
    onAvailable: (callback) => {
      secureIPC.on(channels.UPDATE.AVAILABLE, callback);
      return () => secureIPC.off(channels.UPDATE.AVAILABLE, callback);
    },
    onNotAvailable: (callback) => {
      secureIPC.on(channels.UPDATE.NOT_AVAILABLE, callback);
      return () => secureIPC.off(channels.UPDATE.NOT_AVAILABLE, callback);
    },
    onProgress: (callback) => {
      secureIPC.on(channels.UPDATE.PROGRESS, callback);
      return () => secureIPC.off(channels.UPDATE.PROGRESS, callback);
    },
    onDownloaded: (callback) => {
      secureIPC.on(channels.UPDATE.DOWNLOAD, callback);
      return () => secureIPC.off(channels.UPDATE.DOWNLOAD, callback);
    },
    onError: (callback) => {
      secureIPC.on(channels.UPDATE.ERROR, callback);
      return () => secureIPC.off(channels.UPDATE.ERROR, callback);
    },
  },

  // --- 通知 ---
  notification: {
    show: (data) => secureIPC.send(channels.NOTIFICATION.SHOW, data),
    onClick: (callback) => {
      secureIPC.on(channels.NOTIFICATION.CLICK, callback);
      return () => secureIPC.off(channels.NOTIFICATION.CLICK, callback);
    },
  },

  // --- 快捷键 ---
  shortcuts: {
    register: (accelerator, callbackId) => secureIPC.send(channels.SHORTCUTS.REGISTER, accelerator, callbackId),
    unregister: (callbackId) => secureIPC.send(channels.SHORTCUTS.UNREGISTER, callbackId),
    onTriggered: (callback) => {
      secureIPC.on(channels.SHORTCUTS.TRIGGERED, callback);
      return () => secureIPC.off(channels.SHORTCUTS.TRIGGERED, callback);
    },
  },

  // --- 平台信息（安全读取） ---
  platform: process.platform,
});

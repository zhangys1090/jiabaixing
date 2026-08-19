/**
 * IPC 通道常量定义
 *
 * 所有 IPC 通道名称统一管理，避免硬编码字符串散落各处
 * 与 src/types/electron.d.ts 中的类型定义保持一致
 */

// ============================================================
// 窗口控制通道
// ============================================================
const WINDOW = {
  MINIMIZE: 'window:minimize',
  MAXIMIZE: 'window:maximize',
  CLOSE: 'window:close',
  FULLSCREEN: 'window:fullscreen',
  MAXIMIZE_CHANGE: 'window:maximize-change',
};

// ============================================================
// 系统信息通道
// ============================================================
const SYSTEM = {
  GET_INFO: 'system:get-info',
  GET_PATH: 'system:get-path',
};

// ============================================================
// 文件操作通道
// ============================================================
const FILE = {
  OPEN_DIALOG: 'file:open-dialog',
  SAVE_DIALOG: 'file:save-dialog',
  READ: 'file:read',
  WRITE: 'file:write',
};

// ============================================================
// Shell 通道
// ============================================================
const SHELL = {
  OPEN_URL: 'shell:open-url',
  OPEN_PATH: 'shell:open-path',
};

// ============================================================
// 服务通信通道（主进程 <-> 渲染进程）
// ============================================================
const SERVICE = {
  SEND_MESSAGE: 'service:send-message',
  GET_STATUS: 'service:get-status',
  MESSAGE_RECEIVED: 'service:message-received',
};

// ============================================================
// 应用控制通道
// ============================================================
const APP = {
  QUIT: 'app:quit',
  RELOAD: 'app:reload',
  TOGGLE_DEVTOOLS: 'app:toggle-devtools',
};

// ============================================================
// 系统托盘通道
// ============================================================
const TRAY = {
  STATUS: 'tray:status',
  SHOW_WINDOW: 'tray:show-window',
  HIDE_WINDOW: 'tray:hide-window',
};

// ============================================================
// 全局快捷键通道
// ============================================================
const SHORTCUTS = {
  REGISTER: 'shortcuts:register',
  UNREGISTER: 'shortcuts:unregister',
  TRIGGERED: 'shortcuts:triggered',
};

// ============================================================
// 通知通道
// ============================================================
const NOTIFICATION = {
  SHOW: 'notification:show',
  CLICK: 'notification:click',
  CLOSE: 'notification:close',
};

// ============================================================
// 自动更新通道
// ============================================================
const UPDATE = {
  CHECK: 'update:check',
  DOWNLOAD: 'update:download',
  INSTALL: 'update:install',
  PROGRESS: 'update:progress',
  AVAILABLE: 'update:available',
  NOT_AVAILABLE: 'update:not-available',
  ERROR: 'update:error',
};

module.exports = {
  WINDOW,
  SYSTEM,
  FILE,
  SHELL,
  SERVICE,
  APP,
  TRAY,
  SHORTCUTS,
  NOTIFICATION,
  UPDATE,
};

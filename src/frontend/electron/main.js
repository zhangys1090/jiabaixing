/**
 * Electron 主进程入口
 *
 * 模块化架构：
 * - MainWindow: 窗口管理（状态持久化、多显示器、关闭行为）
 * - TrayManager: 系统托盘（菜单、气泡通知、右键菜单）
 * - GlobalShortcuts: 全局快捷键
 * - Updater: 自动更新（electron-updater）
 * - NotificationManager: 系统通知管理
 * - ipcHandlers: IPC 处理器注册
 *
 * 安全配置：
 * - sandbox: true（通过IPC访问Node API）
 * - contextIsolation: true
 * - nodeIntegration: false
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

// ============================================================
// 导入模块化组件
// ============================================================
const MainWindow = require('./windows/MainWindow');
const TrayManager = require('./tray/TrayManager');
const GlobalShortcuts = require('./shortcuts/GlobalShortcuts');
const Updater = require('./updater/Updater');
const NotificationManager = require('./notifications/NotificationManager');
const { registerAllHandlers } = require('./ipc/ipcHandlers');
const BackendLauncher = require('./backend/BackendLauncher');

// ============================================================
// 全局实例引用
// ============================================================
let mainWindowInstance = null;
let trayManager = null;
let globalShortcuts = null;
let updater = null;
let notificationManager = null;
let backendLauncher = null;

// ============================================================
// 日志工具（打包后 stdout 可能不可用，安全写入避免 EPIPE 崩溃）
// ============================================================
// 打包后没有控制台，stdout/stderr 的 EPIPE 会抛为未捕获异常，必须吞掉
[process.stdout, process.stderr].forEach((stream) => {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (err && err.code === 'EPIPE') return;
      // 其它 stream 错误不吞，避免隐藏真正问题
      throw err;
    });
  }
});

const safeLog = (level, ...args) => {
  try {
    const msg = `[Main] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`;
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
  } catch {
    // 忽略打包后 stdout 写入失败的错误
  }
};

const logger = {
  info: (...args) => safeLog('info', ...args),
  warn: (...args) => safeLog('warn', ...args),
  error: (...args) => safeLog('error', ...args),
};

// ============================================================
// 应用初始化
// ============================================================
app.whenReady().then(async () => {
  logger.info('App starting...');

  // 0. 启动 Python 后端（Hermes 方案：桌面端自动拉起后端）
  backendLauncher = new BackendLauncher({ logger });
  const backendReady = await backendLauncher.start();
  if (backendReady) {
    logger.info('Backend started successfully');
  } else {
    logger.warn('Backend not available, running in offline mode');
  }

  // 1. 创建主窗口
  const mainWindowModule = new MainWindow({
    closeToTray: true,
    logger,
  });
  mainWindowInstance = mainWindowModule.create();
  const windowRef = mainWindowModule.getWindow();

  // 2. 初始化系统托盘
  trayManager = new TrayManager({
    mainWindow: windowRef,
    logger,
  });
  trayManager.create();

  // 3. 注册全局快捷键
  globalShortcuts = new GlobalShortcuts({
    mainWindow: windowRef,
    logger,
  });
  globalShortcuts.registerAll();

  // 4. 初始化自动更新器
  updater = new Updater({
    mainWindow: windowRef,
    logger,
  });
  updater.init();

  // 5. 初始化通知管理器
  notificationManager = new NotificationManager({
    mainWindow: windowRef,
    logger,
  });

  // 6. 注册所有 IPC 处理器（注入依赖）
  registerAllHandlers({
    mainWindow: windowRef,
    trayManager,
    updater,
    notifications: notificationManager,
    globalShortcuts,
    logger,
  });

  logger.info('All modules initialized successfully');

  // macOS dock 点击重建窗口
  app.on('activate', () => {
    if (mainWindowInstance === null || mainWindowInstance?.isDestroyed()) {
      mainWindowInstance = mainWindowModule.create();
      trayManager?.setMainWindow(mainWindowInstance);
      globalShortcuts?.setMainWindow(mainWindowInstance);
    } else {
      mainWindowModule.show();
    }
  });

  // 应用退出时清理
  app.on('before-quit', () => {
    logger.info('App quitting...');
    backendLauncher?.stop();
    globalShortcuts?.unregisterAll();
    trayManager?.destroy();
    mainWindowModule.forceQuit(); // 绕过 closeToTray
  });

  // 所有窗口关闭时的处理（非 macOS）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // 安全策略：阻止新窗口创建
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // 外部链接在系统浏览器中打开
      if (url.startsWith('http:') || url.startsWith('https:')) {
        const { shell } = require('electron');
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // 内容安全策略（CSP）
    contents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:;" +
              "connect-src 'self' ws://localhost:* wss://* http://localhost:* https://*;" +
              "img-src 'self' data: blob: https://*;" +
              "style-src 'self' 'unsafe-inline';" +
              "script-src 'self' 'unsafe-inline' 'unsafe-eval';",
          ],
        },
      });
    });
  });
});

// ============================================================
// 导出实例（供测试使用）
// ============================================================
if (process.env.NODE_ENV === 'test') {
  module.exports = {
    getMainWindow: () => mainWindowInstance,
    getTrayManager: () => trayManager,
    getGlobalShortcuts: () => globalShortcuts,
    getUpdater: () => updater,
    getNotificationManager: () => notificationManager,
  };
}

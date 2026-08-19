/**
 * IPC 处理器模块化注册
 *
 * 将所有 IPC handler 按功能域拆分到独立注册函数中
 * 替代 main.js 中的 600+ 行 handler 堆积
 */

const { ipcMain, dialog, shell, nativeTheme, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const channels = require('./channels');

// ============================================================
// 路径安全校验工具
// ============================================================

/**
 * 允许访问的目录白名单
 */
function getAllowedBaseDirs() {
  return [
    app.getPath('userData'),
    app.getPath('documents'),
    app.getPath('desktop'),
    app.getPath('downloads'),
    app.getPath('home'),
  ];
}

/**
 * 校验路径是否在允许的目录范围内
 * 防止路径遍历攻击：../、符号链接等
 *
 * @param {string} targetPath - 待校验路径
 * @param {string[]} [extraAllowedDirs] - 额外允许的目录
 * @returns {{ allowed: boolean, resolvedPath: string, error?: string }}
 */
function validateFilePath(targetPath, extraAllowedDirs = []) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { allowed: false, resolvedPath: '', error: 'Invalid path' };
  }

  let resolvedPath;
  try {
    resolvedPath = path.resolve(targetPath);
  } catch (e) {
    return { allowed: false, resolvedPath: '', error: 'Failed to resolve path' };
  }

  const allowedDirs = [...getAllowedBaseDirs(), ...extraAllowedDirs];

  const isAllowed = allowedDirs.some((baseDir) => {
    try {
      const resolvedBase = path.resolve(baseDir);
      return resolvedPath.startsWith(resolvedBase + path.sep) || resolvedPath === resolvedBase;
    } catch {
      return false;
    }
  });

  if (!isAllowed) {
    return {
      allowed: false,
      resolvedPath,
      error: `Access denied: path outside allowed directories (${allowedDirs.map((d) => path.basename(d)).join(', ')})`,
    };
  }

  // 检查路径中是否存在 .. 遍历成分（双重保护）
  const relativeFromAny = allowedDirs.some((baseDir) => {
    const relative = path.relative(baseDir, resolvedPath);
    return relative.startsWith('..') || (path.isAbsolute(relative) && relative !== resolvedPath);
  });

  if (relativeFromAny && !isAllowed) {
    return { allowed: false, resolvedPath, error: 'Path traversal detected' };
  }

  return { allowed: true, resolvedPath };
}

/**
 * 校验 Shell 打开的路径
 * 仅允许打开：目录、常见文档类型
 *
 * @param {string} shellPath - 待打开路径
 * @returns {{ allowed: boolean, error?: string }}
 */
function validateShellPath(shellPath) {
  if (!shellPath || typeof shellPath !== 'string') {
    return { allowed: false, error: 'Invalid shell path' };
  }

  let resolvedPath;
  try {
    resolvedPath = path.resolve(shellPath);
  } catch (e) {
    return { allowed: false, error: 'Failed to resolve path' };
  }

  // 危险扩展名黑名单（可执行文件）
  const DANGEROUS_EXTS = [
    '.exe',
    '.bat',
    '.cmd',
    '.com',
    '.msi',
    '.scr',
    '.vbs',
    '.vbe',
    '.js',
    '.jse',
    '.wsf',
    '.wsh',
    '.ps1',
    '.psm1',
    '.psd1',
    '.sh',
    '.bash',
    '.zsh',
    '.csh',
    '.tcsh',
    '.app',
    '.command',
    '.workflow',
    '.deb',
    '.rpm',
    '.dmg',
    '.pkg',
    '.jar',
    '.war',
    '.dll',
    '.so',
    '.dylib',
    '.sys',
    '.drv',
    '.ocx',
    '.cpl',
    '.inf',
    '.reg',
  ];

  const ext = path.extname(resolvedPath).toLowerCase();

  if (DANGEROUS_EXTS.includes(ext)) {
    return {
      allowed: false,
      error: `Execution blocked: executable file type (${ext}) not allowed via shell.openPath`,
    };
  }

  // 校验路径范围（与文件操作相同）
  const pathValidation = validateFilePath(resolvedPath);
  if (!pathValidation.allowed) {
    return {
      allowed: false,
      error: pathValidation.error,
    };
  }

  return { allowed: true };
}

/**
 * 注册所有 IPC 处理器
 * @param {object} deps 依赖注入 { mainWindow, trayManager, serviceRunner, logger }
 */
function registerAllHandlers(deps = {}) {
  const { mainWindow, trayManager, updater, notifications, globalShortcuts, serviceRunner, logger } = deps;

  _registerWindowHandlers(mainWindow);
  _registerSystemHandlers(mainWindow);
  _registerFileHandlers(mainWindow);
  _registerShellHandlers();
  _registerServiceHandlers(serviceRunner, mainWindow);
  _registerAppHandlers(mainWindow);
  _registerTrayHandlers(trayManager, mainWindow);
  _registerUpdateHandlers(updater, mainWindow);
  _registerNotificationHandlers(notifications, mainWindow);
  _registerShortcutHandlers(globalShortcuts, mainWindow);
  _registerThemeHandlers(mainWindow);

  logger?.info?.('[IPC] All handlers registered');
}

// ----------------------------------------------------------------
// 窗口控制
// ----------------------------------------------------------------
function _registerWindowHandlers(mainWindow) {
  if (!mainWindow) return;

  ipcMain.handle(channels.WINDOW.MINIMIZE, () => {
    mainWindow?.minimize();
    return { success: true };
  });

  ipcMain.handle(channels.WINDOW.MAXIMIZE, () => {
    if (!mainWindow) return { success: false };
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { success: true, maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle(channels.WINDOW.CLOSE, () => {
    mainWindow?.close();
    return { success: true };
  });

  ipcMain.handle(channels.WINDOW.FULLSCREEN, () => {
    if (!mainWindow) return { success: false };
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return { success: true, fullscreen: mainWindow.isFullScreen() };
  });
}

// ----------------------------------------------------------------
// 系统信息
// ----------------------------------------------------------------
function _registerSystemHandlers(mainWindow) {
  ipcMain.handle(channels.SYSTEM.GET_INFO, () => ({
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    appVersion: require('electron').app.getVersion(),
    appName: require('electron').app.getName(),
  }));

  ipcMain.handle(channels.SYSTEM.GET_PATH, (_event, name) => {
    try {
      return { success: true, path: require('electron').app.getPath(name) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ----------------------------------------------------------------
// 文件操作
// ----------------------------------------------------------------
function _registerFileHandlers(mainWindow) {
  ipcMain.handle(channels.FILE.OPEN_DIALOG, async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Text', extensions: ['txt', 'md', 'json'] },
      ],
      ...options,
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle(channels.FILE.SAVE_DIALOG, async (_event, options = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Text', extensions: ['txt', 'md'] },
        { name: 'JSON', extensions: ['json'] },
      ],
      ...options,
    });
    return { canceled: result.canceled, filePath: result.filePath };
  });

  ipcMain.handle(channels.FILE.READ, async (_event, filePath) => {
    try {
      const validation = validateFilePath(filePath);
      if (!validation.allowed) {
        return { success: false, error: validation.error };
      }
      const content = await fs.promises.readFile(validation.resolvedPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(channels.FILE.WRITE, async (_event, filePath, content) => {
    try {
      const validation = validateFilePath(filePath);
      if (!validation.allowed) {
        return { success: false, error: validation.error };
      }
      await fs.promises.writeFile(validation.resolvedPath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ----------------------------------------------------------------
// Shell
// ----------------------------------------------------------------
function _registerShellHandlers() {
  ipcMain.handle(channels.SHELL.OPEN_URL, async (_event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(channels.SHELL.OPEN_PATH, async (_event, shellPath) => {
    try {
      const validation = validateShellPath(shellPath);
      if (!validation.allowed) {
        return { success: false, error: validation.error };
      }
      await shell.openPath(shellPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ----------------------------------------------------------------
// 服务通信（通过 child_process 调用 Python 服务）
// ----------------------------------------------------------------
function _registerServiceHandlers(serviceRunner, mainWindow) {
  ipcMain.handle(channels.SERVICE.SEND_MESSAGE, async (_event, message) => {
    try {
      if (serviceRunner && typeof serviceRunner.sendMessage === 'function') {
        const result = await serviceRunner.sendMessage(message);
        return { success: true, data: result };
      }
      return { success: false, error: 'Service runner not available' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(channels.SERVICE.GET_STATUS, () => {
    if (serviceRunner && typeof serviceRunner.getStatus === 'function') {
      return { success: true, data: serviceRunner.getStatus() };
    }
    return { success: true, data: { status: 'unknown' } };
  });

  // 主进程 -> 渲染进程 消息推送
  if (serviceRunner && typeof serviceRunner.onMessage === 'function') {
    serviceRunner.onMessage((msg) => {
      mainWindow?.webContents?.send(channels.SERVICE.MESSAGE_RECEIVED, msg);
    });
  }
}

// ----------------------------------------------------------------
// 应用控制
// ----------------------------------------------------------------
function _registerAppHandlers(mainWindow) {
  const { app } = require('electron');

  ipcMain.handle(channels.APP.QUIT, () => {
    app.quit();
  });

  ipcMain.handle(channels.APP.RELOAD, () => {
    mainWindow?.webContents?.reload();
    return { success: true };
  });

  ipcMain.handle(channels.APP.TOGGLE_DEVTOOLS, () => {
    mainWindow?.webContents?.toggleDevTools();
    return { success: true };
  });
}

// ----------------------------------------------------------------
// 托盘
// ----------------------------------------------------------------
function _registerTrayHandlers(trayManager, mainWindow) {
  ipcMain.handle(channels.TRAY.SHOW_WINDOW, () => {
    trayManager?.showWindow?.();
    return { success: true };
  });

  ipcMain.handle(channels.TRAY.HIDE_WINDOW, () => {
    trayManager?.hideWindow?.();
    return { success: true };
  });

  ipcMain.handle(channels.TRAY.STATUS, () => {
    return {
      visible: trayManager?.isVisible?.() ?? false,
      windowVisible: mainWindow?.isVisible?.() ?? false,
    };
  });
}

// ----------------------------------------------------------------
// 自动更新
// ----------------------------------------------------------------
function _registerUpdateHandlers(updater, mainWindow) {
  ipcMain.on(channels.UPDATE.CHECK, () => {
    if (updater && typeof updater.checkForUpdates === 'function') {
      updater.checkForUpdates();
    }
  });

  ipcMain.on(channels.UPDATE.DOWNLOAD, () => {
    if (updater && typeof updater.downloadUpdate === 'function') {
      updater.downloadUpdate();
    }
  });

  ipcMain.on(channels.UPDATE.INSTALL, () => {
    if (updater && typeof updater.quitAndInstall === 'function') {
      updater.quitAndInstall();
    }
  });

  if (updater && typeof updater.on === 'function') {
    updater.on('update-available', (info) => {
      mainWindow?.webContents?.send(channels.UPDATE.AVAILABLE, info);
    });

    updater.on('update-not-available', () => {
      mainWindow?.webContents?.send(channels.UPDATE.NOT_AVAILABLE);
    });

    updater.on('download-progress', (progress) => {
      mainWindow?.webContents?.send(channels.UPDATE.PROGRESS, progress);
    });

    updater.on('update-downloaded', () => {
      mainWindow?.webContents?.send(channels.UPDATE.DOWNLOAD);
    });

    updater.on('error', (error) => {
      mainWindow?.webContents?.send(channels.UPDATE.ERROR, { message: error?.message || 'Unknown error' });
    });
  }
}

// ----------------------------------------------------------------
// 通知
// ----------------------------------------------------------------
function _registerNotificationHandlers(notifications, mainWindow) {
  ipcMain.on(channels.NOTIFICATION.SHOW, (_event, data) => {
    if (notifications && typeof notifications.show === 'function') {
      notifications.show(data);
    }
  });

  if (notifications && typeof notifications.onClick === 'function') {
    notifications.onClick(() => {
      mainWindow?.webContents?.send(channels.NOTIFICATION.CLICK);
    });
  }
}

// ----------------------------------------------------------------
// 快捷键
// ----------------------------------------------------------------
function _registerShortcutHandlers(globalShortcuts, mainWindow) {
  ipcMain.on(channels.SHORTCUTS.REGISTER, (_event, accelerator, callbackId) => {
    if (globalShortcuts && typeof globalShortcuts.register === 'function') {
      const success = globalShortcuts.register(accelerator, () => {
        mainWindow?.webContents?.send(channels.SHORTCUTS.TRIGGERED, { callbackId });
      });
    }
  });

  ipcMain.on(channels.SHORTCUTS.UNREGISTER, (_event, callbackId) => {
    if (globalShortcuts && typeof globalShortcuts.unregisterByCallbackId === 'function') {
      globalShortcuts.unregisterByCallbackId(callbackId);
    }
  });
}

// ----------------------------------------------------------------
// 主题
// ----------------------------------------------------------------
function _registerThemeHandlers(mainWindow) {
  ipcMain.handle('theme:get', () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  });

  ipcMain.on('theme:set', (_event, theme) => {
    if (theme === 'system') {
      nativeTheme.themeSource = 'system';
    } else {
      nativeTheme.themeSource = theme;
    }
  });
}

module.exports = { registerAllHandlers };

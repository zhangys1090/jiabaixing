/**
 * Electron 主进程
 * 负责创建和管理应用窗口
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const url = require('url');

let mainWindow;

function createWindow() {
  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'jiabaixing 智能助手',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  // 加载应用的 index.html
  const startUrl = process.env.ELECTRON_START_URL || url.format({
    pathname: path.join(__dirname, '../build/index.html'),
    protocol: 'file:',
    slashes: true,
  });

  mainWindow.loadURL(startUrl);

  // 打开开发者工具
  // mainWindow.webContents.openDevTools();

  // 窗口关闭时的事件
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// Electron 应用准备就绪时创建窗口
app.whenReady().then(createWindow);

// 所有窗口关闭时退出应用
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 在 macOS 上，点击 dock 图标时重新创建窗口
app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

// 处理来自渲染进程的消息
ipcMain.on('message', (event, arg) => {
  console.log(arg); // 打印来自渲染进程的消息
  event.reply('message', 'pong'); // 回复渲染进程
});

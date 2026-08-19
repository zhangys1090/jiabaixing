/**
 * Electron Mock - 完整模拟模块
 *
 * 模拟 Electron 所有被源码引用的 API：
 * BrowserWindow, ipcMain, ipcRenderer, Tray, Menu,
 * nativeImage, shell, dialog, app, globalShortcut,
 * Notification, contextBridge, screen, nativeTheme
 */

// ============================================================
// 窗口状态追踪 (所有 BrowserWindow 实例共享)
// ============================================================
const _windowStateMap = new Map();
let _windowIdCounter = 1;

// ============================================================
// BrowserWindow Mock
// ============================================================
class MockBrowserWindow {
  constructor(opts = {}) {
    this.id = _windowIdCounter++;
    this._opts = opts;
    this._isMaximized = false;
    this._isMinimized = false;
    this._isFullScreen = false;
    this._isVisible = true;
    this._isDestroyed = false;
    this._bounds = { x: 100, y: 100, width: opts.width || 1200, height: opts.height || 800 };
    this._listeners = {};
    this._onceListeners = {};

    this.webContents = {
      id: this.id,
      send: jest.fn(),
      reload: jest.fn(),
      toggleDevTools: jest.fn(),
      openDevTools: jest.fn(),
      getURL: jest.fn().mockReturnValue('file:///test'),
      on: jest.fn((event, handler) => {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(handler);
      }),
      once: jest.fn((event, handler) => {
        if (!this._onceListeners[event]) this._onceListeners[event] = [];
        this._onceListeners[event].push(handler);
      }),
      removeAllListeners: jest.fn(),
      setWindowOpenHandler: jest.fn(),
    };

    _windowStateMap.set(this.id, this);
  }

  loadURL(url) {
    this._url = url;
    return Promise.resolve();
  }
  loadFile(path) {
    this._path = path;
    return Promise.resolve();
  }
  show() {
    this._isVisible = true;
    this._emit('show');
  }
  hide() {
    this._isVisible = false;
    this._emit('hide');
  }
  close() {
    this._emit('close');
    if (!this._preventDefault) {
      this._isDestroyed = true;
    }
  }
  focus() {
    this._emit('focus');
  }
  minimize() {
    this._isMinimized = true;
    this._emit('minimize');
  }
  maximize() {
    this._isMaximized = true;
    this._emit('maximize');
  }
  unmaximize() {
    this._isMaximized = false;
    this._emit('unmaximize');
  }
  restore() {
    this._isMinimized = false;
    this._emit('restore');
  }
  destroy() {
    this._isDestroyed = true;
    _windowStateMap.delete(this.id);
    this._emit('closed');
  }
  isMaximized() {
    return this._isMaximized;
  }
  isMinimized() {
    return this._isMinimized;
  }
  isFullScreen() {
    return this._isFullScreen;
  }
  isVisible() {
    return this._isVisible;
  }
  isDestroyed() {
    return this._isDestroyed;
  }
  isFocused() {
    return true;
  }
  setFullScreen(flag) {
    this._isFullScreen = flag;
  }
  getBounds() {
    return { ...this._bounds };
  }
  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }
  once(event, handler) {
    if (!this._onceListeners[event]) this._onceListeners[event] = [];
    this._onceListeners[event].push(handler);
    return this;
  }
  removeAllListeners(event) {
    this._listeners[event] = [];
    return this;
  }

  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {}
    });
    (this._onceListeners[event] || []).forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {}
    });
    this._onceListeners[event] = [];
  }
}

// ============================================================
// Tray Mock
// ============================================================
class MockTray {
  constructor(icon) {
    this._icon = icon;
    this._tooltip = '';
    this._contextMenu = null;
    this._listeners = {};
  }
  setToolTip(text) {
    this._tooltip = text;
  }
  setContextMenu(menu) {
    this._contextMenu = menu;
  }
  displayBalloon(opts) {
    this._balloon = opts;
  }
  setImage(icon) {
    this._icon = icon;
  }
  destroy() {
    this._destroyed = true;
  }
  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }
  removeAllListeners() {
    this._listeners = {};
    return this;
  }
  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((fn) => fn(...args));
  }
}

// ============================================================
// Notification Mock
// ============================================================
class MockNotification {
  constructor(opts) {
    this._opts = opts;
    this._listeners = {};
  }
  show() {
    this._shown = true;
  }
  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }
  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((fn) => fn(...args));
  }
}
MockNotification.isSupported = jest.fn().mockReturnValue(true);

// ============================================================
// ipcMain Mock
// ============================================================
const ipcMain = {
  _handlers: {},
  _onHandlers: {},
  handle: jest.fn((channel, handler) => {
    ipcMain._handlers[channel] = handler;
  }),
  on: jest.fn((channel, handler) => {
    ipcMain._onHandlers[channel] = handler;
  }),
  removeHandler: jest.fn(),
  removeAllListeners: jest.fn(),
};

// ============================================================
// nativeImage Mock
// ============================================================
const nativeImage = {
  createFromPath: jest
    .fn()
    .mockReturnValue({ isEmpty: jest.fn().mockReturnValue(false), resize: jest.fn().mockReturnThis() }),
  createEmpty: jest.fn().mockReturnValue({}),
  createFromBuffer: jest.fn().mockReturnValue({}),
};

// ============================================================
// nativeTheme Mock
// ============================================================
const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: 'system',
};

// ============================================================
// screen Mock
// ============================================================
const _mockDisplay = {
  id: 1,
  label: 'Display 1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  workAreaSize: { width: 1920, height: 1040 },
  scaleFactor: 1,
};

const screen = {
  getPrimaryDisplay: jest.fn().mockReturnValue(_mockDisplay),
  getAllDisplays: jest.fn().mockReturnValue([_mockDisplay]),
  getDisplayMatching: jest.fn().mockReturnValue(_mockDisplay),
};

// ============================================================
// 导出
// ============================================================
module.exports = {
  app: {
    getName: jest.fn().mockReturnValue('jiabaixing'),
    getVersion: jest.fn().mockReturnValue('1.0.0'),
    getPath: jest.fn().mockReturnValue('/mock/path'),
    quit: jest.fn(),
    whenReady: jest.fn().mockReturnValue({ then: (cb) => cb() }),
    on: jest.fn(),
    dock: { setBadge: jest.fn(), setMenu: jest.fn() },
  },
  BrowserWindow: MockBrowserWindow,
  Tray: MockTray,
  Menu: {
    buildFromTemplate: jest.fn().mockReturnValue({}),
    setApplicationMenu: jest.fn(),
  },
  Notification: MockNotification,
  ipcMain,
  ipcRenderer: {
    send: jest.fn(),
    invoke: jest.fn().mockResolvedValue({}),
    on: jest.fn(),
    once: jest.fn(),
    removeAllListeners: jest.fn(),
    removeListener: jest.fn(),
    sendSync: jest.fn(),
    postMessage: jest.fn(),
    sendTo: jest.fn(),
  },
  contextBridge: {
    exposeInMainWorld: jest.fn(),
  },
  shell: {
    openExternal: jest.fn().mockResolvedValue(undefined),
    openPath: jest.fn().mockResolvedValue(undefined),
  },
  dialog: {
    showOpenDialog: jest.fn().mockResolvedValue({ canceled: false, filePaths: [] }),
    showSaveDialog: jest.fn().mockResolvedValue({ canceled: false, filePath: '' }),
    showMessageBox: jest.fn().mockResolvedValue({ response: 0 }),
  },
  nativeImage,
  nativeTheme,
  screen,
  globalShortcut: {
    register: jest.fn().mockReturnValue(true),
    unregister: jest.fn(),
    unregisterAll: jest.fn(),
    isRegistered: jest.fn().mockReturnValue(false),
  },
};

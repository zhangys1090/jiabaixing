/**
 * preload.test.js
 *
 * 测试 Preload 脚本安全桥接
 * 源码: src/frontend/electron/preload.js
 *
 * 覆盖: contextBridge 暴露/IPC 通道白名单/安全校验/数据序列化
 */

// ============================================================
// Mock — 必须使用 jest.mock 确保与源码内部 require('electron') 共享同一实例
// resetModules: true 会使模块缓存被清除，仅靠 moduleNameMapper 会导致不一致
// 注意：工厂函数内不能使用 require() 引用 __mocks__ 文件，否则触发循环解析
// ============================================================
jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: jest.fn() },
  ipcRenderer: {
    on: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    send: jest.fn(),
    invoke: jest.fn().mockResolvedValue(undefined),
  },
}));
const { contextBridge, ipcRenderer } = require('electron');

// ============================================================
// 测试
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
});

// ----------------------------------------------------------------
// contextBridge 注册
// ----------------------------------------------------------------
describe('contextBridge 暴露', () => {
  test('使用 contextBridge.exposeInMainWorld 暴露 API', () => {
    // 加载 preload 源码（触发 contextBridge 注册）
    require('../../../electron/preload');
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalled();
  });

  test('API 名称为 electronAPI', () => {
    require('../../../electron/preload');
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('electronAPI', expect.any(Object));
  });

  test('暴露的 API 包含所有功能域', () => {
    require('../../../electron/preload');
    const api = contextBridge.exposeInMainWorld.mock.calls[0][1];
    expect(api).toHaveProperty('window');
    expect(api).toHaveProperty('system');
    expect(api).toHaveProperty('file');
    expect(api).toHaveProperty('shell');
    expect(api).toHaveProperty('service');
    expect(api).toHaveProperty('app');
    expect(api).toHaveProperty('tray');
    expect(api).toHaveProperty('update');
    expect(api).toHaveProperty('notification');
    expect(api).toHaveProperty('shortcuts');
    expect(api).toHaveProperty('platform');
  });
});

// ----------------------------------------------------------------
// 窗口控制 API
// ----------------------------------------------------------------
describe('窗口控制 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('minimize 发送 MINIMIZE 通道', () => {
    api.window.minimize();
    expect(ipcRenderer.send).toHaveBeenCalledWith('window:minimize');
  });

  test('maximize 发送 MAXIMIZE 通道', () => {
    api.window.maximize();
    expect(ipcRenderer.send).toHaveBeenCalledWith('window:maximize');
  });

  test('close 发送 CLOSE 通道', () => {
    api.window.close();
    expect(ipcRenderer.send).toHaveBeenCalledWith('window:close');
  });

  test('toggleFullscreen 发送 FULLSCREEN 通道', () => {
    api.window.toggleFullscreen();
    expect(ipcRenderer.send).toHaveBeenCalledWith('window:fullscreen');
  });
});

// ----------------------------------------------------------------
// 系统信息 API
// ----------------------------------------------------------------
describe('系统信息 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('getInfo 使用 invoke 调用', () => {
    api.system.getInfo();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('system:get-info');
  });

  test('getPath 使用 invoke 调用', () => {
    api.system.getPath('home');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('system:get-path', 'home');
  });
});

// ----------------------------------------------------------------
// 文件操作 API
// ----------------------------------------------------------------
describe('文件操作 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('openDialog 使用 invoke 调用', () => {
    api.file.openDialog({ filters: [] });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('file:open-dialog', { filters: [] });
  });

  test('saveDialog 使用 invoke 调用', () => {
    api.file.saveDialog({});
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('file:save-dialog', {});
  });

  test('read 使用 invoke 调用', () => {
    api.file.read('/path/to/file');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('file:read', '/path/to/file');
  });

  test('write 使用 invoke 调用', () => {
    api.file.write('/path/to/file', 'content');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('file:write', '/path/to/file', 'content');
  });
});

// ----------------------------------------------------------------
// Shell API
// ----------------------------------------------------------------
describe('Shell API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('openURL 发送 OPEN_URL 通道', () => {
    api.shell.openURL('https://example.com');
    expect(ipcRenderer.send).toHaveBeenCalledWith('shell:open-url', 'https://example.com');
  });

  test('openPath 发送 OPEN_PATH 通道', () => {
    api.shell.openPath('/some/path');
    expect(ipcRenderer.send).toHaveBeenCalledWith('shell:open-path', '/some/path');
  });
});

// ----------------------------------------------------------------
// 服务通信 API
// ----------------------------------------------------------------
describe('服务通信 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('sendMessage 使用 send 调用', () => {
    api.service.sendMessage({ text: 'hello' });
    expect(ipcRenderer.send).toHaveBeenCalledWith('service:send-message', { text: 'hello' });
  });

  test('getStatus 使用 invoke 调用', () => {
    api.service.getStatus();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('service:get-status');
  });

  test('onMessage 监听 MESSAGE_RECEIVED 通道', () => {
    const callback = jest.fn();
    api.service.onMessage(callback);
    expect(ipcRenderer.on).toHaveBeenCalledWith('service:message-received', expect.any(Function));
  });

  test('onMessage 返回取消订阅函数', () => {
    ipcRenderer.removeListener.mockImplementation(() => {});
    const callback = jest.fn();
    const unsubscribe = api.service.onMessage(callback);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 应用控制 API
// ----------------------------------------------------------------
describe('应用控制 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('quit 发送 QUIT 通道', () => {
    api.app.quit();
    expect(ipcRenderer.send).toHaveBeenCalledWith('app:quit');
  });

  test('reload 发送 RELOAD 通道', () => {
    api.app.reload();
    expect(ipcRenderer.send).toHaveBeenCalledWith('app:reload');
  });

  test('toggleDevTools 发送 TOGGLE_DEVTOOLS 通道', () => {
    api.app.toggleDevTools();
    expect(ipcRenderer.send).toHaveBeenCalledWith('app:toggle-devtools');
  });
});

// ----------------------------------------------------------------
// 托盘 API
// ----------------------------------------------------------------
describe('托盘 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('showWindow 发送 SHOW_WINDOW 通道', () => {
    api.tray.showWindow();
    expect(ipcRenderer.send).toHaveBeenCalledWith('tray:show-window');
  });

  test('hideWindow 发送 HIDE_WINDOW 通道', () => {
    api.tray.hideWindow();
    expect(ipcRenderer.send).toHaveBeenCalledWith('tray:hide-window');
  });
});

// ----------------------------------------------------------------
// 更新 API
// ----------------------------------------------------------------
describe('更新 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('onAvailable 监听 UPDATE.AVAILABLE 通道', () => {
    const cb = jest.fn();
    api.update.onAvailable(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('update:available', expect.any(Function));
  });

  test('onProgress 监听 UPDATE.PROGRESS 通道', () => {
    const cb = jest.fn();
    api.update.onProgress(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('update:progress', expect.any(Function));
  });

  test('onDownload 监听 UPDATE.DOWNLOAD 通道', () => {
    const cb = jest.fn();
    api.update.onDownload(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('update:download', expect.any(Function));
  });

  test('onError 监听 UPDATE.ERROR 通道', () => {
    const cb = jest.fn();
    api.update.onError(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('update:error', expect.any(Function));
  });
});

// ----------------------------------------------------------------
// 通知 API
// ----------------------------------------------------------------
describe('通知 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('onShow 监听通知 SHOW 通道', () => {
    const cb = jest.fn();
    api.notification.onShow(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('notification:show', expect.any(Function));
  });

  test('onClick 监听通知 CLICK 通道', () => {
    const cb = jest.fn();
    api.notification.onClick(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('notification:click', expect.any(Function));
  });
});

// ----------------------------------------------------------------
// 快捷键 API
// ----------------------------------------------------------------
describe('快捷键 API', () => {
  let api;
  beforeEach(() => {
    require('../../../electron/preload');
    api = contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('onTriggered 监听 SHORTCUTS.TRIGGERED 通道', () => {
    const cb = jest.fn();
    api.shortcuts.onTriggered(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('shortcuts:triggered', expect.any(Function));
  });
});

// ----------------------------------------------------------------
// 安全通道验证
// ----------------------------------------------------------------
describe('IPC 通道安全', () => {
  test('通道名来自 channels.js 集中管理', () => {
    const ch = require('../../../electron/ipc/channels');
    expect(ch.WINDOW.MINIMIZE).toBe('window:minimize');
    expect(ch.SYSTEM.GET_INFO).toBe('system:get-info');
    expect(ch.FILE.READ).toBe('file:read');
    expect(ch.SHELL.OPEN_URL).toBe('shell:open-url');
    expect(ch.APP.QUIT).toBe('app:quit');
    expect(ch.NOTIFICATION.SHOW).toBe('notification:show');
  });

  test('所有通道名是字符串', () => {
    const ch = require('../../../electron/ipc/channels');
    const flatChannels = Object.values(ch).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v]));
    flatChannels.forEach((c) => expect(typeof c).toBe('string'));
  });
});

// ----------------------------------------------------------------
// 平台信息
// ----------------------------------------------------------------
describe('平台信息', () => {
  test('暴露 platform 字段', () => {
    require('../../../electron/preload');
    const api = contextBridge.exposeInMainWorld.mock.calls[0][1];
    expect(api.platform).toBe(process.platform);
  });
});

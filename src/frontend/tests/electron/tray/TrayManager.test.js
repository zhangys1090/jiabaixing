/**
 * TrayManager.js 单元测试
 *
 * 测试系统托盘管理：
 * - 创建与图标加载
 * - 菜单配置
 * - 事件处理（点击、双击）
 * - 工具提示
 * - 销毁
 */

jest.mock('electron', () => {
  const { EventEmitter } = require('events');
  class MockTray extends EventEmitter {
    constructor(icon) {
      super();
      this._icon = icon;
      this._tooltip = '';
      this._contextMenu = null;
    }
    setToolTip(t) {
      this._tooltip = t;
    }
    setContextMenu(m) {
      this._contextMenu = m;
    }
    setImage() {}
    displayBalloon = jest.fn();
    destroy() {}
  }
  return {
    Tray: MockTray,
    Menu: {
      buildFromTemplate: jest.fn((template) => ({ template })),
    },
    nativeImage: {
      createFromPath: jest.fn(() => ({ isEmpty: () => false, resize: () => ({}) })),
      createEmpty: jest.fn(() => ({})),
    },
    app: {
      quit: jest.fn(),
    },
  };
});

const TrayManager = require('../../../electron/tray/TrayManager');
const channels = require('../../../electron/ipc/channels');

describe('TrayManager', () => {
  let trayManager;
  let mockMainWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMainWindow = {
      show: jest.fn(),
      hide: jest.fn(),
      isVisible: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
      forceQuit: jest.fn(),
    };
  });

  afterEach(() => {
    if (trayManager) {
      trayManager.destroy();
      trayManager = null;
    }
  });

  // ----------------------------------------------------------
  // 初始化
  // ----------------------------------------------------------
  describe('初始化', () => {
    it('should create TrayManager with default options', () => {
      trayManager = new TrayManager();
      expect(trayManager.tray).toBeNull();
    });

    it('should accept mainWindow option', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      expect(trayManager.mainWindow).toBe(mockMainWindow);
    });

    it('should default tooltip to 家百星', () => {
      trayManager = new TrayManager();
      expect(trayManager._tooltip).toBe('家百星');
    });
  });

  // ----------------------------------------------------------
  // 创建托盘
  // ----------------------------------------------------------
  describe('创建托盘', () => {
    it('should create tray instance', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      const tray = trayManager.create();

      expect(tray).toBeDefined();
      expect(trayManager.tray).toBe(tray);
    });

    it('should set tooltip on tray', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      expect(trayManager.tray._tooltip).toBe('家百星');
    });

    it('should return same tray if already created', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      const first = trayManager.create();
      const second = trayManager.create();

      expect(first).toBe(second);
    });
  });

  // ----------------------------------------------------------
  // 工具提示
  // ----------------------------------------------------------
  describe('工具提示', () => {
    it('should update tooltip', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      trayManager.setTooltip('新提示');
      expect(trayManager.tray._tooltip).toBe('新提示');
    });

    it('should update internal tooltip text', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.setTooltip('自定义');
      expect(trayManager._tooltip).toBe('自定义');
    });
  });

  // ----------------------------------------------------------
  // 菜单配置
  // ----------------------------------------------------------
  describe('菜单配置', () => {
    it('should set context menu on tray', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      expect(trayManager.tray._contextMenu).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // 显示/隐藏窗口
  // ----------------------------------------------------------
  describe('显示/隐藏窗口', () => {
    it('should show main window', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.showWindow();

      expect(mockMainWindow.show).toHaveBeenCalled();
    });

    it('should hide main window', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.hideWindow();

      expect(mockMainWindow.hide).toHaveBeenCalled();
    });

    it('should update main window reference', () => {
      trayManager = new TrayManager();
      const newWindow = { show: jest.fn() };
      trayManager.setMainWindow(newWindow);
      trayManager.showWindow();

      expect(newWindow.show).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 气泡通知
  // ----------------------------------------------------------
  describe('气泡通知', () => {
    it('should display balloon notification', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      trayManager.displayBalloon({ title: '测试', content: '内容' });
      expect(trayManager.tray.displayBalloon).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 托盘事件
  // ----------------------------------------------------------
  describe('托盘事件', () => {
    it('should handle macOS click toggle', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      // 窗口不可见时，点击应该显示
      mockMainWindow.isVisible.mockReturnValue(false);
      trayManager.tray.emit('click');
      expect(mockMainWindow.show).toHaveBeenCalled();

      Object.defineProperty(process, 'platform', { value: original, writable: true });
    });

    it('should handle Windows double-click', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      trayManager.tray.emit('double-click');
      expect(mockMainWindow.show).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 图标
  // ----------------------------------------------------------
  describe('图标', () => {
    it('should set icon on tray', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();

      trayManager.setIcon('/path/to/icon.png');
      // 不应报错
    });

    it('should handle setIcon without tray gracefully', () => {
      trayManager = new TrayManager();
      expect(() => trayManager.setIcon('/path/to/icon.png')).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 销毁
  // ----------------------------------------------------------
  describe('销毁', () => {
    it('should destroy tray', () => {
      trayManager = new TrayManager({ mainWindow: mockMainWindow });
      trayManager.create();
      trayManager.destroy();

      expect(trayManager.tray).toBeNull();
    });

    it('should handle destroy without tray gracefully', () => {
      trayManager = new TrayManager();
      expect(() => trayManager.destroy()).not.toThrow();
    });
  });
});

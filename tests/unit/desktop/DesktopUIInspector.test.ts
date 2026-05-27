/**
 * DesktopUIInspector 单元测试
 * Phase 6: 桌面之眼 - UI 控件树枚举功能测试
 */

import {
  DesktopUIInspector,
  UIAControlType,
  UIElement,
  UIElementNode,
  ElementQueryResult,
  UIInspectorConfig,
} from '../../../src/desktop/DesktopUIInspector';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock WindowManager
jest.mock('../../../src/desktop/WindowManager', () => ({
  WindowManager: {
    getInstance: jest.fn().mockReturnValue({
      getForegroundWindow: jest.fn().mockReturnValue({
        handle: 12345,
        title: 'Test Window',
        processName: 'test.exe',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isMinimized: false,
        isMaximized: false,
        zOrder: 0,
      }),
      listWindows: jest.fn().mockReturnValue([
        {
          handle: 12345,
          title: 'Test Window',
          processName: 'test.exe',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          isVisible: true,
          isMinimized: false,
          isMaximized: false,
          zOrder: 0,
        },
      ]),
    }),
  },
}));

describe('DesktopUIInspector', () => {
  let inspector: DesktopUIInspector;

  beforeEach(() => {
    inspector = DesktopUIInspector.getInstance();
  });

  describe('getInstance', () => {
    it('应该返回单例实例', () => {
      const instance1 = DesktopUIInspector.getInstance();
      const instance2 = DesktopUIInspector.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('应该成功初始化', async () => {
      await inspector.initialize();
      expect(inspector).toBeDefined();
    });
  });

  describe('getControlTree', () => {
    it('应该返回控件树', () => {
      const tree = inspector.getControlTree();
      expect(Array.isArray(tree)).toBe(true);
    });
  });

  describe('getInteractiveElements', () => {
    it('应该返回可交互控件列表', () => {
      const elements = inspector.getInteractiveElements();
      expect(Array.isArray(elements)).toBe(true);
    });
  });

  describe('getWindowElements', () => {
    it('应该返回指定窗口的控件', () => {
      const elements = inspector.getWindowElements('Test Window');
      expect(Array.isArray(elements)).toBe(true);
    });
  });

  describe('findElement', () => {
    it('应该通过描述查找控件', () => {
      const result = inspector.findElement('保存按钮');
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(Array.isArray(result.elements)).toBe(true);
    });
  });

  describe('getFocusedElement', () => {
    it('应该返回当前聚焦的控件', () => {
      const element = inspector.getFocusedElement();
      expect(element === null || typeof element === 'object').toBe(true);
    });
  });

  describe('getElementAtCursor', () => {
    it('应该返回鼠标位置的控件', () => {
      const element = inspector.getElementAtCursor();
      expect(element === null || typeof element === 'object').toBe(true);
    });
  });

  describe('generateElementReport', () => {
    it('应该生成控件报告', () => {
      const report = inspector.generateElementReport();
      expect(typeof report).toBe('string');
    });
  });

  describe('shutdown', () => {
    it('应该成功关闭', async () => {
      await inspector.shutdown();
      expect(inspector).toBeDefined();
    });
  });
});

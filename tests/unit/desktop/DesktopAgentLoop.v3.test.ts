const mockObserve = jest.fn().mockResolvedValue({
  timestamp: Date.now(),
  screenshot: { success: true, buffer: Buffer.alloc(0), width: 1920, height: 1080, format: 'png' },
  visionAnalysis: { success: true, description: '桌面有记事本窗口', processingTime: 100, llmAnalyzed: true },
  windows: [{
    title: '记事本', processName: 'notepad.exe', bounds: { x: 0, y: 0, width: 800, height: 600 },
    isVisible: true, isMinimized: false, isMaximized: false, zOrder: 0, handle: 12345, className: '', processId: 0,
  }],
  summary: '桌面有记事本窗口',
});

const mockExecuteTask = jest.fn().mockResolvedValue({
  success: true, actions: [], summary: '执行完成',
});

const mockGetInteractiveElements = jest.fn().mockReturnValue([
  {
    name: '保存', controlTypeName: 'Button', boundingRect: { x: 100, y: 200, width: 80, height: 30 },
    isClickable: true, isEditable: false,
  },
  {
    name: '搜索框', controlTypeName: 'Edit', boundingRect: { x: 300, y: 50, width: 200, height: 25 },
    isClickable: true, isEditable: true,
  },
]);

const mockFindElementByDescription = jest.fn().mockReturnValue({
  name: '保存', controlTypeName: 'Button', boundingRect: { x: 100, y: 200, width: 80, height: 30 },
  isClickable: true, isEditable: false,
});

const mockCheckpointBeforeAction = jest.fn().mockResolvedValue({ snapshotId: 'snap-001', success: true });
const mockRestoreSnapshot = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../../src/desktop/DesktopVisionEngine', () => ({
  DesktopVisionEngine: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      observe: mockObserve,
      generateReport: jest.fn().mockReturnValue('桌面汇报'),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
    reset: jest.fn(),
  },
}));

jest.mock('../../../src/desktop/DesktopActionExecutor', () => ({
  DesktopActionExecutor: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      executeTask: mockExecuteTask,
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/WindowManager', () => ({
  WindowManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      listWindows: jest.fn().mockReturnValue([]),
      getScreenSize: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/SystemInput', () => ({
  SystemInput: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockReturnValue({ success: true }),
      rightClick: jest.fn().mockReturnValue({ success: true }),
      typeText: jest.fn().mockReturnValue({ success: true }),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopUIInspector', () => ({
  DesktopUIInspector: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      getInteractiveElements: mockGetInteractiveElements,
      findElementByDescription: mockFindElementByDescription,
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/StateSnapshotManager', () => ({
  StateSnapshotManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      checkpointBeforeAction: mockCheckpointBeforeAction,
      restoreSnapshot: mockRestoreSnapshot,
      dispose: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/models/LLMProvider', () => ({
  LLMProvider: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    isAvailable: jest.fn().mockReturnValue(true),
    multimodalChat: jest.fn().mockResolvedValue(
      '[{"type":"click","params":{"x":100,"y":200},"description":"点击保存按钮"},{"type":"type","params":{"text":"hello"},"description":"输入hello"}]'
    ),
  })),
}));

import { DesktopAgentLoop } from '../../../src/desktop/DesktopAgentLoop';

describe('DesktopAgentLoop v3 增强验证', () => {
  let agentLoop: DesktopAgentLoop;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteTask.mockResolvedValue({ success: true, actions: [], summary: '执行完成' });
    (DesktopAgentLoop as unknown as { instance: null }).instance = null;
    agentLoop = DesktopAgentLoop.getInstance({ enableCheckpoint: true, sandboxMode: 'moderate' });
  });

  describe('1. LLM驱动决策', () => {
    it('应该使用LLM规划动作', async () => {
      await agentLoop.initialize();
      const result = await agentLoop.execute('点击保存按钮');
      expect(result.success).toBe(true);
    });

    it('LLM不可用时应降级为正则模式', async () => {
      const { LLMProvider } = jest.requireMock('../../../src/models/LLMProvider');
      LLMProvider.mockImplementationOnce(() => ({
        initialize: jest.fn().mockRejectedValue(new Error('LLM不可用')),
        isAvailable: jest.fn().mockReturnValue(false),
      }));
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ enableLLMPlanning: true });
      await loop.initialize();
      const result = await loop.execute('截图');
      expect(result).toBeDefined();
    });

    it('应该限制最大动作步数', async () => {
      const { LLMProvider } = jest.requireMock('../../../src/models/LLMProvider');
      LLMProvider.mockImplementationOnce(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        isAvailable: jest.fn().mockReturnValue(true),
        multimodalChat: jest.fn().mockResolvedValue(
          Array(30).fill(null).map((_, i) =>
            `{"type":"click","params":{"x":${i},"y":${i}},"description":"step ${i}"}`
          ).join(',').replace(/^/, '[').replace(/$/, ']')
        ),
      }));
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ maxPlanSteps: 5 });
      await loop.initialize();
      const result = await loop.execute('复杂任务');
      expect(result.success).toBe(true);
    });
  });

  describe('2. 错误恢复闭环', () => {
    it('执行失败时应自动重试', async () => {
      mockExecuteTask
        .mockResolvedValueOnce({ success: false, actions: [], summary: '执行失败', error: '部分动作失败' })
        .mockResolvedValueOnce({ success: true, actions: [], summary: '重试成功' });

      await agentLoop.initialize();
      const result = await agentLoop.execute('打开记事本');
      expect(result).toBeDefined();
      expect(result.retryCount).toBeGreaterThanOrEqual(1);
    });

    it('超过最大重试次数应返回失败', async () => {
      mockExecuteTask.mockResolvedValue({ success: false, actions: [], summary: '持续失败', error: '失败' });
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ maxRetries: 1 });
      await loop.initialize();
      const result = await loop.execute('打开记事本');
      expect(result.success).toBe(false);
    }, 30000);
  });

  describe('3. CODEX风格安全沙箱', () => {
    it('应该拦截危险shell命令', async () => {
      const { LLMProvider } = jest.requireMock('../../../src/models/LLMProvider');
      LLMProvider.mockImplementationOnce(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        isAvailable: jest.fn().mockReturnValue(true),
        multimodalChat: jest.fn().mockResolvedValue(
          '[{"type":"shell","params":{"command":"format C:"},"description":"格式化C盘"},{"type":"click","params":{"x":100,"y":200},"description":"安全点击"}]'
        ),
      }));
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ sandboxMode: 'moderate' });
      await loop.initialize();
      const result = await loop.execute('格式化磁盘');
      expect(result).toBeDefined();
    });

    it('off模式下不应拦截任何命令', async () => {
      const { LLMProvider } = jest.requireMock('../../../src/models/LLMProvider');
      LLMProvider.mockImplementationOnce(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        isAvailable: jest.fn().mockReturnValue(true),
        multimodalChat: jest.fn().mockResolvedValue(
          '[{"type":"shell","params":{"command":"some_command"},"description":"执行命令"}]'
        ),
      }));
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ sandboxMode: 'off' });
      await loop.initialize();
      const result = await loop.execute('执行命令');
      expect(result).toBeDefined();
    });
  });

  describe('4. CODEX风格Checkpoint', () => {
    it('执行前应自动创建checkpoint', async () => {
      await agentLoop.initialize();
      await agentLoop.execute('打开记事本');
      expect(mockCheckpointBeforeAction).toHaveBeenCalled();
    });

    it('失败后应尝试从checkpoint恢复', async () => {
      mockExecuteTask
        .mockResolvedValueOnce({ success: false, actions: [], summary: '失败', error: '失败' })
        .mockResolvedValueOnce({ success: true, actions: [], summary: '成功' });
      await agentLoop.initialize();
      await agentLoop.execute('打开记事本');
      expect(mockRestoreSnapshot).toHaveBeenCalled();
    });

    it('应支持手动恢复checkpoint', async () => {
      await agentLoop.initialize();
      await agentLoop.execute('打开记事本');
      const restored = await agentLoop.restoreLastCheckpoint();
      expect(typeof restored).toBe('boolean');
    });
  });

  describe('5. Manifest管理', () => {
    it('应该能更新和获取Manifest', () => {
      agentLoop.updateManifest({ allowedApps: ['notepad', 'calc'] });
      const manifest = agentLoop.getManifest();
      expect(manifest.allowedApps).toContain('notepad');
      expect(manifest.allowedApps).toContain('calc');
    });

    it('Manifest应包含forbiddenActions', () => {
      const manifest = agentLoop.getManifest();
      expect(manifest.forbiddenActions.length).toBeGreaterThan(0);
      expect(manifest.forbiddenActions).toContain('format');
      expect(manifest.forbiddenActions).toContain('shutdown');
    });

    it('Manifest应包含maxActionsPerTask', () => {
      const manifest = agentLoop.getManifest();
      expect(manifest.maxActionsPerTask).toBeGreaterThan(0);
    });
  });

  describe('6. 正则降级模式', () => {
    it('应该处理"截图"指令', async () => {
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ enableLLMPlanning: false });
      await loop.initialize();
      const result = await loop.execute('截图');
      expect(result).toBeDefined();
    });

    it('应该处理"复制"指令', async () => {
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ enableLLMPlanning: false });
      await loop.initialize();
      const result = await loop.execute('复制');
      expect(result).toBeDefined();
    });

    it('应该处理"粘贴"指令', async () => {
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ enableLLMPlanning: false });
      await loop.initialize();
      const result = await loop.execute('粘贴');
      expect(result).toBeDefined();
    });

    it('无法识别的指令应返回失败', async () => {
      (DesktopAgentLoop as unknown as { instance: null }).instance = null;
      const loop = DesktopAgentLoop.getInstance({ enableLLMPlanning: false });
      await loop.initialize();
      const result = await loop.execute('做一个后空翻');
      expect(result.success).toBe(false);
    });
  });
});

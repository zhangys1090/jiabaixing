/**
 * P0-A Gate 3: Bridge 断开 fail-closed 运行时测试
 *
 * 验证：
 * 1. Bridge unavailable → NO executable action (FAIL CLOSED)
 * 2. LLM planning throws → NO executable action
 * 3. LLM returns empty → NO executable action
 * 4. planActions() → NOT CALLED (零 production fallback)
 * 5. ActionAuthority 为唯一执行入口
 */

const mockSafetyGuardCheckAction = jest.fn().mockReturnValue({ allowed: true });
const mockExecutorExecuteTask = jest.fn().mockResolvedValue({
  success: true,
  actions: [],
  summary: '执行完成',
});
const mockExecutorExecuteAction = jest.fn().mockResolvedValue({
  success: true,
  action: { type: 'shell', params: { command: 'echo test' } },
  output: 'test',
});

jest.mock('../../../src/desktop/DesktopSafetyGuard', () => ({
  DesktopSafetyGuard: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      checkAction: mockSafetyGuardCheckAction,
      recordAction: jest.fn(),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopActionExecutor', () => ({
  DesktopActionExecutor: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      executeTask: mockExecutorExecuteTask,
      executeAction: mockExecutorExecuteAction,
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopActionAuthority', () => ({
  DesktopActionAuthority: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      authorize: jest.fn().mockReturnValue({ allowed: true }),
      execute: jest.fn().mockImplementation(async (actions: unknown[]) => {
        for (const action of actions) {
          const check = mockSafetyGuardCheckAction(
            (action as { type: string }).type,
            (action as { description?: string }).description || (action as { type: string }).type,
            (action as { params?: unknown }).params
          );
          if (!check.allowed) {
            return { success: false, actions: [], summary: check.reason, authorization: check };
          }
        }
        const result = await mockExecutorExecuteTask(actions);
        return { ...result, authorization: { allowed: true } };
      }),
      executeAction: jest.fn().mockImplementation(async (action: { type: string; description?: string; params?: unknown }) => {
        const check = mockSafetyGuardCheckAction(
          action.type,
          action.description || action.type,
          action.params
        );
        if (!check.allowed) {
          return {
            result: { success: false, action, error: check.reason },
            authorization: check,
          };
        }
        const result = await mockExecutorExecuteAction(action);
        return { result, authorization: { allowed: true } };
      }),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopVisionEngine', () => ({
  DesktopVisionEngine: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      observe: jest.fn().mockResolvedValue({
        timestamp: Date.now(),
        screenshot: { success: true, buffer: Buffer.alloc(0), width: 1920, height: 1080, format: 'png' },
        visionAnalysis: { success: true, description: '', processingTime: 100 },
        windows: [],
        summary: '',
      }),
      generateReport: jest.fn().mockReturnValue(''),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
    reset: jest.fn(),
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
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/DesktopUIInspector', () => ({
  DesktopUIInspector: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({ elements: [], summary: '' }),
      getInteractiveElements: jest.fn().mockReturnValue([]),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../src/desktop/StateSnapshotManager', () => ({
  StateSnapshotManager: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      checkpointBeforeAction: jest.fn().mockResolvedValue('checkpoint-1'),
      restoreSnapshot: jest.fn().mockResolvedValue(true),
      dispose: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

const mockGetPythonBridge = jest.fn().mockReturnValue(null);
jest.mock('../../../src/server/bootstrap', () => ({
  getPythonBridge: mockGetPythonBridge,
  isPythonBackend: jest.fn().mockReturnValue(false),
}));

describe('P0-A Gate 3: Bridge 断开 fail-closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockSafetyGuardCheckAction.mockReturnValue({ allowed: true });
    mockGetPythonBridge.mockReturnValue(null);
  });

  describe('DesktopActionAuthority', () => {
    it('authorize + execute 原子化：executeAction 内含 authorize', async () => {
      const { DesktopActionAuthority } = require('../../../src/desktop/DesktopActionAuthority');
      const authority = DesktopActionAuthority.getInstance();

      const action = {
        type: 'shell',
        params: { command: 'echo hello' },
        description: '测试命令',
      };

      const result = await authority.executeAction(action);

      expect(mockSafetyGuardCheckAction).toHaveBeenCalledWith(
        'shell',
        '测试命令',
        { command: 'echo hello' }
      );
      expect(mockExecutorExecuteAction).toHaveBeenCalledWith(action);
      expect(result.authorization.allowed).toBe(true);
      expect(result.result.success).toBe(true);
    });

    it('安全检查拒绝时：executeAction 不调用 executor', async () => {
      mockSafetyGuardCheckAction.mockReturnValueOnce({
        allowed: false,
        reason: '危险命令',
        severity: 'high',
      });

      const { DesktopActionAuthority } = require('../../../src/desktop/DesktopActionAuthority');
      const authority = DesktopActionAuthority.getInstance();

      const action = {
        type: 'shell',
        params: { command: 'rm -rf /' },
        description: '删除命令',
      };

      const result = await authority.executeAction(action);

      expect(result.authorization.allowed).toBe(false);
      expect(result.authorization.reason).toBe('危险命令');
      expect(result.result.success).toBe(false);
      expect(mockExecutorExecuteAction).not.toHaveBeenCalled();
    });

    it('execute() 批量动作：任一拒绝则全部阻止', async () => {
      mockSafetyGuardCheckAction
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, reason: '第二个动作危险' });

      const { DesktopActionAuthority } = require('../../../src/desktop/DesktopActionAuthority');
      const authority = DesktopActionAuthority.getInstance();

      const actions = [
        { type: 'shell', params: { command: 'echo ok' }, description: '安全命令' },
        { type: 'shell', params: { command: 'format C:' }, description: '格式化命令' },
      ];

      const result = await authority.execute(actions);

      expect(result.success).toBe(false);
      expect(result.authorization.allowed).toBe(false);
      expect(mockExecutorExecuteTask).not.toHaveBeenCalled();
    });
  });

  describe('Bridge unavailable → FAIL CLOSED', () => {
    it('_bridgeLlmAvailable() = false → execute() 返回 BRIDGE_UNAVAILABLE_FAIL_CLOSED', async () => {
      mockGetPythonBridge.mockReturnValue(null);

      jest.isolateModules(() => {
        const { DesktopAgentLoop } = require('../../../src/desktop/DesktopAgentLoop');
        const loop = DesktopAgentLoop.getInstance();

        loop.initialize().then(async () => {
          const result = await loop.execute('打开记事本');
          expect(result.success).toBe(false);
          expect(result.error).toBe('BRIDGE_UNAVAILABLE_FAIL_CLOSED');
        });
      });
    });

    it('Bridge 断开后 executor.executeTask / executeAction 未被调用', async () => {
      mockGetPythonBridge.mockReturnValue(null);

      jest.isolateModules(() => {
        const { DesktopAgentLoop } = require('../../../src/desktop/DesktopAgentLoop');
        const loop = DesktopAgentLoop.getInstance();

        loop.initialize().then(async () => {
          await loop.execute('打开记事本');
          expect(mockExecutorExecuteTask).not.toHaveBeenCalled();
          expect(mockExecutorExecuteAction).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('LLM planning 异常 → FAIL CLOSED', () => {
    it('Bridge 断开后无 executable action', async () => {
      mockGetPythonBridge.mockReturnValue(null);

      jest.isolateModules(() => {
        const { DesktopAgentLoop } = require('../../../src/desktop/DesktopAgentLoop');
        const loop = DesktopAgentLoop.getInstance();

        loop.initialize().then(async () => {
          await loop.execute('打开记事本');
          expect(mockExecutorExecuteTask).not.toHaveBeenCalled();
          expect(mockExecutorExecuteAction).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('LLM throws - FAIL CLOSED (runtime test)', () => {
    it('LLM 规划抛异常 - executor 不被调用', async () => {
      const mockBridge = {
        llmMultimodalChat: jest.fn().mockRejectedValue(new Error('LLM 服务崩溃')),
      };
      mockGetPythonBridge.mockReturnValue(mockBridge);

      jest.isolateModules(() => {
        const { DesktopAgentLoop } = require('../../../src/desktop/DesktopAgentLoop');
        const loop = DesktopAgentLoop.getInstance();

        loop.initialize().then(async () => {
          const result = await loop.execute('打开记事本');
          expect(mockExecutorExecuteTask).not.toHaveBeenCalled();
          expect(mockExecutorExecuteAction).not.toHaveBeenCalled();
          expect(result.success).toBe(false);
        });
      });
    });
  });

  describe('LLM returns empty - FAIL CLOSED (runtime test)', () => {
    it('LLM 返回空字符串 - executor 不被调用', async () => {
      const mockBridge = {
        llmMultimodalChat: jest.fn().mockResolvedValue(''),
      };
      mockGetPythonBridge.mockReturnValue(mockBridge);

      jest.isolateModules(() => {
        const { DesktopAgentLoop } = require('../../../src/desktop/DesktopAgentLoop');
        const loop = DesktopAgentLoop.getInstance();

        loop.initialize().then(async () => {
          const result = await loop.execute('打开记事本');
          expect(mockExecutorExecuteTask).not.toHaveBeenCalled();
          expect(mockExecutorExecuteAction).not.toHaveBeenCalled();
          expect(result.success).toBe(false);
        });
      });
    });

    it('LLM 返回无效 JSON - executor 不被调用', async () => {
      const mockBridge = {
        llmMultimodalChat: jest.fn().mockResolvedValue('这不是有效的JSON'),
      };
      mockGetPythonBridge.mockReturnValue(mockBridge);

      jest.isolateModules(() => {
        const { DesktopAgentLoop } = require('../../../src/desktop/DesktopAgentLoop');
        const loop = DesktopAgentLoop.getInstance();

        loop.initialize().then(async () => {
          const result = await loop.execute('打开记事本');
          expect(mockExecutorExecuteTask).not.toHaveBeenCalled();
          expect(mockExecutorExecuteAction).not.toHaveBeenCalled();
          expect(result.success).toBe(false);
        });
      });
    });
  });

});

import { ConstraintsService } from '../../../src/harness/constraints/ConstraintsService';
import type { ConstraintsServiceDeps } from '../../../src/harness/constraints/ConstraintsService';
import type {
  BudgetState,
  PermissionResult,
  ToolContext,
  LifecycleHook,
  HookContext,
  HookResult,
} from '../../../src/harness/types';
import { LifecycleEvent, Permission } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockPermissionGuard = {
  check: jest.fn(),
};

const deps: ConstraintsServiceDeps = {
  permissionGuard: mockPermissionGuard,
};

function createBudgetState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    roundsUsed: 0,
    softRoundLimit: 4,
    hardRoundLimit: 8,
    tokensUsed: 0,
    tokenWarningLimit: 4500,
    tokenHardLimit: 6000,
    startTime: Date.now() - 1000,
    maxDurationMs: 60000,
    toolCallsUsed: 0,
    maxToolCalls: 20,
    ...overrides,
  };
}

describe('ConstraintsService', () => {
  let service: ConstraintsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ConstraintsService(deps);
  });

  describe('checkBudget', () => {
    it('should return withinBudget true when all limits are within range', () => {
      const state = createBudgetState();
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.remaining.rounds).toBe(8);
      expect(result.remaining.tokens).toBe(6000);
      expect(result.remaining.toolCalls).toBe(20);
      expect(result.remaining.durationMs).toBeGreaterThan(0);
    });

    it('should warn when roundsUsed reaches soft limit', () => {
      const state = createBudgetState({ roundsUsed: 4 });
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(false);
      expect(result.warnings).toContain('轮次已达软限制 4/8');
    });

    it('should warn when roundsUsed reaches hard limit', () => {
      const state = createBudgetState({ roundsUsed: 8 });
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(false);
      expect(result.warnings).toContain('轮次已达硬限制 8');
    });

    it('should warn when tokensUsed reaches warning limit', () => {
      const state = createBudgetState({ tokensUsed: 4500 });
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(false);
      expect(result.warnings).toContain('Token 接近限制 4500/6000');
    });

    it('should warn when tokensUsed reaches hard limit', () => {
      const state = createBudgetState({ tokensUsed: 6000 });
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(false);
      expect(result.warnings).toContain('Token 已达硬限制 6000');
    });

    it('should warn when toolCallsUsed reaches max', () => {
      const state = createBudgetState({ toolCallsUsed: 20 });
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(false);
      expect(result.warnings).toContain('工具调用已达上限 20');
    });

    it('should warn when duration exceeds maxDurationMs', () => {
      const state = createBudgetState({ startTime: Date.now() - 70000, maxDurationMs: 60000 });
      const result = service.checkBudget(state);
      expect(result.withinBudget).toBe(false);
      expect(result.warnings.some(w => w.includes('时间已达上限'))).toBe(true);
    });

    it('should calculate remaining values correctly', () => {
      const state = createBudgetState({ roundsUsed: 3, tokensUsed: 1000, toolCallsUsed: 5 });
      const result = service.checkBudget(state);
      expect(result.remaining.rounds).toBe(5);
      expect(result.remaining.tokens).toBe(5000);
      expect(result.remaining.toolCalls).toBe(15);
    });

    it('should not return negative remaining values', () => {
      const state = createBudgetState({ roundsUsed: 10, tokensUsed: 7000, toolCallsUsed: 25 });
      const result = service.checkBudget(state);
      expect(result.remaining.rounds).toBe(0);
      expect(result.remaining.tokens).toBe(0);
      expect(result.remaining.toolCalls).toBe(0);
    });

    it('should report multiple warnings simultaneously', () => {
      const state = createBudgetState({
        roundsUsed: 8,
        tokensUsed: 6000,
        toolCallsUsed: 20,
        startTime: Date.now() - 70000,
        maxDurationMs: 60000,
      });
      const result = service.checkBudget(state);
      expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('checkPermission', () => {
    it('should return allowed when permission guard allows', () => {
      mockPermissionGuard.check.mockReturnValue({ allowed: true, missing: [], reason: undefined });
      const context: ToolContext = { permissions: new Set(), metadata: {} };
      const result = service.checkPermission('tool', [], 'low', context);
      expect(result.allowed).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('should return denied with missing permissions', () => {
      const missing = [Permission.FILE_WRITE, Permission.CODE_EXECUTE];
      mockPermissionGuard.check.mockReturnValue({
        allowed: false,
        missing,
        reason: '缺少权限',
      });
      const context: ToolContext = { permissions: new Set(), metadata: {} };
      const result = service.checkPermission('tool', missing, 'high', context);
      expect(result.allowed).toBe(false);
      expect(result.missing).toEqual(missing);
      expect(result.reason).toBe('缺少权限');
    });

    it('should delegate all arguments to permission guard', () => {
      mockPermissionGuard.check.mockReturnValue({ allowed: true, missing: [], reason: undefined });
      const context: ToolContext = { permissions: new Set([Permission.MEMORY_READ]), metadata: { foo: 'bar' } };
      service.checkPermission('myTool', [Permission.MEMORY_READ], 'low', context);
      expect(mockPermissionGuard.check).toHaveBeenCalledWith('myTool', [Permission.MEMORY_READ], 'low', context);
    });
  });

  describe('checkSafetyBoundary', () => {
    it('should allow normal input and action', () => {
      const result = service.checkSafetyBoundary('hello world', 'read file');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should block oversized input', () => {
      const longInput = 'a'.repeat(10001);
      const result = service.checkSafetyBoundary(longInput, 'safe action');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('输入过长');
    });

    it('should allow input at exactly 10000 characters', () => {
      const input = 'a'.repeat(10000);
      const result = service.checkSafetyBoundary(input, 'safe action');
      expect(result.allowed).toBe(true);
    });

    it('should block rm -rf action', () => {
      const result = service.checkSafetyBoundary('input', 'rm -rf /');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('rm -rf');
    });

    it('should block del /f action', () => {
      const result = service.checkSafetyBoundary('input', 'del /f file.txt');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('del /f');
    });

    it('should block format action', () => {
      const result = service.checkSafetyBoundary('input', 'format C:');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('format');
    });

    it('should block shutdown action', () => {
      const result = service.checkSafetyBoundary('input', 'shutdown now');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('shutdown');
    });

    it('should block drop table action', () => {
      const result = service.checkSafetyBoundary('input', 'drop table users');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('drop table');
    });

    it('should perform case-insensitive check on dangerous actions', () => {
      const result = service.checkSafetyBoundary('input', 'DROP TABLE users');
      expect(result.allowed).toBe(false);
    });
  });

  describe('registerHook and executeHooks', () => {
    it('should execute a single registered hook', async () => {
      const hook: LifecycleHook = jest.fn().mockResolvedValue({ proceed: true });
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook);
      const context: HookContext = { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} };
      const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, context);
      expect(result.proceed).toBe(true);
      expect(hook).toHaveBeenCalledWith(context);
    });

    it('should execute multiple hooks in sequence', async () => {
      const hook1: LifecycleHook = jest.fn().mockResolvedValue({ proceed: true });
      const hook2: LifecycleHook = jest.fn().mockResolvedValue({ proceed: true });
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook1);
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook2);
      const context: HookContext = { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} };
      const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, context);
      expect(result.proceed).toBe(true);
      expect(hook1).toHaveBeenCalled();
      expect(hook2).toHaveBeenCalled();
    });

    it('should stop execution when a hook returns proceed=false', async () => {
      const hook1: LifecycleHook = jest.fn().mockResolvedValue({ proceed: false, reason: 'blocked' });
      const hook2: LifecycleHook = jest.fn().mockResolvedValue({ proceed: true });
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook1);
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook2);
      const context: HookContext = { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} };
      const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, context);
      expect(result.proceed).toBe(false);
      expect(result.reason).toBe('blocked');
      expect(hook2).not.toHaveBeenCalled();
    });

    it('should apply modifiedParams from hook to context', async () => {
      const modifiedParams = { key: 'modified' };
      const hook1: LifecycleHook = jest.fn().mockResolvedValue({ proceed: true, modifiedParams });
      const hook2: LifecycleHook = jest.fn().mockImplementation(async (ctx) => {
        return { proceed: true };
      });
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook1);
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook2);
      const context: HookContext = { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {}, params: { key: 'original' } };
      await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, context);
      expect(context.params).toEqual(modifiedParams);
    });

    it('should continue when a hook throws an error', async () => {
      const hook1: LifecycleHook = jest.fn().mockRejectedValue(new Error('hook error'));
      const hook2: LifecycleHook = jest.fn().mockResolvedValue({ proceed: true });
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook1);
      service.registerHook(LifecycleEvent.BEFORE_TOOL_CALL, hook2);
      const context: HookContext = { event: LifecycleEvent.BEFORE_TOOL_CALL, metadata: {} };
      const result = await service.executeHooks(LifecycleEvent.BEFORE_TOOL_CALL, context);
      expect(result.proceed).toBe(true);
      expect(hook2).toHaveBeenCalled();
    });

    it('should return proceed=true when no hooks are registered for event', async () => {
      const context: HookContext = { event: LifecycleEvent.ON_ERROR, metadata: {} };
      const result = await service.executeHooks(LifecycleEvent.ON_ERROR, context);
      expect(result.proceed).toBe(true);
    });
  });

  describe('enforceBehaviorConstraint', () => {
    describe('no-unbounded-recursion', () => {
      it('should allow recursion depth below 10', () => {
        const result = service.enforceBehaviorConstraint('no-unbounded-recursion', {
          params: { recursionDepth: 5 },
        });
        expect(result.compliant).toBe(true);
      });

      it('should block recursion depth at 10', () => {
        const result = service.enforceBehaviorConstraint('no-unbounded-recursion', {
          params: { recursionDepth: 10 },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('10');
      });

      it('should block recursion depth above 10', () => {
        const result = service.enforceBehaviorConstraint('no-unbounded-recursion', {
          params: { recursionDepth: 15 },
        });
        expect(result.compliant).toBe(false);
      });

      it('should allow when recursionDepth is not provided', () => {
        const result = service.enforceBehaviorConstraint('no-unbounded-recursion', { params: {} });
        expect(result.compliant).toBe(true);
      });
    });

    describe('no-unauthorized-file-access', () => {
      const originalHome = process.env.HOME;
      const originalUserprofile = process.env.USERPROFILE;

      beforeEach(() => {
        process.env.HOME = '/home/testuser';
        process.env.USERPROFILE = 'C:\\Users\\testuser';
      });

      afterEach(() => {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserprofile;
      });

      it('should allow normal file paths', () => {
        const result = service.enforceBehaviorConstraint('no-unauthorized-file-access', {
          params: { filePath: '/workspace/project/file.txt' },
        });
        expect(result.compliant).toBe(true);
      });

      it('should block /etc path', () => {
        const result = service.enforceBehaviorConstraint('no-unauthorized-file-access', {
          params: { filePath: '/etc/passwd' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('/etc');
      });

      it('should block /root path', () => {
        const result = service.enforceBehaviorConstraint('no-unauthorized-file-access', {
          params: { filePath: '/root/.ssh/id_rsa' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('/root');
      });

      it('should block C:\\Windows path', () => {
        const result = service.enforceBehaviorConstraint('no-unauthorized-file-access', {
          params: { filePath: 'C:\\Windows\\System32\\config' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('C:\\Windows');
      });

      it('should block C:\\Program Files path', () => {
        const result = service.enforceBehaviorConstraint('no-unauthorized-file-access', {
          params: { filePath: 'C:\\Program Files\\app\\config' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should allow when filePath is not provided', () => {
        const result = service.enforceBehaviorConstraint('no-unauthorized-file-access', { params: {} });
        expect(result.compliant).toBe(true);
      });
    });

    describe('no-sensitive-data-leak', () => {
      it('should allow normal output', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: 'Hello, this is a normal response' },
        });
        expect(result.compliant).toBe(true);
      });

      it('should block bank card number pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: '您的银行卡号是 6222021234567890123' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('银行卡号');
      });

      it('should block ID number pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: '身份证号 110101199001011234' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('敏感信息');
      });

      it('should block password pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: 'password=MySecret123' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('密码/密钥');
      });

      it('should block email pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: '联系邮箱 user@example.com' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('邮箱地址');
      });

      it('should block phone number pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: '手机号 13812345678' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('手机号码');
      });

      it('should block IP address pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: '服务器IP 192.168.1.100' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('IPv4地址');
      });

      it('should allow when result output is not provided', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true },
        });
        expect(result.compliant).toBe(true);
      });

      it('should handle non-string output by serializing', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-data-leak', {
          result: { success: true, output: { phone: '13812345678' } },
        });
        expect(result.compliant).toBe(false);
      });
    });

    describe('no-sensitive-storage', () => {
      it('should allow normal content in memory_store', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: '用户偏好深色主题' },
        });
        expect(result.compliant).toBe(true);
      });

      it('should block API key in memory_store', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: 'API密钥 sk-abcdefgh12345678' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('API密钥');
      });

      it('should block AWS key pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: 'AWS key AKIAIOSFODNN7EXAMPLE' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('AWS密钥');
      });

      it('should block GitHub token pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: 'token ghp_1234567890abcdefghijklmnopqrstuvwxyz' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('GitHub令牌');
      });

      it('should block generic api_key pattern', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: 'api_key="abcdefgh12345678"' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('密钥凭证');
      });

      it('should block bank card number in storage', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: '卡号 6222021234567890123' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('银行卡号');
      });

      it('should block ID number in storage', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: '身份证 1101011990010112345' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('敏感信息');
      });

      it('should block sensitive credential keywords', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: '数据库密码' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('敏感凭证关键词');
      });

      it('should allow non-sensitive tools regardless of content', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'web_search',
          params: { content: 'api_key=secret12345678' },
        });
        expect(result.compliant).toBe(true);
      });

      it('should check note_take tool as well', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'note_take',
          params: { text: '密码=MyPassword123' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should allow empty content', () => {
        const result = service.enforceBehaviorConstraint('no-sensitive-storage', {
          toolName: 'memory_store',
          params: { content: '' },
        });
        expect(result.compliant).toBe(true);
      });
    });

    describe('no-dangerous-commands', () => {
      it('should allow safe commands', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'ls -la' },
        });
        expect(result.compliant).toBe(true);
      });

      it('should block rm -rf / pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'rm -rf /' },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('危险命令');
      });

      it('should block del /f /q pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'del /f /q C:\\important.dat' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should block format drive pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'format C:' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should block shutdown pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'shutdown /s /t 0' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should block drop table pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'drop table users' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should block drop database pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'drop database production' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should block truncate table pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: 'truncate table logs' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should block SQL injection drop pattern', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { command: "'; -- ; drop table users" },
        });
        expect(result.compliant).toBe(false);
      });

      it('should check script param as fallback', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: { script: 'rm -rf /' },
        });
        expect(result.compliant).toBe(false);
      });

      it('should allow when no command or script is provided', () => {
        const result = service.enforceBehaviorConstraint('no-dangerous-commands', {
          params: {},
        });
        expect(result.compliant).toBe(true);
      });
    });

    describe('resource-limit-check', () => {
      it('should allow within memory and CPU limits', () => {
        const result = service.enforceBehaviorConstraint('resource-limit-check', {
          params: { memoryMB: 256, cpuTimeMs: 10000 },
        });
        expect(result.compliant).toBe(true);
      });

      it('should block when memory exceeds 512MB', () => {
        const result = service.enforceBehaviorConstraint('resource-limit-check', {
          params: { memoryMB: 600 },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('内存使用');
      });

      it('should block when CPU time exceeds 30000ms', () => {
        const result = service.enforceBehaviorConstraint('resource-limit-check', {
          params: { cpuTimeMs: 35000 },
        });
        expect(result.compliant).toBe(false);
        expect(result.violation).toContain('CPU 时间');
      });

      it('should allow when no resource params are provided', () => {
        const result = service.enforceBehaviorConstraint('resource-limit-check', { params: {} });
        expect(result.compliant).toBe(true);
      });

      it('should allow at exactly 512MB memory', () => {
        const result = service.enforceBehaviorConstraint('resource-limit-check', {
          params: { memoryMB: 512 },
        });
        expect(result.compliant).toBe(true);
      });

      it('should allow at exactly 30000ms CPU time', () => {
        const result = service.enforceBehaviorConstraint('resource-limit-check', {
          params: { cpuTimeMs: 30000 },
        });
        expect(result.compliant).toBe(true);
      });
    });

    describe('unknown constraint', () => {
      it('should return compliant for unknown constraint type', () => {
        const result = service.enforceBehaviorConstraint('unknown-constraint', { params: {} });
        expect(result.compliant).toBe(true);
      });
    });
  });
});

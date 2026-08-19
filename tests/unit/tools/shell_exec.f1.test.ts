/**
 * F1 Phase1 shell_exec Python canonical 代理 — jest 冒烟测试 (CI 可跑)。
 *
 * 本地 node_modules 损坏无法跑 jest; 此文件为真实 jest 环境的镜像验证,
 * 与 .f1_verify/verify.cjs (tsc 转译 + Module._load 桩) 断言一致。
 *
 * 行为契约:
 *   - bridge 可用 → 经 getActivePythonBridge().toolsetExecuteRaw('shell_exec', {command,timeout,cwd}) 代理
 *   - Python 逻辑拒绝(含 security_violation) → 诚实返回, 绝不回退本地 shell:true
 *   - 无 bridge → 回退本地执行(shellRunner)
 *   - bridge transport 错误 → 安全降级本地(safe-degrade)
 */
import { createShellExecExecutor } from '../../../src/harness/tools/system/shell_exec';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../src/harness/types', () => ({
  Permission: { SYSTEM_ADMIN: 'system_admin' },
  ToolCategory: { SYSTEM: 'system' },
}));

const mockGetBridge = jest.fn();
jest.mock('../../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: () => mockGetBridge(),
}));

import { getActivePythonBridge } from '../../../src/ide/bridgeRegistry';

type RawResult = {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

function makeBridge(mode: 'success' | 'reject' | 'transport') {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    toolsetExecuteRaw(toolName: string, params: Record<string, unknown>): Promise<RawResult> {
      calls.push({ toolName, params });
      if (mode === 'success') return Promise.resolve({ success: true, output: 'PYOUT', metadata: { pid: 1 } });
      if (mode === 'reject')
        return Promise.resolve({ success: false, error: 'command not allowed', metadata: { security_violation: true } });
      return Promise.reject(new Error('ECONNREFUSED python down'));
    },
  };
}

function makeLocalRunner() {
  const state = { used: false };
  return {
    state,
    run: jest.fn(async () => {
      state.used = true;
      return { stdout: 'LOCAL', exitCode: 0 };
    }),
  };
}

beforeEach(() => {
  mockGetBridge.mockReset();
});

describe('F1 shell_exec Python canonical proxy', () => {
  it('代理成功映射', async () => {
    const bridge = makeBridge('success');
    mockGetBridge.mockReturnValue(bridge);
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls -la' }, {});
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].toolName).toBe('shell_exec');
    expect(bridge.calls[0].params).toMatchObject({ command: 'ls -la', timeout: 30000 });
    expect(res.success).toBe(true);
    expect(res.output).toBe('PYOUT');
    expect(local.state.used).toBe(false);
  });

  it('Python 逻辑拒绝 → 不回退本地', async () => {
    const bridge = makeBridge('reject');
    mockGetBridge.mockReturnValue(bridge);
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls -la' }, {});
    expect(bridge.calls).toHaveLength(1);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/command not allowed/);
    expect(local.state.used).toBe(false);
  });

  it('无 bridge → 回退本地', async () => {
    mockGetBridge.mockReturnValue(null);
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls' }, {});
    expect(local.state.used).toBe(true);
    expect(res.success).toBe(true);
    expect(res.output).toBe('LOCAL');
  });

  it('transport 错误 → 安全降级本地', async () => {
    const bridge = makeBridge('transport');
    mockGetBridge.mockReturnValue(bridge);
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls' }, {});
    expect(bridge.calls).toHaveLength(1);
    expect(local.state.used).toBe(true);
    expect(res.success).toBe(true);
    expect(res.output).toBe('LOCAL');
  });
});

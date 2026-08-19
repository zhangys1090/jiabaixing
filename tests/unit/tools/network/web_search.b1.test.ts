/**
 * B1 jest 镜像 (CI 可跑; 本地运行时验证见 .b1_verify/verify.cjs)。
 *
 * 覆盖: web_search 归 Python canonical (F1 同法)。
 *  - 有 bridge → 代理到 Python web_search, 透传其格式化输出 (metadata.backend='python')
 *  - bridge 不可用 → 降级注入的 searchEngine (TS 本地)
 *  - bridge 逻辑失败(success:false) → 降级 TS 本地
 */
jest.mock('../../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: jest.fn(),
}));

import { createWebSearchExecutor } from '../../../src/harness/tools/network/web_search';
import { getActivePythonBridge } from '../../../src/ide/bridgeRegistry';

const getBridge = getActivePythonBridge as jest.Mock;

describe('B1 web_search 归 Python canonical', () => {
  afterEach(() => getBridge.mockReset());

  it('有 bridge → 透传 Python 输出 (backend=python)', async () => {
    getBridge.mockReturnValue({
      toolsetExecuteRaw: async () => ({
        success: true,
        output: 'PY_RESULTS',
        metadata: { backend: 'python' },
      }),
    });
    const exec = createWebSearchExecutor({});
    const r = await exec({ query: 'q' }, {});
    expect(r.success).toBe(true);
    expect(r.output).toBe('PY_RESULTS');
    expect(r.metadata?.backend).toBe('python');
  });

  it('bridge 不可用 → 降级注入的 searchEngine', async () => {
    getBridge.mockReturnValue(null);
    let engineCalled = false;
    const exec = createWebSearchExecutor({
      searchEngine: async () => {
        engineCalled = true;
        return [{ title: 'L', url: 'u', snippet: 's' }];
      },
    });
    const r = await exec({ query: 'q' }, {});
    expect(engineCalled).toBe(true);
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/L/);
  });

  it('bridge 逻辑失败(success:false) → 降级 TS 本地', async () => {
    getBridge.mockReturnValue({
      toolsetExecuteRaw: async () => ({ success: false, error: 'python down' }),
    });
    let engineCalled = false;
    const exec = createWebSearchExecutor({
      searchEngine: async () => {
        engineCalled = true;
        return [{ title: 'L2', url: 'u', snippet: 's' }];
      },
    });
    const r = await exec({ query: 'q' }, {});
    expect(engineCalled).toBe(true);
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/L2/);
  });
});

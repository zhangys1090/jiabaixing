import { errorMonitor, ErrorLevel } from './errorMonitoring';

// 在 Node.js 测试环境中模拟浏览器 API
// 有些测试环境可能已经定义了 window（如 jsdom），合并而不是替换
const existingWindow = (globalThis as Record<string, unknown>).window as Record<string, unknown> | undefined;
(globalThis as Record<string, unknown>).window = {
  addEventListener: existingWindow?.addEventListener || jest.fn(),
  removeEventListener: existingWindow?.removeEventListener || jest.fn(),
  location: { href: 'http://localhost:3000/', origin: 'http://localhost:3000' },
  ...(existingWindow || {}),
};
(globalThis as Record<string, unknown>).navigator = {
  userAgent: 'jest-test-runner',
};

// 设置测试环境变量
process.env.REACT_APP_API_BASE_URL = 'http://test-api.jiabaixing.com/api';

// 模拟 fetch 函数
global.fetch = jest.fn();

describe('ErrorMonitor', () => {
  beforeEach(() => {
    // 清除所有模拟
    jest.clearAllMocks();
  });

  test('should initialize error monitoring', () => {
    // 模拟 window.addEventListener
    const addEventListenerSpy = jest.spyOn(
      window as unknown as { addEventListener: jest.Mock },
      'addEventListener'
    );

    // 初始化错误监控
    errorMonitor.initialize();

    // 验证是否添加了事件监听器
    expect(addEventListenerSpy).toHaveBeenCalledWith('error', expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenCalledWith('error', expect.any(Function), true);

    // 清理
    addEventListenerSpy.mockRestore();
  });

  test('should report network error', async () => {
    // 模拟 fetch 成功
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({ status: 'ok' }),
    });

    // 报告网络错误
    errorMonitor.reportNetworkError('http://example.com/api', 500, 'Internal Server Error');

    // 验证 fetch 是否被调用
    expect(global.fetch).toHaveBeenCalledWith(
      'http://test-api.jiabaixing.com/api/error/monitoring',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expect.stringContaining('Internal Server Error'),
      })
    );
  });

  test('should report custom error', async () => {
    // 模拟 fetch 成功
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({ status: 'ok' }),
    });

    // 报告自定义错误
    errorMonitor.reportCustomError('Test error', ErrorLevel.ERROR, {
      foo: 'bar',
    });

    // 验证 fetch 是否被调用
    expect(global.fetch).toHaveBeenCalledWith(
      'http://test-api.jiabaixing.com/api/error/monitoring',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expect.stringContaining('Test error'),
      })
    );
  });
});

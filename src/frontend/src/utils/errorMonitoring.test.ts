import { errorMonitor, ErrorLevel } from './errorMonitoring';

// 模拟 fetch 函数
global.fetch = jest.fn();

describe('ErrorMonitor', () => {
  beforeEach(() => {
    // 清除所有模拟
    jest.clearAllMocks();
  });

  test('should initialize error monitoring', () => {
    // 模拟 window.addEventListener
    const addEventListenerSpy = jest.spyOn(window, 'addEventListener');

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

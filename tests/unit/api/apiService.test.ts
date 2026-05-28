/**
 * API服务测试
 * 测试API服务的各项功能
 */

import { JiabaixingApiService } from '../../../src/frontend/src/api/apiService';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('JiabaixingApiService', () => {
  let apiService: JiabaixingApiService;

  beforeEach(() => {
    apiService = new JiabaixingApiService('http://localhost:3101');
    mockFetch.mockClear();
  });

  afterEach(() => {
    apiService.clearCache();
  });

  describe('基础请求方法', () => {
    it('应该正确处理GET请求', async () => {
      const mockResponse = {
        success: true,
        data: { message: 'test' },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await apiService.get<{ message: string }>('/test');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
    });

    it('应该正确处理POST请求', async () => {
      const mockResponse = {
        success: true,
        data: { id: 1 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await apiService.post<{ id: number }>('/test', { data: 'test' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
    });

    it('应该正确处理PUT请求', async () => {
      const mockResponse = {
        success: true,
        data: { updated: true },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await apiService.put<{ updated: boolean }>('/test/1', { data: 'test' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
    });

    it('应该正确处理DELETE请求', async () => {
      const mockResponse = {
        success: true,
        data: { deleted: true },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await apiService.delete<{ deleted: boolean }>('/test/1');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
    });

    it('应该处理请求失败', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      const result = await apiService.get('/test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Server error');
    });

    it('应该处理网络错误', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await apiService.get('/test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('缓存功能', () => {
    it('应该缓存GET请求的结果', async () => {
      const mockResponse = {
        success: true,
        data: { cached: true },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result1 = await apiService.get<{ cached: boolean }>('/cached');
      const result2 = await apiService.get<{ cached: boolean }>('/cached');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.data).toEqual(result2.data);
    });

    it('应该清除指定端点的缓存', async () => {
      const mockResponse = {
        success: true,
        data: { value: 1 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await apiService.get<{ value: number }>('/clearable');
      apiService.clearCacheForEndpoint('/clearable');

      // 下一次请求应该重新获取数据
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { value: 2 } }),
      });

      await apiService.get<{ value: number }>('/clearable');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('应该清除所有缓存', async () => {
      const mockResponse = {
        success: true,
        data: { value: 1 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await apiService.get<{ value: number }>('/clearable');
      apiService.clearCache();

      // 下一次请求应该重新获取数据
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { value: 2 } }),
      });

      await apiService.get<{ value: number }>('/clearable');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('重试机制', () => {
    it('应该在请求失败时重试', async () => {
      const mockResponse = {
        success: true,
        data: { result: 'success' },
      };

      // 前两次请求失败，第三次成功
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

      const result = await apiService.get<{ result: string }>('/retry');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
    });

    it('应该在重试次数超过限制后返回错误', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await apiService.get('/retry');

      expect(mockFetch).toHaveBeenCalledTimes(3); // 默认重试3次
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('智能助手API', () => {
    it('应该正确调用processMessage', async () => {
      const mockResponse = {
        success: true,
        data: { response: 'Hello!' },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await apiService.processMessage('Hi');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3101/process',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ input: 'Hi' }),
        })
      );
      expect(result.success).toBe(true);
      expect(result.data?.response).toBe('Hello!');
    });
  });

});

import { StreamResponseService } from '../../../src/core/StreamResponseService';

// Mock EventBus
// 注意：jest.mock 工厂会被提升到文件顶部，不能直接引用外部变量（TDZ）。
// 使用包装函数延迟访问 mockEmit，避免 ReferenceError。
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: (...args: unknown[]): unknown => mockEmit(...args),
  },
}));

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('StreamResponseService', () => {
  let service: StreamResponseService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new StreamResponseService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('stream', () => {
    it('应该立即发射 stream_start 事件', () => {
      service.stream('你好世界', 'trace-1');
      expect(mockEmit).toHaveBeenCalledWith('stream_start', {
        traceId: 'trace-1',
        totalLength: 4,
        timestamp: expect.any(Number),
      });
    });

    it('应该在第一个延迟后发射第一个 chunk', () => {
      service.stream('你好世界', 'trace-1');
      mockEmit.mockClear();

      jest.advanceTimersByTime(25);
      expect(mockEmit).toHaveBeenCalledWith('stream_chunk', {
        traceId: 'trace-1',
        chunk: '你好世界'.slice(0, 6),
        offset: 6,
        timestamp: expect.any(Number),
      });
    });

    it('应该在所有 chunk 发射后发射 stream_done', () => {
      service.stream('hi', 'trace-2');
      // 第一次 chunk 延迟
      jest.advanceTimersByTime(25);
      // 第二次 chunk 延迟（done 在 offset >= length 时触发）
      jest.advanceTimersByTime(25);

      expect(mockEmit).toHaveBeenCalledWith('stream_done', {
        traceId: 'trace-2',
        fullText: 'hi',
        timestamp: expect.any(Number),
      });
    });

    it('应该处理空字符串', () => {
      service.stream('', 'trace-3');
      // 空字符串应该立即触发 done（offset 0 >= length 0）
      jest.advanceTimersByTime(25);

      expect(mockEmit).toHaveBeenCalledWith('stream_done', {
        traceId: 'trace-3',
        fullText: '',
        timestamp: expect.any(Number),
      });
    });

    it('应该正确分块长文本', () => {
      const longText = '这是一段很长的文本用于测试分块功能'.repeat(3);
      service.stream(longText, 'trace-4');

      // 推进足够多的时间让所有 chunk 完成
      jest.advanceTimersByTime(25 * 100);

      const chunkCalls = mockEmit.mock.calls.filter(
        (c) => c[0] === 'stream_chunk'
      );
      // 每个 chunk 6 字符，基础字符串 17 字符 × 3 = 51 字符，ceil(51/6) = 9 个 chunk
      expect(chunkCalls.length).toBe(9);
    });
  });
});

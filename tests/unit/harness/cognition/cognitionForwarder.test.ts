/**
 * D2 认知信号回灌转发器 — jest 冒烟测试 (CI 可跑)。
 *
 * 本地 node_modules 损坏无法跑 jest; 此文件为真实 jest 环境的镜像验证,
 * 与 .d2_verify/verify.cjs (tsc 转译 + Module._load 桩) 断言一致。
 *
 * 行为契约:
 *   - registerCognitionForwarder 幂等订阅 'cognition_result'
 *   - 携带 sessionId → 经 getActivePythonBridge().sendCognitionSignal 转发, 参数映射正确
 *   - 无 sessionId → 诚实丢弃, 不转发
 *   - bridge 为 null → 不抛错、不调用
 *   - bridge rejected → 被 .catch 吞掉
 */
import { registerCognitionForwarder } from '../../../../src/harness/cognition/cognitionForwarder';

// 共享假 EventBus (注册与 emit 同一对象)
const handlers: Record<string, Array<(p: unknown) => void>> = {};
const fakeEventBus = {
  on(ev: string, fn: (p: unknown) => void) {
    (handlers[ev] || (handlers[ev] = [])).push(fn);
    return fakeEventBus;
  },
  emit(ev: string, payload: unknown) {
    (handlers[ev] || []).forEach((fn) => fn(payload));
    return true;
  },
};

jest.mock('../../../../src/shared/EventBus', () => ({
  EventBus: fakeEventBus,
  JiabaixingEventBus: class {},
}));

const mockCalls: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
const mockSend = jest.fn((sessionId: string, payload: Record<string, unknown>) => {
  mockCalls.push({ sessionId, payload });
  return Promise.resolve();
});
const mockGetBridge = jest.fn(() => ({ sendCognitionSignal: mockSend }));

jest.mock('../../../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: () => mockGetBridge(),
}));

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

beforeEach(() => {
  mockCalls.length = 0;
  mockGetBridge.mockClear();
  mockSend.mockClear();
  handlers['cognition_result'] = [];
  // 重置 forwarder 模块的 registered 标志 (隔离每个测试)
  jest.resetModules();
});

describe('D2 CognitionForwarder', () => {
  it('订阅 cognition_result 且幂等', () => {
    registerCognitionForwarder();
    registerCognitionForwarder();
    expect(handlers['cognition_result']).toHaveLength(1);
  });

  it('携带 sessionId → 转发且参数映射正确', () => {
    registerCognitionForwarder();
    fakeEventBus.emit('cognition_result', {
      tool: 'emotion_detect',
      category: 'cognition',
      success: true,
      durationMs: 12,
      outputPreview: '负面情绪',
      error: null,
      timestamp: '2026-08-12T15:00:00Z',
      sessionId: 'sess-x',
    });
    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0].sessionId).toBe('sess-x');
    expect(mockCalls[0].payload.tool).toBe('emotion_detect');
    expect(mockCalls[0].payload.success).toBe(true);
    expect(mockCalls[0].payload.outputPreview).toBe('负面情绪');
  });

  it('无 sessionId → 不转发', () => {
    registerCognitionForwarder();
    fakeEventBus.emit('cognition_result', {
      tool: 'self_reflect',
      category: 'cognition',
      success: false,
      durationMs: 5,
      outputPreview: null,
      error: 'no deps',
      timestamp: '2026-08-12T15:01:00Z',
      sessionId: null,
    });
    expect(mockCalls).toHaveLength(0);
  });

  it('bridge 为 null → 不抛错、不调用', () => {
    mockGetBridge.mockReturnValue(null as unknown as never);
    registerCognitionForwarder();
    expect(() =>
      fakeEventBus.emit('cognition_result', {
        tool: 'emotion_detect',
        category: 'cognition',
        success: true,
        durationMs: 9,
        outputPreview: 'x',
        error: null,
        timestamp: 't',
        sessionId: 'sess-y',
      })
    ).not.toThrow();
    expect(mockCalls).toHaveLength(0);
  });

  it('bridge 调用 rejected → 被 .catch 吞掉 (不崩)', async () => {
    const failing = jest.fn(() => Promise.reject(new Error('down')));
    mockGetBridge.mockReturnValue({ sendCognitionSignal: failing });
    registerCognitionForwarder();
    expect(() =>
      fakeEventBus.emit('cognition_result', {
        tool: 'emotion_detect',
        category: 'cognition',
        success: true,
        durationMs: 9,
        outputPreview: 'x',
        error: null,
        timestamp: 't',
        sessionId: 'sess-z',
      })
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

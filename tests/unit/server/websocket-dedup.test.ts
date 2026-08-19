/**
 * WebSocket 聊天入口契约测试（真实断言，取代原恒空壳测试）
 *
 * 背景：此前一次"修双重回复"的改动在 processInputOnce 塞了一个死的 early-return，
 * 导致 WS 聊天整条断路（用户发消息收不到任何回复）。本测试用契约方式锁定：
 *   对一次用户生成，processInputOnce 必须真正转发到 Python 桥接，
 *   且整个生命周期**恰好发送一份** response_ready（不是 0 份=断路，也不是 2 份=重复双发），
 *   其文本为完整、未重复的流式拼接结果。
 *
 * 另覆盖：流式事件本身（stream_start / stream_chunk / stream_done）确实被发出，
 * 证明桥接已被触达而非被 early-return 跳过。
 */

import { processInputOnce } from '../../../src/server/websocket';
import * as bootstrap from '../../../src/server/bootstrap';
import { SecurityPolicyEngine } from '../../../src/security/SecurityPolicyEngine';

// 这些重依赖在测试里不需要真实行为，全部 mock 掉，
// 避免加载 JiabaixingCore 等重型模块带来的副作用。
jest.mock('../../../src/server/bootstrap');
jest.mock('../../../src/security/SecurityPolicyEngine');
jest.mock('../../../src/core/JiabaixingCore');
jest.mock('../../../src/utils/Logger', () => ({
  Logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

type SentMessage = { type: string; data: Record<string, unknown> };

function parseSent(ws: { send: jest.Mock }): SentMessage[] {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string) as SentMessage);
}

function makeFakeWs() {
  return { readyState: 1, send: jest.fn() } as unknown as {
    readyState: number;
    send: jest.Mock;
  };
}

describe('WebSocket 聊天入口契约：一次生成只发一份最终回复', () => {
  beforeEach(() => {
    (SecurityPolicyEngine.getInstance as jest.Mock).mockReturnValue({
      getCircuitBreaker: () => ({ recordSuccess: jest.fn() }),
    });
    (bootstrap.isPythonBackend as jest.Mock).mockReturnValue(true);
  });

  it('流式生成后只发送恰好一份 response_ready，且文本完整不重复', async () => {
    const traceId = 'trace-001';
    const fullText = '你好，我是家百星，有什么可以帮你？';

    // 模拟 Python 桥接的流式输出
    (bootstrap.getPythonBridge as jest.Mock).mockImplementation(() => ({
      processInputStream: async function* () {
        yield { type: 'stream_start', trace_id: traceId };
        yield { type: 'stream_chunk', content: '你好，', trace_id: traceId };
        yield { type: 'stream_chunk', content: '我是家百星，', trace_id: traceId };
        yield { type: 'stream_chunk', content: '有什么可以帮你？', trace_id: traceId };
        yield { type: 'stream_done', content: fullText, trace_id: traceId };
      },
    }));

    const ws = makeFakeWs();
    await processInputOnce('你好', 'user-1', traceId, ws as never, null, {
      aborted: false,
    });

    const sent = parseSent(ws);

    // 1) 桥接确实被触达：流式事件确实存在
    const streamStarts = sent.filter((m) => m.type === 'stream_start');
    const streamChunks = sent.filter((m) => m.type === 'stream_chunk');
    const streamDones = sent.filter((m) => m.type === 'stream_done');
    expect(streamStarts.length).toBe(1);
    expect(streamChunks.length).toBe(3);
    expect(streamDones.length).toBe(1);

    // 2) 关键契约：恰好一份 response_ready（不是 0 份=断路，也不是 2 份=双发）
    const responseReadies = sent.filter((m) => m.type === 'response_ready');
    expect(responseReadies.length).toBe(1);

    // 3) 最终文本为完整拼接、未重复
    const finalText = responseReadies[0].data.response as string;
    expect(finalText).toBe(fullText);
    expect(finalText).not.toContain(finalText + finalText);
  });

  it('无 chunk 仅 stream_start + stream_done 时，仍只发一份 response_ready', async () => {
    const traceId = 'trace-002';
    const fullText = '已收到你的指令。';

    (bootstrap.getPythonBridge as jest.Mock).mockImplementation(() => ({
      processInputStream: async function* () {
        yield { type: 'stream_start', trace_id: traceId };
        yield { type: 'stream_done', content: fullText, trace_id: traceId };
      },
    }));

    const ws = makeFakeWs();
    await processInputOnce('执行X', 'user-2', traceId, ws as never, null, {
      aborted: false,
    });

    const sent = parseSent(ws);
    const responseReadies = sent.filter((m) => m.type === 'response_ready');
    expect(responseReadies.length).toBe(1);
    expect(responseReadies[0].data.response).toBe(fullText);
  });

  it('桥接抛错时也只发一份 response_ready（error 分支），不重复', async () => {
    const traceId = 'trace-003';

    (bootstrap.getPythonBridge as jest.Mock).mockImplementation(() => ({
      processInputStream: async function* () {
        yield { type: 'stream_start', trace_id: traceId };
        throw new Error('bridge exploded');
      },
    }));

    const ws = makeFakeWs();
    await expect(
      processInputOnce('坏输入', 'user-3', traceId, ws as never, null, {
        aborted: false,
      })
    ).rejects.toThrow('bridge exploded');

    const sent = parseSent(ws);
    const responseReadies = sent.filter((m) => m.type === 'response_ready');
    expect(responseReadies.length).toBe(1);
    expect(responseReadies[0].data.success).toBe(false);
  });
});

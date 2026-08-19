/**
 * A2A 薄壳路由转发测试 (P1-1)。
 *
 * 验证 TS 网关把 `/a2a/*` 透明转发到 Python A2A 后端：
 *  - 路径、方法、JSON 体、鉴权头正确透传；
 *  - Python 不可用时返回 503；
 *  - 上游 JSON 原样回传。
 *
 * 注：本测试依赖全局 fetch（Node 18+）。本地 node_modules 损坏时无法跑 jest，
 * 可用 `python` 无关的 tsc 转译 + Module._load 桩做等价运行时验证（见交付说明）。
 */

jest.mock('express', () => ({
  __esModule: true,
  default: {
    json: () => (req: unknown, res: unknown, next: () => void) => next(),
  },
}));

import { registerA2ARoutes } from '../../../src/a2a/A2ARouter';

interface Captured {
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

function makeApp(): { app: { use: (p: string, ...mw: unknown[]) => void }; captured: Captured } {
  const captured = { path: '', handler: () => undefined } as Captured;
  const app = {
    use: (p: string, ...mw: unknown[]) => {
      captured.path = p;
      captured.handler = mw[mw.length - 1] as Captured['handler'];
    },
  };
  return { app, captured };
}

describe('A2A 薄壳路由转发 (P1-1)', () => {
  let fetchMock: jest.Mock;
  let captured: Captured;

  beforeEach(() => {
    const { app, captured: cap } = makeApp();
    captured = cap;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    process.env.PYTHON_AGENT_URL = 'http://python-a2a:8765';
    registerA2ARoutes(app as unknown as import('express').Application);
  });

  function fakeRes() {
    const res: Record<string, unknown> = {
      statusCode: 0,
      body: undefined as unknown,
      status(c: number) {
        res.statusCode = c;
        return res;
      },
      json(b: unknown) {
        res.body = b;
        return res;
      },
      send(b: unknown) {
        res.body = b;
        return res;
      },
    };
    return res;
  }

  it('POST /a2a/tasks 应透传方法、路径与 JSON 体到 Python', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ id: 't1', status: 'submitted' }),
    });

    const req = {
      originalUrl: '/a2a/tasks',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: { fromAgentId: 'a', toAgentId: 'b', description: 'd', input: {} },
    };
    const res = fakeRes();
    await (captured.handler as (r: unknown, s: unknown) => Promise<void>)(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://python-a2a:8765/a2a/tasks');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer x');
    expect(JSON.parse(init.body)).toMatchObject({ fromAgentId: 'a' });
    expect((res as Record<string, unknown>).statusCode).toBe(200);
    expect((res as Record<string, unknown>).body).toMatchObject({ id: 't1' });
  });

  it('GET /.well-known/agent.json 应转发发现端点', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ id: 'agent:x' }),
    });
    const req = {
      originalUrl: '/a2a/.well-known/agent.json',
      method: 'GET',
      headers: {},
    };
    const res = fakeRes();
    await (captured.handler as (r: unknown, s: unknown) => Promise<void>)(req, res);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://python-a2a:8765/a2a/.well-known/agent.json'
    );
  });

  it('Python 不可用时返回 503', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const req = {
      originalUrl: '/a2a/tasks',
      method: 'GET',
      headers: {},
    };
    const res = fakeRes();
    await (captured.handler as (r: unknown, s: unknown) => Promise<void>)(req, res);
    expect((res as Record<string, unknown>).statusCode).toBe(503);
    expect((res as Record<string, unknown>).body).toMatchObject({ success: false });
  });
});

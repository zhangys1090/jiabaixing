import { ACPServer } from '../../../src/ide/ACPServer';
import type {
  ACPDeps,
  ACPFileDiff,
  ACPTerminalCommand,
  ACPToolActivity,
} from '../../../src/ide/ACPServer';

describe('ACPServer', () => {
  let server: ACPServer;
  let mockDeps: ACPDeps;

  beforeEach(() => {
    mockDeps = {
      processInput: async (message: string, sessionId?: string) => ({
        response: `回复: ${message}`,
        traceId: sessionId ?? 'test',
      }),
      getFileDiffs: (_sessionId: string) => [] as ACPFileDiff[],
      getTerminalCommands: (_sessionId: string) => [] as ACPTerminalCommand[],
      getToolActivities: (_sessionId: string) => [] as ACPToolActivity[],
    };

    server = new ACPServer(mockDeps);
  });

  it('应处理聊天请求', async () => {
    const response = await server.handleChat({
      message: '你好',
      sessionId: 'test-session',
    });

    expect(response).toHaveProperty('content');
    expect(response.content).toContain('回复');
    expect(response.sessionId).toBe('test-session');
  });

  it('应获取文件 Diff', () => {
    const diff = server.getFileDiff('test-session');
    expect(Array.isArray(diff)).toBe(true);
  });

  it('应获取终端命令', () => {
    const commands = server.getTerminalCommands('test-session');
    expect(Array.isArray(commands)).toBe(true);
  });

  it('应获取工具活动', () => {
    const activities = server.getToolActivities('test-session');
    expect(Array.isArray(activities)).toBe(true);
  });

  it('应追踪活跃会话', async () => {
    await server.handleChat({ message: 'hi', sessionId: 's1' });
    await server.handleChat({ message: 'hello', sessionId: 's2' });

    const sessions = server.getActiveSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId)).toContain('s1');
    expect(sessions.map((s) => s.sessionId)).toContain('s2');
  });

  it('应关闭会话', async () => {
    await server.handleChat({ message: 'hi', sessionId: 's1' });

    const closed = server.closeSession('s1');
    expect(closed).toBe(true);

    const sessions = server.getActiveSessions();
    expect(sessions).toHaveLength(0);
  });

  it('关闭不存在的会话应返回 false', () => {
    const closed = server.closeSession('nonexistent');
    expect(closed).toBe(false);
  });

  it('处理失败时应返回错误信息', async () => {
    const errorDeps: ACPDeps = {
      ...mockDeps,
      processInput: async () => {
        throw new Error('处理失败');
      },
    };

    const errorServer = new ACPServer(errorDeps);
    const response = await errorServer.handleChat({
      message: 'test',
      sessionId: 'error-session',
    });

    expect(response.content).toContain('处理失败');
  });
});

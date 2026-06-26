/**
 * SessionStore 单元测试
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { SessionStore } from '../../../src/persistence/SessionStore';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('SessionStore', () => {
  let store: SessionStore;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `session-test-${Date.now()}.db`);
    store = new SessionStore(tmpFile);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
    try {
      fs.rmSync(tmpFile + '-wal');
    } catch {}
    try {
      fs.rmSync(tmpFile + '-shm');
    } catch {}
  });

  const SID = 'test-session-1';

  describe('会话 CRUD', () => {
    it('应创建和读取会话', () => {
      store.createSession({
        id: SID,
        source: 'test',
        userId: 'u1',
        model: 'deepseek',
      });
      const session = store.getSession(SID);
      expect(session).toBeDefined();
      expect(session!.source).toBe('test');
      expect(session!.userId).toBe('u1');
      expect(session!.model).toBe('deepseek');
    });

    it('不存在的会话应返回 undefined', () => {
      const session = store.getSession('nonexistent');
      expect(session).toBeUndefined();
    });

    it('应列出最近会话', () => {
      store.createSession({ id: 's1', source: 'cli' });
      store.createSession({ id: 's2', source: 'telegram' });
      const sessions = store.getSessions(10);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });

    it('应按来源过滤会话', () => {
      store.createSession({ id: 's-cli', source: 'cli' });
      const sessions = store.getSessions(10, 'cli');
      expect(sessions.every((s) => s.source === 'cli')).toBe(true);
    });
  });

  describe('消息 CRUD', () => {
    beforeEach(() => {
      store.createSession({ id: SID, source: 'test' });
    });

    it('应添加和读取消息', () => {
      const msgId = store.appendMessage({
        sessionId: SID,
        role: 'user',
        content: '你好',
      });
      expect(msgId).toBeGreaterThan(0);

      const messages = store.getMessages(SID);
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('你好');
    });

    it('getConversation 不抛异常', () => {
      store.appendMessage({ sessionId: SID, role: 'user', content: 'hi' });
      const conv = store.getConversation(SID);
      expect(Array.isArray(conv)).toBe(true);
    });

    it('应支持工具消息', () => {
      store.appendMessage({
        sessionId: SID,
        role: 'assistant',
        toolCalls: JSON.stringify([{ name: 'web_search' }]),
      });
      const msgs = store.getMessages(SID);
      expect(msgs.length).toBe(1);
      expect(msgs[0].toolCalls).toContain('web_search');
    });
  });

  describe('搜索', () => {
    beforeEach(() => {
      store.createSession({ id: SID, source: 'cli', model: 'deepseek' });
      store.appendMessage({
        sessionId: SID,
        role: 'user',
        content: '如何部署 Docker 容器',
      });
    });

    it('搜索不应抛异常', () => {
      const results = store.searchMessages('Docker');
      expect(Array.isArray(results)).toBe(true);
    });

    it('无匹配应返回空', () => {
      const results = store.searchMessages('xyznonexistent');
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('维护', () => {
    it('应删除会话', () => {
      store.createSession({ id: SID, source: 'test' });
      store.deleteSession(SID);
      expect(store.getSession(SID)).toBeUndefined();
    });

    it('应返回统计', () => {
      store.createSession({ id: 's1', source: 'test' });
      store.appendMessage({ sessionId: 's1', role: 'user', content: 'a' });
      const stats = store.getStats();
      expect(stats.sessions).toBeGreaterThanOrEqual(1);
      expect(stats.messages).toBeGreaterThanOrEqual(1);
    });
  });
});

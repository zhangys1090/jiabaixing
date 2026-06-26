/**
 * GatewaySessionStore 单元测试
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { GatewaySessionStore } from '../../../src/integration/GatewaySessionStore';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('GatewaySessionStore', () => {
  let store: GatewaySessionStore;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `gw-sessions-test-${Date.now()}.db`);
    store = new GatewaySessionStore(tmpFile);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  describe('平台会话', () => {
    it('应存储和读取平台会话', () => {
      store.savePlatformSession(
        'telegram',
        JSON.stringify({ token: '123:abc' })
      );
      const loaded = store.getPlatformSession('telegram');
      expect(loaded).toBeDefined();
      expect(loaded!.platform).toBe('telegram');
      expect(JSON.parse(loaded!.configJson)).toEqual({ token: '123:abc' });
    });

    it('不存在的平台应返回 undefined', () => {
      const loaded = store.getPlatformSession('nonexistent');
      expect(loaded).toBeUndefined();
    });

    it('应列出所有已保存的平台', () => {
      store.savePlatformSession('telegram', '{}');
      store.savePlatformSession('discord', '{}');
      const all = store.getAllPlatformSessions();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('应删除平台会话', () => {
      store.savePlatformSession('slack', '{}');
      store.deletePlatformSession('slack');
      expect(store.getPlatformSession('slack')).toBeUndefined();
    });
  });

  describe('聊天会话', () => {
    it('应存储和读取聊天会话', () => {
      store.saveChatSession(
        'chat-1',
        'telegram',
        JSON.stringify({ history: ['hi'] })
      );
      const loaded = store.getChatSession('chat-1', 'telegram');
      expect(loaded).toBeDefined();
      expect(loaded!.chatId).toBe('chat-1');
    });

    it('应更新 lastActive', () => {
      store.saveChatSession('chat-2', 'discord', '{}');
      const before = store.getChatSession('chat-2', 'discord')!;
      const t1 = before.lastActive;
      store.touchChatSession('chat-2', 'discord');
      const after = store.getChatSession('chat-2', 'discord')!;
      expect(after.lastActive).toBeGreaterThanOrEqual(t1);
    });

    it('应删除聊天会话', () => {
      store.saveChatSession('chat-3', 'qq', 'data');
      store.deleteChatSession('chat-3', 'qq');
      expect(store.getChatSession('chat-3', 'qq')).toBeUndefined();
    });
  });

  describe('用户白名单', () => {
    it('应添加和查询白名单用户', () => {
      store.addAllowedUser('telegram', 'user123', 'admin');
      const check = store.isUserAllowed('telegram', 'user123');
      expect(check.allowed).toBe(true);
      expect(check.role).toBe('admin');
    });

    it('未授权的用户应返回 false', () => {
      const check = store.isUserAllowed('telegram', 'unknown');
      expect(check.allowed).toBe(false);
    });

    it('应移除白名单用户', () => {
      store.addAllowedUser('discord', 'user456');
      expect(store.isUserAllowed('discord', 'user456').allowed).toBe(true);
      store.removeAllowedUser('discord', 'user456');
      expect(store.isUserAllowed('discord', 'user456').allowed).toBe(false);
    });

    it('应获取平台的所有白名单用户', () => {
      store.addAllowedUser('telegram', 'u1', 'admin');
      store.addAllowedUser('telegram', 'u2', 'user');
      const users = store.getAllowedUsers('telegram');
      expect(users.length).toBe(2);
    });

    it('应获取所有平台的所有用户', () => {
      store.addAllowedUser('telegram', 't1');
      store.addAllowedUser('discord', 'd1');
      const all = store.getAllAllowedUsers();
      expect(all.length).toBe(2);
    });
  });

  describe('统计', () => {
    it('应返回正确统计', () => {
      store.savePlatformSession('t', '{}');
      store.saveChatSession('c', 't', '{}');
      store.addAllowedUser('t', 'u1');
      const stats = store.getStats();
      expect(stats.platformSessions).toBe(1);
      expect(stats.chatSessions).toBe(1);
      expect(stats.allowedUsers).toBe(1);
    });
  });

  describe('Token 锁', () => {
    it('应获取和检查锁', () => {
      const ok = store.acquireTokenLock('hash123', 'telegram', 'instance-1');
      expect(ok).toBe(true);
      expect(store.isTokenLocked('hash123')).toBe(true);
    });

    it('重复获取同一锁应失败', () => {
      store.acquireTokenLock('hash456', 'discord', 'instance-1');
      const ok = store.acquireTokenLock('hash456', 'discord', 'instance-2');
      expect(ok).toBe(false);
    });

    it('应释放锁', () => {
      store.acquireTokenLock('hash789', 'slack', 'instance-1');
      const released = store.releaseTokenLock('hash789', 'instance-1');
      expect(released).toBe(true);
      expect(store.isTokenLocked('hash789')).toBe(false);
    });

    it('释放应验证所有者', () => {
      store.acquireTokenLock('hash999', 'telegram', 'instance-1');
      const released = store.releaseTokenLock('hash999', 'wrong-owner');
      expect(released).toBe(false);
      expect(store.isTokenLocked('hash999')).toBe(true);
    });

    it('应释放所有者的所有锁', () => {
      store.acquireTokenLock('a', 'telegram', 'owner1');
      store.acquireTokenLock('b', 'discord', 'owner1');
      store.acquireTokenLock('c', 'slack', 'owner2');
      expect(store.releaseAllLocksByOwner('owner1')).toBe(2);
      expect(store.isTokenLocked('a')).toBe(false);
      expect(store.isTokenLocked('b')).toBe(false);
      expect(store.isTokenLocked('c')).toBe(true);
    });
  });
});

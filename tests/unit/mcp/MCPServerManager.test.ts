/**
 * MCPServerManager 单元测试
 * 测试 MCP 服务器管理器的配置持久化、健康检查、prompts/resources 协议支持
 */

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('child_process', () => ({
  spawn: jest.fn().mockReturnValue({
    pid: 12345,
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    stdin: { write: jest.fn() },
    kill: jest.fn(),
    on: jest.fn(),
  }),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('[]'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  watch: jest.fn().mockReturnValue({ close: jest.fn() }),
}));

import { MCPServerManager } from '../../../src/mcp/MCPServerManager';

describe('MCPServerManager', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    const fs = require('fs');
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('[]');
    fs.writeFileSync.mockClear();
    fs.mkdirSync.mockClear();
    MCPServerManager.resetInstance();
    manager = MCPServerManager.getInstance();
  });

  afterEach(() => {
    MCPServerManager.resetInstance();
  });

  describe('初始化', () => {
    it('应该正确初始化单例', () => {
      expect(manager).toBeInstanceOf(MCPServerManager);
    });

    it('getInstance 应返回同一实例', () => {
      const instance1 = MCPServerManager.getInstance();
      const instance2 = MCPServerManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('resetInstance 后应创建新实例', () => {
      const instance1 = MCPServerManager.getInstance();
      MCPServerManager.resetInstance();
      const instance2 = MCPServerManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('默认服务器', () => {
    it('应注册4个默认服务器', () => {
      expect(manager.getServerCount()).toBeGreaterThanOrEqual(4);
    });

    it('filesystem 服务器应存在', () => {
      const status = manager.getServerStatus('filesystem');
      expect(status.config).toBeDefined();
      expect(status.config?.name).toBe('filesystem');
    });

    it('browser 服务器应存在', () => {
      const status = manager.getServerStatus('browser');
      expect(status.config).toBeDefined();
    });
  });

  describe('服务器注册', () => {
    it('应能注册新服务器', () => {
      manager.registerServer({
        name: 'test-server',
        command: 'node',
        args: ['test.js'],
        description: '测试服务器',
      });

      const status = manager.getServerStatus('test-server');
      expect(status.config).toBeDefined();
      expect(status.config?.name).toBe('test-server');
    });

    it('注册后应保存配置', () => {
      const fs = require('fs');
      manager.registerServer({
        name: 'test-server',
        command: 'node',
        args: ['test.js'],
      });

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('应能注销服务器', () => {
      manager.registerServer({
        name: 'to-remove',
        command: 'node',
        args: ['test.js'],
      });

      manager.unregisterServer('to-remove');
      const status = manager.getServerStatus('to-remove');
      expect(status.config).toBeUndefined();
    });
  });

  describe('服务器状态', () => {
    it('未启动的服务器 running 应为 false', () => {
      const status = manager.getServerStatus('filesystem');
      expect(status.running).toBe(false);
      expect(status.initialized).toBe(false);
    });

    it('getAllServerStatus 应返回所有服务器状态', () => {
      const allStatus = manager.getAllServerStatus();
      expect(Object.keys(allStatus).length).toBeGreaterThanOrEqual(4);
    });

    it('getRunningServers 应返回空数组', () => {
      const running = manager.getRunningServers();
      expect(running).toEqual([]);
    });
  });

  describe('健康检查', () => {
    it('getServerHealth 未启动时 healthy 应为 false', () => {
      const health = manager.getServerHealth('filesystem');
      expect(health.healthy).toBe(false);
      expect(health.running).toBe(false);
      expect(health.restartCount).toBe(0);
    });

    it('getAllServerHealth 应返回所有服务器健康状态', () => {
      const allHealth = manager.getAllServerHealth();
      expect(Object.keys(allHealth).length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('配置持久化', () => {
    it('loadConfig 应从文件加载配置', () => {
      const fs = require('fs');
      fs.existsSync.mockReturnValueOnce(true);
      fs.readFileSync.mockReturnValueOnce(
        JSON.stringify([
          {
            name: 'custom-server',
            command: 'node',
            args: ['custom.js'],
            enabled: true,
          },
        ])
      );

      MCPServerManager.resetInstance();
      const newManager = MCPServerManager.getInstance();
      const status = newManager.getServerStatus('custom-server');
      expect(status.config).toBeDefined();
    });

    it('reloadConfig 应触发 configReloaded 事件', () => {
      const listener = jest.fn();
      manager.on('configReloaded', listener);
      manager.reloadConfig();
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('工具过滤', () => {
    const mockTools = [
      { name: 'read_file', description: '读取文件' },
      { name: 'write_file', description: '写入文件' },
      { name: 'delete_file', description: '删除文件' },
      { name: 'list_dir', description: '列出目录' },
    ];

    it('不启用过滤时返回全部工具', () => {
      const result = manager.filterTools('filesystem', mockTools);
      expect(result).toHaveLength(4);
    });

    it('黑名单应过滤指定工具', () => {
      manager.registerServer({
        name: 'test-filter',
        command: 'node',
        args: ['test.js'],
        toolFiltering: true,
        deniedTools: ['delete_file'],
      });

      const result = manager.filterTools('test-filter', mockTools);
      expect(result).toHaveLength(3);
      expect(
        result.find((t) => (t as any).name === 'delete_file')
      ).toBeUndefined();
    });

    it('白名单应只保留指定工具', () => {
      manager.registerServer({
        name: 'test-allow',
        command: 'node',
        args: ['test.js'],
        toolFiltering: true,
        allowedTools: ['read_file', 'write_file'],
      });

      const result = manager.filterTools('test-allow', mockTools);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: 'read_file' });
      expect(result[1]).toMatchObject({ name: 'write_file' });
    });

    it('黑名单优先级高于白名单', () => {
      manager.registerServer({
        name: 'test-both',
        command: 'node',
        args: ['test.js'],
        toolFiltering: true,
        allowedTools: ['read_file', 'write_file', 'delete_file'],
        deniedTools: ['delete_file'],
      });

      const result = manager.filterTools('test-both', mockTools);
      expect(result).toHaveLength(2);
      expect(
        result.find((t) => (t as any).name === 'delete_file')
      ).toBeUndefined();
    });

    it('callTool 应拒绝黑名单工具', async () => {
      manager.registerServer({
        name: 'test-call',
        command: 'node',
        args: ['test.js'],
        toolFiltering: true,
        deniedTools: ['dangerous_tool'],
      });

      await expect(
        manager.callTool('test-call', 'dangerous_tool', {})
      ).rejects.toThrow(/禁用/);
    });

    it('callTool 应拒绝非白名单工具', async () => {
      manager.registerServer({
        name: 'test-call-allow',
        command: 'node',
        args: ['test.js'],
        toolFiltering: true,
        allowedTools: ['safe_tool'],
      });

      await expect(
        manager.callTool('test-call-allow', 'unsafe_tool', {})
      ).rejects.toThrow(/不在.*允许列表/);
    });

    it('toolFiltering 默认应为 false', () => {
      manager.registerServer({
        name: 'no-filter',
        command: 'node',
        args: ['test.js'],
      });

      // 直接调用 filterTools 应返回全部工具
      const result = manager.filterTools('no-filter', mockTools);
      expect(result).toHaveLength(4);
    });
  });
});

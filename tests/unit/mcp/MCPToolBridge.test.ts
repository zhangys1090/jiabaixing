/**
 * MCPToolBridge 单元测试
 * 测试 MCP 工具桥接的动态注册和同步功能
 */

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../src/mcp/MCPServerManager', () => ({
  MCPServerManager: {
    getInstance: jest.fn().mockReturnValue({
      getRunningServers: jest.fn().mockReturnValue(['test-server']),
      listTools: jest.fn().mockResolvedValue([
        {
          name: 'read_file',
          description: '读取文件内容',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: '写入文件',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
              content: { type: 'string', description: '文件内容' },
            },
            required: ['path', 'content'],
          },
        },
      ]),
      callTool: jest.fn().mockResolvedValue({ content: 'test result' }),
    }),
  },
}));

import { MCPToolBridge } from '../../../src/harness/tools/registry/MCPToolBridge';
import { ToolRegistry } from '../../../src/harness/tools/registry/ToolRegistry';

describe('MCPToolBridge', () => {
  let bridge: MCPToolBridge;
  let registry: ToolRegistry;

  beforeEach(() => {
    // 重置单例
    (MCPToolBridge as any).instance = null;
    bridge = MCPToolBridge.getInstance();
    registry = new ToolRegistry();
  });

  describe('初始化', () => {
    it('应该正确初始化单例', () => {
      expect(bridge).toBeInstanceOf(MCPToolBridge);
    });

    it('getInstance 应返回同一实例', () => {
      const instance1 = MCPToolBridge.getInstance();
      const instance2 = MCPToolBridge.getInstance();
      expect(instance1).toBe(instance1);
    });
  });

  describe('syncToRegistry', () => {
    it('应将 MCP 工具同步到 ToolRegistry', async () => {
      const count = await bridge.syncToRegistry(registry);
      expect(count).toBe(2);
    });

    it('同步的工具名应有 mcp_ 前缀', async () => {
      await bridge.syncToRegistry(registry);
      const bridged = bridge.getBridgedTools();
      expect(bridged.has('mcp_test-server_read_file')).toBe(true);
      expect(bridged.has('mcp_test-server_write_file')).toBe(true);
    });

    it('重复同步不应增加重复工具', async () => {
      await bridge.syncToRegistry(registry);
      const count2 = await bridge.syncToRegistry(registry);
      expect(count2).toBe(0);
    });
  });

  describe('getBridgedTools', () => {
    it('未同步时应返回空 Map', () => {
      const bridged = bridge.getBridgedTools();
      expect(bridged.size).toBe(0);
    });

    it('同步后应返回桥接的工具映射', async () => {
      await bridge.syncToRegistry(registry);
      const bridged = bridge.getBridgedTools();
      expect(bridged.size).toBe(2);
    });
  });

  describe('autoSync', () => {
    it('startAutoSync 应启动定时同步', () => {
      bridge.startAutoSync(registry);
      bridge.stopAutoSync();
    });

    it('stopAutoSync 应停止定时同步', () => {
      bridge.startAutoSync(registry);
      bridge.stopAutoSync();
    });
  });
});

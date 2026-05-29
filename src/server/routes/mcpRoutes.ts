/**
 * MCP服务器路由 - 服务器管理 / 工具调用 / 工具列表
 */

import express from 'express';
import { MCPServerManager } from '../../mcp/MCPServerManager';
import { Logger } from '../../utils/Logger';

export function registerMCPRoutes(app: express.Application): void {
  const manager = MCPServerManager.getInstance();

  app.get('/api/mcp/servers', (_req, res) => {
    try {
      const status = manager.getAllServerStatus();
      res.json({ success: true, data: status });
    } catch (error) {
      Logger.error('获取MCP服务器状态失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/mcp/servers/:name', (req, res) => {
    try {
      const { name } = req.params;
      const status = manager.getServerStatus(name);
      res.json({ success: true, data: status });
    } catch (error) {
      Logger.error('获取MCP服务器状态失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/mcp/servers/:name/start', async (req, res) => {
    try {
      const { name } = req.params;
      const result = await manager.startServer(name);
      res.json({ success: result, data: { name, running: result } });
    } catch (error) {
      Logger.error('启动MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/mcp/servers/:name/stop', (req, res) => {
    try {
      const { name } = req.params;
      const result = manager.stopServer(name);
      res.json({ success: result, data: { name, stopped: result } });
    } catch (error) {
      Logger.error('停止MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/mcp/servers/start-all', async (_req, res) => {
    try {
      await manager.startAllServers();
      res.json({
        success: true,
        data: { runningCount: manager.getRunningServerCount() },
      });
    } catch (error) {
      Logger.error('启动所有MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/mcp/servers/:name/tools', async (req, res) => {
    try {
      const { name } = req.params;
      const tools = await manager.listTools(name);
      res.json({ success: true, data: { server: name, tools } });
    } catch (error) {
      Logger.error('获取MCP工具列表失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/mcp/servers/:name/call',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { name } = req.params;
        const { tool, args } = req.body as {
          tool?: string;
          args?: Record<string, unknown>;
        };

        if (!tool) {
          return res
            .status(400)
            .json({ success: false, error: '缺少 tool 参数' });
        }

        const result = await manager.callTool(name, tool, args || {});
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('MCP工具调用失败', error as Error, 'MCPRoutes');
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/mcp/servers/:name/message',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { name } = req.params;
        const message = req.body;

        if (!message || !message.method) {
          return res
            .status(400)
            .json({ success: false, error: '缺少 method 参数' });
        }

        const response = await manager.sendMessage(name, message);
        res.json({ success: true, data: response });
      } catch (error) {
        Logger.error('MCP消息发送失败', error as Error, 'MCPRoutes');
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post('/api/mcp/register', express.json({ limit: '1mb' }), (req, res) => {
    try {
      const config = req.body;
      if (!config || !config.name || !config.command) {
        return res.status(400).json({
          success: false,
          error: '缺少 name 或 command 参数',
        });
      }
      manager.registerServer(config);
      res.json({ success: true, data: { name: config.name } });
    } catch (error) {
      Logger.error('注册MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}

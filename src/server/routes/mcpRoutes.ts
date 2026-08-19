/**
 * MCP服务器路由 - 服务器管理 / 工具调用 / 工具列表
 *
 * 迁移说明：MCP 核心逻辑（进程生命周期 / 工具发现）已归属 Python
 * (agent.mcp.server_manager)。本路由仅作为 TS 薄网关，将所有请求代理到
 * Python FastAPI (:3112) 的 /v1/mcp/* 端点。AGENT_BACKEND=local 降级时
 * Python 不可用，统一返回 503。
 */

import express from 'express';
import { Logger } from '../../utils/Logger';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';

export function registerMCPRoutes(app: express.Application): void {
  app.get('/api/mcp/servers', async (_req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const data = await bridge.getMcpServersStatus();
      res.json({ success: true, data });
    } catch (error) {
      Logger.error('获取MCP服务器状态失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/mcp/servers/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const data = await bridge.getMcpServerStatus(name);
      res.json({ success: true, data });
    } catch (error) {
      Logger.error('获取MCP服务器状态失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/mcp/servers/:name/start', async (req, res) => {
    try {
      const { name } = req.params;
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.startMcpServer(name);
      res.json({ success: result, data: { name, running: result } });
    } catch (error) {
      Logger.error('启动MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/mcp/servers/:name/stop', async (req, res) => {
    try {
      const { name } = req.params;
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const result = await bridge.stopMcpServer(name);
      res.json({ success: result, data: { name, stopped: result } });
    } catch (error) {
      Logger.error('停止MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/mcp/servers/start-all', async (_req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const { running, total } = await bridge.startAllMcpServers();
      res.json({ success: true, data: { runningCount: running, total } });
    } catch (error) {
      Logger.error('启动所有MCP服务器失败', error as Error, 'MCPRoutes');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/mcp/servers/:name/tools', async (req, res) => {
    try {
      const { name } = req.params;
      const bridge = getActivePythonBridge();
      if (!bridge) {
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      }
      const tools = await bridge.listMcpTools(name);
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

        const bridge = getActivePythonBridge();
        if (!bridge) {
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        }

        const result = await bridge.callMcpTool(name, tool, args || {});
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('MCP工具调用失败', error as Error, 'MCPRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
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

        const bridge = getActivePythonBridge();
        if (!bridge) {
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        }

        const response = await bridge.sendMcpMessage(name, message);
        res.json({ success: true, data: response });
      } catch (error) {
        Logger.error('MCP消息发送失败', error as Error, 'MCPRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/mcp/register',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const config = req.body;
        if (!config || !config.name || !config.command) {
          return res.status(400).json({
            success: false,
            error: '缺少 name 或 command 参数',
          });
        }

        const bridge = getActivePythonBridge();
        if (!bridge) {
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        }

        await bridge.registerMcpServer(config);
        res.json({ success: true, data: { name: config.name } });
      } catch (error) {
        Logger.error('注册MCP服务器失败', error as Error, 'MCPRoutes');
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    }
  );
}

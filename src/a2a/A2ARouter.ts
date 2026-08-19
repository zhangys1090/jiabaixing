/**
 * A2A 协议 TS 薄壳 —— HTTP 入口路由转发（符合 AGENTS.md §0.1）。
 *
 * 将 `/a2a/*` 的 HTTP 请求透明代理转发到 Python FastAPI 的真实 A2A 端点
 * （`agent/a2a/server.create_a2a_router`，挂载前缀 `/a2a`）。
 *
 * 设计原则：
 * - 本文件**不实现任何 A2A 业务逻辑**，仅做透传。
 * - 鉴权、Task 生命周期、Agent Card 发现等全部由 Python 端处理。
 * - Python 后端不可用时统一返回 503，与 adminRoutes / mcpRoutes 行为一致。
 *
 * 转发目标：`${PYTHON_AGENT_URL}${req.originalUrl}`，
 * 其中 originalUrl 形如 `/a2a/tasks`，正好对齐 Python 端 `/a2a` 前缀。
 */

import express from 'express';
import { Logger } from '../utils/Logger';

function getPythonAgentUrl(): string {
  return process.env.PYTHON_AGENT_URL || 'http://localhost:3112';
}

/**
 * 将 `/a2a/*` 注册为到 Python A2A 后端的透明代理。
 *
 * @param app Express 应用实例（来自 main.ts）
 */
export function registerA2ARoutes(app: express.Application): void {
  const forward = async (req: express.Request, res: express.Response) => {
    const bridgePath = req.originalUrl; // 形如 /a2a/tasks 或 /a2a/.well-known/agent.json
    const target = `${getPythonAgentUrl()}${bridgePath}`;
    try {
      const headers: Record<string, string> = {};

      // 透传调用方鉴权头
      const auth = req.headers['authorization'];
      if (auth) headers['Authorization'] = auth as string;
      const apiKey = req.headers['x-api-key'];
      if (apiKey) headers['X-API-Key'] = apiKey as string;
      const a2aToken = req.headers['x-a2a-token'];
      if (a2aToken) headers['X-A2A-Token'] = a2aToken as string;

      // 透传 Content-Type（POST 体需要）
      const contentType = req.headers['content-type'];
      if (contentType) headers['Content-Type'] = contentType as string;

      const init: RequestInit = {
        method: req.method,
        headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        init.body =
          typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      const upstream = await fetch(target, init);
      const text = await upstream.text();
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try {
          res.json(JSON.parse(text));
          return;
        } catch {
          /* 解析失败则回退为原始文本 */
        }
      }
      res.send(text);
    } catch (error) {
      Logger.error('A2A 代理转发失败', error as Error, 'A2ARouter');
      res.status(503).json({
        success: false,
        error: 'Python A2A 后端未连接或代理失败',
        path: bridgePath,
      });
    }
  };

  // 仅解析 JSON 体；GET/HEAD 无体，json 中间件对其无副作用。
  app.use('/a2a', express.json({ limit: '2mb' }), forward);
}

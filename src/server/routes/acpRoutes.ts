/**
 * ACP (Agent Communication Protocol) 路由 - IDE 集成入口
 *
 * POST /api/ide/chat   - 编辑器聊天（VS Code / Zed / JetBrains）
 * GET  /api/ide/sessions - 活跃会话列表
 *
 * 支持动态后端切换:
 *   AGENT_BACKEND=python  → 使用 Python Agent 后端（默认）
 *   AGENT_BACKEND=local   → 使用 TS 本地 JiabaixingCore（回退）
 *
 * 架构：复用 bootstrap.ts 中的全局 PythonAgentBridge 实例，
 * 避免创建第二个 bridge 导致双重连接/双重回复。
 */

import express from 'express';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import {
  ACPAuthManager,
  ACPPermissionGuard,
  ACPServer,
  type ACPDeps,
} from '../../ide/ACPServer';
import { PythonAgentBridge } from '../../ide/PythonAgentBridge';
import {
  EventBus,
  type EventName,
  type JiabaixingEventBus,
} from '../../shared/EventBus';
import { Logger } from '../../utils/Logger';
import { getPythonBridge, isPythonBackend } from '../bootstrap';

let acpServer: ACPServer | null = null;
let eventBusBridgeInitialized: boolean = false;
let authManager: ACPAuthManager | null = null;
let permissionGuard: ACPPermissionGuard | null = null;

function getAuthManager(): ACPAuthManager {
  if (!authManager) {
    authManager = new ACPAuthManager();
    Logger.info('🔐 ACP 认证管理器已初始化', 'ACPRoutes');
  }
  return authManager;
}

function getPermissionGuard(): ACPPermissionGuard {
  if (!permissionGuard) {
    permissionGuard = new ACPPermissionGuard(getAuthManager());
  }
  return permissionGuard;
}

function isAuthEnabled(): boolean {
  return process.env.ACP_AUTH_ENABLED !== 'false';
}

function setupEventBusBridge(bridge: PythonAgentBridge): void {
  if (eventBusBridgeInitialized) return;
  eventBusBridgeInitialized = true;

  const forwardEvents = [
    'agent_execution_update',
    'perception_update',
    'brain_stage_update',
    'skill_execution_update',
    'evolution_event',
    'weight_update',
    'proactive_interaction',
    'clarification_request',
    'execution_preview',
    'file_modified',
    'file_rollback',
    'multi_file_modified',
    'tool_trace',
    'user_correction',
    'stream_start',
    'stream_chunk',
    'stream_done',
  ];

  for (const event of forwardEvents) {
    (EventBus as JiabaixingEventBus).on(
      event as EventName,
      (...args: unknown[]) => {
        const data = args.length === 1 ? args[0] : args;
        bridge.forwardTsEvent(event, data);
      }
    );
  }

  Logger.info(
    '🔌 EventBus TS→Python 单向桥接已建立（Python→TS 由 bootstrap.ts 管理）',
    'ACPRoutes'
  );
}

function getACPServer(core: JiabaixingCore): ACPServer {
  if (acpServer) return acpServer;

  const usePython = isPythonBackend();
  let deps: ACPDeps;

  if (usePython) {
    const bridge = getPythonBridge();
    if (bridge) {
      deps = bridge;
      setupEventBusBridge(bridge);
      Logger.info('🔌 ACPServer 复用全局 PythonAgentBridge 实例', 'ACPRoutes');
    } else {
      deps = {
        processInput: async (message, sessionId) => {
          const result = await core.processInput(message, sessionId);
          return { response: result.response, traceId: result.traceId };
        },
        getFileDiffs: () => [],
        getTerminalCommands: () => [],
        getToolActivities: () => [],
      };
      Logger.info(
        '🔌 ACPServer Python Bridge 不可用，降级到 TS 本地',
        'ACPRoutes'
      );
    }
  } else {
    deps = {
      processInput: async (message, sessionId) => {
        const result = await core.processInput(message, sessionId);
        return { response: result.response, traceId: result.traceId };
      },
      getFileDiffs: () => [],
      getTerminalCommands: () => [],
      getToolActivities: () => [],
    };
    Logger.info('🔌 ACPServer 使用本地 TS 后端', 'ACPRoutes');
  }

  acpServer = new ACPServer(deps);
  return acpServer;
}

export function registerACPRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.post(
    '/api/ide/chat',
    express.json({ limit: '10mb' }),
    async (req, res) => {
      try {
        if (!core) {
          res.status(503).json({ success: false, error: '核心未初始化' });
          return;
        }

        if (isAuthEnabled()) {
          const guard = getPermissionGuard();
          const authResult = guard.extractAuth(
            req.headers as Record<string, string | undefined>
          );
          if (!authResult.authenticated || !authResult.token) {
            res.status(401).json({
              success: false,
              error: authResult.error || 'Authentication required',
            });
            return;
          }
          const permCheck = guard.checkRequest(authResult.token);
          if (!permCheck.allowed) {
            res.status(403).json({
              success: false,
              error: permCheck.reason || 'Permission denied',
            });
            return;
          }
        }

        const { message, sessionId, contextFiles } = req.body as {
          message?: string;
          sessionId?: string;
          contextFiles?: string[];
        };

        if (!message) {
          res.status(400).json({ success: false, error: '缺少 message' });
          return;
        }

        const server = getACPServer(core);
        const response = await server.handleChat({
          message,
          sessionId: sessionId || `ide_${Date.now()}`,
          contextFiles,
        });

        res.json({ success: true, data: response });
      } catch (error) {
        Logger.error('ACP 聊天失败', error as Error, 'ACPRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.get('/api/ide/sessions', (_req, res) => {
    try {
      if (!core || !acpServer) {
        res.json({ success: true, sessions: [] });
        return;
      }
      res.json({ success: true, sessions: acpServer.getActiveSessions() });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/ide/auth/token', express.json(), (req, res) => {
    try {
      const { apiKey } = req.body as { apiKey?: string };
      if (!apiKey) {
        res.status(400).json({ success: false, error: 'Missing apiKey' });
        return;
      }
      const mgr = getAuthManager();
      const result = mgr.authenticate(apiKey);
      if (!result.authenticated) {
        res.status(401).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, token: result.token });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post('/api/ide/auth/revoke', express.json(), (req, res) => {
    try {
      const { tokenId } = req.body as { tokenId?: string };
      if (!tokenId) {
        res.status(400).json({ success: false, error: 'Missing tokenId' });
        return;
      }
      const mgr = getAuthManager();
      const revoked = mgr.revokeToken(tokenId);
      res.json({ success: revoked });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/ide/auth/stats', (_req, res) => {
    try {
      const mgr = getAuthManager();
      res.json({ success: true, stats: mgr.getStats() });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}

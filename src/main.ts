/**
 * jiabaixing 唯一入口 - 统一初始化流程
 *
 * 初始化顺序（严格按10步执行）：
 * 1. 日志
 * 2. 安全与加密
 * 3. 数据库 (SQLite, Chroma)
 * 4. 表情、语音、环境感知
 * 5. 工具注册与推荐引擎
 * 6. 模型初始化 (OpenAI 兼容接口)
 * 7. 核心推理引擎
 * 8. 交互引擎
 * 9. 学习循环 (热监视、自动优化)
 * 10. 场景感知调度器（启动核心任务执行循环）
 */

if (process.platform === 'win32') {
  process.stdout.setDefaultEncoding?.('utf8');
}

// Windows DNS 修复：Node.js 默认 IPv6 优先导致 DeepSeek API 连接超时
import cors from 'cors';
import dns from 'dns';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import path from 'path';
import * as WebSocket from 'ws';
dns.setDefaultResultOrder('ipv4first');

require('dotenv/config');

if (!process.env.CONSOLE_LOG_LEVEL) {
  process.env.CONSOLE_LOG_LEVEL = 'warn';
}

import { Logger } from './utils/Logger';

type WSServer = WebSocket.Server;

import { JiabaixingCore } from './core/JiabaixingCore';

import automationRoutes from './routes/automation';
import chatRoutes, { setChatCore } from './routes/chat';
import orchestrateRoutes, { setOrchestrateCore } from './routes/orchestrate';
import taskRoutes, { setHarnessInstance } from './routes/tasks';
import integrationRoutes from './server/routes/integrationRoutes';
import {
  setSystemStateCore,
  systemStateRoutes,
} from './server/routes/systemStateRoutes';

import { registerACPRoutes } from './server/routes/acpRoutes';
import { registerBatchRoutes } from './server/routes/batchRoutes';
import { registerContextManageRoutes } from './server/routes/contextManageRoutes';
import { registerCoreRoutes } from './server/routes/coreRoutes';
import conversationRoutes from './server/routes/conversationRoutes';
import approvalRoutes from './server/routes/approvalRoutes';
import { registerDebugRoutes } from './server/routes/debugRoutes';
import { registerDocsRoutes } from './server/routes/docsRoutes';
import { registerEvolutionRoutes } from './server/routes/evolutionRoutes';
import { registerMCPRoutes } from './server/routes/mcpRoutes';
import { registerMemoryRoutes } from './server/routes/memoryRoutes';
import { registerPerformanceRoutes } from './server/routes/performanceRoutes';
import { registerSecurityRoutes } from './server/routes/securityRoutes';
import { registerSkillRoutes } from './server/routes/skillRoutes';
import { registerToolRoutes } from './server/routes/toolRoutes';
import { registerTraeRoutes } from './server/routes/traeRoutes';
import { registerTrajectoryRoutes } from './server/routes/trajectoryRoutes';

import { bootstrap } from './server/bootstrap';
import { setupEventBus } from './server/eventBusSetup';
import { gracefulShutdown } from './server/shutdown';
import { setupWebSocket } from './server/websocket';

let PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3111;
let server: http.Server | null = null;
let wss: WSServer | null = null;
let core: JiabaixingCore | null = null;
const app = express();

function setupRoutes(broadcast: (data: Record<string, unknown>) => void): void {
  app.use(
    cors({
      origin:
        process.env.NODE_ENV === 'production'
          ? false
          : ['http://localhost:3100'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 文档路由（优先，提供llms.txt等）
  registerDocsRoutes(app, process.cwd());

  app.use('/api/integration', integrationRoutes);
  app.use('/api/automation', automationRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api', chatRoutes);
  app.use('/api', orchestrateRoutes);
  app.use(systemStateRoutes);

  registerCoreRoutes(app, core);
  registerPerformanceRoutes(app, core);
  registerSecurityRoutes(app, core);
  registerEvolutionRoutes(app, core);
  registerMemoryRoutes(app, core);
  registerSkillRoutes(app, core);
  registerTraeRoutes(app, core);
  registerMCPRoutes(app);
  registerContextManageRoutes(app, core);
  registerBatchRoutes(app, core);
  registerACPRoutes(app, core);
  registerTrajectoryRoutes(app, core);
  registerToolRoutes(app, core);
  registerDebugRoutes(app, core, broadcast);

  // 会话持久化 API（ConversationStore + FTS5 搜索）
  app.use('/api/conversations', conversationRoutes);

  // 审批 API（ApprovalEngine）
  app.use('/api/approvals', approvalRoutes);
}

async function setupStaticFiles(): Promise<void> {
  const frontendBuildPath = path.join(
    process.cwd(),
    'src',
    'frontend',
    'build'
  );
  const frontendExists = await fs.promises
    .access(frontendBuildPath)
    .then(() => true)
    .catch(() => false);
  if (frontendExists) {
    app.use(express.static(frontendBuildPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(frontendBuildPath, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({
        message: 'jiabaixing API 服务已就绪',
        model: process.env.LLM_MODEL || 'deepseek-chat',
        port: PORT,
        frontend: '未构建（可选功能）',
      });
    });
  }
}

async function startServer(): Promise<void> {
  core = await bootstrap();

  setSystemStateCore(
    core as unknown as import('./interfaces').JiabaixingCorePublicAPI
  );
  setChatCore(core);
  setOrchestrateCore(core);

  const harness = core.getHarness();
  if (harness) {
    setHarnessInstance(harness);
  }

  server = http.createServer(app);
  wss = new WebSocket.WebSocketServer({ server: server! });
  const broadcast = setupEventBus(wss, core);
  setupRoutes(broadcast);
  await setupStaticFiles();
  setupWebSocket(wss, core);
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', core, wss, server!));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', core, wss, server!));
}

function listenServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server!
      .listen(PORT, () => {
        const ipcPath =
          process.env.IPC_PATH ||
          (process.platform === 'win32'
            ? '\\\\.\\pipe\\jiabaixing'
            : '/tmp/jiabaixing.sock');
        console.log(
          '  ==========================================================='
        );
        console.log('  [READY] jiabaixing\n');
        console.log(`  API:       http://localhost:${PORT}`);
        console.log(`  WebSocket: ws://localhost:${PORT}`);
        console.log(`  IPC:       ${ipcPath}`);
        console.log(`  Model:     ${process.env.LLM_MODEL || 'deepseek-chat'}`);
        console.log(
          `  Auto Opt:  ${process.env.ENABLE_AUTO_OPTIMIZE !== 'false' ? 'ON' : 'OFF'}`
        );
        console.log(
          '\n  ===========================================================\n'
        );
        resolve();
      })
      .on('error', (err: { code: string }) => {
        reject(err);
      });
  });
}

async function startServerWithRetry(maxRetries = 3): Promise<void> {
  await startServer();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await listenServer();
      return;
    } catch (error) {
      const errCode = (error as { code?: string }).code;
      if (errCode === 'EADDRINUSE' && attempt < maxRetries) {
        Logger.warn(`端口 ${PORT} 被占用，尝试端口 ${PORT + 1}`, 'Main');
        PORT++;
        if (server) {
          server.close();
        }
        if (wss) {
          wss.close();
        }
        server = http.createServer(app);
        wss = new WebSocket.WebSocketServer({ server: server! });
        setupWebSocket(wss, core!);
        continue;
      }
      if (errCode === 'EADDRINUSE') {
        console.error(
          `\n  ❌ 端口 ${PORT} 已被占用（已尝试 ${maxRetries + 1} 个端口），请先关闭占用端口的进程：`
        );
        console.error(`     Windows: Get-NetTCPConnection -LocalPort ${PORT}`);
        console.error(`     然后执行 Stop-Process -Id <进程ID> -Force\n`);
      }
      throw error;
    }
  }
}

// ── ACP stdio 模式入口 ──
// 如果命令行参数包含 --acp-stdio，启动 ACP stdio 服务器而非 HTTP 服务
if (process.argv.includes('--acp-stdio')) {
  (async () => {
    const { startACPStdio } = await import('./ide/ACPStdioServer');
    const { JiabaixingCore } = await import('./core/JiabaixingCore');
    // JiabaixingCore 没有静态 create 方法，需要先实例化再初始化
    const core = new JiabaixingCore();
    if (typeof (core as any).initialize === 'function') {
      await (core as any).initialize();
    }

    startACPStdio({
      processInput: async (message, sessionId) => {
        const result = await core.processInput(message, sessionId);
        return { response: result.response, traceId: result.traceId };
      },
      getFileDiffs: () => [],
      getTerminalCommands: () => [],
      getToolActivities: () => [],
    });
  })().catch((err) => {
    Logger.error('ACP stdio 启动失败', err as Error, 'Main');
    process.exit(1);
  });
} else {
  startServerWithRetry().catch((error) => {
    Logger.error('启动失败', error as Error, 'Main');
    process.exit(1);
  });
}

process.on('uncaughtException', (error) => {
  if (
    error &&
    'code' in error &&
    (error as any).code === 'WS_ERR_INVALID_CLOSE_CODE'
  ) {
    Logger.warn(`WS帧解析错误（已忽略）: ${error.message}`, 'Main');
    return;
  }
  Logger.error('未捕获异常', error as Error, 'Main');
});

process.on('unhandledRejection', (reason) => {
  Logger.error(
    `未处理的Promise拒绝: ${reason}`,
    new Error(String(reason)),
    'Main'
  );
});

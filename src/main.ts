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

require('dotenv/config');

if (!process.env.CONSOLE_LOG_LEVEL) {
  process.env.CONSOLE_LOG_LEVEL = 'warn';
}
import cors from 'cors';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import path from 'path';
import * as WebSocket from 'ws';

import { Logger } from './utils/Logger';

type WSServer = WebSocket.Server;

import { JiabaixingCore } from './core/JiabaixingCore';

import automationRoutes from './routes/automation';
import taskRoutes, { setHarnessInstance } from './routes/tasks';
import chatRoutes, { setChatCore } from './routes/chat';
import orchestrateRoutes, { setOrchestrateCore } from './routes/orchestrate';
import integrationRoutes from './server/routes/integrationRoutes';
import {
  systemStateRoutes,
  setSystemStateCore,
} from './server/routes/systemStateRoutes';

import { registerCoreRoutes } from './server/routes/coreRoutes';
import { registerDebugRoutes } from './server/routes/debugRoutes';
import { registerEvolutionRoutes } from './server/routes/evolutionRoutes';
import { registerMemoryRoutes } from './server/routes/memoryRoutes';
import { registerPerformanceRoutes } from './server/routes/performanceRoutes';
import { registerSecurityRoutes } from './server/routes/securityRoutes';
import { registerSkillRoutes } from './server/routes/skillRoutes';
import { registerTraeRoutes } from './server/routes/traeRoutes';

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
  registerDebugRoutes(app, core, broadcast);
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
        console.log(
          '  ==========================================================='
        );
        console.log('  [READY] jiabaixing\n');
        console.log(`  API:       http://localhost:${PORT}`);
        console.log(`  WebSocket: ws://localhost:${PORT}`);
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

startServerWithRetry().catch((error) => {
  Logger.error('启动失败', error as Error, 'Main');
  process.exit(1);
});

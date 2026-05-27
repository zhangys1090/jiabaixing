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

// 设置控制台 UTF-8 编码（解决 Windows 中文乱码）
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

// 核心引擎
import { JiabaixingCore } from './core/JiabaixingCore';

// Phase 3/4 集成 API（前端 IntegrationPanel）
import automationRoutes from './routes/automation';
import taskRoutes, { setHarnessInstance } from './routes/tasks';
import integrationRoutes from './server/routes/integrationRoutes';
import { systemStateRoutes, setSystemStateCore } from './server/routes/systemStateRoutes';

// 路由模块
import { registerCoreRoutes } from './server/routes/coreRoutes';
import { registerDebugRoutes } from './server/routes/debugRoutes';
import { registerEvolutionRoutes } from './server/routes/evolutionRoutes';
import { registerMemoryRoutes } from './server/routes/memoryRoutes';
import { registerPerformanceRoutes } from './server/routes/performanceRoutes';
import { registerSecurityRoutes } from './server/routes/securityRoutes';
import { registerSkillRoutes } from './server/routes/skillRoutes';
import { registerTraeRoutes } from './server/routes/traeRoutes';

// 服务器模块
import { bootstrap } from './server/bootstrap';
import { setupEventBus } from './server/eventBusSetup';
import { gracefulShutdown } from './server/shutdown';
import { setupWebSocket } from './server/websocket';

// 全局变量
let PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3111;
let server: http.Server | null = null;
let wss: WSServer | null = null;
let core: JiabaixingCore | null = null;
const app = express();

// ===================== API 路由 =====================

function setupRoutes(broadcast: (data: Record<string, unknown>) => void): void {
  // CORS 配置：允许前端开发服务器跨域访问
  app.use(
    cors({
      origin:
        process.env.NODE_ENV === 'production'
          ? false // 生产环境禁用CORS（使用同源策略）
          : ['http://localhost:3100'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Phase 3/4 集成面板 REST API
  app.use('/api/integration', integrationRoutes);

  // 智能自动化 REST API
  app.use('/api/automation', automationRoutes);

  // Harness 任务管理 REST API
  app.use('/api/tasks', taskRoutes);

  // 系统状态 REST API（进化状态、系统资源等）
  app.use(systemStateRoutes);

  // 注册各模块路由
  registerCoreRoutes(app, core);
  registerPerformanceRoutes(app, core);
  registerSecurityRoutes(app, core);
  registerEvolutionRoutes(app, core);
  registerMemoryRoutes(app, core);
  registerSkillRoutes(app, core);
  registerTraeRoutes(app, core);
  registerDebugRoutes(app, core, broadcast);
}

// ===================== 静态文件服务 =====================

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
        model: process.env.MODEL_NAME || 'qwen2.5:3b',
        port: PORT,
        frontend: '未构建（可选功能）',
      });
    });
  }
}

// ===================== 启动流程 =====================

async function startServer(): Promise<void> {
  core = await bootstrap();

  setSystemStateCore(core as unknown as import('./interfaces').JiabaixingCorePublicAPI);

  const harness = core.getHarness();
  if (harness) {
    setHarnessInstance(harness);
  }

  const broadcast = setupEventBus(wss, core);
  setupRoutes(broadcast);
  await setupStaticFiles();

  server = http.createServer(app);

  wss = new WebSocket.WebSocketServer({ server: server! });

  setupWebSocket(wss, core);

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', core, wss, server!));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', core, wss, server!));
}

function listenServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server!.listen(PORT, () => {
      console.log(
        '  ==========================================================='
      );
      console.log('  [READY] jiabaixing\n');
      console.log(`  API:       http://localhost:${PORT}`);
      console.log(`  WebSocket: ws://localhost:${PORT}`);
      console.log(
        `  Model:     ${process.env.LLM_SERVER_MODEL || process.env.MODEL_NAME || 'qwen2.5:3b'}`
      );
      console.log(
        `  Auto Opt:  ${process.env.ENABLE_AUTO_OPTIMIZE !== 'false' ? 'ON' : 'OFF'}`
      );
      console.log(
        '\n  ===========================================================\n'
      );
      resolve();
    }).on('error', (err: { code: string }) => {
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
        server = http.createServer(app);
        wss = new WebSocket.WebSocketServer({ server: server! });
        setupWebSocket(wss, core!);
        continue;
      }
      if (errCode === 'EADDRINUSE') {
        console.error(`\n  ❌ 端口 ${PORT} 已被占用（已尝试 ${maxRetries + 1} 个端口），请先关闭占用端口的进程：`);
        console.error(`     Windows: netstat -ano | findstr :${PORT}`);
        console.error(`     然后执行 taskkill /PID <进程ID> /F\n`);
      }
      throw error;
    }
  }
}

startServerWithRetry().catch((error) => {
  Logger.error('启动失败', error as Error, 'Main');
  process.exit(1);
});

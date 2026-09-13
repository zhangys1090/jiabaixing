"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
if (process.platform === 'win32') {
    process.stdout.setDefaultEncoding?.('utf8');
}
// Windows DNS 修复：Node.js 默认 IPv6 优先导致 DeepSeek API 连接超时
const cors_1 = __importDefault(require("cors"));
const dns_1 = __importDefault(require("dns"));
const express_1 = __importDefault(require("express"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const path_1 = __importDefault(require("path"));
const WebSocket = __importStar(require("ws"));
dns_1.default.setDefaultResultOrder('ipv4first');
require('dotenv/config');
if (!process.env.CONSOLE_LOG_LEVEL) {
    process.env.CONSOLE_LOG_LEVEL = 'warn';
}
const Logger_1 = require("./utils/Logger");
const automation_1 = __importDefault(require("./routes/automation"));
const chat_1 = __importStar(require("./routes/chat"));
const orchestrate_1 = __importStar(require("./routes/orchestrate"));
const tasks_1 = __importStar(require("./routes/tasks"));
const integrationRoutes_1 = __importDefault(require("./server/routes/integrationRoutes"));
const systemStateRoutes_1 = require("./server/routes/systemStateRoutes");
const A2ARouter_1 = require("./a2a/A2ARouter");
const PerformanceMonitor_1 = require("./monitoring/PerformanceMonitor");
const acpRoutes_1 = require("./server/routes/acpRoutes");
const adminRoutes_1 = require("./server/routes/adminRoutes");
const approvalRoutes_1 = __importDefault(require("./server/routes/approvalRoutes"));
const batchRoutes_1 = require("./server/routes/batchRoutes");
const contextManageRoutes_1 = require("./server/routes/contextManageRoutes");
const conversationRoutes_1 = __importDefault(require("./server/routes/conversationRoutes"));
const coreRoutes_1 = require("./server/routes/coreRoutes");
const debugRoutes_1 = require("./server/routes/debugRoutes");
const docsRoutes_1 = require("./server/routes/docsRoutes");
const evolutionRoutes_1 = require("./server/routes/evolutionRoutes");
const mcpRoutes_1 = require("./server/routes/mcpRoutes");
const memoryRoutes_1 = require("./server/routes/memoryRoutes");
const openaiCompatibleRoutes_1 = require("./server/routes/openaiCompatibleRoutes");
const performanceRoutes_1 = require("./server/routes/performanceRoutes");
const planRoutes_1 = require("./server/routes/planRoutes");
const securityRoutes_1 = require("./server/routes/securityRoutes");
const sessionRoutes_1 = require("./server/routes/sessionRoutes");
const skillRoutes_1 = require("./server/routes/skillRoutes");
const toolRoutes_1 = require("./server/routes/toolRoutes");
const traeRoutes_1 = require("./server/routes/traeRoutes");
const trajectoryRoutes_1 = require("./server/routes/trajectoryRoutes");
const bootstrap_1 = require("./server/bootstrap");
const eventBusSetup_1 = require("./server/eventBusSetup");
const shutdown_1 = require("./server/shutdown");
const index_1 = require("./server/websocket/index");
let PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3111;
let server = null;
let wss = null;
let core = null;
const app = (0, express_1.default)();
function setupRoutes(broadcast) {
    app.use((0, cors_1.default)({
        // P1-1 修复: CORS origin 从环境变量读取，生产环境禁止 *
        origin: (() => {
            const envOrigin = process.env.CORS_ORIGIN;
            if (process.env.NODE_ENV === 'production') {
                if (!envOrigin || envOrigin === '*') {
                    Logger_1.Logger.warn('⚠️ 生产环境 CORS_ORIGIN 未配置或为 *，已禁用跨域0', 'Main');
                    return false;
                }
                return envOrigin.split(',').map((s) => s.trim());
            }
            return envOrigin
                ? envOrigin.split(',').map((s) => s.trim())
                : ['http://localhost:3100'];
        })(),
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }));
    app.use(express_1.default.json({ limit: '50mb' }));
    app.use(express_1.default.urlencoded({ extended: true }));
    // ═══════════════════════════════════════════════════════════
    // P1 #9: API 网关中间件 — 鉴权 + 限流 + 请求追踪
    // ═══════════════════════════════════════════════════════════
    // 请求追踪 + 可观测性
    app.use((req, _res, next) => {
        const start = Date.now();
        const traceId = req.headers['x-trace-id'] ||
            `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        req._traceId = traceId;
        req._startTime = start;
        next();
    });
    // 响应追踪 + 指标记录
    app.use((_req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            const path = _req.route?.path || _req.path;
            const success = res.statusCode < 400;
            (0, PerformanceMonitor_1.recordOTelRequest)(path, duration, success);
        });
        next();
    });
    // API Key 鉴权（生产环境启用）
    const API_KEY = process.env.API_KEY;
    if (API_KEY) {
        app.use('/api', (req, res, next) => {
            const authHeader = req.headers['authorization'];
            const apiKey = req.headers['x-api-key'];
            const queryKey = req.query.api_key;
            const providedKey = authHeader?.replace('Bearer ', '') || apiKey || queryKey;
            if (providedKey !== API_KEY) {
                res.status(401).json({
                    error: 'Unauthorized',
                    message: 'Invalid or missing API key',
                });
                return;
            }
            next();
        });
    }
    // 令牌桶限流
    const rateLimitMap = new Map();
    const RATE_LIMIT_WINDOW_MS = 60000;
    const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
    // P0-3 修复: 限流 Map 最大容量，防止 IP 爆破导致 OOM
    const RATE_LIMIT_MAX_ENTRIES = 10000;
    app.use('/api', (req, res, next) => {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let bucket = rateLimitMap.get(clientIp);
        if (!bucket) {
            // P0-3: 超过最大条目时淘汰最旧的条目（LRU），而非无限增长
            if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
                let oldestKey = null;
                let oldestTime = Infinity;
                for (const [ip, b] of rateLimitMap) {
                    if (b.lastRefill < oldestTime) {
                        oldestTime = b.lastRefill;
                        oldestKey = ip;
                    }
                }
                if (oldestKey !== null) {
                    rateLimitMap.delete(oldestKey);
                }
            }
            bucket = { tokens: RATE_LIMIT_MAX_REQUESTS, lastRefill: now };
            rateLimitMap.set(clientIp, bucket);
        }
        const elapsed = now - bucket.lastRefill;
        const refillTokens = Math.floor(elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_MAX_REQUESTS;
        if (refillTokens > 0) {
            bucket.tokens = Math.min(RATE_LIMIT_MAX_REQUESTS, bucket.tokens + refillTokens);
            bucket.lastRefill = now;
        }
        if (bucket.tokens <= 0) {
            res.status(429).json({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded, please try again later',
                retryAfter: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.lastRefill)) / 1000),
            });
            return;
        }
        bucket.tokens--;
        next();
    });
    // 定期清理过期限流桶
    setInterval(() => {
        const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
        for (const [ip, bucket] of rateLimitMap) {
            if (bucket.lastRefill < cutoff) {
                rateLimitMap.delete(ip);
            }
        }
    }, 60000);
    // 文档路由（优先，提供llms.txt等）
    (0, docsRoutes_1.registerDocsRoutes)(app, process.cwd());
    app.use('/api/integration', integrationRoutes_1.default);
    app.use('/api/automation', automation_1.default);
    app.use('/api/tasks', tasks_1.default);
    app.use('/api', chat_1.default);
    app.use('/api', orchestrate_1.default);
    app.use(systemStateRoutes_1.systemStateRoutes);
    (0, coreRoutes_1.registerCoreRoutes)(app, core);
    (0, openaiCompatibleRoutes_1.registerOpenAIRoutes)(app, core);
    (0, performanceRoutes_1.registerPerformanceRoutes)(app, core);
    (0, securityRoutes_1.registerSecurityRoutes)(app, core);
    (0, evolutionRoutes_1.registerEvolutionRoutes)(app, core);
    (0, memoryRoutes_1.registerMemoryRoutes)(app, core);
    (0, skillRoutes_1.registerSkillRoutes)(app, core);
    (0, traeRoutes_1.registerTraeRoutes)(app, core);
    (0, mcpRoutes_1.registerMCPRoutes)(app);
    (0, sessionRoutes_1.registerSessionRoutes)(app);
    (0, planRoutes_1.registerPlanRoutes)(app);
    (0, contextManageRoutes_1.registerContextManageRoutes)(app, core);
    (0, batchRoutes_1.registerBatchRoutes)(app, core);
    (0, acpRoutes_1.registerACPRoutes)(app, core);
    (0, trajectoryRoutes_1.registerTrajectoryRoutes)(app, core);
    (0, toolRoutes_1.registerToolRoutes)(app, core);
    (0, adminRoutes_1.registerAdminRoutes)(app);
    (0, A2ARouter_1.registerA2ARoutes)(app);
    (0, debugRoutes_1.registerDebugRoutes)(app, core, broadcast);
    // 会话持久化 API（ConversationStore + FTS5 搜索）
    app.use('/api/conversations', conversationRoutes_1.default);
    // 审批 API（ApprovalEngine）
    app.use('/api/approvals', approvalRoutes_1.default);
}
async function setupStaticFiles() {
    const frontendBuildPath = path_1.default.join(process.cwd(), 'src', 'frontend', 'build');
    const frontendExists = await fs.promises
        .access(frontendBuildPath)
        .then(() => true)
        .catch(() => false);
    if (frontendExists) {
        app.use(express_1.default.static(frontendBuildPath));
        app.get('*', (_req, res) => {
            res.sendFile(path_1.default.join(frontendBuildPath, 'index.html'));
        });
    }
    else {
        app.get('/', (_req, res) => {
            res.json({
                message: 'jiabaixing API 服务已就绪',
                model: process.env.LLM_MODEL || 'deepseek-v4-flash',
                port: PORT,
                frontend: '未构建（可选功能）',
            });
        });
    }
}
let shutdownRegistered = false;
function registerShutdownHandlers(core) {
    if (shutdownRegistered) {
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('SIGINT');
    }
    shutdownRegistered = true;
    process.on('SIGTERM', () => (0, shutdown_1.gracefulShutdown)('SIGTERM', core, wss, server));
    process.on('SIGINT', () => (0, shutdown_1.gracefulShutdown)('SIGINT', core, wss, server));
}
async function startServer() {
    core = await (0, bootstrap_1.bootstrap)();
    (0, systemStateRoutes_1.setSystemStateCore)(core);
    (0, chat_1.setChatCore)(core);
    (0, orchestrate_1.setOrchestrateCore)(core);
    const harness = core.getHarness();
    if (harness) {
        (0, tasks_1.setHarnessInstance)(harness);
    }
    server = http.createServer(app);
    wss = new WebSocket.WebSocketServer({ server: server });
    const broadcast = (0, eventBusSetup_1.setupEventBus)(wss, core);
    setupRoutes(broadcast);
    await setupStaticFiles();
    (0, index_1.setupWebSocket)(wss, core);
    registerShutdownHandlers(core);
}
function listenServer() {
    return new Promise((resolve, reject) => {
        server
            .listen(PORT, () => {
            const ipcPath = process.env.IPC_PATH ||
                (process.platform === 'win32'
                    ? '\\\\.\\pipe\\jiabaixing'
                    : '/tmp/jiabaixing.sock');
            console.log(`\n  [READY] jiabaixing v5.0 | API :${PORT} | WS :${PORT} | IPC ${ipcPath} | Model ${process.env.LLM_MODEL || 'deepseek-v4-flash'}\n`);
            resolve();
        })
            .on('error', (err) => {
            reject(err);
        });
    });
}
async function startServerWithRetry(maxRetries = 3) {
    await startServer();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await listenServer();
            return;
        }
        catch (error) {
            const errCode = error.code;
            if (errCode === 'EADDRINUSE' && attempt < maxRetries) {
                Logger_1.Logger.warn(`端口 ${PORT} 被占用，尝试端口 ${PORT + 1}`, 'Main');
                PORT++;
                if (server) {
                    server.close();
                }
                if (wss) {
                    wss.close();
                }
                server = http.createServer(app);
                wss = new WebSocket.WebSocketServer({ server: server });
                (0, index_1.setupWebSocket)(wss, core);
                registerShutdownHandlers(core);
                continue;
            }
            if (errCode === 'EADDRINUSE') {
                console.error(`\n  ❌ 端口 ${PORT} 已被占用（已尝试 ${maxRetries + 1} 个端口），请先关闭占用端口的进程：`);
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
        const { startACPStdio } = await Promise.resolve().then(() => __importStar(require('./ide/ACPStdioServer')));
        const { JiabaixingCore } = await Promise.resolve().then(() => __importStar(require('./core/JiabaixingCore')));
        // JiabaixingCore 没有静态 create 方法，需要先实例化再初始化
        const core = new JiabaixingCore();
        await core.initialize();
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
        Logger_1.Logger.error('ACP stdio 启动失败', err, 'Main');
        process.exit(1);
    });
}
else {
    startServerWithRetry().catch((error) => {
        Logger_1.Logger.error('启动失败', error, 'Main');
        process.exit(1);
    });
}
process.on('uncaughtException', (error) => {
    if (error &&
        'code' in error &&
        error.code === 'WS_ERR_INVALID_CLOSE_CODE') {
        Logger_1.Logger.warn(`WS帧解析错误（已忽略）: ${error.message}`, 'Main');
        return;
    }
    const errCode = error.code;
    if (errCode === 'ECONNRESET' ||
        errCode === 'EPIPE' ||
        errCode === 'ERR_STREAM_WRITE_AFTER_END' ||
        errCode === 'EADDRINUSE') {
        Logger_1.Logger.warn(`可恢复的I/O错误（已忽略）: ${errCode} ${error.message}`, 'Main');
        return;
    }
    Logger_1.Logger.error('未捕获异常，进程将退出', error, 'Main');
    process.exit(1);
});
process.on('unhandledRejection', (reason, _promise) => {
    Logger_1.Logger.error(`未处理的Promise拒绝: ${reason}`, new Error(String(reason)), 'Main');
    // P0-2 修复: 区分致命与可恢复的 Promise 拒绝。
    // - 网络类错误（ECONNRESET/ETIMEDOUT/ENOTFOUND 等）为瞬时故障，仅告警不退出，
    //   避免单次网络抖动杀死整个进程。
    // - 其他未捕获拒绝仍代表逻辑缺陷，进程退出（fail-fast）。
    const reasonStr = String(reason);
    const isTransientNetworkError = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EPIPE|socket hang up|fetch failed/i.test(reasonStr);
    if (isTransientNetworkError) {
        Logger_1.Logger.warn(`瞬态网络错误（不退出）: ${reasonStr}`, 'Main');
        return;
    }
    // 非瞬态错误：进程已处于不可预期的损坏状态，必须退出
    process.exit(1);
});

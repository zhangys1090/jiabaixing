"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPythonBridge = getPythonBridge;
exports.isPythonBackend = isPythonBackend;
exports.startIpcServer = startIpcServer;
exports.stopIpcServer = stopIpcServer;
exports.printBanner = printBanner;
exports.bootstrap = bootstrap;
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
const path = __importStar(require("path"));
const JiabaixingCore_1 = require("../core/JiabaixingCore");
const ScenarioAwareScheduler_1 = require("../core/ScenarioAwareScheduler");
const PythonAgentBridge_1 = require("../ide/PythonAgentBridge");
const bridgeRegistry_1 = require("../ide/bridgeRegistry");
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
const initEvolution_1 = require("./init/initEvolution");
const initGateway_1 = require("./init/initGateway");
const initHarness_1 = require("./init/initHarness");
const initInteraction_1 = require("./init/initInteraction");
const initMemory_1 = require("./init/initMemory");
const initSecurity_1 = require("./init/initSecurity");
/** Python Agent 桥接实例（AGENT_BACKEND=python 时启用） */
let pythonBridge = null;
/**
 * 后端决策锁定（P0-1 收口）：在启动期一次性决定「Python 主实现」还是「TS 本地兜底」，
 * 之后禁止运行时静默切换。所有 isPythonBackend() 调用（含 IPC / 路由层）均返回此锁定值，
 * 避免 pythonBridge 连接状态在会话中途变化导致「双脑行为漂移且无告警」。
 * - null：尚未锁定（极早期启动路径，isPythonBackend 回退到实时状态）。
 * - 'python' / 'ts'：已锁定，全程不可变。
 */
let _backendDecision = null;
/** 漂移告警只发一次，避免日志刷屏 */
let _driftWarned = false;
/** 获取 PythonAgentBridge 实例 */
function getPythonBridge() {
    return pythonBridge;
}
/** 检查是否使用 Python 后端
 * 直接反映启动期锁定的后端决策（P0-1 收口）：
 *   - 决策已锁定后返回锁定值，不再轮询 pythonBridge 实时状态，禁止运行时静默切换；
 *     若实时连接状态与锁定决策冲突，仅告警一次、行为不变。
 *   - 决策尚未锁定（极早期启动路径）时回退到 pythonBridge 实时状态，保证早期调用正确。
 * 这样 AGENT_BACKEND 未设置时也能在启动期正确识别为 Python 后端。 */
function isPythonBackend() {
    if (_backendDecision !== null) {
        const locked = _backendDecision === 'python';
        const live = pythonBridge !== null;
        if (live !== locked && !_driftWarned) {
            _driftWarned = true;
            Logger_1.Logger.warn(`后端连接状态与启动期锁定决策不一致（live=${live}, locked=${locked}）；` +
                `已锁定为「${locked ? 'Python 主实现' : 'TS 本地兜底'}」，运行时不做静默切换。` +
                `如需切换后端请重启进程或显式设置 AGENT_HARNESS_ENABLE。`, 'Bootstrap');
        }
        return locked;
    }
    return pythonBridge !== null;
}
/** 获取 Python Agent 后端 URL */
function getPythonAgentUrl() {
    return process.env.PYTHON_AGENT_URL || 'http://localhost:3112';
}
/** IPC 服务器实例引用，用于优雅关闭 */
let ipcServer = null;
/**
 * 获取 IPC 端点路径
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 可通过环境变量 IPC_PATH 覆盖默认路径
 * @returns IPC 端点路径
 */
function getIpcPath() {
    if (process.env.IPC_PATH) {
        return process.env.IPC_PATH;
    }
    const isWindows = process.platform === 'win32';
    return isWindows ? '\\\\.\\pipe\\jiabaixing' : '/tmp/jiabaixing.sock';
}
/**
 * 处理 IPC 请求，路由到对应方法
 * @param request - IPC 请求对象
 * @param core - JiabaixingCore 实例
 * @returns IPC 响应对象
 */
async function handleIpcRequest(request, core) {
    const { id, method, params } = request;
    try {
        let result;
        switch (method) {
            case 'ping': {
                result = { pong: true, timestamp: Date.now() };
                break;
            }
            case 'process': {
                const input = params?.input || '';
                if (!input) {
                    return { id, error: { code: -1, message: '缺少 input 参数' } };
                }
                if (isPythonBackend()) {
                    const bridgeResult = await pythonBridge.processInput(input);
                    result = bridgeResult.response;
                }
                else {
                    const processResult = await core.processInput(input);
                    result = processResult.response;
                }
                break;
            }
            case 'status': {
                if (isPythonBackend()) {
                    const llmStatus = await pythonBridge.getLlmStatus();
                    result = {
                        initialized: true,
                        uptime: process.uptime(),
                        llm: llmStatus,
                        backend: 'python',
                        pid: process.pid,
                    };
                }
                else {
                    const scheduler = core.getScenarioScheduler();
                    const memoryEngine = core.getMemoryEngine();
                    const llmHealth = await core.getLLMHealth();
                    result = {
                        initialized: true,
                        uptime: process.uptime(),
                        llm: llmHealth,
                        scheduler: scheduler ? { running: true } : { running: false },
                        memory: memoryEngine ? { available: true } : { available: false },
                        backend: 'typescript',
                        pid: process.pid,
                    };
                }
                break;
            }
            case 'skill.list': {
                if (isPythonBackend()) {
                    result = await pythonBridge.listSkills();
                }
                else {
                    const { SkillRegistry } = await Promise.resolve().then(() => __importStar(require('../skills/SkillRegistry')));
                    const registry = SkillRegistry.getInstance();
                    const skills = registry.getAllSkillMeta();
                    result = { skills, count: skills.length };
                }
                break;
            }
            case 'skill.execute': {
                const skillName = params?.name || '';
                const skillParams = params?.params || {};
                if (!skillName) {
                    return { id, error: { code: -1, message: '缺少 name 参数' } };
                }
                if (isPythonBackend()) {
                    result = await pythonBridge.executeSkill(skillName, skillParams);
                }
                else {
                    const { SkillRegistry: SR } = await Promise.resolve().then(() => __importStar(require('../skills/SkillRegistry')));
                    const reg = SR.getInstance();
                    const skillResult = await reg.executeSkill(skillName, skillParams);
                    result = skillResult;
                }
                break;
            }
            case 'schedule.list': {
                if (isPythonBackend()) {
                    result = await pythonBridge.listCronJobs();
                }
                else {
                    const scheduler = core.getScenarioScheduler();
                    if (!scheduler) {
                        result = { tasks: [], count: 0 };
                    }
                    else {
                        const tasks = scheduler.getTasks();
                        result = { tasks, count: tasks.length };
                    }
                }
                break;
            }
            case 'schedule.add': {
                if (isPythonBackend()) {
                    const name = params?.name || '';
                    const cronExpression = params?.cron || params?.schedule || '';
                    const description = params?.description || '';
                    if (!name || !cronExpression) {
                        return {
                            id,
                            error: { code: -1, message: '缺少 name 或 cron 参数' },
                        };
                    }
                    result = await pythonBridge.registerCronJob({
                        name,
                        schedule: cronExpression,
                        description,
                    });
                }
                else {
                    const scheduler = core.getScenarioScheduler();
                    if (!scheduler) {
                        return { id, error: { code: -1, message: '调度器未初始化' } };
                    }
                    const name = params?.name || '';
                    const cronExpression = params?.cron || params?.schedule || '';
                    const description = params?.description || '';
                    if (!name || !cronExpression) {
                        return {
                            id,
                            error: { code: -1, message: '缺少 name 或 cron 参数' },
                        };
                    }
                    const taskId = `ipc_${Date.now()}`;
                    scheduler.addTask({
                        id: taskId,
                        name,
                        schedule: cronExpression,
                        description,
                        enabled: true,
                        priority: params?.priority || 5,
                        executionCount: 0,
                        successCount: 0,
                        averageExecutionTime: 0,
                    });
                    result = { success: true, taskId };
                }
                break;
            }
            case 'memory.search': {
                const query = params?.query || '';
                if (!query) {
                    return { id, error: { code: -1, message: '缺少 query 参数' } };
                }
                if (isPythonBackend()) {
                    const limit = params?.limit || 10;
                    result = await pythonBridge.searchMemory(query, limit);
                }
                else {
                    const memEngine = core.getMemoryEngine();
                    if (!memEngine || !memEngine.retrieveRelevant) {
                        result = { memories: [], count: 0 };
                    }
                    else {
                        const limit = params?.limit || 10;
                        const memories = await memEngine.retrieveRelevant({
                            query,
                            limit,
                            includeBehaviorPatterns: true,
                        });
                        result = {
                            memories,
                            count: Array.isArray(memories) ? memories.length : 0,
                        };
                    }
                }
                break;
            }
            case 'evolution.status': {
                if (isPythonBackend()) {
                    result = await pythonBridge.getEvolutionStatus();
                }
                else {
                    const { EvolutionOrchestrator } = await Promise.resolve().then(() => __importStar(require('../evolution/EvolutionOrchestrator')));
                    const orchestrator = EvolutionOrchestrator.getInstance();
                    const metrics = orchestrator.getUnifiedMetrics();
                    result = metrics;
                }
                break;
            }
            case 'context.list': {
                const loadedFiles = core.getLoadedContextFiles();
                result = {
                    files: loadedFiles.map((f) => ({
                        fileName: f.fileName,
                        size: f.content.length,
                        loadedAt: f.loadedAt,
                    })),
                    count: loadedFiles.length,
                };
                break;
            }
            case 'context.refresh': {
                const count = await core.refreshProjectContext();
                result = {
                    count,
                    message: `上下文文件缓存已刷新，当前加载 ${count} 个文件。`,
                };
                break;
            }
            case 'context.create': {
                const { fileName = 'JIABAIXING.md' } = params;
                const allowedFiles = [
                    'JIABAIXING.md',
                    'CONTEXT.md',
                    '.jiabaixing/context.md',
                    'CLAUDE.md',
                ];
                if (!allowedFiles.includes(fileName)) {
                    return {
                        id,
                        error: {
                            code: -1,
                            message: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}`,
                        },
                    };
                }
                const projectRoot = process.cwd();
                const filePath = path.join(projectRoot, fileName);
                if (fs.existsSync(filePath)) {
                    return {
                        id,
                        error: {
                            code: -1,
                            message: `文件已存在: ${fileName}。如需更新请直接编辑文件后使用 refresh 操作刷新缓存。`,
                        },
                    };
                }
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                const template = `# 项目上下文

> 此文件由家百星自动创建，内容将自动注入到每次对话的上下文中。

## 项目概述

<!-- 描述项目的目标和用途 -->

## 技术栈

<!-- 列出项目使用的主要技术 -->

## 开发规范

<!-- 列出团队的开发规范和约定 -->

## 注意事项

<!-- 列出需要特别注意的事项 -->
`;
                fs.writeFileSync(filePath, template, 'utf-8');
                result = {
                    fileName,
                    message: `已创建上下文文件模板: ${fileName}。请编辑该文件添加项目信息，内容将在下次对话时自动加载。`,
                };
                break;
            }
            case 'context.read': {
                const { fileName } = params;
                if (!fileName) {
                    return { id, error: { code: -1, message: '缺少 fileName 参数' } };
                }
                const allowedFiles = [
                    'JIABAIXING.md',
                    'CONTEXT.md',
                    '.jiabaixing/context.md',
                    'CLAUDE.md',
                ];
                if (!allowedFiles.includes(fileName)) {
                    return {
                        id,
                        error: {
                            code: -1,
                            message: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}`,
                        },
                    };
                }
                const projectRoot = process.cwd();
                const filePath = path.join(projectRoot, fileName);
                if (!fs.existsSync(filePath)) {
                    return {
                        id,
                        error: { code: -1, message: `文件不存在: ${fileName}` },
                    };
                }
                const content = fs.readFileSync(filePath, 'utf-8');
                result = {
                    fileName,
                    content,
                    size: content.length,
                };
                break;
            }
            default:
                return { id, error: { code: -2, message: `未知方法: ${method}` } };
        }
        return { id, result };
    }
    catch (error) {
        Logger_1.Logger.error(`IPC 请求处理失败: ${method}`, error, 'IPC');
        return { id, error: { code: -3, message: error.message } };
    }
}
/**
 * 启动 IPC 服务器
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 通信协议为 JSON Lines（每行一个 JSON 对象）
 * @param core - JiabaixingCore 实例
 */
async function startIpcServer(core) {
    const pipePath = getIpcPath();
    const isWindows = process.platform === 'win32';
    // Linux/macOS: 清理旧 socket 文件
    if (!isWindows && fs.existsSync(pipePath)) {
        try {
            fs.unlinkSync(pipePath);
        }
        catch (err) {
            Logger_1.Logger.warn(`清理旧 socket 文件失败: ${pipePath}`, 'IPC');
        }
    }
    ipcServer = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString('utf8');
            const lines = buffer.split('\n');
            // 最后一个元素可能是不完整的行，保留在缓冲区
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                let request;
                try {
                    request = JSON.parse(trimmed);
                }
                catch (err) {
                    Logger_1.Logger.debug(`IPC JSON解析失败: ${err?.message}`, 'IPC');
                    const errorResponse = {
                        id: 0,
                        error: { code: -4, message: '无效的 JSON 格式' },
                    };
                    socket.write(JSON.stringify(errorResponse) + '\n');
                    continue;
                }
                if (typeof request.id !== 'number' ||
                    typeof request.method !== 'string') {
                    const errorResponse = {
                        id: request.id ?? 0,
                        error: { code: -4, message: '请求格式错误：缺少 id 或 method' },
                    };
                    socket.write(JSON.stringify(errorResponse) + '\n');
                    continue;
                }
                void handleIpcRequest(request, core).then((response) => {
                    if (!socket.destroyed) {
                        socket.write(JSON.stringify(response) + '\n');
                    }
                });
            }
        });
        socket.on('error', (err) => {
            Logger_1.Logger.warn(`IPC 客户端连接错误: ${err.message}`, 'IPC');
        });
        socket.on('close', () => {
            buffer = '';
        });
    });
    ipcServer.on('error', (err) => {
        Logger_1.Logger.error('IPC 服务器错误', err, 'IPC');
    });
    return new Promise((resolve) => {
        ipcServer.listen(pipePath, () => {
            Logger_1.Logger.info(`IPC 服务器已启动: ${pipePath}`, 'IPC');
            resolve();
        });
    });
}
/**
 * 关闭 IPC 服务器
 */
function stopIpcServer() {
    return new Promise((resolve) => {
        if (ipcServer) {
            ipcServer.close(() => {
                Logger_1.Logger.info('IPC 服务器已关闭', 'IPC');
                ipcServer = null;
                resolve();
            });
        }
        else {
            resolve();
        }
    });
}
function printBanner() {
    Logger_1.Logger.info('\n  ===========================================================\n  |                                                         |\n  |   jiabaixing v5.0                                       |\n  |                                                         |\n  ===========================================================\n', 'Bootstrap');
}
async function bootstrap() {
    Logger_1.Logger.info('🚀 jiabaixing v5.0 启动中...', 'Bootstrap');
    let core;
    try {
        process.stdout.write('  🧠 核心引擎... ');
        core = new JiabaixingCore_1.JiabaixingCore();
        Logger_1.Logger.info('✅ 核心引擎初始化完成', 'Bootstrap');
        process.stdout.write('  🔒 安全模块... ');
        const { sovereigntyPipeline } = await (0, initSecurity_1.initSecurity)();
        Logger_1.Logger.info('✅ 安全模块初始化完成', 'Bootstrap');
        process.stdout.write('  📡 可观测性... ');
        Logger_1.Logger.info('✅ 可观测性就绪（OTel 由 Python 后端管理，TS 仅透传 traceId）', 'Bootstrap');
        process.stdout.write('  💾 数据库... ');
        const { memoryEngine } = await (0, initMemory_1.initMemory)(core, sovereigntyPipeline);
        Logger_1.Logger.info('✅ 数据库初始化完成', 'Bootstrap');
        process.stdout.write('  🎭 交互模块... ');
        const { sceneRecognizer } = await (0, initInteraction_1.initInteraction)(core, memoryEngine);
        Logger_1.Logger.info('✅ 交互模块初始化完成', 'Bootstrap');
        process.stdout.write('  🔧 技能系统... ');
        Logger_1.Logger.info('✅ 技能系统就绪（内置）', 'Bootstrap');
        process.stdout.write('  🧠 推理引擎... ');
        Logger_1.Logger.info('✅ 推理引擎就绪', 'Bootstrap');
        process.stdout.write('  🧬 核心初始化... ');
        await core.initialize();
        Logger_1.Logger.info('✅ 核心初始化完成', 'Bootstrap');
        process.stdout.write('  📡 调度器... ');
        const scenarioScheduler = new ScenarioAwareScheduler_1.ScenarioAwareScheduler();
        scenarioScheduler.setMemoryEngine(memoryEngine);
        core.setScenarioScheduler(scenarioScheduler);
        scenarioScheduler.start();
        const { setSchedulerInstance } = await Promise.resolve().then(() => __importStar(require('../routes/automation')));
        setSchedulerInstance(scenarioScheduler);
        Logger_1.Logger.info('✅ 调度器启动完成', 'Bootstrap');
        process.stdout.write('  🧬 进化引擎... ');
        await (0, initEvolution_1.initEvolution)(core, memoryEngine);
        Logger_1.Logger.info('✅ 进化引擎初始化完成', 'Bootstrap');
        // ── 后端选型（纯环境变量解析，无副作用；需前置以便决定 TS Harness 是否构建）──
        // V5.0 默认启用 Python 后端（真后端）。
        // 仅当显式设置 AGENT_BACKEND=local（或 ts / ts-local）时，才回退到 TS 本地实现。
        const rawBackend = process.env.AGENT_BACKEND;
        const isLocalOverride = rawBackend === 'local' ||
            rawBackend === 'ts' ||
            rawBackend === 'ts-local';
        const usePythonBackend = !isLocalOverride; // 未设置 / python / 其他 → 默认 python
        // ── Python Agent 桥接 ──
        // 必须先于 MCP Host 与 Harness：前者要用 bridge 实例，后者要根据 bridge
        // 的**实际可用性**（而非配置意图）决定是否构建 TS 兜底实现。
        if (usePythonBackend) {
            process.stdout.write('  🐍 Python Agent 桥接... ');
            const pythonConfig = {
                baseUrl: getPythonAgentUrl(),
                timeout: 60000,
            };
            pythonBridge = new PythonAgentBridge_1.PythonAgentBridge(pythonConfig);
            (0, bridgeRegistry_1.setActivePythonBridge)(pythonBridge);
            const pyHealthy = await pythonBridge.healthCheck();
            if (pyHealthy) {
                pythonBridge.setTsEventBusForward((event, payload) => {
                    try {
                        void EventBus_1.EventBus.emit(event, payload);
                    }
                    catch (err) {
                        Logger_1.Logger.debug(`EventBus emit失败: ${err?.message}`, 'IPC');
                    }
                });
                pythonBridge.connectEvents();
                pythonBridge.connectChatWs();
                core.setPythonBridgeResolver(() => pythonBridge);
                Logger_1.Logger.info('✅ Python Agent 桥接成功', 'Bootstrap');
                Logger_1.Logger.info(`Python Agent 桥接已启用: ${getPythonAgentUrl()}`, 'Bootstrap');
            }
            else {
                Logger_1.Logger.warn('⚠️ Python Agent 不可用，降级到 TS 本地', 'Bootstrap');
                Logger_1.Logger.warn(`Python Agent 不可用: ${getPythonAgentUrl()}，降级到 TS 本地`, 'Bootstrap');
                pythonBridge = null;
                (0, bridgeRegistry_1.setActivePythonBridge)(null);
            }
        }
        else {
            process.stdout.write('  🐍 Python Agent 桥接... ');
            Logger_1.Logger.info('⏭️ 使用 TS 本地', 'Bootstrap');
        }
        // W5（审计 §1.8）：此处原先位于 Python 桥接**之前**，
        // getActivePythonBridge() 恒为 null → startAllMcpServers() 从未执行，
        // 却照常打印 ✅（接线断裂 + 假成功）。现移到桥接之后并如实上报。
        process.stdout.write('  🔌 MCP Host... ');
        const mcpBridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (mcpBridge) {
            try {
                await mcpBridge.startAllMcpServers();
                Logger_1.Logger.info('✅ MCP Host 启动成功', 'Bootstrap');
            }
            catch (err) {
                Logger_1.Logger.warn('⚠️ MCP Host 启动失败', 'Bootstrap');
                Logger_1.Logger.warn(`MCP Host 启动失败: ${err.message}`, 'Bootstrap');
            }
        }
        else {
            Logger_1.Logger.info('⏭️ 无 Python 桥接，MCP Host 未启动', 'Bootstrap');
        }
        // W2（审计 §1.8）：TS Harness 此前无条件构建。
        // Python 后端为主实现时，这一整套 TS Loop/Tools/Context/Verification 只会空转，
        // 既拖慢启动、占用内存，又制造"TS 侧也有一套 Agent 核心"的假象（违反 AGENTS.md §0.1）。
        // 判据用 pythonBridge 实际可用性：Python 配了但连不上时仍会构建 TS Harness 兜底。
        // 迁移期需要双端对拍时用 AGENT_HARNESS_ENABLE=1 强制开启。
        const harnessForced = process.env.AGENT_HARNESS_ENABLE === '1' ||
            process.env.AGENT_HARNESS_ENABLE === 'true';
        const pythonBackendLive = pythonBridge !== null;
        // P0-1 收口：后端决策在启动期一次性锁定，禁止运行时静默切换双脑。
        _backendDecision = pythonBackendLive ? 'python' : 'ts';
        Logger_1.Logger.info(`后端决策已锁定：${pythonBackendLive ? 'Python 主实现（AGENTS.md §0.1）' : 'TS 本地兜底'}`, 'Bootstrap');
        const enableTsHarness = !pythonBackendLive || harnessForced;
        process.stdout.write('  🏗️ Harness 框架... ');
        let harness = null;
        if (enableTsHarness) {
            ({ harness } = await (0, initHarness_1.initHarness)(core, memoryEngine, sceneRecognizer));
            if (pythonBackendLive) {
                Logger_1.Logger.info('✅ Harness 已构建 (AGENT_HARNESS_ENABLE 强制开启)', 'Bootstrap');
            }
            else {
                Logger_1.Logger.info('✅ Harness 已构建 (TS 本地兜底)', 'Bootstrap');
            }
        }
        else {
            Logger_1.Logger.info('⏭️ Python 后端为主实现；AGENT_HARNESS_ENABLE=1 可强制开启', 'Bootstrap');
            Logger_1.Logger.info('TS Harness 未构建：Agent 核心由 Python 后端承担（AGENTS.md §0.1）', 'Bootstrap');
        }
        process.stdout.write('  📡 网关隔离... ');
        await (0, initGateway_1.initGateway)(core, harness);
        Logger_1.Logger.info('✅ 网关隔离启动完成', 'Bootstrap');
        process.stdout.write('  🔗 IPC 服务器... ');
        await startIpcServer(core);
        Logger_1.Logger.info('✅ IPC 服务器启动完成', 'Bootstrap');
        Logger_1.Logger.info('✅ 系统就绪', 'Bootstrap');
        Logger_1.Logger.info('系统初始化完成', 'Bootstrap');
        return core;
    }
    catch (error) {
        Logger_1.Logger.error('❌ 初始化失败', error, 'Bootstrap');
        process.exit(1);
    }
}

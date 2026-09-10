import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { JiabaixingCore } from '../core/JiabaixingCore';
import { ScenarioAwareScheduler } from '../core/ScenarioAwareScheduler';
import { registerCognitionForwarder } from '../harness/cognition/cognitionForwarder';
import {
  PythonAgentBridge,
  type PythonAgentConfig,
} from '../ide/PythonAgentBridge';
import {
  getActivePythonBridge,
  setActivePythonBridge,
} from '../ide/bridgeRegistry';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { initEvolution } from './init/initEvolution';
import { initGateway } from './init/initGateway';
import { initHarness } from './init/initHarness';
import { initInteraction } from './init/initInteraction';
import { initMemory } from './init/initMemory';
import { initSecurity } from './init/initSecurity';

/** Python Agent 桥接实例（AGENT_BACKEND=python 时启用） */
let pythonBridge: PythonAgentBridge | null = null;

/**
 * 后端决策锁定（P0-1 收口）：在启动期一次性决定「Python 主实现」还是「TS 本地兜底」，
 * 之后禁止运行时静默切换。所有 isPythonBackend() 调用（含 IPC / 路由层）均返回此锁定值，
 * 避免 pythonBridge 连接状态在会话中途变化导致「双脑行为漂移且无告警」。
 * - null：尚未锁定（极早期启动路径，isPythonBackend 回退到实时状态）。
 * - 'python' / 'ts'：已锁定，全程不可变。
 */
let _backendDecision: 'python' | 'ts' | null = null;
/** 漂移告警只发一次，避免日志刷屏 */
let _driftWarned = false;

/** 获取 PythonAgentBridge 实例 */
export function getPythonBridge(): PythonAgentBridge | null {
  return pythonBridge;
}

/** 检查是否使用 Python 后端
 * 直接反映启动期锁定的后端决策（P0-1 收口）：
 *   - 决策已锁定后返回锁定值，不再轮询 pythonBridge 实时状态，禁止运行时静默切换；
 *     若实时连接状态与锁定决策冲突，仅告警一次、行为不变。
 *   - 决策尚未锁定（极早期启动路径）时回退到 pythonBridge 实时状态，保证早期调用正确。
 * 这样 AGENT_BACKEND 未设置时也能在启动期正确识别为 Python 后端。 */
export function isPythonBackend(): boolean {
  if (_backendDecision !== null) {
    const locked = _backendDecision === 'python';
    const live = pythonBridge !== null;
    if (live !== locked && !_driftWarned) {
      _driftWarned = true;
      Logger.warn(
        `后端连接状态与启动期锁定决策不一致（live=${live}, locked=${locked}）；` +
          `已锁定为「${locked ? 'Python 主实现' : 'TS 本地兜底'}」，运行时不做静默切换。` +
          `如需切换后端请重启进程或显式设置 AGENT_HARNESS_ENABLE。`,
        'Bootstrap'
      );
    }
    return locked;
  }
  return pythonBridge !== null;
}

/** 获取 Python Agent 后端 URL */
function getPythonAgentUrl(): string {
  return process.env.PYTHON_AGENT_URL || 'http://localhost:3112';
}

/** IPC 请求接口 */
interface IpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** IPC 成功响应接口 */
interface IpcSuccessResponse {
  id: number;
  result: unknown;
}

/** IPC 错误响应接口 */
interface IpcErrorResponse {
  id: number;
  error: { code: number; message: string };
}

/** IPC 响应类型 */
type IpcResponse = IpcSuccessResponse | IpcErrorResponse;

/** IPC 服务器实例引用，用于优雅关闭 */
let ipcServer: net.Server | null = null;

/**
 * 获取 IPC 端点路径
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 可通过环境变量 IPC_PATH 覆盖默认路径
 * @returns IPC 端点路径
 */
function getIpcPath(): string {
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
async function handleIpcRequest(
  request: IpcRequest,
  core: JiabaixingCore
): Promise<IpcResponse> {
  const { id, method, params } = request;

  try {
    let result: unknown;

    switch (method) {
      case 'ping': {
        result = { pong: true, timestamp: Date.now() };
        break;
      }
      case 'process': {
        const input = (params?.input as string) || '';
        if (!input) {
          return { id, error: { code: -1, message: '缺少 input 参数' } };
        }
        if (isPythonBackend()) {
          const bridgeResult = await pythonBridge!.processInput(input);
          result = bridgeResult.response;
        } else {
          const processResult = await core.processInput(input);
          result = processResult.response;
        }
        break;
      }
      case 'status': {
        if (isPythonBackend()) {
          const llmStatus = await pythonBridge!.getLlmStatus();
          result = {
            initialized: true,
            uptime: process.uptime(),
            llm: llmStatus,
            backend: 'python',
            pid: process.pid,
          };
        } else {
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
          result = await pythonBridge!.listSkills();
        } else {
          const { SkillRegistry } = await import('../skills/SkillRegistry');
          const registry = SkillRegistry.getInstance();
          const skills = registry.getAllSkillMeta();
          result = { skills, count: skills.length };
        }
        break;
      }
      case 'skill.execute': {
        const skillName = (params?.name as string) || '';
        const skillParams = (params?.params as Record<string, unknown>) || {};
        if (!skillName) {
          return { id, error: { code: -1, message: '缺少 name 参数' } };
        }
        if (isPythonBackend()) {
          result = await pythonBridge!.executeSkill(skillName, skillParams);
        } else {
          const { SkillRegistry: SR } = await import('../skills/SkillRegistry');
          const reg = SR.getInstance();
          const skillResult = await reg.executeSkill(skillName, skillParams);
          result = skillResult;
        }
        break;
      }
      case 'schedule.list': {
        if (isPythonBackend()) {
          result = await pythonBridge!.listCronJobs();
        } else {
          const scheduler = core.getScenarioScheduler();
          if (!scheduler) {
            result = { tasks: [], count: 0 };
          } else {
            const tasks = scheduler.getTasks();
            result = { tasks, count: tasks.length };
          }
        }
        break;
      }
      case 'schedule.add': {
        if (isPythonBackend()) {
          const name = (params?.name as string) || '';
          const cronExpression =
            (params?.cron as string) || (params?.schedule as string) || '';
          const description = (params?.description as string) || '';
          if (!name || !cronExpression) {
            return {
              id,
              error: { code: -1, message: '缺少 name 或 cron 参数' },
            };
          }
          result = await pythonBridge!.registerCronJob({
            name,
            schedule: cronExpression,
            description,
          });
        } else {
          const scheduler = core.getScenarioScheduler();
          if (!scheduler) {
            return { id, error: { code: -1, message: '调度器未初始化' } };
          }
          const name = (params?.name as string) || '';
          const cronExpression =
            (params?.cron as string) || (params?.schedule as string) || '';
          const description = (params?.description as string) || '';
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
            priority: (params?.priority as number) || 5,
            executionCount: 0,
            successCount: 0,
            averageExecutionTime: 0,
          });
          result = { success: true, taskId };
        }
        break;
      }
      case 'memory.search': {
        const query = (params?.query as string) || '';
        if (!query) {
          return { id, error: { code: -1, message: '缺少 query 参数' } };
        }
        if (isPythonBackend()) {
          const limit = (params?.limit as number) || 10;
          result = await pythonBridge!.searchMemory(query, limit);
        } else {
          const memEngine = core.getMemoryEngine();
          if (!memEngine || !memEngine.retrieveRelevant) {
            result = { memories: [], count: 0 };
          } else {
            const limit = (params?.limit as number) || 10;
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
          result = await pythonBridge!.getEvolutionStatus();
        } else {
          const { EvolutionOrchestrator } =
            await import('../evolution/EvolutionOrchestrator');
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
        const { fileName = 'JIABAIXING.md' } = params as { fileName?: string };
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
        const { fileName } = params as { fileName?: string };
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
  } catch (error) {
    Logger.error(`IPC 请求处理失败: ${method}`, error as Error, 'IPC');
    return { id, error: { code: -3, message: (error as Error).message } };
  }
}

/**
 * 启动 IPC 服务器
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 通信协议为 JSON Lines（每行一个 JSON 对象）
 * @param core - JiabaixingCore 实例
 */
export async function startIpcServer(core: JiabaixingCore): Promise<void> {
  const pipePath = getIpcPath();
  const isWindows = process.platform === 'win32';

  // Linux/macOS: 清理旧 socket 文件
  if (!isWindows && fs.existsSync(pipePath)) {
    try {
      fs.unlinkSync(pipePath);
    } catch {
      Logger.warn(`清理旧 socket 文件失败: ${pipePath}`, 'IPC');
    }
  }

  ipcServer = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      // 最后一个元素可能是不完整的行，保留在缓冲区
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let request: IpcRequest;
        try {
          request = JSON.parse(trimmed) as IpcRequest;
        } catch {
          const errorResponse: IpcErrorResponse = {
            id: 0,
            error: { code: -4, message: '无效的 JSON 格式' },
          };
          socket.write(JSON.stringify(errorResponse) + '\n');
          continue;
        }

        if (
          typeof request.id !== 'number' ||
          typeof request.method !== 'string'
        ) {
          const errorResponse: IpcErrorResponse = {
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

    socket.on('error', (err: Error) => {
      Logger.warn(`IPC 客户端连接错误: ${err.message}`, 'IPC');
    });

    socket.on('close', () => {
      buffer = '';
    });
  });

  return new Promise<void>((resolve) => {
    let settled = false;
    const server = ipcServer!;

    server.on('error', (err: Error) => {
      Logger.error(`IPC 服务器错误: ${err.message}`, err, 'IPC');
      if (!settled) {
        settled = true;
        try {
          server.close();
        } catch {
          /* ignore */
        }
        ipcServer = null;
        Logger.warn('IPC 服务器启动失败，跳过 IPC（不影响主服务）', 'IPC');
        resolve();
      }
    });

    server.listen(pipePath, () => {
      Logger.info(`IPC 服务器已启动: ${pipePath}`, 'IPC');
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

/**
 * 关闭 IPC 服务器
 */
export function stopIpcServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ipcServer) {
      ipcServer.close(() => {
        Logger.info('IPC 服务器已关闭', 'IPC');
        ipcServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export function printBanner(): void {
  Logger.info('jiabaixing v5.0', 'Bootstrap');
}

const BOOT_STEP_WIDTH = 18;
function bootStep(label: string): void {
  process.stdout.write(`  ${label}`.padEnd(BOOT_STEP_WIDTH) + '... ');
}
function bootOk(msg?: string): void {
  process.stdout.write('OK\n');
  if (msg) Logger.info(msg, 'Bootstrap');
}

async function healthCheckWithRetry(
  bridge: PythonAgentBridge,
  maxRetries = 10,
  intervalMs = 2000
): Promise<boolean> {
  for (let i = 0; i <= maxRetries; i++) {
    if (await bridge.healthCheck()) return true;
    if (i < maxRetries) {
      Logger.info(
        `Python Agent 未就绪，${intervalMs / 1000}s 后重试 (${i + 1}/${maxRetries})`,
        'Bootstrap'
      );
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

export async function bootstrap(): Promise<JiabaixingCore> {
  Logger.info('jiabaixing v5.0 启动', 'Bootstrap');

  let core: JiabaixingCore;

  try {
    bootStep('核心引擎');
    core = new JiabaixingCore();
    bootOk('核心引擎初始化完成');

    bootStep('安全模块');
    const { sovereigntyPipeline } = await initSecurity();
    bootOk('安全模块初始化完成');

    bootStep('可观测性');
    bootOk('可观测性就绪');

    bootStep('数据库');
    const { memoryEngine } = await initMemory(core, sovereigntyPipeline);
    bootOk('数据库初始化完成');

    bootStep('交互模块');
    const { sceneRecognizer } = await initInteraction(
      core,
      memoryEngine as import('../core/IMemoryEngine').IMemoryEngine
    );
    bootOk('交互模块初始化完成');

    bootStep('技能系统');
    bootOk('技能系统就绪');

    bootStep('推理引擎');
    bootOk('推理引擎就绪');

    bootStep('核心初始化');
    await core.initialize();
    bootOk('核心初始化完成');

    bootStep('调度器');
    const scenarioScheduler = new ScenarioAwareScheduler();
    scenarioScheduler.setMemoryEngine(memoryEngine);

    core.setScenarioScheduler(scenarioScheduler);

    scenarioScheduler.start();

    const { setSchedulerInstance } = await import('../routes/automation');
    setSchedulerInstance(scenarioScheduler);

    bootOk('调度器启动完成');

    bootStep('进化引擎');
    await initEvolution(core, memoryEngine);
    bootOk('进化引擎初始化完成');

    // ── 后端选型（纯环境变量解析，无副作用；需前置以便决定 TS Harness 是否构建）──
    // V5.0 默认启用 Python 后端（真后端）。
    // 仅当显式设置 AGENT_BACKEND=local（或 ts / ts-local）时，才回退到 TS 本地实现。
    const rawBackend = process.env.AGENT_BACKEND;
    const isLocalOverride =
      rawBackend === 'local' ||
      rawBackend === 'ts' ||
      rawBackend === 'ts-local';
    const usePythonBackend = !isLocalOverride; // 未设置 / python / 其他 → 默认 python

    // ── Python Agent 桥接 ──
    // 必须先于 MCP Host 与 Harness：前者要用 bridge 实例，后者要根据 bridge
    // 的**实际可用性**（而非配置意图）决定是否构建 TS 兜底实现。
    if (usePythonBackend) {
      bootStep('Python Agent');
      const pythonConfig: PythonAgentConfig = {
        baseUrl: getPythonAgentUrl(),
        timeout: 60000,
      };
      pythonBridge = new PythonAgentBridge(pythonConfig);
      setActivePythonBridge(pythonBridge);
      registerCognitionForwarder();
      const pyHealthy = await healthCheckWithRetry(pythonBridge);
      if (pyHealthy) {
        pythonBridge.setTsEventBusForward((event: string, payload: unknown) => {
          try {
            void (EventBus as any).emit(event, payload);
          } catch {
            // ignore emit errors
          }
        });
        pythonBridge.connectEvents();
        pythonBridge.connectChatWs();
        core.setPythonBridgeResolver(() => pythonBridge);
        bootOk(`Python Agent 桥接成功: ${getPythonAgentUrl()}`);
      } else {
        process.stdout.write('FALLBACK\n');
        Logger.warn(
          `Python Agent 不可用: ${getPythonAgentUrl()}，降级到 TS 本地`,
          'Bootstrap'
        );
        pythonBridge = null;
        setActivePythonBridge(null);
      }
    } else {
      bootStep('Python Agent');
      process.stdout.write('SKIP (TS本地)\n');
    }

    // W5（审计 §1.8）：此处原先位于 Python 桥接**之前**，
    // getActivePythonBridge() 恒为 null → startAllMcpServers() 从未执行，
    // 却照常打印 ✅（接线断裂 + 假成功）。现移到桥接之后并如实上报。
    bootStep('MCP Host');
    const mcpBridge = getActivePythonBridge();
    if (mcpBridge) {
      try {
        await mcpBridge.startAllMcpServers();
        bootOk('MCP Host 启动成功');
      } catch (err) {
        process.stdout.write('FAIL\n');
        Logger.warn(
          `MCP Host 启动失败: ${(err as Error).message}`,
          'Bootstrap'
        );
      }
    } else {
      process.stdout.write('SKIP\n');
    }

    // W2（审计 §1.8）：TS Harness 此前无条件构建。
    // Python 后端为主实现时，这一整套 TS Loop/Tools/Context/Verification 只会空转，
    // 既拖慢启动、占用内存，又制造"TS 侧也有一套 Agent 核心"的假象（违反 AGENTS.md §0.1）。
    // 判据用 pythonBridge 实际可用性：Python 配了但连不上时仍会构建 TS Harness 兜底。
    // 迁移期需要双端对拍时用 AGENT_HARNESS_ENABLE=1 强制开启。
    const harnessForced =
      process.env.AGENT_HARNESS_ENABLE === '1' ||
      process.env.AGENT_HARNESS_ENABLE === 'true';
    const pythonBackendLive = pythonBridge !== null;
    // P0-1 收口：后端决策在启动期一次性锁定，禁止运行时静默切换双脑。
    _backendDecision = pythonBackendLive ? 'python' : 'ts';
    Logger.info(
      `后端决策锁定: ${pythonBackendLive ? 'Python' : 'TS本地'}`,
      'Bootstrap'
    );
    const enableTsHarness = !pythonBackendLive || harnessForced;

    bootStep('Harness 框架');
    let harness: Awaited<ReturnType<typeof initHarness>>['harness'] = null;
    if (enableTsHarness) {
      ({ harness } = await initHarness(core, memoryEngine, sceneRecognizer));
      bootOk(
        pythonBackendLive
          ? 'Harness 已构建 (AGENT_HARNESS_ENABLE)'
          : 'Harness 已构建 (TS本地兜底)'
      );
    } else {
      process.stdout.write('SKIP (Python主实现)\n');
    }

    bootStep('网关隔离');
    await initGateway(core, harness);
    bootOk('网关隔离启动完成');

    bootStep('IPC 服务器');
    await startIpcServer(core);
    bootOk('IPC 服务器启动完成');

    Logger.info('系统就绪', 'Bootstrap');

    return core;
  } catch (error) {
    Logger.error('❌ 初始化失败', error as Error, 'Bootstrap');
    process.exit(1);
  }
}

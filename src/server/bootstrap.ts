import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { JiabaixingCore } from '../core/JiabaixingCore';
import { ScenarioAwareScheduler } from '../core/ScenarioAwareScheduler';
import { Logger } from '../utils/Logger';
import { initSecurity } from './init/initSecurity';
import { initMemory } from './init/initMemory';
import { initInteraction } from './init/initInteraction';
import { initEvolution } from './init/initEvolution';
import { initHarness } from './init/initHarness';
import { initGateway } from './init/initGateway';
import { MCPServerManager } from '../mcp/MCPServerManager';

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
        const processResult = await core.processInput(input);
        result = processResult.response;
        break;
      }
      case 'status': {
        const scheduler = core.getScenarioScheduler();
        const memoryEngine = core.getMemoryEngine();
        const llmHealth = await core.getLLMHealth();
        result = {
          initialized: true,
          uptime: process.uptime(),
          llm: llmHealth,
          scheduler: scheduler ? { running: true } : { running: false },
          memory: memoryEngine ? { available: true } : { available: false },
          pid: process.pid,
        };
        break;
      }
      case 'skill.list': {
        const { SkillRegistry } = await import('../skills/SkillRegistry');
        const registry = SkillRegistry.getInstance();
        const skills = registry.getAllSkillMeta();
        result = { skills, count: skills.length };
        break;
      }
      case 'skill.execute': {
        const skillName = (params?.name as string) || '';
        const skillParams = (params?.params as Record<string, unknown>) || {};
        if (!skillName) {
          return { id, error: { code: -1, message: '缺少 name 参数' } };
        }
        const { SkillRegistry: SR } = await import('../skills/SkillRegistry');
        const reg = SR.getInstance();
        const skillResult = await reg.executeSkill(skillName, skillParams);
        result = skillResult;
        break;
      }
      case 'schedule.list': {
        const scheduler = core.getScenarioScheduler();
        if (!scheduler) {
          result = { tasks: [], count: 0 };
        } else {
          const tasks = scheduler.getTasks();
          result = { tasks, count: tasks.length };
        }
        break;
      }
      case 'schedule.add': {
        const scheduler = core.getScenarioScheduler();
        if (!scheduler) {
          return { id, error: { code: -1, message: '调度器未初始化' } };
        }
        const name = (params?.name as string) || '';
        const cronExpression = (params?.cron as string) || (params?.schedule as string) || '';
        const description = (params?.description as string) || '';
        if (!name || !cronExpression) {
          return { id, error: { code: -1, message: '缺少 name 或 cron 参数' } };
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
        break;
      }
      case 'memory.search': {
        const query = (params?.query as string) || '';
        if (!query) {
          return { id, error: { code: -1, message: '缺少 query 参数' } };
        }
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
          result = { memories, count: Array.isArray(memories) ? memories.length : 0 };
        }
        break;
      }
      case 'evolution.status': {
        const { EvolutionOrchestrator } = await import('../evolution/EvolutionOrchestrator');
        const orchestrator = EvolutionOrchestrator.getInstance();
        const metrics = orchestrator.getUnifiedMetrics();
        result = metrics;
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
        const allowedFiles = ['JIABAIXING.md', 'CONTEXT.md', '.jiabaixing/context.md', 'CLAUDE.md'];

        if (!allowedFiles.includes(fileName)) {
          return { id, error: { code: -1, message: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}` } };
        }

        const projectRoot = process.cwd();
        const filePath = path.join(projectRoot, fileName);

        if (fs.existsSync(filePath)) {
          return { id, error: { code: -1, message: `文件已存在: ${fileName}。如需更新请直接编辑文件后使用 refresh 操作刷新缓存。` } };
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

        const allowedFiles = ['JIABAIXING.md', 'CONTEXT.md', '.jiabaixing/context.md', 'CLAUDE.md'];
        if (!allowedFiles.includes(fileName)) {
          return { id, error: { code: -1, message: `不支持的文件名: ${fileName}。允许的文件名: ${allowedFiles.join(', ')}` } };
        }

        const projectRoot = process.cwd();
        const filePath = path.join(projectRoot, fileName);

        if (!fs.existsSync(filePath)) {
          return { id, error: { code: -1, message: `文件不存在: ${fileName}` } };
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

        if (typeof request.id !== 'number' || typeof request.method !== 'string') {
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

  ipcServer.on('error', (err: Error) => {
    Logger.error('IPC 服务器错误', err, 'IPC');
  });

  return new Promise<void>((resolve) => {
    ipcServer!.listen(pipePath, () => {
      Logger.info(`IPC 服务器已启动: ${pipePath}`, 'IPC');
      resolve();
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
  console.log('\n');
  console.log('  ===========================================================');
  console.log('  |                                                         |');
  console.log('  |   jiabaixing v5.0                                       |');
  console.log('  |                                                         |');
  console.log('  ===========================================================');
  console.log('');
}

export async function bootstrap(): Promise<JiabaixingCore> {
  console.log('  🚀 jiabaixing v5.0 启动中...\n');

  let core: JiabaixingCore;

  try {
    process.stdout.write('  🧠 核心引擎... ');
    core = new JiabaixingCore();
    console.log('✅');

    process.stdout.write('  🔒 安全模块... ');
    const { sovereigntyPipeline } = await initSecurity();
    console.log('✅');

    process.stdout.write('  💾 数据库... ');
    const { memoryEngine } = await initMemory(core, sovereigntyPipeline);
    console.log('✅');

    process.stdout.write('  🎭 交互模块... ');
    const { sceneRecognizer } = await initInteraction(core);
    console.log('✅');

    process.stdout.write('  🔧 技能系统... ');
    console.log('✅ (内置)');

    process.stdout.write('  🧠 推理引擎... ');
    console.log('✅');

    process.stdout.write('  🧬 核心初始化... ');
    await core.initialize();
    console.log('✅');

    process.stdout.write('  📡 调度器... ');
    const scenarioScheduler = new ScenarioAwareScheduler();
    scenarioScheduler.setMemoryEngine(memoryEngine);

    core.setScenarioScheduler(scenarioScheduler);

    scenarioScheduler.start();

    const { setSchedulerInstance } = await import('../routes/automation');
    setSchedulerInstance(scenarioScheduler);

    console.log('✅');

    process.stdout.write('  🧬 进化引擎... ');
    await initEvolution(core, memoryEngine);
    console.log('✅');

    process.stdout.write('  🏗️ Harness 框架... ');
    const { harness } = await initHarness(core, memoryEngine, sceneRecognizer);
    console.log('✅');

    process.stdout.write('  📡 网关隔离... ');
    await initGateway(core, harness);
    console.log('✅');

    process.stdout.write('  🔌 MCP Host... ');
    const mcpManager = MCPServerManager.getInstance();
    await mcpManager.startAutoStartServers();
    console.log('✅');

    process.stdout.write('  🔗 IPC 服务器... ');
    await startIpcServer(core);
    console.log('✅');

    console.log('\n  ✅ 系统就绪\n');
    Logger.info('系统初始化完成', 'Bootstrap');

    return core;
  } catch (error) {
    console.log('❌');
    Logger.error('❌ 初始化失败', error as Error, 'Bootstrap');
    process.exit(1);
  }
}

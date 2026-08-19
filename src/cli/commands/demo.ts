import { Logger } from '../../utils/Logger';
import { backendUrl, COLORS } from '../constants';
import { extractResponse, ipcSend } from '../ipc';

/**
 * /demo 命令 — 从 Hermes Agent 学习的穿透式演示
 * 用法: /demo <场景>
 * 场景: research, a-share, daily-brief, code-review
 * @param input - 完整输入（含 /demo 前缀）
 */
export async function handleDemoCommand(input: string): Promise<void> {
  const args = input.trim().split(/\s+/).slice(1);
  const scenario = args[0] || 'help';

  const DEMO_SCENARIOS: Record<
    string,
    { name: string; prompt: string; description: string }
  > = {
    research: {
      name: '深度研究',
      prompt:
        '帮我研究{topic}的最新发展趋势，搜索3个不同角度的信息，总结5个要点，格式化输出',
      description: '多角度搜索 → 分析 → 总结报告',
    },
    'a-share': {
      name: 'A股情绪日报',
      prompt:
        '帮我看看今天A股大盘情绪怎么样，搜索今日A股行情、涨跌比、板块热度，做个简短的情绪分析日报',
      description: '搜索行情 → 情绪分析 → 日报输出',
    },
    'daily-brief': {
      name: '每日简报',
      prompt:
        '帮我整理今日科技新闻要点，搜索AI、科技、互联网领域的最新动态，总结3-5条重要新闻',
      description: '搜索新闻 → 筛选 → 简报',
    },
    'code-review': {
      name: '代码审查',
      prompt:
        '帮我审查当前项目的代码质量，分析最近修改的文件，找出潜在的bug和改进建议',
      description: '读取代码 → 分析 → 审查报告',
    },
    help: {
      name: '帮助',
      prompt: '',
      description: '',
    },
  };

  if (scenario === 'help' || !DEMO_SCENARIOS[scenario]) {
    Logger.info(
      `\n  ${COLORS.bold}${COLORS.cyan}✦ /demo 演示命令${COLORS.reset}`,
      'CLI'
    );
    Logger.info(
      `  ${COLORS.dim}从 Hermes Agent 学习的穿透式工作流演示${COLORS.reset}\n`,
      'CLI'
    );
    Logger.info(`  ${COLORS.bold}可用场景:${COLORS.reset}\n`, 'CLI');
    for (const [key, s] of Object.entries(DEMO_SCENARIOS)) {
      if (key === 'help') continue;
      Logger.info(
        `    ${COLORS.cyan}/demo ${key}${COLORS.reset}  ${s.name} — ${s.description}`,
        'CLI'
      );
    }
    Logger.info(
      `\n  ${COLORS.dim}用法: /demo <场景> [自定义参数]${COLORS.reset}`,
      'CLI'
    );
    Logger.info(
      `  ${COLORS.dim}示例: /demo research 智慧养老AI${COLORS.reset}\n`,
      'CLI'
    );
    return;
  }

  const demo = DEMO_SCENARIOS[scenario];
  let prompt = demo.prompt;

  // 支持自定义参数替换 {topic}
  const topic = args.slice(1).join(' ');
  if (topic) {
    prompt = prompt.replace(/\{topic\}/g, topic);
  }

  Logger.info(
    `\n  ${COLORS.bold}${COLORS.cyan}✦ Demo: ${demo.name}${COLORS.reset}`,
    'CLI'
  );
  Logger.info(`  ${COLORS.dim}${demo.description}${COLORS.reset}\n`, 'CLI');
  Logger.info(
    `  ${COLORS.yellow}▸ 指令: ${prompt.substring(0, 80)}...${COLORS.reset}\n`,
    'CLI'
  );

  // 发送到后端处理
  try {
    const startTime = Date.now();
    let data: {
      success: boolean;
      response: string;
      trace_id?: string;
    };

    // 优先尝试 IPC
    try {
      const ipcResult = await ipcSend('process', { input: prompt });
      if (typeof ipcResult === 'string') {
        data = { success: true, response: ipcResult };
      } else {
        data = {
          success: true,
          response: extractResponse(ipcResult),
        };
      }
    } catch {
      Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
      const resp = await fetch(`${backendUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt }),
      });

      if (!resp.ok) {
        Logger.info(
          `  ${COLORS.red}✗ 请求失败: HTTP ${resp.status}${COLORS.reset}\n`,
          'CLI'
        );
        return;
      }

      data = (await resp.json()) as {
        success: boolean;
        response: string;
        trace_id?: string;
      };
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    Logger.info(
      `  ${COLORS.green}✓ 完成 (${duration}s)${COLORS.reset}\n`,
      'CLI'
    );

    if (data.response) {
      const lines = data.response.split('\n');
      for (const line of lines) {
        Logger.info(`  ${line}`, 'CLI');
      }
      Logger.info('', 'CLI');
    }

    if (data.trace_id) {
      Logger.info(
        `  ${COLORS.dim}轨迹: ${data.trace_id}${COLORS.reset}\n`,
        'CLI'
      );
    }
  } catch (err) {
    Logger.info(
      `  ${COLORS.red}✗ 错误: ${(err as Error).message}${COLORS.reset}\n`,
      'CLI'
    );
    Logger.info(
      `  ${COLORS.dim}请确认后端服务已运行: npm start${COLORS.reset}\n`,
      'CLI'
    );
  }
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDemoCommand = handleDemoCommand;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
/**
 * /demo 命令 — 从 Hermes Agent 学习的穿透式演示
 * 用法: /demo <场景>
 * 场景: research, a-share, daily-brief, code-review
 * @param input - 完整输入（含 /demo 前缀）
 */
async function handleDemoCommand(input) {
    const args = input.trim().split(/\s+/).slice(1);
    const scenario = args[0] || 'help';
    const DEMO_SCENARIOS = {
        research: {
            name: '深度研究',
            prompt: '帮我研究{topic}的最新发展趋势，搜索3个不同角度的信息，总结5个要点，格式化输出',
            description: '多角度搜索 → 分析 → 总结报告',
        },
        'a-share': {
            name: 'A股情绪日报',
            prompt: '帮我看看今天A股大盘情绪怎么样，搜索今日A股行情、涨跌比、板块热度，做个简短的情绪分析日报',
            description: '搜索行情 → 情绪分析 → 日报输出',
        },
        'daily-brief': {
            name: '每日简报',
            prompt: '帮我整理今日科技新闻要点，搜索AI、科技、互联网领域的最新动态，总结3-5条重要新闻',
            description: '搜索新闻 → 筛选 → 简报',
        },
        'code-review': {
            name: '代码审查',
            prompt: '帮我审查当前项目的代码质量，分析最近修改的文件，找出潜在的bug和改进建议',
            description: '读取代码 → 分析 → 审查报告',
        },
        help: {
            name: '帮助',
            prompt: '',
            description: '',
        },
    };
    if (scenario === 'help' || !DEMO_SCENARIOS[scenario]) {
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}✦ /demo 演示命令${constants_1.COLORS.reset}`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.dim}从 Hermes Agent 学习的穿透式工作流演示${constants_1.COLORS.reset}\n`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.bold}可用场景:${constants_1.COLORS.reset}\n`, 'CLI');
        for (const [key, s] of Object.entries(DEMO_SCENARIOS)) {
            if (key === 'help')
                continue;
            Logger_1.Logger.info(`    ${constants_1.COLORS.cyan}/demo ${key}${constants_1.COLORS.reset}  ${s.name} — ${s.description}`, 'CLI');
        }
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.dim}用法: /demo <场景> [自定义参数]${constants_1.COLORS.reset}`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.dim}示例: /demo research 智慧养老AI${constants_1.COLORS.reset}\n`, 'CLI');
        return;
    }
    const demo = DEMO_SCENARIOS[scenario];
    let prompt = demo.prompt;
    // 支持自定义参数替换 {topic}
    const topic = args.slice(1).join(' ');
    if (topic) {
        prompt = prompt.replace(/\{topic\}/g, topic);
    }
    Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}${constants_1.COLORS.cyan}✦ Demo: ${demo.name}${constants_1.COLORS.reset}`, 'CLI');
    Logger_1.Logger.info(`  ${constants_1.COLORS.dim}${demo.description}${constants_1.COLORS.reset}\n`, 'CLI');
    Logger_1.Logger.info(`  ${constants_1.COLORS.yellow}▸ 指令: ${prompt.substring(0, 80)}...${constants_1.COLORS.reset}\n`, 'CLI');
    // 发送到后端处理
    try {
        const startTime = Date.now();
        let data;
        // 优先尝试 IPC
        try {
            const ipcResult = await (0, ipc_1.ipcSend)('process', { input: prompt });
            if (typeof ipcResult === 'string') {
                data = { success: true, response: ipcResult };
            }
            else {
                data = {
                    success: true,
                    response: (0, ipc_1.extractResponse)(ipcResult),
                };
            }
        }
        catch {
            Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
            const resp = await fetch(`${constants_1.backendUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: prompt }),
            });
            if (!resp.ok) {
                Logger_1.Logger.info(`  ${constants_1.COLORS.red}✗ 请求失败: HTTP ${resp.status}${constants_1.COLORS.reset}\n`, 'CLI');
                return;
            }
            data = (await resp.json());
        }
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        Logger_1.Logger.info(`  ${constants_1.COLORS.green}✓ 完成 (${duration}s)${constants_1.COLORS.reset}\n`, 'CLI');
        if (data.response) {
            const lines = data.response.split('\n');
            for (const line of lines) {
                Logger_1.Logger.info(`  ${line}`, 'CLI');
            }
            Logger_1.Logger.info('', 'CLI');
        }
        if (data.trace_id) {
            Logger_1.Logger.info(`  ${constants_1.COLORS.dim}轨迹: ${data.trace_id}${constants_1.COLORS.reset}\n`, 'CLI');
        }
    }
    catch (err) {
        Logger_1.Logger.info(`  ${constants_1.COLORS.red}✗ 错误: ${err.message}${constants_1.COLORS.reset}\n`, 'CLI');
        Logger_1.Logger.info(`  ${constants_1.COLORS.dim}请确认后端服务已运行: npm start${constants_1.COLORS.reset}\n`, 'CLI');
    }
}

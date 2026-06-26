import * as path from 'path';
import * as readline from 'readline';
import { Logger } from '../../utils/Logger';
import { COLORS, c } from '../constants';
import { requestWithFallback } from '../ipc';
import { ask } from '../repl';
import {
  detectEnvironmentType,
  getEnvFilePath,
  getForegroundWindowInfo,
  getGitStatus,
  readEnvFileSafe,
} from '../utils';

/**
 * 处理 /config 交互菜单（REPL 模式）
 * @param rl - readline 接口
 */
export async function handleConfigMenu(rl: readline.Interface): Promise<void> {
  while (true) {
    Logger.info(
      `\n  ${COLORS.bold}${COLORS.cyan}CONFIG 系统配置${COLORS.reset}\n`,
      'CLI'
    );
    Logger.info(`  ${COLORS.cyan}show${COLORS.reset}   显示当前配置`, 'CLI');
    Logger.info(`  ${COLORS.cyan}env${COLORS.reset}    编辑 .env 文件`, 'CLI');
    Logger.info(`  ${COLORS.cyan}model${COLORS.reset}  模型配置`, 'CLI');
    Logger.info(
      `  ${COLORS.cyan}gateway${COLORS.reset} Tool Gateway 配置`,
      'CLI'
    );
    Logger.info(`  ${COLORS.dim}  back  返回${COLORS.reset}\n`, 'CLI');

    const choice = await ask(rl, `  ${COLORS.cyan}config${COLORS.reset}> `);
    if (choice === 'back') return;

    switch (choice) {
      case 'show': {
        const envFile = getEnvFilePath();
        Logger.info('\n  .env 配置:\n', 'CLI');
        const lines = readEnvFileSafe(envFile);
        for (const line of lines) {
          Logger.info(`  ${line}`, 'CLI');
        }
        Logger.info('', 'CLI');
        break;
      }
      case 'env': {
        const envFile = getEnvFilePath();
        try {
          const { execSync } = require('child_process') as {
            execSync: (cmd: string, opts?: Record<string, unknown>) => Buffer;
          };
          if (process.platform === 'win32') {
            execSync(`notepad "${envFile}"`);
          } else {
            execSync(`vi "${envFile}"`, { stdio: 'inherit' });
          }
        } catch {
          Logger.info(`  .env 路径: ${envFile}\n`, 'CLI');
        }
        break;
      }
      case 'model': {
        const {
          getProviderManager,
          runSetupCLI,
        } = require('../../../config/setup');
        Logger.info('', 'CLI');
        const manager = getProviderManager();
        const providers = manager.getAll();
        const primary = manager.getPrimary();

        if (providers.length === 0) {
          Logger.info('  ⚠️ 未配置任何 LLM Provider\n', 'CLI');
          Logger.info('  是否添加第一个 Provider?', 'CLI');
          const ans = await ask(rl, '  (y/n): ');
          if (ans.toLowerCase() === 'y') {
            await runSetupCLI(['--add']);
          }
        } else {
          Logger.info(
            `  ${COLORS.bold}已配置 ${providers.length} 个 Provider:${COLORS.reset}\n`,
            'CLI'
          );
          for (const p of providers) {
            const mark =
              primary?.name === p.name
                ? ` ${COLORS.green}(主)${COLORS.reset}`
                : '';
            const status =
              p.healthy === undefined
                ? '?'
                : p.healthy
                  ? `${COLORS.green}✓${COLORS.reset}`
                  : `${COLORS.red}✗${COLORS.reset}`;
            Logger.info(
              `  ${status} ${p.displayName} ${COLORS.dim}(${p.model})${COLORS.reset}${mark}`,
              'CLI'
            );
          }
          Logger.info(
            `\n  路由: ${manager.getRouting().enabled ? `${COLORS.green}启用${COLORS.reset}` : '禁用'}`,
            'CLI'
          );
          Logger.info(
            `\n  输入 ${COLORS.cyan}setup${COLORS.reset} 打开配置向导`,
            'CLI'
          );
          Logger.info(
            `  输入 ${COLORS.cyan}add${COLORS.reset} 添加新的 Provider`,
            'CLI'
          );
          Logger.info(
            `  输入 ${COLORS.cyan}switch${COLORS.reset} 切换主模型`,
            'CLI'
          );

          const sub = await ask(
            rl,
            `  ${COLORS.cyan}config model${COLORS.reset}> `
          );
          if (sub === 'setup') {
            await runSetupCLI([]);
          } else if (sub === 'add') {
            await runSetupCLI(['--add']);
          } else if (sub === 'switch') {
            Logger.info('', 'CLI');
            providers.forEach(
              (p: { name: string; displayName: string }, _i: number) => {
                const mark = primary?.name === p.name ? ' ★' : '';
                Logger.info(`  ${_i + 1}. ${p.displayName}${mark}`, 'CLI');
              }
            );
            const idx = parseInt(await ask(rl, '  选择主模型 (1)')) - 1;
            if (idx >= 0 && idx < providers.length) {
              manager.setPrimary(providers[idx].name);
              Logger.info(
                `  ${COLORS.green}✅ 主模型已切换为 ${providers[idx].displayName}${COLORS.reset}\n`,
                'CLI'
              );
            }
          }
        }
        break;
      }
      case 'gateway': {
        await handleGatewayConfig(rl);
        break;
      }
      default:
        Logger.info('  未知命令', 'CLI');
    }
  }
}

/**
 * 处理 Tool Gateway 交互式配置
 * @param rl - readline 接口
 */
async function handleGatewayConfig(rl: readline.Interface): Promise<void> {
  const { getProviderManager } = require('../../models/ProviderManager') as {
    getProviderManager: () => import('../../models/ProviderManager').ProviderManager;
  };
  const manager = getProviderManager();
  const status = manager.getToolGatewayStatus();

  Logger.info(
    `\n  ${COLORS.bold}${COLORS.cyan}◆ Nous Tool Gateway${COLORS.reset}\n`,
    'CLI'
  );

  // 显示当前状态
  if (status.hasToken) {
    Logger.info(`  订阅状态: ${COLORS.green}✓ 已配置${COLORS.reset}`, 'CLI');
  } else {
    Logger.info(
      `  订阅状态: ${COLORS.yellow}○ 未配置 Token${COLORS.reset}`,
      'CLI'
    );
  }

  Logger.info(`\n  ${COLORS.bold}工具网关状态:${COLORS.reset}`, 'CLI');
  for (const tool of status.tools) {
    const gatewayMark = tool.useGateway
      ? `${COLORS.green}✓ 网关${COLORS.reset} (${tool.backend})`
      : `${COLORS.dim}○ 直连${COLORS.reset}`;
    Logger.info(`    ${tool.name.padEnd(12)} ${gatewayMark}`, 'CLI');
  }

  Logger.info(
    `\n  ${COLORS.cyan}token${COLORS.reset}   设置 Nous Portal Token`,
    'CLI'
  );
  Logger.info(`  ${COLORS.cyan}toggle${COLORS.reset}  切换工具网关开关`, 'CLI');
  Logger.info(`  ${COLORS.cyan}enable${COLORS.reset}  一键启用全部网关`, 'CLI');
  Logger.info(`  ${COLORS.cyan}disable${COLORS.reset} 一键禁用全部网关`, 'CLI');
  Logger.info(`  ${COLORS.dim}  back  返回${COLORS.reset}\n`, 'CLI');

  const sub = await ask(rl, `  ${COLORS.cyan}config gateway${COLORS.reset}> `);

  switch (sub) {
    case 'token': {
      Logger.info(
        '\n  请输入 Nous Portal Token（从 https://nousresearch.com 获取）:',
        'CLI'
      );
      const token = await ask(rl, '  Token: ');
      if (token && token.trim()) {
        manager.updateToolGateway({ userToken: token.trim() });
        Logger.info(`  ${COLORS.green}✅ Token 已保存${COLORS.reset}\n`, 'CLI');
      }
      break;
    }
    case 'toggle': {
      Logger.info('\n  选择要切换的工具:', 'CLI');
      const toolNames = ['web', 'imageGen', 'tts', 'browser'];
      const toolLabels: Record<string, string> = {
        web: '网页搜索与抓取',
        imageGen: '文生图',
        tts: '语音合成',
        browser: '浏览器自动化',
      };
      toolNames.forEach((name, i) => {
        const current = status.tools.find(
          (t: { name: string; useGateway: boolean; backend: string }) =>
            t.name === name
        );
        const state = current?.useGateway
          ? `${COLORS.green}网关${COLORS.reset}`
          : `${COLORS.dim}直连${COLORS.reset}`;
        Logger.info(
          `  ${i + 1}. ${toolLabels[name].padEnd(12)} ${state}`,
          'CLI'
        );
      });
      const idx = parseInt(await ask(rl, '  选择 (1-4): ')) - 1;
      if (idx >= 0 && idx < toolNames.length) {
        const toolName = toolNames[idx] as
          | 'web'
          | 'imageGen'
          | 'tts'
          | 'browser';
        const current = status.tools.find(
          (t: { name: string; useGateway: boolean; backend: string }) =>
            t.name === toolName
        );
        manager.updateToolGatewayTool(toolName, {
          useGateway: !current?.useGateway,
        });
        const newState = !current?.useGateway ? '网关' : '直连';
        Logger.info(
          `  ${COLORS.green}✅ ${toolLabels[toolName]} 已切换为 ${newState}${COLORS.reset}\n`,
          'CLI'
        );
      }
      break;
    }
    case 'enable': {
      manager.updateToolGateway({
        tools: {
          web: { useGateway: true, backend: 'firecrawl' },
          imageGen: { useGateway: true, backend: 'fal' },
          tts: { useGateway: true, backend: 'openai' },
          browser: { useGateway: true, backend: 'browser-use' },
        },
      });
      Logger.info(
        `  ${COLORS.green}✅ 全部工具已启用网关${COLORS.reset}\n`,
        'CLI'
      );
      break;
    }
    case 'disable': {
      manager.updateToolGateway({
        tools: {
          web: { useGateway: false, backend: 'firecrawl' },
          imageGen: { useGateway: false, backend: 'fal' },
          tts: { useGateway: false, backend: 'openai' },
          browser: { useGateway: false, backend: 'browser-use' },
        },
      });
      Logger.info(
        `  ${COLORS.yellow}✅ 全部工具已切换为直连模式${COLORS.reset}\n`,
        'CLI'
      );
      break;
    }
    case 'back':
      return;
    default:
      Logger.info('  未知命令', 'CLI');
  }
}

/**
 * 处理 /env 命令（REPL 模式）
 * 显示桌面环境信息
 */
export async function handleEnvCommand(): Promise<void> {
  try {
    const health = await requestWithFallback<Record<string, unknown>>(
      'status',
      {},
      { path: '/api/health' }
    );

    Logger.info(`\n  ${COLORS.bold}桌面环境${COLORS.reset}\n`, 'CLI');
    Logger.info(`  后端: ${health.status}`, 'CLI');
    Logger.info(`  模型: ${health.model}`, 'CLI');
    Logger.info(
      `  运行: ${Math.round((health.uptime as number) / 60)} 分钟\n`,
      'CLI'
    );

    // 尝试获取前台窗口信息
    const windowInfo = getForegroundWindowInfo();
    if (windowInfo) {
      Logger.info(`  前台窗口:`, 'CLI');
      Logger.info(
        `    ${COLORS.cyan}进程:${COLORS.reset} ${windowInfo.proc}`,
        'CLI'
      );
      Logger.info(
        `    ${COLORS.cyan}标题:${COLORS.reset} ${windowInfo.title.substring(0, 80)}`,
        'CLI'
      );
      const envType = detectEnvironmentType(windowInfo.title, windowInfo.proc);
      Logger.info(`  环境: ${envType}`, 'CLI');
    } else {
      Logger.info(`  ${COLORS.dim}未检测到前台窗口${COLORS.reset}`, 'CLI');
    }

    // Git状态
    Logger.info(`\n  ${COLORS.dim}项目Git状态:${COLORS.reset}`, 'CLI');
    const dirs = [
      process.cwd(),
      path.resolve(process.cwd(), '..', 'hermes-agent-main'),
    ];
    const gitResults = getGitStatus(dirs);
    for (const resultJson of gitResults) {
      const { name, branch, uncommitted, lastMsg } = JSON.parse(resultJson) as {
        name: string;
        branch: string;
        uncommitted: number;
        lastMsg: string;
      };
      const marker =
        uncommitted > 0
          ? c(COLORS.yellow, ` ⚡${uncommitted}个未提交`)
          : c(COLORS.green, ' ✅ 干净');
      Logger.info(
        `    ${COLORS.cyan}${name}${COLORS.reset} [${branch}]${marker}`,
        'CLI'
      );
      Logger.info(
        `    ${COLORS.dim}${lastMsg.substring(0, 60)}${COLORS.reset}`,
        'CLI'
      );
    }
  } catch {
    Logger.info(`  ${c(COLORS.red, '❌ 获取环境状态失败')}`, 'CLI');
  }
  Logger.info('', 'CLI');
}

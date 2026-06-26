/**
 * 配置向导 — 交互式配置 LLM Provider
 *
 * 可以在 CLI 中通过 /config 命令调用，或独立运行
 *
 * 用法:
 *   ts-node src/config/setup.ts           # 交互式
 *   ts-node src/config/setup.ts --list     # 查看当前配置
 *   ts-node src/config/setup.ts --add      # 添加新的 Provider
 *   ts-node src/config/setup.ts --test     # 测试所有 Provider 连接
 */

import * as readline from 'readline';
import { getProviderManager } from '../models/ProviderManager';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function c(color: string, text: string): string {
  return `${color}${text}${COLORS.reset}`;
}

function rl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const reader = rl();
  return new Promise((resolve) => {
    const hint = defaultValue ? ` (${defaultValue})` : '';
    reader.question(`  ${question}${hint}: `, (answer) => {
      reader.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

const PROVIDER_TEMPLATES: Record<
  string,
  { displayName: string; baseUrl: string; model: string; hint: string }
> = {
  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hint: 'API Key 格式: sk-...',
  },
  xiaomi: {
    displayName: '小米 MiMo',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    hint: 'API Key 格式: tp-crt-...',
  },
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: 'API Key 格式: sk-...',
  },
  zhipu: {
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-air',
    hint: 'API Key 格式: 智谱平台获取',
  },
  local: {
    displayName: '本地 LLM',
    baseUrl: 'http://127.0.0.1:8001/v1',
    model: 'qwen2.5:7b',
    hint: '本地 Ollama/vLLM 服务地址',
  },
  custom: {
    displayName: '自定义 OpenAI 兼容',
    baseUrl: '',
    model: '',
    hint: '任意 OpenAI 兼容 API',
  },
};

/** 交互式添加 Provider */
async function addProviderInteractive(
  manager: ReturnType<typeof getProviderManager>
): Promise<void> {
  console.log(`\n  ${c(COLORS.bold, '添加 LLM Provider')}\n`);
  console.log(`  ${COLORS.dim}选择 Provider 类型:${COLORS.reset}\n`);

  const names = Object.keys(PROVIDER_TEMPLATES);
  names.forEach((key, i) => {
    const t = PROVIDER_TEMPLATES[key];
    console.log(
      `  ${c(COLORS.cyan, `${i + 1}.`)} ${c(COLORS.bold, t.displayName)} ${COLORS.dim}- ${t.hint}${COLORS.reset}`
    );
  });
  console.log();

  const choice = await ask('请输入编号 (1-6)', '1');
  const idx = parseInt(choice) - 1;
  if (idx < 0 || idx >= names.length) {
    console.log(`  ${c(COLORS.red, '无效选择')}\n`);
    return;
  }

  const templateKey = names[idx];
  const template = PROVIDER_TEMPLATES[templateKey];

  const name = templateKey;
  const displayName = template.displayName;
  const baseUrl = await ask('API Base URL', template.baseUrl);
  const apiKey = await ask('API Key', '');
  const model = await ask('模型名称', template.model);

  if (!apiKey && templateKey !== 'local') {
    console.log(
      `  ${c(COLORS.yellow, '⚠️ 未输入 API Key，稍后可在配置文件中补填')}\n`
    );
  }

  manager.register({
    name,
    displayName,
    baseUrl,
    apiKey: apiKey || 'not-set',
    model,
    priority: manager.getAll().length,
  });

  // 如果是第一个 provider，自动设为主模型
  if (manager.getAll().length === 1 || !manager.getPrimary()) {
    manager.setPrimary(name);
  }

  console.log(`  ${c(COLORS.green, `✅ ${displayName} 已添加`)}\n`);
}

/** 列出当前配置 */
function listProviders(manager: ReturnType<typeof getProviderManager>): void {
  const providers = manager.getAll();
  const primary = manager.getPrimary();

  console.log(`\n  ${c(COLORS.bold, 'LLM Provider 配置')}\n`);

  if (providers.length === 0) {
    // 从 .env 读取未导入的配置提示
    const envHints: string[] = [];
    if (process.env.XIAOMI_API_KEY) envHints.push('小米 MiMo (XIAOMI_API_KEY)');
    if (process.env.DEEPSEEK_API_KEY)
      envHints.push('DeepSeek (DEEPSEEK_API_KEY)');
    if (process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY)
      envHints.push('OpenAI (OPENAI_API_KEY)');

    console.log(`  ${c(COLORS.yellow, '⚠️  未配置任何 Provider')}\n`);
    if (envHints.length > 0) {
      console.log(
        `  ${COLORS.dim}检测到 .env 中有以下配置（可执行 npm run setup 导入）:${COLORS.reset}`
      );
      envHints.forEach((h) => console.log(`    ${h}`));
    }
    console.log(
      `\n  使用 ${c(COLORS.cyan, 'npm run setup')} 或 ${c(COLORS.cyan, '/config model')} 添加\n`
    );
    return;
  }

  console.log(
    `  ${COLORS.dim}已注册 ${providers.length} 个 Provider，路由: ${manager.getRouting().enabled ? '启用' : '禁用'}${COLORS.reset}\n`
  );

  providers.forEach((p) => {
    const isPrimary = primary?.name === p.name;
    const prefix = isPrimary ? c(COLORS.green, '★') : ' ';
    const status =
      p.healthy === undefined
        ? c(COLORS.dim, '? 未检测')
        : p.healthy
          ? c(COLORS.green, '✓ 正常')
          : c(COLORS.red, '✗ 异常');
    const lastCheck = p.lastHealthCheck
      ? `${Math.round((Date.now() - p.lastHealthCheck) / 1000)}s前`
      : '';

    console.log(
      `  ${prefix} ${c(COLORS.bold, p.displayName)} ${isPrimary ? c(COLORS.dim, '(主)') : ''}`
    );
    console.log(`    模型: ${p.model}`);
    console.log(`    地址: ${p.baseUrl}`);
    console.log(`    状态: ${status} ${COLORS.dim}${lastCheck}${COLORS.reset}`);
    console.log();
  });
}

/** 测试所有 Provider 连接 */
async function testProviders(
  manager: ReturnType<typeof getProviderManager>
): Promise<void> {
  const providers = manager.getAll();
  if (providers.length === 0) {
    console.log(`\n  ${c(COLORS.yellow, '⚠️  无 Provider 可测试')}\n`);
    return;
  }

  console.log(`\n  ${c(COLORS.bold, '测试 Provider 连接')}\n`);

  for (const p of providers) {
    process.stdout.write(`  ${p.displayName} (${p.model})... `);
    try {
      const response = await fetch(`${p.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(10000),
      } as RequestInit);

      if (response.ok) {
        console.log(c(COLORS.green, '✅'));
        manager.updateHealth(p.name, true);
      } else if (response.status === 401) {
        console.log(c(COLORS.yellow, '⚠️  可连接但认证失败 (401)'));
        manager.updateHealth(p.name, true);
      } else {
        console.log(c(COLORS.red, `❌ HTTP ${response.status}`));
        manager.updateHealth(p.name, false);
      }
    } catch (e) {
      console.log(c(COLORS.red, `❌ ${(e as Error).message}`));
      manager.updateHealth(p.name, false);
    }
  }
  console.log();
}

/** CLI 交互主流程 */
export async function runSetupCLI(args: string[]): Promise<void> {
  const manager = getProviderManager();

  if (args.includes('--list')) {
    listProviders(manager);
    return;
  }

  if (args.includes('--test')) {
    await testProviders(manager);
    return;
  }

  if (args.includes('--add')) {
    await addProviderInteractive(manager);
    return;
  }

  // 交互式主菜单
  while (true) {
    console.log(`\n  ${c(COLORS.bold, '家百星 配置向导')}\n`);
    listProviders(manager);

    console.log(`  ${COLORS.dim}操作:${COLORS.reset}`);
    console.log(`  ${c(COLORS.cyan, '1')}  添加 Provider`);
    console.log(`  ${c(COLORS.cyan, '2')}  测试连接`);
    console.log(`  ${c(COLORS.cyan, '3')}  设置主模型`);
    console.log(
      `  ${c(COLORS.cyan, '4')}  切换路由 (当前: ${manager.getRouting().enabled ? '开' : '关'})`
    );
    console.log(`  ${c(COLORS.cyan, 'q')}  退出`);
    console.log();

    const choice = await ask('请选择');

    if (choice === 'q') break;

    switch (choice) {
      case '1':
        await addProviderInteractive(manager);
        break;
      case '2':
        await testProviders(manager);
        break;
      case '3': {
        const providers = manager.getAll();
        if (providers.length === 0) {
          console.log(`  ${c(COLORS.yellow, '⚠️  请先添加 Provider')}\n`);
          break;
        }
        console.log();
        providers.forEach((p, i) => {
          const mark = manager.getPrimary()?.name === p.name ? ' ★' : '';
          console.log(
            `  ${c(COLORS.cyan, `${i + 1}.`)} ${p.displayName}${mark}`
          );
        });
        const idx = parseInt(await ask('选择主模型编号', '1')) - 1;
        if (idx >= 0 && idx < providers.length) {
          manager.setPrimary(providers[idx].name);
          console.log(
            `  ${c(COLORS.green, `✅ 主模型已切换为 ${providers[idx].displayName}`)}\n`
          );
        }
        break;
      }
      case '4': {
        const current = manager.getRouting().enabled;
        const newVal = !current;
        const store = (
          manager as unknown as { store: { routingEnabled: boolean } }
        ).store;
        store.routingEnabled = newVal;
        console.log(
          `  ${c(COLORS.green, `✅ 路由已${newVal ? '启用' : '禁用'}`)}\n`
        );
        break;
      }
    }
  }
}

// 独立运行
const isMain = require.main === module;
if (isMain) {
  runSetupCLI(process.argv.slice(2)).catch(console.error);
}

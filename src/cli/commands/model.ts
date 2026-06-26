import { Logger } from '../../utils/Logger';
import { COLORS, c } from '../constants';
import { requestWithFallback } from '../ipc';
import { checkBackendHealth } from '../utils';
import { SubcommandOptions } from '../types';

/**
 * 处理 /model 命令（REPL 模式）
 * 显示当前模型信息
 */
export async function handleModelCommand(): Promise<void> {
  const health = await checkBackendHealth();
  Logger.info(`\n  ${COLORS.bold}当前模型${COLORS.reset}\n`, 'CLI');
  Logger.info(`  模型: ${health.model || 'deepseek-chat'}`, 'CLI');
  Logger.info(
    `  LLM: ${health.llm?.available ? c(COLORS.green, '✅ 可用') : c(COLORS.red, '❌ 不可用')}`,
    'CLI'
  );
  if (health.llm?.message) Logger.info(`  信息: ${health.llm.message}`, 'CLI');
  Logger.info('', 'CLI');
}

/**
 * 处理 model 子命令 — 模型管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleModelCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      const data = await requestWithFallback(
        'model.list',
        {},
        { path: '/api/models' }
      );
      if (options.json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const models = (data as any)?.models || [];
        process.stdout.write(`可用模型 (${models.length}):\n`);
        for (const m of models) {
          process.stdout.write(`  ${m.name || m.id || m}\n`);
        }
      }
      break;
    }
    case 'switch': {
      const modelName = subArgs[1];
      if (!modelName) {
        process.stderr.write('错误: model switch 需要模型名称\n');
        process.exit(1);
      }
      const data = await requestWithFallback(
        'model.switch',
        { modelName },
        {
          path: '/api/models/switch',
          method: 'POST',
          body: { model: modelName },
        }
      );
      process.stdout.write(`模型切换: ${JSON.stringify(data)}\n`);
      break;
    }
    default:
      process.stderr.write(
        `未知 model 子命令: ${action}。可用: list, switch\n`
      );
      process.exit(1);
  }
}

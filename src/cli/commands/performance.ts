import { Logger } from '../../utils/Logger';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 performance 子命令 — 性能监控
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handlePerformanceCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'snapshot';

  switch (action) {
    case 'snapshot': {
      try {
        const data = await requestWithFallback(
          'performance.snapshot',
          {},
          { path: '/api/performance/snapshot' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`性能快照:\n${JSON.stringify(data, null, 2)}\n`);
        }
      } catch (err) {
        Logger.error('获取性能快照失败', err as Error, 'PerformanceCommand');
        process.stderr.write(`获取性能快照失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'stats': {
      try {
        const data = await requestWithFallback(
          'performance.stats',
          {},
          { path: '/api/performance/stats' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`性能统计:\n${JSON.stringify(data, null, 2)}\n`);
        }
      } catch (err) {
        Logger.error('获取性能统计失败', err as Error, 'PerformanceCommand');
        process.stderr.write(`获取性能统计失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(
        `未知 performance 子命令: ${action}。可用: snapshot, stats\n`
      );
      process.exit(1);
  }
}

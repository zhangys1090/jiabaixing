import { Logger } from '../../utils/Logger';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 security 子命令 — 安全审计
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleSecurityCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'status';

  switch (action) {
    case 'status':
    case 'report': {
      try {
        const data = await requestWithFallback(
          'security.report',
          {},
          { path: '/api/security/report' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`安全报告:\n${JSON.stringify(data, null, 2)}\n`);
        }
      } catch (err) {
        Logger.error('获取安全报告失败', err as Error, 'SecurityCommand');
        process.stderr.write(`获取安全报告失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'logs': {
      try {
        const data = await requestWithFallback(
          'security.logs',
          {},
          { path: '/api/security/logs' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const logs =
            ((data as Record<string, unknown>)?.logs as Array<
              Record<string, unknown>
            >) || [];
          process.stdout.write(`安全日志 (${logs.length}):\n`);
          for (const log of logs) {
            process.stdout.write(
              `  [${log.timestamp || ''}] ${log.message || JSON.stringify(log)}\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取安全日志失败', err as Error, 'SecurityCommand');
        process.stderr.write(`获取安全日志失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(
        `未知 security 子命令: ${action}。可用: status, report, logs\n`
      );
      process.exit(1);
  }
}

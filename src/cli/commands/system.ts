import { Logger } from '../../utils/Logger';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 system 子命令 — 系统管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleSystemCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'info';

  switch (action) {
    case 'info':
    case 'status': {
      try {
        const data = await requestWithFallback(
          'system.info',
          {},
          { path: '/api/system/resources' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`系统信息:\n${JSON.stringify(data, null, 2)}\n`);
        }
      } catch (err) {
        Logger.error('获取系统信息失败', err as Error, 'SystemCommand');
        process.stderr.write(`获取系统信息失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'resources': {
      try {
        const data = await requestWithFallback(
          'system.resources',
          {},
          { path: '/api/system/resources' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`系统资源:\n${JSON.stringify(data, null, 2)}\n`);
        }
      } catch (err) {
        Logger.error('获取系统资源失败', err as Error, 'SystemCommand');
        process.stderr.write(`获取系统资源失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'integrity': {
      try {
        const data = await requestWithFallback(
          'system.integrity',
          {},
          { path: '/api/system/integrity' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(
            `系统完整性:\n${JSON.stringify(data, null, 2)}\n`
          );
        }
      } catch (err) {
        Logger.error('获取系统完整性失败', err as Error, 'SystemCommand');
        process.stderr.write(`获取系统完整性失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(
        `未知 system 子命令: ${action}。可用: info, status, resources, integrity\n`
      );
      process.exit(1);
  }
}

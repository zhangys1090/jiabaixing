import { Logger } from '../../utils/Logger';
import { COLORS, c } from '../constants';
import { SubcommandOptions } from '../types';
import { checkBackendHealth, getIM } from '../utils';

/**
 * 处理 /status 命令（REPL 模式）
 * 显示系统运行状态
 */
export async function handleStatusCommand(): Promise<void> {
  const health = await checkBackendHealth();
  Logger.info(`\n  ${COLORS.bold}系统状态${COLORS.reset}\n`, 'CLI');
  Logger.info(
    `  后端服务: ${health.online ? c(COLORS.green, '🟢 在线') : c(COLORS.red, '🔴 离线')}`,
    'CLI'
  );
  Logger.info(`  健康状态: ${health.status || 'unknown'}`, 'CLI');
  if (health.uptime) {
    Logger.info(`  运行时间: ${Math.round(health.uptime / 60)} 分钟`, 'CLI');
  }
  if (health.services) {
    Logger.info(`\n  ${COLORS.dim}服务组件:${COLORS.reset}`, 'CLI');
    for (const [name, svc] of Object.entries(health.services)) {
      const info = svc as { status?: string; message?: string };
      const mark =
        info.status === 'ok' ? c(COLORS.green, '🟢') : c(COLORS.red, '🔴');
      Logger.info(
        `    ${mark} ${name}: ${info.message || info.status || '-'}`,
        'CLI'
      );
    }
  }

  const im = getIM();
  const platforms = await im.getPlatforms();
  if (platforms.length > 0) {
    Logger.info(`\n  ${COLORS.dim}平台连接:${COLORS.reset}`, 'CLI');
    for (const p of platforms) {
      const s = (p.status?.status as string) || 'disconnected';
      const mark =
        s === 'connected'
          ? '🟢'
          : s === 'connecting'
            ? '🟡'
            : s === 'error'
              ? '🔴'
              : '⚪';
      Logger.info(`    ${mark} ${p.icon} ${p.name}: ${s}`, 'CLI');
    }
  }
  Logger.info('', 'CLI');
}

/**
 * 处理 status 子命令 — 查看系统状态
 * @param options - 子命令选项
 */
export async function handleStatusCommandCLI(
  options: SubcommandOptions
): Promise<void> {
  Logger.info('查看系统状态', 'StatusCommand');

  try {
    const health = await checkBackendHealth();

    if (options.json) {
      process.stdout.write(JSON.stringify(health, null, 2) + '\n');
    } else {
      process.stdout.write(`系统状态\n\n`);
      process.stdout.write(`  后端服务: ${health.online ? '在线' : '离线'}\n`);
      process.stdout.write(`  健康状态: ${health.status || 'unknown'}\n`);
      if (health.uptime) {
        process.stdout.write(
          `  运行时间: ${Math.round(health.uptime / 60)} 分钟\n`
        );
      }
      if (health.model) {
        process.stdout.write(`  模型: ${health.model}\n`);
      }
      if (health.services) {
        process.stdout.write(`\n  服务组件:\n`);
        for (const [name, svc] of Object.entries(health.services)) {
          const info = svc as { status?: string; message?: string };
          process.stdout.write(
            `    ${info.status === 'ok' ? '🟢' : '🔴'} ${name}: ${info.message || info.status || '-'}\n`
          );
        }
      }
    }
  } catch (err) {
    Logger.error('获取系统状态失败', err as Error, 'StatusCommand');
    process.stderr.write(`获取系统状态失败: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

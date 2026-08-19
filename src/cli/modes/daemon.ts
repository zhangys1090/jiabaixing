import { DaemonManager } from '../../daemon/DaemonManager';
import { Logger } from '../../utils/Logger';

/**
 * 独立 Daemon 模式：不进入 REPL，直接执行 daemon 命令后退出
 * @param args - daemon 子命令参数
 */
export async function standaloneDaemon(args: string[]): Promise<void> {
  const dm = new DaemonManager();
  const cmd = args[0] || 'status';

  switch (cmd) {
    case 'start': {
      const r = await dm.start();
      Logger.info(r.success ? `✅ ${r.message}` : `❌ ${r.message}`, 'CLI');
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'stop': {
      const r = await dm.stop();
      Logger.info(r.success ? `✅ ${r.message}` : `❌ ${r.message}`, 'CLI');
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'restart': {
      const r = await dm.restart();
      Logger.info(r.success ? `✅ ${r.message}` : `❌ ${r.message}`, 'CLI');
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'status': {
      const status = await dm.status();
      if (status.running) {
        const uptime = dm.formatUptime(status.uptime!);
        const pythonInfo = status.pythonReady
          ? `  Python: PID ${status.state!.pythonPid} :${status.state!.pythonPort}`
          : '  Python: 未运行';
        Logger.info(
          `🟢 运行中  PID: ${status.state!.pid}  端口: ${status.state!.port}  运行: ${uptime}${status.memoryUsage ? `  内存: ${status.memoryUsage}` : ''}${pythonInfo}`,
          'CLI'
        );
      } else {
        Logger.info('🔴 未运行', 'CLI');
      }
      process.exit(status.running ? 0 : 1);
      break;
    }
    case 'logs': {
      const n = parseInt(args[1], 10) || 30;
      const logText = await dm.logs(n);
      Logger.info(logText, 'CLI');
      process.exit(0);
      break;
    }
    default:
      Logger.info(
        `用法: npm run cli daemon <start|stop|restart|status|logs>`,
        'CLI'
      );
      process.exit(1);
  }
}

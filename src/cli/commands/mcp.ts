import { Logger } from '../../utils/Logger';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 mcp 子命令 — MCP服务器管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleMcpCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'servers';

  switch (action) {
    case 'servers':
    case 'list': {
      try {
        const data = await requestWithFallback<{
          servers?: Array<Record<string, unknown>>;
        }>('mcp.servers', {}, { path: '/api/mcp/servers' });
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const servers =
            ((data as Record<string, unknown>)?.servers as Array<
              Record<string, unknown>
            >) || [];
          process.stdout.write(`MCP服务器 (${servers.length}):\n`);
          for (const s of servers) {
            const name = s.name || s.id || JSON.stringify(s);
            const status =
              (s as Record<string, unknown>).status === 'connected'
                ? '✅'
                : '❌';
            process.stdout.write(`  ${status} ${name}\n`);
          }
        }
      } catch (err) {
        Logger.error('获取MCP服务器列表失败', err as Error, 'McpCommand');
        process.stderr.write(
          `获取MCP服务器列表失败: ${(err as Error).message}\n`
        );
        process.exit(1);
      }
      break;
    }
    case 'status': {
      try {
        const data = await requestWithFallback(
          'mcp.servers',
          {},
          { path: '/api/mcp/servers' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(
            `MCP服务器状态: ${JSON.stringify(data, null, 2)}\n`
          );
        }
      } catch (err) {
        Logger.error('获取MCP状态失败', err as Error, 'McpCommand');
        process.stderr.write(`获取MCP状态失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(
        `未知 mcp 子命令: ${action}。可用: list, servers, status\n`
      );
      process.exit(1);
  }
}

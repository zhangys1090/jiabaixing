import { Logger } from '../../utils/Logger';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 conversations 子命令 — 对话历史管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleConversationsCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        const data = await requestWithFallback(
          'conversations.list',
          {},
          { path: '/api/conversations' }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const conversations =
            ((data as Record<string, unknown>)?.conversations as Array<
              Record<string, unknown>
            >) || [];
          process.stdout.write(`对话历史 (${conversations.length}):\n`);
          for (const c of conversations) {
            const id = c.id || '';
            const title = c.title || c.name || '(无标题)';
            const time = c.updatedAt || c.createdAt || '';
            process.stdout.write(
              `  ${id} | ${title}${time ? ` | ${time}` : ''}\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取对话列表失败', err as Error, 'ConversationsCommand');
        process.stderr.write(`获取对话列表失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'view': {
      const convId = subArgs[1];
      if (!convId) {
        process.stderr.write('用法: conversations view <对话ID>\n');
        process.exit(1);
      }
      try {
        const data = await requestWithFallback(
          'conversations.view',
          { id: convId },
          { path: `/api/conversations/${encodeURIComponent(convId)}` }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(
            `对话 ${convId}:\n${JSON.stringify(data, null, 2)}\n`
          );
        }
      } catch (err) {
        Logger.error('查看对话失败', err as Error, 'ConversationsCommand');
        process.stderr.write(`查看对话失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'delete': {
      const convId = subArgs[1];
      if (!convId) {
        process.stderr.write('用法: conversations delete <对话ID>\n');
        process.exit(1);
      }
      try {
        const data = await requestWithFallback(
          'conversations.delete',
          { id: convId },
          {
            path: `/api/conversations/${encodeURIComponent(convId)}`,
            method: 'DELETE',
          }
        );
        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`对话 ${convId} 已删除\n`);
        }
      } catch (err) {
        Logger.error('删除对话失败', err as Error, 'ConversationsCommand');
        process.stderr.write(`删除对话失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(
        `未知 conversations 子命令: ${action}。可用: list, view <id>, delete <id>\n`
      );
      process.exit(1);
  }
}

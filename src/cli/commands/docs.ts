import { Logger } from '../../utils/Logger';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 docs 子命令 — 文档管理
 * 支持: list, generate, view <name>
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleDocsCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        const data = await requestWithFallback<{
          docs?: Array<{
            name: string;
            title: string;
            size?: number;
            updated?: string;
          }>;
        }>('docs.list', {}, { path: '/api/docs/index' });

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const docs =
            ((data as Record<string, unknown>)?.docs as Array<
              Record<string, unknown>
            >) || [];
          process.stdout.write(`可用文档 (${docs.length}):\n`);
          for (const d of docs) {
            const name = d.name || d.title || JSON.stringify(d);
            const size = d.size ? ` (${d.size} bytes)` : '';
            process.stdout.write(`  ${name}${size}\n`);
          }
        }
      } catch (err) {
        Logger.error('获取文档列表失败', err as Error, 'DocsCommand');
        process.stderr.write(`获取文档列表失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'generate': {
      try {
        const scope = subArgs[1] || 'all';
        const data = await requestWithFallback<{
          success?: boolean;
          message?: string;
        }>(
          'docs.generate',
          { scope },
          { path: '/api/docs/generate', method: 'POST', body: { scope } }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(
            `文档生成: ${(data as Record<string, unknown>)?.message || '完成'}\n`
          );
        }
      } catch (err) {
        Logger.error('生成文档失败', err as Error, 'DocsCommand');
        process.stderr.write(`生成文档失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'view': {
      const docName = subArgs.slice(1).join(' ');
      if (!docName) {
        process.stderr.write('用法: docs view <文档名称>\n');
        process.exit(1);
      }
      try {
        const data = await requestWithFallback<{
          content?: string;
          title?: string;
        }>(
          'docs.view',
          { name: docName },
          { path: `/api/docs/view?name=${encodeURIComponent(docName)}` }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const content = (data as Record<string, unknown>)?.content as string;
          const title = (data as Record<string, unknown>)?.title as string;
          if (title) {
            process.stdout.write(`\n${title}\n${'='.repeat(title.length)}\n\n`);
          }
          process.stdout.write(content || '无内容\n');
        }
      } catch (err) {
        Logger.error('查看文档失败', err as Error, 'DocsCommand');
        process.stderr.write(`查看文档失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    default:
      process.stderr.write(
        `未知 docs 子命令: ${action}。可用: list, generate, view <name>\n`
      );
      process.exit(1);
  }
}

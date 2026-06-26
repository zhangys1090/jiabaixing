import { Logger } from '../../utils/Logger';
import { COLORS, c, backendUrl } from '../constants';
import { requestWithFallback, ipcSend } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 /memory 命令（REPL 模式）
 * 显示记忆统计
 */
export async function handleMemoryCommand(): Promise<void> {
  try {
    const data = await requestWithFallback<{
      data?: {
        totalMemories?: number;
        shortTermSize?: number;
        dbPath?: string;
      };
    }>('memory.stats', {}, { path: '/api/memory/stats' });

    Logger.info(`\n  ${COLORS.bold}记忆统计${COLORS.reset}\n`, 'CLI');
    if (data.data) {
      Logger.info(`  记忆条数: ${data.data.totalMemories || 0}`, 'CLI');
      Logger.info(`  短期记忆: ${data.data.shortTermSize || 0} 字节`, 'CLI');
      if (data.data.dbPath) Logger.info(`  数据库: ${data.data.dbPath}`, 'CLI');
    } else {
      Logger.info(`  ${COLORS.dim}无记忆数据${COLORS.reset}`, 'CLI');
    }
  } catch {
    Logger.info(`  ${c(COLORS.red, '❌ 获取记忆统计失败')}`, 'CLI');
  }
  Logger.info('', 'CLI');
}

/**
 * 处理 memory 子命令 — 记忆管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleMemoryCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'stats';

  switch (action) {
    case 'stats': {
      try {
        let data: {
          data?: {
            totalMemories?: number;
            shortTermSize?: number;
            dbPath?: string;
          };
        };

        try {
          const ipcResult = await ipcSend('memory.stats');
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/memory/stats`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`记忆统计\n\n`);
          }
          if (data.data) {
            process.stdout.write(
              `  记忆条数: ${data.data.totalMemories || 0}\n`
            );
            process.stdout.write(
              `  短期记忆: ${data.data.shortTermSize || 0} 字节\n`
            );
            if (data.data.dbPath) {
              process.stdout.write(`  数据库: ${data.data.dbPath}\n`);
            }
          } else {
            process.stdout.write(`  无记忆数据\n`);
          }
        }
      } catch (err) {
        Logger.error('获取记忆统计失败', err as Error, 'MemoryCommand');
        process.stderr.write(`获取记忆统计失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'search': {
      const query = subArgs.slice(1).join(' ');
      if (!query) {
        process.stderr.write('用法: memory search <关键词>\n');
        process.exit(1);
      }
      try {
        let data: {
          results?: Array<{
            content: string;
            similarity: number;
            importance?: string;
          }>;
          total?: number;
        };

        try {
          const ipcResult = await ipcSend('memory.search', { query });
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(
            `${backendUrl}/api/memory/search?query=${encodeURIComponent(query)}`
          );
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(
              `搜索 "${query}" (${data.total ?? 0} 条结果)\n\n`
            );
          }
          const results = data.results || [];
          if (results.length === 0) {
            process.stdout.write(`  未找到相关记忆\n`);
          } else {
            for (let i = 0; i < Math.min(results.length, 10); i++) {
              const r = results[i];
              process.stdout.write(
                `  ${i + 1}. [${(r.similarity * 100).toFixed(0)}%] ${r.content.substring(0, 100)}\n`
              );
            }
          }
        }
      } catch (err) {
        Logger.error('搜索记忆失败', err as Error, 'MemoryCommand');
        process.stderr.write(`搜索记忆失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'store': {
      const content = subArgs.slice(1).join(' ');
      if (!content) {
        process.stderr.write('用法: memory store <内容>\n');
        process.exit(1);
      }
      try {
        let data: { success?: boolean; id?: string };

        try {
          const ipcResult = await ipcSend('memory.store', {
            content,
            type: 'long',
          });
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/memory/store`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, type: 'long' }),
          });
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (data.success) {
            process.stdout.write(`✅ 记忆已存储 (ID: ${data.id || '--'})\n`);
          } else {
            process.stderr.write(`❌ 存储记忆失败\n`);
          }
        }
      } catch (err) {
        Logger.error('存储记忆失败', err as Error, 'MemoryCommand');
        process.stderr.write(`存储记忆失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'profile': {
      try {
        let data: Record<string, unknown>;

        try {
          const ipcResult = await ipcSend('memory.profile');
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/memory/profile`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`用户画像\n\n`);
          }
          const sections: Array<{ label: string; key: string }> = [
            { label: '基本信息', key: 'basicInfo' },
            { label: '开发习惯', key: 'developmentHabits' },
            { label: '生活偏好', key: 'lifePreferences' },
            { label: '情绪模式', key: 'emotionalPatterns' },
            { label: '任务偏好', key: 'taskPreferences' },
          ];
          let hasData = false;
          for (const s of sections) {
            const sectionData = data[s.key] as
              | Record<string, unknown>
              | undefined;
            if (sectionData && Object.keys(sectionData).length > 0) {
              hasData = true;
              process.stdout.write(`  ${s.label}:\n`);
              for (const [k, v] of Object.entries(sectionData)) {
                const display =
                  typeof v === 'object' ? JSON.stringify(v) : String(v);
                process.stdout.write(`    ${k}: ${display}\n`);
              }
              process.stdout.write('\n');
            }
          }
          if (!hasData) {
            process.stdout.write(`  画像数据为空，继续使用系统后将自动学习\n`);
          }
        }
      } catch (err) {
        Logger.error('获取用户画像失败', err as Error, 'MemoryCommand');
        process.stderr.write(`获取用户画像失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 memory 子命令: ${action}\n`);
      process.stderr.write(
        '用法: memory [stats|search <关键词>|store <内容>|profile]\n'
      );
      process.exit(1);
  }
}

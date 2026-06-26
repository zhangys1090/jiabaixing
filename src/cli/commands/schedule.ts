import * as readline from 'readline';
import { Logger } from '../../utils/Logger';
import { COLORS, backendUrl } from '../constants';
import { requestWithFallback, ipcSend } from '../ipc';
import { ask } from '../repl';
import { SubcommandOptions } from '../types';

/**
 * 处理 /schedule 交互菜单（REPL 模式）
 * @param rl - readline 接口
 */
export async function handleScheduleMenu(
  rl: readline.Interface
): Promise<void> {
  while (true) {
    Logger.info(
      `\n  ${COLORS.bold}${COLORS.cyan}SCHEDULE 定时任务 & 自动化${COLORS.reset}\n`,
      'CLI'
    );
    Logger.info(
      `  内置任务: 早安简报(8:00) · 情绪检查(30min) · 任务提醒(15min) · 行为分析(2:00)\n`,
      'CLI'
    );
    Logger.info(`  ${COLORS.cyan}list${COLORS.reset}    查看所有任务`, 'CLI');
    Logger.info(`  ${COLORS.cyan}add${COLORS.reset}     添加新任务`, 'CLI');
    Logger.info(`  ${COLORS.cyan}toggle${COLORS.reset}  启用/禁用`, 'CLI');
    Logger.info(`  ${COLORS.cyan}run${COLORS.reset}     手动执行`, 'CLI');
    Logger.info(`  ${COLORS.cyan}triggers${COLORS.reset} 触发器队列`, 'CLI');
    Logger.info(`  ${COLORS.cyan}patterns${COLORS.reset} 行为模式`, 'CLI');
    Logger.info(`  ${COLORS.dim}  back  返回${COLORS.reset}\n`, 'CLI');

    const choice = await ask(rl, `  ${COLORS.cyan}schedule${COLORS.reset}> `);
    if (choice === 'back') return;

    switch (choice) {
      case 'list': {
        try {
          const result = await requestWithFallback<{
            data?: Array<Record<string, unknown>>;
            success?: boolean;
          }>('automation.tasks', {}, { path: '/api/automation/tasks' });
          const tasks: Array<Record<string, unknown>> = Array.isArray(
            result.data
          )
            ? result.data
            : Array.isArray(result)
              ? (result as Array<Record<string, unknown>>)
              : [];

          Logger.info('\n  定时任务:\n', 'CLI');
          if (Array.isArray(tasks) && tasks.length > 0) {
            for (const t of tasks) {
              const enabled = t.enabled as boolean;
              const status = enabled ? '🟢 启用' : '⚪ 禁用';
              Logger.info(`  ${status} ${t.name || t.id}`, 'CLI');
              Logger.info(
                `     cron: ${t.schedule || t.cronExpression || '-'}  |  执行 ${t.executionCount || 0} 次\n`,
                'CLI'
              );
            }
          } else {
            Logger.info('  (暂无任务数据，请先启动后端服务)\n', 'CLI');
          }
        } catch {
          Logger.info('  ⚠️ 后端服务未启动\n', 'CLI');
        }
        break;
      }
      case 'add': {
        const name = await ask(rl, '  任务名称: ');
        const cron = await ask(rl, '  Cron 表达式 (例: 0 8 * * *): ');
        const desc = await ask(rl, '  描述: ');
        try {
          const res = await requestWithFallback<Record<string, unknown>>(
            'schedule.add',
            { name, schedule: cron, description: desc, enabled: true },
            {
              path: '/api/automation/tasks',
              method: 'POST',
              body: { name, schedule: cron, description: desc, enabled: true },
            }
          );

          Logger.info(
            res.success ? `  ✅ 任务 "${name}" 已创建` : `  ❌ 创建失败`,
            'CLI'
          );
        } catch {
          Logger.info('  ⚠️ 后端服务未启动', 'CLI');
        }
        break;
      }
      case 'toggle': {
        const id = await ask(rl, '  任务ID: ');
        try {
          const res = await requestWithFallback<Record<string, unknown>>(
            'automation.task_toggle',
            { id },
            { path: `/api/automation/tasks/${id}/toggle`, method: 'PATCH' }
          );

          Logger.info(res.success ? '  ✅ 已切换' : '  ❌ 失败', 'CLI');
        } catch {
          Logger.info('  ⚠️ 后端服务未启动', 'CLI');
        }
        break;
      }
      case 'run': {
        const id = await ask(rl, '  任务ID: ');
        try {
          const res = await requestWithFallback<Record<string, unknown>>(
            'automation.task_execute',
            { id },
            { path: `/api/automation/tasks/${id}/execute`, method: 'POST' }
          );

          Logger.info(
            res.success ? '  ✅ 已执行' : `  ❌ 失败: ${res.error || ''}`,
            'CLI'
          );
        } catch {
          Logger.info('  ⚠️ 后端服务未启动', 'CLI');
        }
        break;
      }
      case 'triggers': {
        try {
          const ipcResult = await requestWithFallback<{
            triggers: Array<Record<string, unknown>>;
            count: number;
          }>('automation.triggers', {}, { path: '/api/automation/triggers' });
          const triggers: Array<Record<string, unknown>> = Array.isArray(
            ipcResult.triggers
          )
            ? ipcResult.triggers
            : [];

          Logger.info('\n  触发器队列:\n', 'CLI');
          if (Array.isArray(triggers) && triggers.length > 0) {
            for (const t of triggers) {
              Logger.info(
                `  🔔 [${t.type}] ${t.reason} (优先级: ${t.priority})`,
                'CLI'
              );
            }
          } else {
            Logger.info('  (队列为空)\n', 'CLI');
          }
        } catch {
          Logger.info('  ⚠️ 后端服务未启动', 'CLI');
        }
        break;
      }
      case 'patterns': {
        try {
          const ipcResult = await requestWithFallback<{
            patterns: Record<string, unknown>;
          }>('automation.patterns', {}, { path: '/api/automation/patterns' });
          const patterns: Record<string, unknown> = ipcResult.patterns || {};

          Logger.info('\n  用户行为模式:\n', 'CLI');
          if (patterns.activeHours) {
            Logger.info(
              `  活跃时段: ${(patterns.activeHours as string[]).join(', ')}`,
              'CLI'
            );
            Logger.info(
              `  常用话题: ${((patterns.frequentTopics as string[]) || []).join(', ')}`,
              'CLI'
            );
            Logger.info(
              `  任务完成率: ${Math.round(((patterns.taskCompletionRate as number) || 0) * 100)}%`,
              'CLI'
            );
          } else {
            Logger.info('  (暂无足够数据)\n', 'CLI');
          }
        } catch {
          Logger.info('  ⚠️ 后端服务未启动', 'CLI');
        }
        break;
      }
      default:
        Logger.info('  未知命令', 'CLI');
    }
  }
}

/**
 * 处理 schedule 子命令 — 定时任务管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleScheduleCommand(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        let data: {
          data?: Array<Record<string, unknown>>;
          success?: boolean;
        };

        try {
          const ipcResult = await ipcSend('automation.tasks.list');
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/automation/tasks`);
          data = (await resp.json()) as typeof data;
        }

        const tasks = Array.isArray(data.data)
          ? data.data
          : Array.isArray(data)
            ? (data as Array<Record<string, unknown>>)
            : [];

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`定时任务 (${tasks.length})\n\n`);
          }
          for (const t of tasks) {
            const enabled = t.enabled as boolean;
            const status = enabled ? '🟢 启用' : '⚪ 禁用';
            process.stdout.write(
              `  ${status} ${t.name || t.id}  cron: ${t.schedule || t.cronExpression || '-'}  执行 ${t.executionCount || 0} 次\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取定时任务失败', err as Error, 'ScheduleCommand');
        process.stderr.write(`获取定时任务失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'add': {
      const name = subArgs[1];
      const cron = subArgs[2];
      const desc = subArgs.slice(3).join(' ') || '';

      if (!name || !cron) {
        process.stderr.write(
          '错误: schedule add 需要提供任务名称和 cron 表达式\n'
        );
        process.stderr.write('用法: schedule add <名称> <cron> [描述]\n');
        process.exit(1);
      }

      Logger.info(`添加定时任务: ${name}`, 'ScheduleCommand');

      try {
        let data: Record<string, unknown>;

        try {
          const ipcResult = await ipcSend('automation.tasks.add', {
            name,
            schedule: cron,
            description: desc,
            enabled: true,
          });
          data = ipcResult as Record<string, unknown>;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/automation/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              schedule: cron,
              description: desc,
              enabled: true,
            }),
          });
          data = (await resp.json()) as Record<string, unknown>;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const success = data.success as boolean;
          process.stdout.write(
            success ? `✅ 任务 "${name}" 已创建\n` : `❌ 创建失败\n`
          );
        }
      } catch (err) {
        Logger.error('添加定时任务失败', err as Error, 'ScheduleCommand');
        process.stderr.write(`添加定时任务失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 schedule 子命令: ${action}\n`);
      process.stderr.write(
        '用法: schedule list | schedule add <名称> <cron> [描述]\n'
      );
      process.exit(1);
  }
}

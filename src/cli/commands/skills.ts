import { Logger } from '../../utils/Logger';
import { COLORS, c, backendUrl } from '../constants';
import { requestWithFallback, ipcSend } from '../ipc';
import { SubcommandOptions } from '../types';
import { stripAnsi } from '../utils';

/**
 * 处理 /skills 命令（REPL 模式）
 * 显示技能列表
 */
export async function handleSkillsCommand(): Promise<void> {
  try {
    const data = await requestWithFallback<{
      skills?: Array<{ name: string; description: string; category: string }>;
      count?: number;
    }>('skill.list', {}, { path: '/api/skills/list' });

    Logger.info(
      `\n  ${COLORS.bold}技能列表 (${data.count || 0})${COLORS.reset}\n`,
      'CLI'
    );
    if (data.skills) {
      for (const skill of data.skills) {
        Logger.info(
          `  ${COLORS.cyan}■${COLORS.reset} ${COLORS.bold}${skill.name}${COLORS.reset}`,
          'CLI'
        );
        Logger.info(
          `    ${COLORS.dim}${skill.description.substring(0, 80)}${skill.description.length > 80 ? '...' : ''}${COLORS.reset}`,
          'CLI'
        );
        Logger.info(
          `    ${COLORS.yellow}分类: ${skill.category}${COLORS.reset}\n`,
          'CLI'
        );
      }
    }
  } catch {
    Logger.info(`  ${c(COLORS.red, '❌ 获取技能列表失败')}`, 'CLI');
  }
  Logger.info('', 'CLI');
}

/**
 * 处理 skill 子命令 — 技能管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleSkillCommand(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        let data: {
          skills?: Array<{
            name: string;
            description: string;
            category: string;
          }>;
          count?: number;
        };

        // 优先尝试 IPC
        try {
          const ipcResult = await ipcSend('skill.list');
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/skills/list`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const skills = data.skills || [];
          if (!options.quiet) {
            process.stdout.write(
              `技能列表 (${data.count || skills.length})\n\n`
            );
          }
          for (const skill of skills) {
            process.stdout.write(
              `  ${skill.name}  ${skill.description.substring(0, 60)}  [${skill.category}]\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取技能列表失败', err as Error, 'SkillCommand');
        process.stderr.write(`获取技能列表失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'execute': {
      const skillName = subArgs[1];
      if (!skillName) {
        process.stderr.write('错误: skill execute 需要提供技能名称\n');
        process.exit(1);
      }
      let params: Record<string, unknown> = {};
      if (subArgs[2]) {
        try {
          params = JSON.parse(subArgs[2]) as Record<string, unknown>;
        } catch {
          params = { query: subArgs.slice(2).join(' ') };
        }
      }

      Logger.info(`执行技能: ${skillName}`, 'SkillCommand');

      try {
        let data: Record<string, unknown>;

        try {
          const ipcResult = await ipcSend('skill.execute', {
            skillName,
            params,
          });
          data = ipcResult as Record<string, unknown>;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/skills/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skillName, params }),
            signal: AbortSignal.timeout(120000),
          });
          data = (await resp.json()) as Record<string, unknown>;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const output =
            (data.output as string) ||
            (data.error as string) ||
            JSON.stringify(data);
          process.stdout.write(stripAnsi(output) + '\n');
        }
      } catch (err) {
        Logger.error('技能执行失败', err as Error, 'SkillCommand');
        process.stderr.write(`技能执行失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 skill 子命令: ${action}\n`);
      process.stderr.write('用法: skill list | skill execute <名称> [参数]\n');
      process.exit(1);
  }
}

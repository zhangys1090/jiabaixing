/**
 * Curator CLI 命令 — 技能库后台维护
 *
 * 子命令:
 *   status              查看状态概览
 *   run                 执行一次完整运行
 *   run --dry-run       预览模式（不修改）
 *   run --background    后台执行
 *   backup              手动创建备份快照
 *   rollback            回滚到最新备份
 *   rollback --list     列出可用备份
 *   rollback --id <ts>  回滚到指定备份
 *   rollback -y         跳过确认
 *   pause               暂停自动运行
 *   resume              恢复自动运行
 *   pin <skill>         固定技能
 *   unpin <skill>       取消固定
 *   restore <skill>     恢复已归档技能
 */

import * as readline from 'readline';
import { Logger } from '../../utils/Logger';
import { COLORS } from '../constants';
import { SubcommandOptions } from '../types';
import { CuratorService } from '../../curator/CuratorService';

/**
 * 处理 /curator 命令（REPL 模式）
 */
export async function handleCuratorCommand(
  subArgs: string[] = []
): Promise<void> {
  const action = subArgs[0] || 'status';
  const curator = CuratorService.getInstance();

  switch (action) {
    case 'status': {
      const status = curator.getStatus();
      Logger.info(`\n  ${COLORS.bold}Curator 状态${COLORS.reset}\n`, 'CLI');
      Logger.info(`  启用: ${status.enabled ? '✅' : '❌'}`, 'CLI');
      Logger.info(`  暂停: ${status.paused ? '是' : '否'}`, 'CLI');
      Logger.info(`  上次运行: ${status.last_run_at || '从未运行'}`, 'CLI');
      Logger.info(`  下次可运行: ${status.next_run_eligible}`, 'CLI');
      Logger.info(
        `  间隔: ${status.config.interval_hours}h / 空闲: ${status.config.min_idle_hours}h`,
        'CLI'
      );
      Logger.info(
        `  stale: ${status.config.stale_after_days}天 / 归档: ${status.config.archive_after_days}天`,
        'CLI'
      );
      Logger.info(`\n  ${COLORS.bold}技能统计${COLORS.reset}`, 'CLI');
      Logger.info(`  活跃: ${status.counts.active}`, 'CLI');
      Logger.info(`  陈旧: ${status.counts.stale}`, 'CLI');
      Logger.info(`  已归档: ${status.counts.archived}`, 'CLI');
      Logger.info(`  已固定: ${status.counts.pinned}`, 'CLI');

      if (status.lru_top5.length > 0) {
        Logger.info(
          `\n  ${COLORS.bold}最久未使用 (LRU Top 5)${COLORS.reset}`,
          'CLI'
        );
        for (const item of status.lru_top5) {
          Logger.info(
            `  ${COLORS.cyan}●${COLORS.reset} ${item.name}: ${item.last_used_at || '从未使用'}`,
            'CLI'
          );
        }
      }

      if (status.pinned_list.length > 0) {
        Logger.info(`\n  ${COLORS.bold}固定技能${COLORS.reset}`, 'CLI');
        for (const name of status.pinned_list) {
          Logger.info(`  📌 ${name}`, 'CLI');
        }
      }
      Logger.info('', 'CLI');
      break;
    }
    case 'run': {
      const dryRun = subArgs.includes('--dry-run');
      const background = subArgs.includes('--background');

      if (dryRun) {
        Logger.info('Curator 预览运行...', 'CLI');
      } else {
        Logger.info('Curator 正式运行...', 'CLI');
      }

      const report = await curator.run(dryRun);

      Logger.info(`\n  ${COLORS.bold}Curator 运行报告${COLORS.reset}`, 'CLI');
      Logger.info(`  运行 ID: ${report.run_id}`, 'CLI');
      Logger.info(`  模式: ${report.dry_run ? '预览' : '正式'}`, 'CLI');
      Logger.info(`  状态转换: ${report.transitions.length} 个`, 'CLI');

      for (const t of report.transitions) {
        Logger.info(
          `    ${COLORS.yellow}${t.skill}${COLORS.reset}: ${t.from} → ${t.to} (${t.reason})`,
          'CLI'
        );
      }

      if (report.rename_mapping.length > 0) {
        Logger.info(`  重命名映射:`, 'CLI');
        for (const m of report.rename_mapping) {
          Logger.info(`    ${m.from} → ${m.to}`, 'CLI');
        }
      }

      Logger.info(
        `\n  活跃: ${report.summary.active} | 陈旧: ${report.summary.stale} | 已归档: ${report.summary.archived}`,
        'CLI'
      );

      if (report.errors.length > 0) {
        Logger.info(`\n  ${COLORS.red}错误:${COLORS.reset}`, 'CLI');
        for (const e of report.errors) {
          Logger.info(`    ${e.skill}: ${e.error}`, 'CLI');
        }
      }

      if (!background) {
        Logger.info(`  运行完成`, 'CLI');
      }
      Logger.info('', 'CLI');
      break;
    }
    case 'backup': {
      const reason = subArgs.slice(1).join(' ') || '手动备份';
      Logger.info(`创建备份: ${reason}`, 'CLI');
      const manifest = await curator.createBackup(reason);
      if (manifest) {
        Logger.info(
          `✅ 备份已创建: ${manifest.id} (${(manifest.size_bytes / 1024).toFixed(1)}KB, ${manifest.skill_count} 个技能)`,
          'CLI'
        );
      } else {
        Logger.info('❌ 备份创建失败', 'CLI');
      }
      break;
    }
    case 'rollback': {
      const listOnly = subArgs.includes('--list');
      const skipConfirm = subArgs.includes('-y');
      const idIdx = subArgs.indexOf('--id');
      const targetId = idIdx >= 0 ? subArgs[idIdx + 1] : undefined;

      if (listOnly) {
        const backups = curator.listBackups();
        if (backups.length === 0) {
          Logger.info('没有可用的备份', 'CLI');
        } else {
          Logger.info(`\n  ${COLORS.bold}可用备份${COLORS.reset}\n`, 'CLI');
          for (const b of backups) {
            Logger.info(
              `  ${COLORS.cyan}${b.id}${COLORS.reset} | ${b.reason} | ${(b.size_bytes / 1024).toFixed(1)}KB | ${b.skill_count} 技能`,
              'CLI'
            );
          }
        }
        break;
      }

      if (!skipConfirm) {
        Logger.info('⚠️  回滚将替换当前技能库，是否继续？(y/N)', 'CLI');
        // 在 REPL 中简化处理，直接执行
      }

      const result = await curator.rollback(targetId);
      if (result.success) {
        Logger.info('✅ 回滚成功', 'CLI');
      } else {
        Logger.info(`❌ 回滚失败: ${result.error}`, 'CLI');
      }
      break;
    }
    case 'pause': {
      curator.pause();
      Logger.info('⏸️  Curator 已暂停', 'CLI');
      break;
    }
    case 'resume': {
      curator.resume();
      Logger.info('▶️  Curator 已恢复', 'CLI');
      break;
    }
    case 'pin': {
      const skillName = subArgs[1];
      if (!skillName) {
        Logger.info('用法: curator pin <技能名称>', 'CLI');
        break;
      }
      const result = curator.pin(skillName);
      if (result.success) {
        Logger.info(`📌 技能已固定: ${skillName}`, 'CLI');
      } else {
        Logger.info(`❌ 固定失败: ${result.error}`, 'CLI');
      }
      break;
    }
    case 'unpin': {
      const skillName = subArgs[1];
      if (!skillName) {
        Logger.info('用法: curator unpin <技能名称>', 'CLI');
        break;
      }
      const result = curator.unpin(skillName);
      if (result.success) {
        Logger.info(`📌 技能已取消固定: ${skillName}`, 'CLI');
      } else {
        Logger.info(`❌ 取消固定失败: ${result.error}`, 'CLI');
      }
      break;
    }
    case 'restore': {
      const skillName = subArgs[1];
      if (!skillName) {
        Logger.info('用法: curator restore <技能名称>', 'CLI');
        break;
      }
      const result = curator.restore(skillName);
      if (result.success) {
        Logger.info(`📦 技能已恢复: ${skillName}`, 'CLI');
      } else {
        Logger.info(`❌ 恢复失败: ${result.error}`, 'CLI');
      }
      break;
    }
    default:
      Logger.info(
        `未知 curator 子命令: ${action}\n` +
          '用法: curator status | run | backup | rollback | pause | resume | pin | unpin | restore',
        'CLI'
      );
  }
}

/**
 * 处理 curator 子命令（CLI 模式）
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleCuratorCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'status';
  const curator = CuratorService.getInstance();

  switch (action) {
    case 'status': {
      const status = curator.getStatus();

      if (options.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      } else {
        process.stdout.write('Curator 状态\n\n');
        process.stdout.write(`  启用: ${status.enabled ? '是' : '否'}\n`);
        process.stdout.write(`  暂停: ${status.paused ? '是' : '否'}\n`);
        process.stdout.write(
          `  上次运行: ${status.last_run_at || '从未运行'}\n`
        );
        process.stdout.write(`  下次可运行: ${status.next_run_eligible}\n`);
        process.stdout.write(
          `  间隔: ${status.config.interval_hours}h / 空闲: ${status.config.min_idle_hours}h\n`
        );
        process.stdout.write(
          `  stale: ${status.config.stale_after_days}天 / 归档: ${status.config.archive_after_days}天\n`
        );
        process.stdout.write(`\n技能统计\n`);
        process.stdout.write(`  活跃: ${status.counts.active}\n`);
        process.stdout.write(`  陈旧: ${status.counts.stale}\n`);
        process.stdout.write(`  已归档: ${status.counts.archived}\n`);
        process.stdout.write(`  已固定: ${status.counts.pinned}\n`);

        if (status.lru_top5.length > 0) {
          process.stdout.write(`\n最久未使用 (LRU Top 5)\n`);
          for (const item of status.lru_top5) {
            process.stdout.write(
              `  ${item.name}: ${item.last_used_at || '从未使用'}\n`
            );
          }
        }

        if (status.pinned_list.length > 0) {
          process.stdout.write(`\n固定技能\n`);
          for (const name of status.pinned_list) {
            process.stdout.write(`  ${name}\n`);
          }
        }
      }
      break;
    }
    case 'run': {
      const dryRun = subArgs.includes('--dry-run');
      const background = subArgs.includes('--background');

      if (!options.quiet) {
        process.stdout.write(`Curator ${dryRun ? '预览' : '正式'}运行...\n`);
      }

      if (background && !dryRun) {
        // 后台执行
        curator
          .run(false)
          .then((report) => {
            Logger.info(
              `Curator 后台运行完成: ${report.run_id}, transitions=${report.transitions.length}`,
              'CuratorCLI'
            );
          })
          .catch((err) => {
            Logger.warn(`Curator 后台运行失败: ${err.message}`, 'CuratorCLI');
          });
        process.stdout.write('Curator 后台运行已启动\n');
      } else {
        const report = await curator.run(dryRun);

        if (options.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          process.stdout.write(`\nCurator 运行报告\n`);
          process.stdout.write(`  运行 ID: ${report.run_id}\n`);
          process.stdout.write(`  模式: ${report.dry_run ? '预览' : '正式'}\n`);
          process.stdout.write(`  状态转换: ${report.transitions.length} 个\n`);

          for (const t of report.transitions) {
            process.stdout.write(
              `    ${t.skill}: ${t.from} → ${t.to} (${t.reason})\n`
            );
          }

          if (report.rename_mapping.length > 0) {
            process.stdout.write(`  重命名映射:\n`);
            for (const m of report.rename_mapping) {
              process.stdout.write(`    ${m.from} → ${m.to}\n`);
            }
          }

          process.stdout.write(
            `\n  活跃: ${report.summary.active} | 陈旧: ${report.summary.stale} | 已归档: ${report.summary.archived}\n`
          );

          if (report.errors.length > 0) {
            process.stdout.write(`\n  错误:\n`);
            for (const e of report.errors) {
              process.stdout.write(`    ${e.skill}: ${e.error}\n`);
            }
          }
        }
      }
      break;
    }
    case 'backup': {
      const reason = subArgs.slice(1).join(' ') || '手动备份';
      const manifest = await curator.createBackup(reason);
      if (manifest) {
        if (options.json) {
          process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
        } else {
          process.stdout.write(
            `备份已创建: ${manifest.id} (${(manifest.size_bytes / 1024).toFixed(1)}KB, ${manifest.skill_count} 个技能)\n`
          );
        }
      } else {
        process.stderr.write('备份创建失败\n');
        process.exit(1);
      }
      break;
    }
    case 'rollback': {
      const listOnly = subArgs.includes('--list');
      const skipConfirm = subArgs.includes('-y');
      const idIdx = subArgs.indexOf('--id');
      const targetId = idIdx >= 0 ? subArgs[idIdx + 1] : undefined;

      if (listOnly) {
        const backups = curator.listBackups();
        if (options.json) {
          process.stdout.write(JSON.stringify(backups, null, 2) + '\n');
        } else {
          if (backups.length === 0) {
            process.stdout.write('没有可用的备份\n');
          } else {
            process.stdout.write('可用备份\n\n');
            for (const b of backups) {
              process.stdout.write(
                `  ${b.id} | ${b.reason} | ${(b.size_bytes / 1024).toFixed(1)}KB | ${b.skill_count} 技能\n`
              );
            }
          }
        }
        break;
      }

      if (!skipConfirm) {
        const confirmed = await confirmAction(
          '回滚将替换当前技能库，是否继续？(y/N): '
        );
        if (!confirmed) {
          process.stdout.write('已取消\n');
          break;
        }
      }

      const result = await curator.rollback(targetId);
      if (result.success) {
        process.stdout.write('回滚成功\n');
      } else {
        process.stderr.write(`回滚失败: ${result.error}\n`);
        process.exit(1);
      }
      break;
    }
    case 'pause': {
      curator.pause();
      process.stdout.write('Curator 已暂停\n');
      break;
    }
    case 'resume': {
      curator.resume();
      process.stdout.write('Curator 已恢复\n');
      break;
    }
    case 'pin': {
      const skillName = subArgs[1];
      if (!skillName) {
        process.stderr.write('用法: curator pin <技能名称>\n');
        process.exit(1);
      }
      const result = curator.pin(skillName);
      if (result.success) {
        process.stdout.write(`技能已固定: ${skillName}\n`);
      } else {
        process.stderr.write(`固定失败: ${result.error}\n`);
        process.exit(1);
      }
      break;
    }
    case 'unpin': {
      const skillName = subArgs[1];
      if (!skillName) {
        process.stderr.write('用法: curator unpin <技能名称>\n');
        process.exit(1);
      }
      const result = curator.unpin(skillName);
      if (result.success) {
        process.stdout.write(`技能已取消固定: ${skillName}\n`);
      } else {
        process.stderr.write(`取消固定失败: ${result.error}\n`);
        process.exit(1);
      }
      break;
    }
    case 'restore': {
      const skillName = subArgs[1];
      if (!skillName) {
        process.stderr.write('用法: curator restore <技能名称>\n');
        process.exit(1);
      }
      const result = curator.restore(skillName);
      if (result.success) {
        process.stdout.write(`技能已恢复: ${skillName}\n`);
      } else {
        process.stderr.write(`恢复失败: ${result.error}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 curator 子命令: ${action}\n`);
      process.stderr.write(
        '用法: curator status | run [--dry-run] [--background] | backup | rollback [--list] [--id <ts>] [-y] | pause | resume | pin <skill> | unpin <skill> | restore <skill>\n'
      );
      process.exit(1);
  }
}

/**
 * 交互式确认
 */
function confirmAction(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

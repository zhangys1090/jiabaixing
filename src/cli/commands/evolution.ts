import { Logger } from '../../utils/Logger';
import { COLORS, c, backendUrl } from '../constants';
import { requestWithFallback, ipcSend } from '../ipc';
import { SubcommandOptions } from '../types';

/**
 * 处理 /evolution 命令（REPL 模式）
 * 显示进化数据
 */
export async function handleEvolutionCommand(): Promise<void> {
  try {
    const data = await requestWithFallback<{
      orchestrator?: {
        totalInteractions?: number;
        totalOptimizations?: number;
        averageQualityScore?: number;
        qualityTrend?: string;
        failureRate?: number;
        cyclesToday?: number;
        totalCycles?: number;
        userProfileConfidence?: number;
        lastCycleTime?: number;
      };
      enginesActive?: string[];
    }>('evolution.status', {}, { path: '/api/evolution/status' });

    Logger.info(`\n  ${COLORS.bold}进化数据${COLORS.reset}\n`, 'CLI');
    if (data.orchestrator) {
      const o = data.orchestrator;
      Logger.info(`  交互: ${o.totalInteractions || 0} 次`, 'CLI');
      Logger.info(`  优化: ${o.totalOptimizations || 0} 次`, 'CLI');
      Logger.info(
        `  平均质量: ${(o.averageQualityScore || 0).toFixed(3)}`,
        'CLI'
      );
      Logger.info(`  趋势: ${o.qualityTrend || 'stable'}`, 'CLI');
      Logger.info(
        `  失败率: ${((o.failureRate || 0) * 100).toFixed(1)}%`,
        'CLI'
      );
      Logger.info(`  今日周期: ${o.cyclesToday || 0}`, 'CLI');
      Logger.info(`  总周期: ${o.totalCycles || 0}`, 'CLI');
      if (o.lastCycleTime) {
        const ago = Math.round((Date.now() - o.lastCycleTime) / 60000);
        Logger.info(`  上次优化: ${ago} 分钟前`, 'CLI');
      }
      if (o.userProfileConfidence) {
        Logger.info(
          `  画像置信度: ${(o.userProfileConfidence * 100).toFixed(0)}%`,
          'CLI'
        );
      }
    } else {
      Logger.info(`  ${COLORS.dim}进化引擎未启动${COLORS.reset}`, 'CLI');
    }
    if (data.enginesActive?.length) {
      Logger.info(`  活跃引擎: ${data.enginesActive.join(', ')}`, 'CLI');
    }

    // 额外获取优化结果详情
    try {
      const metricsData = await requestWithFallback<{
        data?: {
          optimizationHistory?: Array<{
            id: string;
            reason: string;
            toneAdjustments: Array<unknown>;
            skillAdjustments: Array<unknown>;
            promptExamples: Array<unknown>;
          }>;
        };
      }>('evolution.metrics', {}, { path: '/api/evolution/metrics' });
      const history = metricsData.data?.optimizationHistory;
      if (history && history.length > 0) {
        Logger.info(`\n  ${COLORS.dim}最近优化:${COLORS.reset}`, 'CLI');
        for (const h of history.slice(-3)) {
          const tone = h.toneAdjustments?.length || 0;
          const skill = h.skillAdjustments?.length || 0;
          const prompt = h.promptExamples?.length || 0;
          Logger.info(
            `    ${COLORS.cyan}●${COLORS.reset} ${h.reason.substring(0, 40)} → 语气${tone} 技能${skill} 示例${prompt}`,
            'CLI'
          );
        }
      }
    } catch {
      Logger.warn('展示进化历史详情失败', 'EvolutionCommand');
    }
  } catch {
    Logger.info(`  ${c(COLORS.red, '❌ 获取进化数据失败')}`, 'CLI');
  }
  Logger.info('', 'CLI');
}

/**
 * 处理 evolution 子命令 — 查看进化状态
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleEvolutionCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'status';

  switch (action) {
    case 'status': {
      try {
        let data: {
          orchestrator?: {
            totalInteractions?: number;
            totalOptimizations?: number;
            averageQualityScore?: number;
            qualityTrend?: string;
            failureRate?: number;
            cyclesToday?: number;
            totalCycles?: number;
            userProfileConfidence?: number;
            lastCycleTime?: number;
          };
          enginesActive?: string[];
        };

        try {
          const ipcResult = await ipcSend('evolution.status');
          data = ipcResult as typeof data;
        } catch {
          Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
          const resp = await fetch(`${backendUrl}/api/evolution/status`);
          data = (await resp.json()) as typeof data;
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`进化数据\n\n`);
          }
          if (data.orchestrator) {
            const o = data.orchestrator;
            process.stdout.write(`  交互: ${o.totalInteractions || 0} 次\n`);
            process.stdout.write(`  优化: ${o.totalOptimizations || 0} 次\n`);
            process.stdout.write(
              `  平均质量: ${(o.averageQualityScore || 0).toFixed(3)}\n`
            );
            process.stdout.write(`  趋势: ${o.qualityTrend || 'stable'}\n`);
            process.stdout.write(
              `  失败率: ${((o.failureRate || 0) * 100).toFixed(1)}%\n`
            );
            process.stdout.write(`  今日周期: ${o.cyclesToday || 0}\n`);
            process.stdout.write(`  总周期: ${o.totalCycles || 0}\n`);
            if (o.lastCycleTime) {
              const ago = Math.round((Date.now() - o.lastCycleTime) / 60000);
              process.stdout.write(`  上次优化: ${ago} 分钟前\n`);
            }
            if (o.userProfileConfidence) {
              process.stdout.write(
                `  画像置信度: ${(o.userProfileConfidence * 100).toFixed(0)}%\n`
              );
            }
          } else {
            process.stdout.write(`  进化引擎未启动\n`);
          }
          if (data.enginesActive?.length) {
            process.stdout.write(
              `  活跃引擎: ${data.enginesActive.join(', ')}\n`
            );
          }
        }
      } catch (err) {
        Logger.error('获取进化状态失败', err as Error, 'EvolutionCommand');
        process.stderr.write(`获取进化状态失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 evolution 子命令: ${action}\n`);
      process.stderr.write('用法: evolution status\n');
      process.exit(1);
  }
}

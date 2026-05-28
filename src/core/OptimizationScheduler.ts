import * as fs from 'fs';
import path from 'path';
import { EventBus } from '../shared/EventBus';
import { HeuristicSuggestion } from '../interfaces';
import { Logger } from '../utils/Logger';

interface OptimizationReport {
  timestamp?: string;
  generatedAt?: string;
  analysisWindow: { start: string; end: string } | string;
  toolWeightAdjustments?: unknown[];
  heuristicSuggestions?: HeuristicSuggestion[];
}

interface IMemoryEngine {
  storeFeedbackSignal?: (signal: {
    traceId?: string;
    toolName: string;
    feedbackType: string;
    rating: number;
    message: string;
  }) => Promise<void>;
}

export interface OptimizationDependencies {
  memoryEngine: IMemoryEngine | null;
}

export class OptimizationScheduler {
  private optimizationScheduler: NodeJS.Timeout | null = null;

  constructor(private deps: OptimizationDependencies) {}

  async applyOptimizationsFromReport(): Promise<void> {
    const traceId = Logger.generateTraceId();
    Logger.setTraceId(traceId);

    const reportPath = path.join(
      process.cwd(),
      'data',
      'feedback',
      'feedback_analysis_report.json'
    );

    Logger.info(
      '🤖 自动优化调度：开始扫描优化报告...',
      'OptimizationScheduler'
    );

    if (!fs.existsSync(reportPath)) {
      Logger.info(
        `⏭️ 自动优化调度：未找到报告文件 (${reportPath})，跳过`,
        'OptimizationScheduler'
      );
      Logger.clearTraceId();
      return;
    }

    try {
      const reportContent = await fs.promises.readFile(reportPath, 'utf-8');
      const report: OptimizationReport = JSON.parse(reportContent);

      const reportTimestamp = report.timestamp || report.generatedAt || '未知';
      const analysisWindowStr =
        typeof report.analysisWindow === 'string'
          ? report.analysisWindow
          : `${report.analysisWindow.start} ~ ${report.analysisWindow.end}`;

      Logger.info(
        `📊 自动优化调度：加载报告 [${reportTimestamp}]，分析窗口: ${analysisWindowStr}`,
        'OptimizationScheduler'
      );

      if (
        report.heuristicSuggestions &&
        report.heuristicSuggestions.length > 0
      ) {
        Logger.info(
          `启发式建议: ${report.heuristicSuggestions.length} 项（由 LLM FC 循环自动处理）`,
          'OptimizationScheduler'
        );
      }

      Logger.info(
        `✅ 自动优化调度：处理完成（工具权重调整由 LLM FC 循环驱动）`,
        'OptimizationScheduler'
      );
    } catch (error) {
      Logger.error(
        '❌ 自动优化调度：处理报告失败',
        error as Error,
        'OptimizationScheduler'
      );
    }

    Logger.clearTraceId();
  }

  watchAnalysisReport(): void {
    const reportPath = path.join(
      process.cwd(),
      'data',
      'feedback',
      'feedback_analysis_report.json'
    );

    fs.watchFile(reportPath, { interval: 10000 }, async (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        Logger.info(
          '📡 检测到优化报告更新，正在热加载...',
          'OptimizationScheduler'
        );
        await this.applyOptimizationsFromReport();
        Logger.info('✅ 优化报告已热加载', 'OptimizationScheduler');
      }
    });

    Logger.info('🔍 已启动优化报告热监视', 'OptimizationScheduler');
  }

  startOptimizationScheduler(): void {
    const INTERVAL_24H = 24 * 60 * 60 * 1000;

    this.optimizationScheduler = setInterval(async () => {
      Logger.info(
        '⏰ 定时调度触发：开始执行自动优化...',
        'OptimizationScheduler'
      );
      await this.applyOptimizationsFromReport();
    }, INTERVAL_24H);

    Logger.info(
      `⏰ 自动优化定时调度已启动，间隔: 24小时`,
      'OptimizationScheduler'
    );
  }

  setupUserCorrectionHandler(): void {
    EventBus.on('user_correction', async (data: unknown) => {
      try {
        const payload = data as Record<string, unknown>;
        const toolId = (payload.toolId || payload.tool_name) as
          | string
          | undefined;
        const correctionType = (payload.correctionType ||
          payload.type) as string;
        const reason = (payload.reason || payload.message) as string;
        const severity = Number(payload.severity) || 1;
        const traceId = (payload.traceId || payload.trace_id) as
          | string
          | undefined;

        if (!toolId) {
          Logger.warn(
            '⚠️ user_correction事件缺少toolId',
            'OptimizationScheduler'
          );
          return;
        }

        const mem = this.deps.memoryEngine as IMemoryEngine | undefined;
        if (mem?.storeFeedbackSignal) {
          await mem.storeFeedbackSignal({
            traceId,
            toolName: toolId,
            feedbackType: 'correction',
            rating: severity > 0 ? 1 : 4,
            message: `[${correctionType}] ${reason || '未提供原因'}`,
          });
        }

        Logger.info(
          `🎯 用户纠错已记录: [${toolId}] ${correctionType}, 原因: ${reason}`,
          'OptimizationScheduler'
        );
      } catch (error) {
        Logger.warn(
          '⚠️ 处理user_correction事件失败: ' + (error as Error).message,
          'OptimizationScheduler'
        );
      }
    });
    Logger.info('✅ user_correction事件监听器已注册', 'OptimizationScheduler');
  }

  shutdown(): void {
    if (this.optimizationScheduler) {
      clearInterval(this.optimizationScheduler);
      this.optimizationScheduler = null;
    }
  }
}

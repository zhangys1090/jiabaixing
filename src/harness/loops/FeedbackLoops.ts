/**
 * FeedbackLoops — 闭环服务
 *
 * 将 JiabaixingCore 中的内联闭环逻辑提取为独立服务，
 * 通过 AFTER_RESPONSE 钩子触发，与 Core 解耦。
 *
 * 包含 4 个闭环：
 * 1. 进化闭环：质量评分 → EvolutionOrchestrator.recordInteraction
 * 2. 工具失败反馈闭环：工具失败 → FeedbackCollector.recordToolFailure
 * 3. 偏好学习闭环：用户纠正 → PreferenceManager.applyCorrection
 * 4. 自动知识提取：对话 → MemoryAssistant.autoExtractKnowledge
 */

import { EvolutionOrchestrator } from '../../evolution/EvolutionOrchestrator';
import { Logger } from '../../utils/Logger';
import type {
  FeedbackCollectorDeps,
  EvolutionEngineDeps,
  MemoryAssistantDeps,
} from '../deps';
import type { HookContext, HookResult, LifecycleHook } from '../types';

/** FeedbackLoops 依赖 */
export interface FeedbackLoopsDeps {
  /** 反馈收集器（必需） */
  feedbackCollector: FeedbackCollectorDeps;
  /** 进化引擎（可选） */
  evolutionEngine?: EvolutionEngineDeps;
  /** 记忆助手（可选，用于自动知识提取） */
  memoryAssistant?: MemoryAssistantDeps;
}

/** AFTER_RESPONSE 钩子 metadata 中期望的数据结构 */
interface AfterResponseMetadata {
  input: string;
  response: string;
  quality: { overall: number };
  traceId: string;
  toolsUsed: string[];
  userId?: string;
  trace?: {
    trajectory: Array<{
      type: string;
      toolName?: string;
      duration?: number;
      toolResult?: { success: boolean };
    }>;
    totalDuration: number;
  };
  previousResponse?: string;
}

export class FeedbackLoops {
  constructor(private deps: FeedbackLoopsDeps) {}

  /**
   * 创建 AFTER_RESPONSE 钩子函数
   * 注册到 ConstraintsService 后，每次响应后自动触发所有闭环
   * @returns LifecycleHook 钩子函数
   */
  createAFTER_RESPONSEHook(): LifecycleHook {
    return async (ctx: HookContext): Promise<HookResult> => {
      await this.executeLoops(ctx);
      return { proceed: true };
    };
  }

  /**
   * 执行所有闭环
   * 非关键闭环异步执行，不阻塞主流程
   */
  private async executeLoops(ctx: HookContext): Promise<void> {
    const meta = ctx.metadata as unknown as AfterResponseMetadata;

    // 偏好学习闭环 — 同步执行（快速，仅正则匹配）
    try {
      this.runPreferenceLoop(meta);
    } catch (err) {
      Logger.debug(
        `偏好学习闭环失败（非关键）: ${(err as Error).message}`,
        'FeedbackLoops'
      );
    }

    // 进化闭环 + 工具失败反馈 — 异步执行
    setImmediate(() => {
      this.runEvolutionLoop(meta).catch((err) => {
        Logger.debug(
          `进化闭环失败（非关键）: ${(err as Error).message}`,
          'FeedbackLoops'
        );
      });
    });

    // 自动知识提取 — 异步执行
    if (this.deps.memoryAssistant) {
      setImmediate(() => {
        this.deps.memoryAssistant!
          .autoExtractKnowledge(meta.input, meta.response, meta.userId)
          .catch(() => {});
      });
    }
  }

  /**
   * 进化闭环：质量评分 → EvolutionOrchestrator + 工具失败反馈
   */
  private async runEvolutionLoop(meta: AfterResponseMetadata): Promise<void> {
    const qualityScore = meta.quality?.overall ?? 0.7;
    const input = meta.input;
    const response = meta.response;
    const userId = meta.userId;
    const scene = this.inferSceneFromInput(input);

    // 从轨迹中提取工具调用详情
    const trajectory = meta.trace?.trajectory || [];
    const toolResults = new Map<string, boolean>();
    for (const s of trajectory) {
      if (s.type === 'tool_result' && s.toolName) {
        toolResults.set(s.toolName, s.toolResult?.success ?? false);
      }
    }
    const toolCalls = trajectory
      .filter((s) => s.type === 'tool_call')
      .map((s) => ({
        toolName: s.toolName || 'unknown',
        success: toolResults.get(s.toolName || '') ?? false,
        executionTime: s.duration || 0,
      }));

    // 记录交互到进化编排器
    try {
      const orchestrator = EvolutionOrchestrator.getInstance();
      orchestrator.recordInteraction({
        traceId: meta.traceId,
        input,
        response,
        success: qualityScore >= 0.5,
        qualityScore,
        executionDuration: meta.trace?.totalDuration ?? 0,
        toolCalls,
        scene,
        userId: userId || 'default',
      });
    } catch (err) {
      Logger.debug(
        `进化编排器记录失败（非关键）: ${(err as Error).message}`,
        'FeedbackLoops'
      );
    }

    // 低质量交互触发反馈收集
    if (qualityScore < 0.5) {
      this.deps.feedbackCollector.recordLowQuality(
        input,
        response,
        qualityScore,
        userId,
        scene
      );
    }

    // 工具失败触发反馈收集
    for (const tc of toolCalls) {
      if (!tc.success) {
        this.deps.feedbackCollector.recordToolFailure(
          tc.toolName,
          '工具执行失败',
          input,
          userId
        );
      }
    }
  }

  /**
   * 偏好学习闭环：用户纠正 → PreferenceManager
   */
  private runPreferenceLoop(meta: AfterResponseMetadata): void {
    const input = meta.input;
    const response = meta.response;
    const userId = meta.userId;
    const previousResponse = meta.previousResponse || '';
    const scene = this.inferSceneFromInput(input);

    // 分析用户输入是否为纠正/重试
    const feedbackRecord = this.deps.feedbackCollector.analyzeUserInput(
      input,
      previousResponse,
      userId,
      scene
    );

    if (feedbackRecord) {
      // 将反馈信号传递给进化引擎
      if (this.deps.evolutionEngine) {
        this.deps.evolutionEngine.collectFeedback(
          input,
          response,
          {
            success: false,
            toolsUsed: [],
            error: `用户反馈: ${feedbackRecord.type}`,
          },
          scene
        );
      }

      // 从纠正中自动学习用户偏好
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PreferenceManager } = require('../../memory/PreferenceManager');
        const pm = PreferenceManager.getInstance();
        const entry = pm.applyCorrection(input, 'general');
        if (entry) {
          Logger.info(
            `⚡ 从用户纠正中提取偏好: ${entry.key}=${entry.value}`,
            'FeedbackLoops'
          );
        }
      } catch {
        // 偏好提取失败不影响主流程
      }
    }
  }

  /**
   * 从输入推断场景类型
   * 迁移自 JiabaixingCore.inferSceneFromInput
   */
  private inferSceneFromInput(input: string): string {
    if (/代码|编程|编译|重构|debug|bug|测试|接口|API|函数|类|模块/.test(input))
      return 'coding';
    if (/文件|目录|文件夹|打开|搜索|查找|读|写|创建|删除/.test(input))
      return 'file_operation';
    if (/桌面|截图|点击|窗口|应用|程序|打开|关闭/.test(input)) return 'desktop';
    if (/记忆|记得|之前|上次|回忆|历史/.test(input)) return 'memory';
    if (/天气|新闻|搜索|查询|什么是|怎么/.test(input)) return 'knowledge';
    if (/提醒|日程|任务|计划|安排/.test(input)) return 'planning';
    if (/你好|嗨|谢谢|再见|早安|晚安/.test(input)) return 'greeting';
    return 'general';
  }
}

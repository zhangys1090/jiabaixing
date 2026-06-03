/**
 * 优化结果分发器
 * 将 StrategyOptimizer 产生的优化结果分发到各个消费端，完成进化闭环
 * 解决进化闭环断裂问题：优化结果 → 实际影响系统行为
 */

import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import {
  OptimizationLog,
  ToneAdjustment,
  SkillWeightAdjustment,
  PromptExample,
} from './StrategyOptimizer';

/**
 * 优化结果快照（用于持久化和分发）
 */
export interface OptimizationSnapshot {
  id: string;
  timestamp: number;
  toneAdjustments: ToneAdjustment[];
  skillWeights: Record<string, number>;
  promptExamples: PromptExample[];
}

/**
 * 优化结果消费者接口
 */
export interface OptimizationConsumer {
  name: string;
  onOptimizationUpdate(snapshot: OptimizationSnapshot): void | Promise<void>;
}

/**
 * 优化结果分发器（单例）
 * 负责将 StrategyOptimizer 的优化结果路由到所有注册的消费者
 */
export class OptimizationResultDispatcher {
  private static instance: OptimizationResultDispatcher | null = null;
  private consumers: OptimizationConsumer[] = [];
  private lastSnapshot: OptimizationSnapshot | null = null;
  private dispatchHistory: OptimizationSnapshot[] = [];
  private readonly maxHistorySize = 50;

  private constructor() {}

  public static getInstance(): OptimizationResultDispatcher {
    if (!OptimizationResultDispatcher.instance) {
      OptimizationResultDispatcher.instance =
        new OptimizationResultDispatcher();
    }
    return OptimizationResultDispatcher.instance;
  }

  public static reset(): void {
    OptimizationResultDispatcher.instance = null;
  }

  /**
   * 注册优化结果消费者
   */
  public registerConsumer(consumer: OptimizationConsumer): void {
    const exists = this.consumers.some((c) => c.name === consumer.name);
    if (exists) {
      Logger.warn(
        `⚠️ 优化消费者已存在，跳过重复注册: ${consumer.name}`,
        'OptimizationResultDispatcher'
      );
      return;
    }
    this.consumers.push(consumer);
    Logger.info(
      `✅ 优化消费者已注册: ${consumer.name}`,
      'OptimizationResultDispatcher'
    );
  }

  /**
   * 注销优化结果消费者
   */
  public unregisterConsumer(name: string): void {
    const before = this.consumers.length;
    this.consumers = this.consumers.filter((c) => c.name !== name);
    if (this.consumers.length < before) {
      Logger.info(
        `🗑️ 优化消费者已注销: ${name}`,
        'OptimizationResultDispatcher'
      );
    }
  }

  /**
   * 分发优化结果到所有消费者
   * 这是完成进化闭环的关键方法
   */
  public async dispatch(log: OptimizationLog): Promise<void> {
    const snapshot: OptimizationSnapshot = {
      id: log.id,
      timestamp: log.timestamp.getTime(),
      toneAdjustments: log.toneAdjustments,
      skillWeights: this.mapSkillAdjustmentsToWeights(log.skillAdjustments),
      promptExamples: log.promptExamples,
    };

    this.lastSnapshot = snapshot;
    this.dispatchHistory.push(snapshot);
    if (this.dispatchHistory.length > this.maxHistorySize) {
      this.dispatchHistory.shift();
    }

    Logger.info(
      `📢 分发优化结果: tone=${snapshot.toneAdjustments.length}, skills=${Object.keys(snapshot.skillWeights).length}, prompts=${snapshot.promptExamples.length}`,
      'OptimizationResultDispatcher'
    );

    // 广播优化更新事件（供异步监听者使用）
    void EventBus.emit('optimization_update', snapshot);

    // 同步分发到所有注册的消费者
    const results = await Promise.allSettled(
      this.consumers.map(async (consumer) => {
        try {
          await consumer.onOptimizationUpdate(snapshot);
          Logger.debug(
            `✅ 优化结果已分发到 ${consumer.name}`,
            'OptimizationResultDispatcher'
          );
        } catch (error) {
          Logger.error(
            `❌ 优化结果分发到 ${consumer.name} 失败`,
            error as Error,
            'OptimizationResultDispatcher'
          );
        }
      })
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    Logger.info(
      `✅ 优化分发完成: ${succeeded}/${this.consumers.length} 成功`,
      'OptimizationResultDispatcher'
    );
  }

  /**
   * 获取最近一次优化快照
   */
  public getLastSnapshot(): OptimizationSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * 获取分发历史
   */
  public getDispatchHistory(): OptimizationSnapshot[] {
    return [...this.dispatchHistory];
  }

  /**
   * 获取已注册消费者列表
   */
  public getConsumerNames(): string[] {
    return this.consumers.map((c) => c.name);
  }

  /**
   * 将技能权重调整转换为权重映射
   */
  private mapSkillAdjustmentsToWeights(
    adjustments: SkillWeightAdjustment[]
  ): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const adj of adjustments) {
      weights[adj.skillName] = adj.weightDelta;
    }
    return weights;
  }
}

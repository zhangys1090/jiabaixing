/**
 * 隐式反馈收集器
 *
 * 【功能】
 * 从用户行为中提取隐式反馈信号，解决学习信号稀疏问题
 *
 * 【设计原则】
 * - 静默收集：后台运行，不打扰用户
 * - 隐私安全：只统计行为模式，不存储敏感内容
 * - 轻量级：不影响主循环性能
 * - 可配置：可开关和调整敏感度
 *
 * 【反馈信号类型】
 * ✅ 正向信号：
 * - 用户复制了 AI 输出
 * - 用户表示满意/认可
 * - 用户采纳建议并执行
 * - 用户连续使用同一功能
 * - 用户停留时间长且无修改
 *
 * ⚠️ 负向信号：
 * - 用户修改了 AI 输出
 * - 用户重试同一问题
 * - 用户连续追问（表示没理解或不满意）
 * - 用户快速切换话题
 * - 用户删除了 AI 生成的内容
 *
 * 🤔 中性信号：
 * - 用户长时间不回复
 * - 用户切换话题
 * - 用户只看不互动
 *
 * 【应用场景】
 * - 为 V1 进化引擎提供轻量级学习信号
 * - 分析用户行为模式，优化交互体验
 * - 识别高价值交互，重点学习
 *
 * @module ImplicitFeedbackCollector
 * @version 0.1.0
 * @status Beta - 功能基本完成，测试中
 * @since 2026-06-24
 */

import EventBus, { JiabaixingEventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';

// ========== 常量定义 ==========

/** 最大历史记录数 */
const MAX_HISTORY_SIZE = 1000;

/** 反馈信号类型 */
export type FeedbackType = 'positive' | 'negative' | 'neutral';

/** 反馈信号强度 */
export type FeedbackStrength = 'weak' | 'medium' | 'strong';

/** 反馈信号来源 */
export type FeedbackSource =
  | 'copy' // 复制
  | 'modify' // 修改
  | 'retry' // 重试
  | 'follow_up' // 追问
  | 'satisfaction' // 满意度表达
  | 'adoption' // 采纳执行
  | 'switch_topic' // 切换话题
  | 'idle' // 空闲不回复
  | 'delete' // 删除
  | 'engagement'; // 参与度

/** 反馈信号 */
export interface FeedbackSignal {
  /** 信号 ID */
  id: string;
  /** 反馈类型 */
  type: FeedbackType;
  /** 信号强度 */
  strength: FeedbackStrength;
  /** 信号来源 */
  source: FeedbackSource;
  /** 关联的消息 ID */
  messageId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 置信度 (0-1) */
  confidence: number;
  /** 附加数据（不包含敏感内容） */
  metadata?: Record<string, unknown>;
}

/** 反馈统计 */
export interface FeedbackStatistics {
  /** 总反馈数 */
  totalSignals: number;
  /** 正向反馈数 */
  positiveCount: number;
  /** 负向反馈数 */
  negativeCount: number;
  /** 中性反馈数 */
  neutralCount: number;
  /** 各来源统计 */
  bySource: Record<FeedbackSource, number>;
  /** 会话内反馈数（当前会话启动以来） */
  sessionCount: number;
  /**
   * 今日反馈数
   * @deprecated 字段名不准确，实际为会话内计数，请使用 sessionCount 替代
   */
  todayCount: number;
  /**
   * 本周反馈数
   * @deprecated 字段名不准确，实际为会话内计数，请使用 sessionCount 替代
   */
  weekCount: number;
  /** 平均置信度 */
  averageConfidence: number;
  /** 错误计数（检测失败的次数） */
  errorCount: number;
}

/**
 * 隐式反馈收集器
 */
export class ImplicitFeedbackCollector {
  private static instance: ImplicitFeedbackCollector;

  /** 是否启用 */
  private enabled = true;

  /** 反馈信号历史 */
  private signalHistory: FeedbackSignal[] = [];

  /** 最大历史记录数 */
  private readonly maxHistorySize = MAX_HISTORY_SIZE;

  /** 事件监听器是否已注册 */
  private listenersRegistered = false;

  /** 统计数据 */
  private statistics: FeedbackStatistics = {
    totalSignals: 0,
    positiveCount: 0,
    negativeCount: 0,
    neutralCount: 0,
    bySource: {} as Record<FeedbackSource, number>,
    sessionCount: 0,
    todayCount: 0,
    weekCount: 0,
    averageConfidence: 0,
    errorCount: 0,
  };

  /** 会话开始时间 */
  private sessionStartTime = Date.now();

  /** 上一条用户消息时间 */
  private lastUserMessageTime = 0;

  /** 上一条 AI 消息时间 */
  private lastAiMessageTime = 0;

  /** 连续追问计数 */
  private consecutiveFollowUps = 0;

  /** 重试计数（同一话题） */
  private retryCount = 0;

  /** 当前话题关键词 */
  private currentTopicKeywords: string[] = [];

  private constructor() {
    Logger.info('🎯 隐式反馈收集器已初始化', 'ImplicitFeedback');

    // 监听事件总线
    if (EventBus && typeof EventBus.on === 'function') {
      this.setupEventListeners();
    }
  }

  static create(): ImplicitFeedbackCollector {
    return new ImplicitFeedbackCollector();
  }

  static getInstance(): ImplicitFeedbackCollector {
    if (!ImplicitFeedbackCollector.instance) {
      ImplicitFeedbackCollector.instance = new ImplicitFeedbackCollector();
    }
    return ImplicitFeedbackCollector.instance;
  }

  /**
   * 重置单例实例（测试用）
   *
   * 【注意】
   * - 仅供测试使用，生产环境请勿调用
   * - 会清除所有状态和历史数据
   * - 调用后下次 getInstance() 会创建新实例
   */
  static resetInstance(): void {
    if (ImplicitFeedbackCollector.instance) {
      // 清理事件监听器
      ImplicitFeedbackCollector.instance.cleanupEventListeners();
      ImplicitFeedbackCollector.instance =
        null as unknown as ImplicitFeedbackCollector;
    }
  }

  /**
   * 清理所有已注册的事件监听器
   * 防止测试中重复注册导致内存泄漏
   */
  private cleanupEventListeners(): void {
    if (!this.listenersRegistered) return;

    try {
      const bus = EventBus as JiabaixingEventBus;
      bus.off('user:message', this.onUserMessageHandler);
      bus.off('ai:message', this.onAiMessageHandler);
      bus.off('user:copy', this.onCopyHandler);
      bus.off('user:modify', this.onModifyHandler);
      bus.off('user:delete', this.onDeleteHandler);
      this.listenersRegistered = false;
      Logger.debug('事件监听器已清理', 'ImplicitFeedback');
    } catch (error) {
      Logger.warn(
        `清理事件监听器失败: ${(error as Error).message}`,
        'ImplicitFeedback'
      );
    }
  }

  /**
   * 创建测试用独立实例（测试用）
   *
   * 【注意】
   * - 仅供测试使用，生产环境请勿调用
   * - 创建的是独立实例，不影响单例
   * - 可传入自定义依赖进行 mock
   */
  static createTestInstance(): ImplicitFeedbackCollector {
    return new ImplicitFeedbackCollector();
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (this.listenersRegistered) return;

    try {
      const bus = EventBus as JiabaixingEventBus;

      // 监听用户消息
      bus.on('user:message', this.onUserMessageHandler);

      // 监听 AI 消息
      bus.on('ai:message', this.onAiMessageHandler);

      // 监听用户复制
      bus.on('user:copy', this.onCopyHandler);

      // 监听用户修改
      bus.on('user:modify', this.onModifyHandler);

      // 监听用户删除
      bus.on('user:delete', this.onDeleteHandler);

      this.listenersRegistered = true;
      Logger.debug('事件监听器已注册', 'ImplicitFeedback');
    } catch (error) {
      Logger.warn(
        `注册事件监听器失败: ${(error as Error).message}`,
        'ImplicitFeedback'
      );
    }
  }

  /** 用户消息事件处理器（命名的类属性方法，用于注销） */
  private onUserMessageHandler = (data: Record<string, unknown>): void => {
    this.onUserMessage(data);
  };

  /** AI 消息事件处理器 */
  private onAiMessageHandler = (data: Record<string, unknown>): void => {
    this.onAiMessage(data);
  };

  /** 用户复制事件处理器 */
  private onCopyHandler = (data: Record<string, unknown>): void => {
    this.recordSignal({
      type: 'positive',
      strength: 'medium',
      source: 'copy',
      messageId: data.messageId as string,
      confidence: 0.7,
    });
  };

  /** 用户修改事件处理器 */
  private onModifyHandler = (data: Record<string, unknown>): void => {
    this.recordSignal({
      type: 'negative',
      strength: 'medium',
      source: 'modify',
      messageId: data.messageId as string,
      confidence: 0.8,
    });
  };

  /** 用户删除事件处理器 */
  private onDeleteHandler = (data: Record<string, unknown>): void => {
    this.recordSignal({
      type: 'negative',
      strength: 'strong',
      source: 'delete',
      messageId: data.messageId as string,
      confidence: 0.9,
    });
  };

  /**
   * 处理用户消息
   *
   * 【错误隔离设计】
   * 每个检测逻辑都有独立的 try-catch 保护，
   * 确保一个检测失败不会影响其他检测的执行，
   * 也不会影响主消息循环。
   */
  onUserMessage(data: Record<string, unknown>): void {
    if (!this.enabled) return;

    const now = Date.now();
    const content = (data.content as string) || '';

    // ========== 1. 检测满意度表达 ==========
    try {
      if (this.isSatisfactionExpression(content)) {
        this.recordSignal({
          type: 'positive',
          strength: 'strong',
          source: 'satisfaction',
          confidence: 0.9,
        });
      }
    } catch (error) {
      this.statistics.errorCount++;
      Logger.warn(
        `满意度检测失败: ${error instanceof Error ? error.message : String(error)}`,
        'ImplicitFeedback'
      );
    }

    // ========== 2. 检测追问 ==========
    try {
      if (
        this.lastAiMessageTime > 0 &&
        now - this.lastAiMessageTime < 5 * 60 * 1000
      ) {
        if (this.isFollowUp(content)) {
          this.consecutiveFollowUps++;

          // 连续追问超过 2 次，视为负向信号
          if (this.consecutiveFollowUps >= 2) {
            this.recordSignal({
              type: 'negative',
              strength: this.consecutiveFollowUps >= 3 ? 'strong' : 'weak',
              source: 'follow_up',
              confidence: Math.min(0.5 + this.consecutiveFollowUps * 0.1, 0.9),
              metadata: { followUpCount: this.consecutiveFollowUps },
            });
          }
        } else {
          this.consecutiveFollowUps = 0;
        }
      }
    } catch (error) {
      this.statistics.errorCount++;
      Logger.warn(
        `追问检测失败: ${error instanceof Error ? error.message : String(error)}`,
        'ImplicitFeedback'
      );
    }

    // ========== 3. 检测话题切换 ==========
    try {
      if (this.isTopicSwitch(content)) {
        this.recordSignal({
          type: 'neutral',
          strength: 'weak',
          source: 'switch_topic',
          confidence: 0.6,
        });
        this.currentTopicKeywords = this.extractKeywords(content);
      }
    } catch (error) {
      this.statistics.errorCount++;
      Logger.warn(
        `话题切换检测失败: ${error instanceof Error ? error.message : String(error)}`,
        'ImplicitFeedback'
      );
    }

    // ========== 4. 检测重试 ==========
    try {
      if (this.isRetry(content)) {
        this.retryCount++;
        this.recordSignal({
          type: 'negative',
          strength: 'medium',
          source: 'retry',
          confidence: 0.7,
          metadata: { retryCount: this.retryCount },
        });
      }
    } catch (error) {
      this.statistics.errorCount++;
      Logger.warn(
        `重试检测失败: ${error instanceof Error ? error.message : String(error)}`,
        'ImplicitFeedback'
      );
    }

    // ========== 5. 更新状态（确保总能执行） ==========
    try {
      this.lastUserMessageTime = now;
    } catch (error) {
      this.statistics.errorCount++;
      Logger.warn(
        `状态更新失败: ${error instanceof Error ? error.message : String(error)}`,
        'ImplicitFeedback'
      );
    }
  }

  /**
   * 处理 AI 消息
   */
  onAiMessage(_data: Record<string, unknown>): void {
    if (!this.enabled) return;

    this.lastAiMessageTime = Date.now();
    this.retryCount = 0;
  }

  /**
   * 记录反馈信号
   */
  recordSignal(signal: Omit<FeedbackSignal, 'id' | 'timestamp'>): void {
    if (!this.enabled) return;

    const fullSignal: FeedbackSignal = {
      ...signal,
      id: `fb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    // 添加到历史
    this.signalHistory.push(fullSignal);
    if (this.signalHistory.length > this.maxHistorySize) {
      this.signalHistory.shift();
    }

    // 更新统计
    this.updateStatistics(fullSignal);

    // 发布事件
    try {
      if (EventBus && typeof EventBus.emit === 'function') {
        (EventBus as JiabaixingEventBus).emit('feedback:implicit', fullSignal);
      }
    } catch {
      // 静默
    }

    Logger.debug(
      `隐式反馈: ${signal.type} (${signal.source}, 强度: ${signal.strength}, 置信度: ${(signal.confidence * 100).toFixed(0)}%)`,
      'ImplicitFeedback'
    );
  }

  /**
   * 更新统计数据
   */
  private updateStatistics(signal: FeedbackSignal): void {
    this.statistics.totalSignals++;

    switch (signal.type) {
      case 'positive':
        this.statistics.positiveCount++;
        break;
      case 'negative':
        this.statistics.negativeCount++;
        break;
      case 'neutral':
        this.statistics.neutralCount++;
        break;
    }

    // 按来源统计
    if (!this.statistics.bySource[signal.source]) {
      this.statistics.bySource[signal.source] = 0;
    }
    this.statistics.bySource[signal.source]++;

    // 会话内计数（同时更新旧字段以保持兼容）
    this.statistics.sessionCount++;
    this.statistics.todayCount++;
    this.statistics.weekCount++;

    // 平均置信度
    const total = this.statistics.totalSignals;
    this.statistics.averageConfidence =
      (this.statistics.averageConfidence * (total - 1) + signal.confidence) /
      total;
  }

  /**
   * 获取统计数据
   */
  getStatistics(): FeedbackStatistics {
    return { ...this.statistics };
  }

  /**
   * 获取近期反馈信号
   */
  getRecentSignals(limit: number = 20): FeedbackSignal[] {
    return this.signalHistory.slice(-limit);
  }

  /**
   * 获取正向反馈比例
   */
  getPositiveRatio(): number {
    if (this.statistics.totalSignals === 0) return 0.5;
    return this.statistics.positiveCount / this.statistics.totalSignals;
  }

  /**
   * 启用/禁用收集器
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    Logger.info(
      `隐式反馈收集器已${enabled ? '启用' : '禁用'}`,
      'ImplicitFeedback'
    );
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ========== 辅助检测方法 ==========

  /**
   * 检测是否为满意度表达
   */
  private isSatisfactionExpression(content: string): boolean {
    const positivePatterns = [
      /^(好的|好|ok|OK|对|是的|没错|谢谢|感谢|赞|厉害|牛|完美|太棒了|真不错|满意|可以)$/i,
      /谢谢|感谢|太棒了|真不错|很满意|非常好/,
    ];

    return positivePatterns.some((pattern) => pattern.test(content.trim()));
  }

  /**
   * 检测是否为追问
   */
  private isFollowUp(content: string): boolean {
    const followUpPatterns = [
      /为什么|怎么|如何|什么|哪里|哪个|谁|何时|多少/,
      /请解释|请说明|详细说|再说说|继续/,
      /不太懂|不理解|没明白|没听懂/,
      /然后呢|接下来|之后/,
    ];

    return followUpPatterns.some((pattern) => pattern.test(content));
  }

  /**
   * 检测是否为话题切换
   */
  private isTopicSwitch(content: string): boolean {
    // 简化实现：如果内容与当前话题关键词重叠度低，视为切换话题
    if (this.currentTopicKeywords.length === 0) return false;

    const contentLower = content.toLowerCase();
    const overlap = this.currentTopicKeywords.filter((kw) =>
      contentLower.includes(kw.toLowerCase())
    ).length;

    return overlap === 0 && content.length > 10;
  }

  /**
   * 检测是否为重试
   */
  private isRetry(content: string): boolean {
    const retryPatterns = [
      /再试一次|重新来|再来一次|不对|错了|不是/,
      /重新|再一次|重来/,
    ];

    return retryPatterns.some((pattern) => pattern.test(content));
  }

  /**
   * 提取关键词（简化实现）
   */
  private extractKeywords(content: string): string[] {
    // 简化实现：提取长度大于 2 的词
    const words = content.split(
      /[\s，。！？、；：""''（）【】\[\].,!?;:'"()]+/
    );
    return words.filter((w) => w.length >= 2).slice(0, 5);
  }

  /**
   * 重置会话状态
   */
  resetSession(): void {
    this.sessionStartTime = Date.now();
    this.lastUserMessageTime = 0;
    this.lastAiMessageTime = 0;
    this.consecutiveFollowUps = 0;
    this.retryCount = 0;
    this.currentTopicKeywords = [];

    Logger.debug('会话状态已重置', 'ImplicitFeedback');
  }
}

export default ImplicitFeedbackCollector;

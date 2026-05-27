/**
 * 情绪分析器（向后兼容包装类）
 * 原模块 EmotionAnalysisService 已删除，本地实现
 * 保留原有接口以避免破坏现有代码
 */

import { EmotionTag } from '../interfaces';
import { MultimodalInput } from './MultimodalInput';

/** EmotionAnalysisService 存根（原模块已删除） */
class EmotionAnalysisService {
  private history: Array<{ emotion: EmotionTag; timestamp: number }> = [];

  async initialize(): Promise<void> {}

  async analyze(_input: MultimodalInput): Promise<EmotionTag> {
    return { type: 'neutral', intensity: 0.5, potentialNeeds: [] };
  }

  getEmotionHistory(): Array<{ emotion: EmotionTag; timestamp: number }> {
    return this.history;
  }

  analyzeEmotionTrend(): {
    dominantEmotion: string;
    trend: 'increasing' | 'decreasing' | 'stable';
    averageIntensity: number;
  } {
    return { dominantEmotion: 'neutral', trend: 'stable', averageIntensity: 0.5 };
  }

  cleanup(): void {
    this.history = [];
  }
}

export class EmotionAnalyzer {
  private initialized = false;
  private service: EmotionAnalysisService = new EmotionAnalysisService();

  public async initialize(): Promise<void> {
    await this.service.initialize();
    this.initialized = true;
  }

  public async analyze(input: MultimodalInput): Promise<EmotionTag> {
    this.ensureInitialized();
    return this.service.analyze(input);
  }

  public getEmotionHistory(): EmotionTag[] {
    return this.service.getEmotionHistory().map((h) => h.emotion);
  }

  public clearEmotionHistory(): void {
    this.service.cleanup();
  }

  public analyzeEmotionTrend(): {
    dominantEmotion: string;
    trend: 'increasing' | 'decreasing' | 'stable';
    averageIntensity: number;
  } {
    return this.service.analyzeEmotionTrend();
  }

  public async shutdown(): Promise<void> {
    this.service.cleanup();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('情绪分析器未初始化！请先调用initialize方法。');
    }
  }
}

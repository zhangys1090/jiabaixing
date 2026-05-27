import { Logger } from '../utils/Logger';

export class PromptOptimizer {
  static optimizePrompt(prompt: string, maxLength: number = 2000): string {
    if (prompt.length <= maxLength) {
      return prompt;
    }
    Logger.warn(
      `Prompt过长 (${prompt.length} chars)，将被截断到 ${maxLength} chars`,
      'PromptOptimizer'
    );

    const lines = prompt.split('\n');
    let optimized = '';
    let currentLength = 0;

    for (const line of lines) {
      if (currentLength + line.length + 1 > maxLength) {
        break;
      }
      optimized += line + '\n';
      currentLength += line.length + 1;
    }

    return optimized.trim();
  }

  static compressHistory(
    history: Array<{ role: string; content: string }>,
    maxTokens: number = 1000
  ): Array<{ role: string; content: string }> {
    if (history.length <= 2) {
      return history;
    }

    const compressed: Array<{ role: string; content: string }> = [];
    let totalTokens = 0;

    const estimateTokens = (text: string): number => {
      const cjkCount = (
        text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []
      ).length;
      const nonCjkLength = text.length - cjkCount;
      return Math.ceil(cjkCount / 1.5 + nonCjkLength / 4);
    };

    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      const tokens = estimateTokens(item.content);

      if (totalTokens + tokens > maxTokens) {
        break;
      }

      compressed.unshift(item);
      totalTokens += tokens;
    }

    if (compressed.length < history.length) {
      Logger.warn(
        `历史对话已压缩: ${history.length} -> ${compressed.length} 条消息`,
        'PromptOptimizer'
      );
    }

    return compressed;
  }
}

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
    const headBudget = Math.floor(maxLength * 0.4);
    const tailBudget = Math.floor(maxLength * 0.5);
    const ellipsis = '\n... [内容已省略，保留首尾关键信息] ...\n';

    let headLines: string[] = [];
    let headLen = 0;
    for (const line of lines) {
      if (headLen + line.length + 1 > headBudget) break;
      headLines.push(line);
      headLen += line.length + 1;
    }

    let tailLines: string[] = [];
    let tailLen = 0;
    for (let i = lines.length - 1; i >= headLines.length; i--) {
      if (tailLen + lines[i].length + 1 > tailBudget) break;
      tailLines.unshift(lines[i]);
      tailLen += lines[i].length + 1;
    }

    if (tailLines.length === 0 && headLines.length < lines.length) {
      let optimized = '';
      let currentLength = 0;
      for (const line of lines) {
        if (currentLength + line.length + 1 > maxLength) break;
        optimized += line + '\n';
        currentLength += line.length + 1;
      }
      return optimized.trim();
    }

    const result = headLines.join('\n') + ellipsis + tailLines.join('\n');
    return result.trim();
  }

  static compressHistory(
    history: Array<{ role: string; content: string }>,
    maxTokens: number = 1000
  ): Array<{ role: string; content: string }> {
    if (history.length <= 2) {
      return history;
    }

    const estimateTokens = (text: string): number => {
      const cjkCount = (
        text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []
      ).length;
      const nonCjkLength = text.length - cjkCount;
      return Math.ceil(cjkCount / 1.5 + nonCjkLength / 4);
    };

    const systemMessages = history.filter((h) => h.role === 'system');
    const nonSystemHistory = history.filter((h) => h.role !== 'system');

    const systemTokenBudget = Math.floor(maxTokens * 0.2);
    let systemTokens = 0;
    const keptSystem: Array<{ role: string; content: string }> = [];
    for (const sm of systemMessages) {
      const t = estimateTokens(sm.content);
      if (systemTokens + t > systemTokenBudget) break;
      keptSystem.push(sm);
      systemTokens += t;
    }

    const remainingBudget = maxTokens - systemTokens;
    const compressed: Array<{ role: string; content: string }> = [];
    let totalTokens = 0;

    for (let i = nonSystemHistory.length - 1; i >= 0; i--) {
      const item = nonSystemHistory[i];
      const tokens = estimateTokens(item.content);

      if (totalTokens + tokens > remainingBudget) {
        break;
      }

      compressed.unshift(item);
      totalTokens += tokens;
    }

    const result = [...keptSystem, ...compressed];

    if (result.length < history.length) {
      Logger.warn(
        `历史对话已压缩: ${history.length} -> ${result.length} 条消息 (保留${keptSystem.length}条system + ${compressed.length}条对话)`,
        'PromptOptimizer'
      );
    }

    return result;
  }
}

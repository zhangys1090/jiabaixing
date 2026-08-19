/**
 * @deprecated 已迁移到 Python agent/memory/tokenizer.py（使用 jieba 分词库）。
 * 此存根仅保持向后兼容，V6.0 后移除。
 */
export class ChineseTokenizer {
  static tokenize(text: string): string[] {
    return text.split(/[\s\u3000]+/).filter((t: string) => t.length > 0);
  }

  static countTokens(text: string): number {
    return ChineseTokenizer.tokenize(text).length;
  }

  tokenize(text: string): string[] {
    return ChineseTokenizer.tokenize(text);
  }

  countTokens(text: string): number {
    return ChineseTokenizer.countTokens(text);
  }
}

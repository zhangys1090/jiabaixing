/**
 * 中文分词工具
 * 基于N-gram的轻量级中文分词，无需外部依赖
 * 支持中英混合文本，优先使用双字gram（bigram）捕获中文语义
 *
 * @deprecated 已迁移到 Python agent/memory/tokenizer.py（使用 jieba 分词库）。当 AGENT_BACKEND=python（默认）时不再使用此文件。
 *   回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现。
 *   迁移日期：2026-06-22
 */

export class ChineseTokenizer {
  private static readonly STOP_WORDS = new Set([
    '的',
    '了',
    '在',
    '是',
    '我',
    '有',
    '和',
    '就',
    '不',
    '人',
    '都',
    '一',
    '一个',
    '上',
    '也',
    '很',
    '到',
    '说',
    '要',
    '去',
    '你',
    '会',
    '着',
    '没有',
    '看',
    '好',
    '自己',
    '这',
    '他',
    '她',
    '它',
    '吗',
    '吧',
    '呢',
    '啊',
    '哦',
    '嗯',
    '那',
    '这个',
    '那个',
    '什么',
    '怎么',
    '为什么',
    '可以',
    '能',
    '还是',
    '或者',
    '但是',
    '因为',
    '所以',
    '如果',
    '虽然',
    '而且',
    '不过',
    '然后',
    '已经',
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'shall',
    'i',
    'you',
    'he',
    'she',
    'it',
    'we',
    'they',
    'me',
    'him',
    'her',
    'us',
    'them',
    'my',
    'your',
    'his',
    'its',
    'our',
    'and',
    'or',
    'but',
    'not',
    'no',
    'so',
    'if',
    'then',
    'than',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
  ]);

  public static tokenize(text: string): string[] {
    const tokens: string[] = [];
    const cleaned = text
      .toLowerCase()
      .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z0-9]/g, ' ');

    const segments = cleaned.split(/\s+/).filter((s) => s.length > 0);

    for (const segment of segments) {
      const isChinese = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(segment);

      if (isChinese) {
        tokens.push(...ChineseTokenizer.tokenizeChinese(segment));
      } else {
        if (segment.length > 1 && !ChineseTokenizer.STOP_WORDS.has(segment)) {
          tokens.push(segment);
        }
      }
    }

    return tokens;
  }

  private static tokenizeChinese(text: string): string[] {
    const tokens: string[] = [];
    const chars = [...text];
    let i = 0;

    while (i < chars.length) {
      if (ChineseTokenizer.isChineseChar(chars[i])) {
        if (
          i + 1 < chars.length &&
          ChineseTokenizer.isChineseChar(chars[i + 1])
        ) {
          const bigram = chars[i] + chars[i + 1];
          if (!ChineseTokenizer.STOP_WORDS.has(bigram)) {
            tokens.push(bigram);
          }
          if (
            i + 2 < chars.length &&
            ChineseTokenizer.isChineseChar(chars[i + 2])
          ) {
            const trigram = chars[i] + chars[i + 1] + chars[i + 2];
            if (!ChineseTokenizer.STOP_WORDS.has(trigram)) {
              tokens.push(trigram);
            }
          }
          i++;
        } else {
          if (!ChineseTokenizer.STOP_WORDS.has(chars[i])) {
            tokens.push(chars[i]);
          }
          i++;
        }
      } else {
        i++;
      }
    }

    return tokens;
  }

  private static isChineseChar(char: string): boolean {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
    );
  }
}

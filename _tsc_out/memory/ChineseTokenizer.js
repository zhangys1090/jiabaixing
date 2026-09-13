"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChineseTokenizer = void 0;
/**
 * @deprecated 已迁移到 Python agent/memory/tokenizer.py（使用 jieba 分词库）。
 * 此存根仅保持向后兼容，V6.0 后移除。
 */
class ChineseTokenizer {
    static tokenize(text) {
        return text.split(/[\s\u3000]+/).filter((t) => t.length > 0);
    }
    static countTokens(text) {
        return ChineseTokenizer.tokenize(text).length;
    }
    tokenize(text) {
        return ChineseTokenizer.tokenize(text);
    }
    countTokens(text) {
        return ChineseTokenizer.countTokens(text);
    }
}
exports.ChineseTokenizer = ChineseTokenizer;

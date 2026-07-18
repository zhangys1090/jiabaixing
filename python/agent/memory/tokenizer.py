from __future__ import annotations

import jieba


class ChineseTokenizer:
    """中文分词与关键词提取工具类（基于 jieba）。"""

    _initialized: bool = False

    @classmethod
    def ensure_initialized(cls) -> None:
        """惰性初始化 jieba 分词引擎（首次调用时加载词典）。"""
        if not cls._initialized:
            jieba.initialize()
            cls._initialized = True

    @classmethod
    def tokenize(cls, text: str) -> list[str]:
        """精确模式分词，返回 token 列表。"""
        cls.ensure_initialized()
        return list(jieba.cut(text))

    @classmethod
    def tokenize_for_search(cls, text: str) -> list[str]:
        """搜索引擎模式分词（更细粒度），适合 FTS5 索引。"""
        cls.ensure_initialized()
        return list(jieba.cut_for_search(text))

    @classmethod
    def extract_keywords(cls, text: str, top_k: int = 10) -> list[str]:
        """基于 TF-IDF 提取关键词。"""
        import jieba.analyse
        cls.ensure_initialized()
        return jieba.analyse.extract_tags(text, topK=top_k)

    # 向后兼容别名：部分历史调用方使用 extract_tags 名称（与 jieba.analyse 一致）
    extract_tags = extract_keywords

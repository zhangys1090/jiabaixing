from __future__ import annotations

import jieba


class ChineseTokenizer:
    _initialized: bool = False

    @classmethod
    def ensure_initialized(cls) -> None:
        if not cls._initialized:
            jieba.initialize()
            cls._initialized = True

    @classmethod
    def tokenize(cls, text: str) -> list[str]:
        cls.ensure_initialized()
        return list(jieba.cut(text))

    @classmethod
    def tokenize_for_search(cls, text: str) -> list[str]:
        cls.ensure_initialized()
        return list(jieba.cut_for_search(text))

    @classmethod
    def extract_keywords(cls, text: str, top_k: int = 10) -> list[str]:
        import jieba.analyse
        cls.ensure_initialized()
        return jieba.analyse.extract_tags(text, topK=top_k)

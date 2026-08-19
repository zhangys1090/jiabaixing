"""精确 Token 计数器 — 基于 tiktoken 的精确 Token 计数。

提供：
- 自动检测模型对应的编码器
- 精确 Token 计数（替代旧的 4 字符 ≈ 1 token 估算）
- 消息列表总 Token 计数
- 优雅降级：tiktoken 不可用时回退到 approximate 模式

Usage:
    counter = TokenCounter(model="gpt-4o")
    tokens = counter.count_tokens("你好世界")
    total = counter.count_messages_tokens(messages)
"""

from __future__ import annotations

import threading
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("token_counter")

MODEL_TO_ENCODING: dict[str, str] = {
    "gpt-4o": "o200k_base",
    "gpt-4o-mini": "o200k_base",
    "gpt-4-turbo": "cl100k_base",
    "gpt-4": "cl100k_base",
    "gpt-3.5-turbo": "cl100k_base",
    "text-embedding-ada-002": "cl100k_base",
    "text-embedding-3-small": "cl100k_base",
    "text-embedding-3-large": "cl100k_base",
}

MODEL_PREFIX_TO_ENCODING: list[tuple[str, str]] = [
    ("gpt-4o", "o200k_base"),
    ("gpt-4", "cl100k_base"),
    ("gpt-3.5", "cl100k_base"),
    ("o1", "o200k_base"),
    ("o3", "o200k_base"),
    ("o4", "o200k_base"),
]


class TokenCounter:
    """精确 Token 计数器。

    基于 OpenAI 的 tiktoken 库实现精确的 Token 计数，
    根据模型名称自动选择对应的编码器。

    特性：
    - 自动模型→编码器映射
    - 线程安全的编码器缓存
    - 优雅降级到 approximate 模式
    - 支持消息列表批量计数（含 tool_calls）

    Usage:
        counter = TokenCounter()
        tokens = counter.count_tokens("你好世界")  # 精确计数
        total = counter.count_messages_tokens(messages)
    """

    _encoding_cache: dict[str, Any] = {}
    _cache_lock = threading.Lock()
    _tiktoken_available: bool | None = None

    def __init__(self, model: str = "gpt-4o") -> None:
        self._model = model
        self._encoding_name = self._resolve_encoding(model)

    @classmethod
    def is_available(cls) -> bool:
        if cls._tiktoken_available is None:
            try:
                import tiktoken
                cls._tiktoken_available = True
            except ImportError:
                cls._tiktoken_available = False
                log.info("tiktoken not available, falling back to approximate token counting")
        return cls._tiktoken_available

    @staticmethod
    def _resolve_encoding(model: str) -> str:
        if model in MODEL_TO_ENCODING:
            return MODEL_TO_ENCODING[model]
        for prefix, encoding in MODEL_PREFIX_TO_ENCODING:
            if model.startswith(prefix):
                return encoding
        return "cl100k_base"

    def _get_encoding(self) -> Any:
        if not self.is_available():
            return None
        with self._cache_lock:
            if self._encoding_name not in self._encoding_cache:
                import tiktoken
                try:
                    self._encoding_cache[self._encoding_name] = tiktoken.get_encoding(self._encoding_name)
                except Exception:
                    try:
                        self._encoding_cache[self._encoding_name] = tiktoken.get_encoding("cl100k_base")
                    except Exception:
                        return None
            return self._encoding_cache[self._encoding_name]

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        enc = self._get_encoding()
        if enc is not None:
            try:
                return len(enc.encode(text, disallowed_special=()))
            except Exception as _exc:
                log_ignored(log, "token_counter.TokenCounter.count_tokens", _exc)
        return self._approximate_count(text)

    def count_messages_tokens(self, messages: list[dict[str, Any]]) -> int:
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str):
                total += self.count_tokens(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        total += self.count_tokens(part.get("text", ""))
            if msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    total += self.count_tokens(fn.get("name", ""))
                    total += self.count_tokens(fn.get("arguments", ""))
            if msg.get("role") == "tool":
                total += self.count_tokens(str(msg.get("tool_call_id", "")))
        return max(1, total)

    @staticmethod
    def _approximate_count(text: str) -> int:
        cn_chars = 0
        jp_chars = 0
        kr_chars = 0
        other_chars = 0
        for ch in text:
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x2A6DF:
                cn_chars += 1
            elif 0x3040 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF:
                jp_chars += 1
            elif 0xAC00 <= cp <= 0xD7AF or 0x1100 <= cp <= 0x11FF:
                kr_chars += 1
            else:
                other_chars += 1
        cn_tokens = int(cn_chars * 1.5)
        jp_tokens = int(jp_chars * 1.2)
        kr_tokens = int(kr_chars * 1.3)
        en_tokens = max(1, other_chars // 4) if other_chars > 0 else 0
        return max(1, cn_tokens + jp_tokens + kr_tokens + en_tokens)


_global_counter: TokenCounter | None = None
_global_counter_lock = threading.Lock()


def get_token_counter(model: str = "gpt-4o") -> TokenCounter:
    global _global_counter
    if _global_counter is None:
        with _global_counter_lock:
            if _global_counter is None:
                _global_counter = TokenCounter(model=model)
    return _global_counter

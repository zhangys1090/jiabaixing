"""语义工具选择器 — 基于 embedding 的工具语义检索。

对工具名称和描述做 embedding 编码，与用户输入做语义匹配，
返回最相关的 Top-K 工具。作为场景关键词匹配的补充，提高工具选择准确率。

依赖 sentence-transformers（已在 pyproject.toml 中声明）。

Usage:
    selector = SemanticToolSelector(tool_registry=registry)
    tools = selector.select("搜索今天的天气", top_k=15)
"""

from __future__ import annotations

import threading
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("semantic_selector")



class SemanticToolSelector:
    """语义工具选择器。

    使用 sentence-transformers 对工具描述进行向量编码，
    与用户输入做余弦相似度匹配，返回最相关的工具。

    特性：
    - 惰性初始化：首次调用时加载模型并编码全部工具描述
    - 工具描述缓存：工具注册表变更时自动失效
    - 优雅降级：模型不可用时返回 None
    - 线程安全：编码和搜索使用锁保护

    Usage:
        selector = SemanticToolSelector(tool_registry=registry)
        tools = selector.select("发送邮件给张三", top_k=10)
    """

    _DEFAULT_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
    _EMBEDDING_DIM = 384

    def __init__(self, tool_registry: Any, model_name: str = _DEFAULT_MODEL) -> None:
        self._tool_registry = tool_registry
        self._model_name = model_name
        self._model: Any = None
        self._embeddings: list[Any] = []
        self._tool_names: list[str] = []
        self._lock = threading.Lock()
        self._initialized = False
        self._tool_count_at_init = 0

    def select(self, input_text: str, top_k: int = 15) -> list[dict[str, Any]] | None:
        if not self._ensure_initialized():
            return None

        try:
            import numpy as np
        except ImportError:
            return None

        with self._lock:
            if not self._embeddings:
                return None
            query_embedding = self._model.encode([input_text], show_progress_bar=False)
            embeddings_array = np.array(self._embeddings)
            similarity = np.dot(embeddings_array, query_embedding[0]) / (
                np.linalg.norm(embeddings_array, axis=1) * np.linalg.norm(query_embedding[0])
            )
            top_indices = np.argsort(similarity)[-top_k:][::-1]
            selected_names = [self._tool_names[i] for i in top_indices if similarity[i] > 0.1]

        if not selected_names:
            return None

        all_tools = self._tool_registry.to_openai_tools()
        selected_set = set(selected_names)
        return [
            t for t in all_tools
            if (t.get("function", {}).get("name") or t.get("name")) in selected_set
        ]

    def _ensure_initialized(self) -> bool:
        if self._initialized:
            return True

        tool_count = self._tool_registry.size() if self._tool_registry else 0
        if tool_count == 0:
            return False

        with self._lock:
            if self._initialized:
                if tool_count != self._tool_count_at_init:
                    self._initialized = False
                else:
                    return True

            try:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(self._model_name)
            except Exception as e:
                log.warning("Failed to load sentence-transformers model", error=str(e))
                return False

            all_tools = self._tool_registry.to_openai_tools()
            descriptions: list[str] = []
            names: list[str] = []

            for tool in all_tools:
                fn = tool.get("function", {})
                name = fn.get("name", "")
                desc = fn.get("description", "")
                if name:
                    names.append(name)
                    descriptions.append(f"{name}: {desc}")

            if not descriptions:
                return False

            try:
                self._embeddings = self._model.encode(
                    descriptions, show_progress_bar=False,
                ).tolist()
                if len(self._embeddings) > self._MAX_EMBEDDINGS:
                    self._embeddings = self._embeddings[-self._MAX_EMBEDDINGS * 3 // 4:]
                self._tool_names = names
                if len(self._tool_names) > self._MAX_TOOL_NAMES:
                    self._tool_names = self._tool_names[-self._MAX_TOOL_NAMES * 3 // 4:]
                self._tool_count_at_init = tool_count
                self._initialized = True
                log.info(
                    "Semantic tool selector initialized",
                    tools=len(names),
                    model=self._model_name,
                )
            except Exception as e:
                log.warning("Failed to encode tool descriptions", error=str(e))
                return False

        return self._initialized

    def invalidate(self) -> None:
        with self._lock:
            self._initialized = False
            self._embeddings = []
            self._tool_names = []
        log.info("Semantic tool selector cache invalidated")

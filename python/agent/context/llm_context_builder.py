"""智能记忆筛选构建器（LLMContextBuilder）。

对标 TS 侧 src/memory/LLMContextBuilder.ts。

负责智能筛选和排序记忆：
- 相关性评分
- 记忆去重
- 记忆压缩
- 场景感知权重调整
- Token 预算控制
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class LLMContextBuilderConfig:
    """构建器配置。

    Attributes:
        max_memories: 最大记忆数量。
        min_relevance: 最小相关性阈值。
        max_total_length: 最大总长度（字符）。
        enable_deduplication: 是否启用去重。
        enable_compression: 是否启用压缩。
        context_window: 上下文窗口大小（Token）。
    """

    max_memories: int = 8
    min_relevance: float = 0.15
    max_total_length: int = 2000
    enable_deduplication: bool = True
    enable_compression: bool = True
    context_window: int = 4096


@dataclass
class FilteredMemory:
    """筛选后的记忆。

    Attributes:
        content: 记忆内容。
        relevance: 相关性分数。
        timestamp: 时间戳。
        memory_type: 记忆类型。
        source: 来源。
        compressed: 是否已压缩。
    """

    content: str = ""
    relevance: float = 0.0
    timestamp: str = ""
    memory_type: str = "general"
    source: str = ""
    compressed: bool = False


@dataclass
class LLMContextResult:
    """构建结果。

    Attributes:
        memories: 筛选后的记忆列表。
        total_tokens: 估算 Token 数。
        total_length: 总字符长度。
        filtered_count: 被过滤的记忆数。
        deduplicated_count: 去重的记忆数。
    """

    memories: list[FilteredMemory] = field(default_factory=list)
    total_tokens: int = 0
    total_length: int = 0
    filtered_count: int = 0
    deduplicated_count: int = 0


class LLMContextBuilder:
    """智能记忆筛选构建器。

    对标 TS 侧 LLMContextBuilder。

    负责从原始记忆中智能筛选最相关的内容，供 LLM 上下文使用。

    Usage:
        config = LLMContextBuilderConfig(max_memories=8, min_relevance=0.15)
        builder = LLMContextBuilder(config)

        raw_memories = [{"content": "...", "relevance": 0.8}, ...]
        result = builder.build(raw_memories, scene="coding", max_tokens=2000)
        for mem in result.memories:
            print(f"[{mem.relevance:.2f}] {mem.content}")
    """

    _SCENE_WEIGHTS: dict[str, float] = {
        "coding": 1.2,
        "analysis": 1.0,
        "conversation": 0.8,
        "search": 0.9,
        "automation": 1.1,
        "general": 1.0,
    }

    _TYPE_WEIGHTS: dict[str, float] = {
        "episodic": 1.0,
        "semantic": 0.8,
        "procedural": 1.1,
        "conversation": 0.9,
        "general": 0.7,
    }

    def __init__(self, config: LLMContextBuilderConfig | None = None) -> None:
        """初始化构建器。

        Args:
            config: 配置，None 则使用默认配置。
        """
        self._config = config or LLMContextBuilderConfig()

    @property
    def config(self) -> LLMContextBuilderConfig:
        """当前配置。"""
        return self._config

    def build(
        self,
        raw_memories: list[dict[str, Any]],
        scene: str = "general",
        max_tokens: int = 0,
        emotion: str = "",
        user_input: str = "",
    ) -> LLMContextResult:
        """构建筛选后的记忆列表。

        Args:
            raw_memories: 原始记忆列表。
            scene: 场景类型。
            max_tokens: 最大 Token 数，0 表示使用配置默认值。
            emotion: 情感类型。
            user_input: 用户输入（用于相关性增强）。

        Returns:
            LLMContextResult: 构建结果。
        """
        result = LLMContextResult()
        scene_weight = self._SCENE_WEIGHTS.get(scene, 1.0)
        effective_max_tokens = max_tokens if max_tokens > 0 else self._config.context_window

        scored: list[FilteredMemory] = []
        for mem in raw_memories:
            relevance = self._compute_relevance(mem, scene_weight, emotion, user_input)

            if relevance < self._config.min_relevance:
                result.filtered_count += 1
                continue

            scored.append(FilteredMemory(
                content=mem.get("content", ""),
                relevance=relevance,
                timestamp=mem.get("timestamp", ""),
                memory_type=mem.get("type", "general"),
                source=mem.get("source", ""),
                compressed=False,
            ))

        scored.sort(key=lambda m: m.relevance, reverse=True)

        if self._config.enable_deduplication:
            scored, deduped = self._deduplicate(scored)
            result.deduplicated_count = deduped

        scored = self._apply_token_limit(
            scored,
            self._config.max_memories,
            self._config.max_total_length,
            effective_max_tokens,
        )

        if self._config.enable_compression:
            scored = self._compress(scored, effective_max_tokens)

        total_length = sum(len(m.content) for m in scored)
        total_tokens = total_length // 4

        result.memories = scored
        result.total_length = total_length
        result.total_tokens = total_tokens

        return result

    def _compute_relevance(
        self,
        memory: dict[str, Any],
        scene_weight: float,
        emotion: str,
        user_input: str,
    ) -> float:
        """计算记忆的相关性分数。

        Args:
            memory: 记忆条目。
            scene_weight: 场景权重。
            emotion: 情感类型。
            user_input: 用户输入。

        Returns:
            相关性分数。
        """
        base_relevance = float(memory.get("relevance", 0.5))
        memory_type = memory.get("type", "general")
        type_weight = self._TYPE_WEIGHTS.get(memory_type, 0.7)

        score = base_relevance * scene_weight * type_weight

        score = max(0.0, min(1.0, score))

        if user_input and memory.get("content"):
            score += self._keyword_overlap_score(user_input, memory["content"]) * 0.2

        return max(0.0, min(1.0, score))

    def _keyword_overlap_score(self, text1: str, text2: str) -> float:
        """计算关键词重叠分数。

        Args:
            text1: 文本1。
            text2: 文本2。

        Returns:
            重叠分数 (0.0 ~ 1.0)。
        """
        words1 = set(text1.lower().split())
        words2 = set(text2.lower().split())
        if not words1 or not words2:
            return 0.0
        intersection = words1 & words2
        return len(intersection) / min(len(words1), len(words2))

    def _deduplicate(
        self,
        memories: list[FilteredMemory],
    ) -> tuple[list[FilteredMemory], int]:
        """去重记忆。

        基于内容相似度去重，保留相关性更高的。

        Args:
            memories: 记忆列表。

        Returns:
            (去重后的列表, 去重数量)。
        """
        if len(memories) <= 1:
            return memories, 0

        seen: set[str] = set()
        unique: list[FilteredMemory] = []
        deduped = 0

        for mem in memories:
            content_key = mem.content[:100].strip().lower()
            if content_key in seen:
                deduped += 1
                continue
            seen.add(content_key)
            unique.append(mem)

        return unique, deduped

    def _apply_token_limit(
        self,
        memories: list[FilteredMemory],
        max_count: int,
        max_length: int,
        max_tokens: int,
    ) -> list[FilteredMemory]:
        """应用 Token 限制。

        Args:
            memories: 记忆列表。
            max_count: 最大数量。
            max_length: 最大字符长度。
            max_tokens: 最大 Token 数。

        Returns:
            截断后的记忆列表。
        """
        limited = memories[:max_count]

        total_length = 0
        result: list[FilteredMemory] = []
        for mem in limited:
            mem_tokens = len(mem.content) // 4 + 10
            if total_length + len(mem.content) > max_length:
                break
            total_length += len(mem.content)
            result.append(mem)

        return result

    def _compress(
        self,
        memories: list[FilteredMemory],
        max_tokens: int,
    ) -> list[FilteredMemory]:
        """压缩记忆。

        对过长的记忆内容进行截断。

        Args:
            memories: 记忆列表。
            max_tokens: 最大 Token 数。

        Returns:
            压缩后的记忆列表。
        """
        total_tokens = sum(len(m.content) // 4 for m in memories)

        if total_tokens <= max_tokens:
            return memories

        per_memory = max_tokens // max(len(memories), 1)
        for mem in memories:
            if len(mem.content) > per_memory * 4:
                mem.content = mem.content[: per_memory * 4] + "..."
                mem.compressed = True

        return memories

    def build_simple(
        self,
        raw_memories: list[dict[str, Any]],
        scene: str = "general",
    ) -> list[dict[str, Any]]:
        """简化构建，返回字典格式。

        Args:
            raw_memories: 原始记忆列表。
            scene: 场景类型。

        Returns:
            筛选后的记忆字典列表。
        """
        result = self.build(raw_memories, scene=scene)
        return [
            {
                "content": m.content,
                "relevance": m.relevance,
                "timestamp": m.timestamp,
                "type": m.memory_type,
                "source": m.source,
                "compressed": m.compressed,
            }
            for m in result.memories
        ]

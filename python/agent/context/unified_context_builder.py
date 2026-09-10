"""统一上下文构建器（UnifiedContextBuilder）。

对标 TS 侧 src/harness/context/UnifiedContextBuilder.ts。

作为上下文系统的统一入口，整合所有上下文相关组件：
- UnifiedContextPipeline：上下文数据生成（场景、情感、记忆、画像）
- UnifiedContextOrchestrator：组件编排和执行
- LLMContextBuilder：智能记忆筛选

提供简洁的 build_context(options) 接口，内部协调所有组件的协作。

Usage:
    builder = UnifiedContextBuilder()
    result = await builder.build_context(
        user_input="帮我写一个排序函数",
        user_id="user_1",
        include_system_prompt=True,
        include_memory=True,
    )
    logger.info("状态: {result.status}, 消息数: {len(result.messages)}")
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.context.llm_context_builder import LLMContextBuilder, LLMContextBuilderConfig
from agent.context.unified_context_pipeline import (
    UnifiedContext,
    UnifiedContextPipeline,
)
import logging
logger = logging.getLogger(__name__)


@dataclass
class ContextBuildOptions:
    """上下文构建选项。

    Attributes:
        user_input: 用户输入。
        user_id: 用户ID。
        include_system_prompt: 是否包含系统 Prompt。
        include_memory: 是否包含记忆。
        include_file_context: 是否包含文件上下文。
        resolve_references: 是否解析 @引用。
        max_tokens: 最大 Token 预算。
        scene: 场景类型（不指定则自动检测）。
        history: 历史消息列表。
        history_limit: 历史消息数量限制。
    """

    user_input: str = ""
    user_id: str = ""
    include_system_prompt: bool = True
    include_memory: bool = True
    include_file_context: bool = False
    resolve_references: bool = False
    max_tokens: int = 4096
    scene: str = ""
    history: list[dict[str, str]] = field(default_factory=list)
    history_limit: int = 20


@dataclass
class ContextStats:
    """上下文统计。

    Attributes:
        total_messages: 总消息数。
        estimated_tokens: 估算 Token 数。
        memory_count: 记忆数量。
        file_context_count: 文件上下文数量。
        reference_count: 引用解析数。
        build_time_ms: 构建耗时（毫秒）。
    """

    total_messages: int = 0
    estimated_tokens: int = 0
    memory_count: int = 0
    file_context_count: int = 0
    reference_count: int = 0
    build_time_ms: float = 0.0


@dataclass
class ContextBuildResult:
    """上下文构建结果。

    Attributes:
        messages: 完整的消息列表（可直接发送给 LLM）。
        system_prompt: 系统 Prompt。
        memories: 记忆内容列表。
        unified_context: 统一上下文（场景、情感、时间等）。
        stats: 构建统计。
        status: 构建状态 (success/partial/failed)。
        errors: 错误详情。
    """

    messages: list[dict[str, str]] = field(default_factory=list)
    system_prompt: str = ""
    memories: list[str] = field(default_factory=list)
    unified_context: UnifiedContext | None = None
    stats: ContextStats = field(default_factory=ContextStats)
    status: str = "success"
    errors: list[dict[str, str]] = field(default_factory=list)


class UnifiedContextBuilder:
    """统一上下文构建器。

    对标 TS 侧 UnifiedContextBuilder。

    上下文系统的统一入口，整合所有上下文相关组件，提供简洁的构建接口。

    特性：
    - 单例模式：全局唯一实例
    - 缓存机制：系统 Prompt 缓存，减少重复构建
    - 错误隔离：每个组件独立 try-catch，不影响整体
    - 统计追踪：构建次数、耗时、缓存命中率
    """

    _instance: UnifiedContextBuilder | None = None

    def __init__(self) -> None:
        self._pipeline = UnifiedContextPipeline()
        self._llm_context_builder = LLMContextBuilder()

        self._cache_enabled: bool = True
        self._system_prompt_cache: str | None = None
        self._cache_timestamp: float = 0.0
        self._cache_ttl: float = 300.0

        self._build_count: int = 0
        self._total_build_time: float = 0.0
        self._cache_hits: int = 0
        self._cache_checks: int = 0

        self._orchestrator: Any = None

    @classmethod
    def get_instance(cls) -> UnifiedContextBuilder:
        """获取单例实例。

        Returns:
            UnifiedContextBuilder: 单例实例。
        """
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """重置单例实例（测试用）。"""
        cls._instance = None

    def set_orchestrator(self, orchestrator: Any) -> None:
        """设置上下文编排器。

        Args:
            orchestrator: UnifiedContextOrchestrator 实例。
        """
        self._orchestrator = orchestrator

    def set_memory_engine(self, engine: Any) -> None:
        """设置记忆引擎。

        Args:
            engine: 记忆引擎实例。
        """
        self._pipeline.set_memory_engine(engine)

    def set_sovereignty_pipeline(self, pipeline: Any) -> None:
        """设置数据主权管道。

        Args:
            pipeline: 数据主权管道实例。
        """
        self._pipeline.set_sovereignty_pipeline(pipeline)

    async def build_context(
        self,
        user_input: str = "",
        user_id: str = "",
        include_system_prompt: bool = True,
        include_memory: bool = True,
        include_file_context: bool = False,
        resolve_references: bool = False,
        max_tokens: int = 4096,
        scene: str = "",
        history: list[dict[str, str]] | None = None,
        history_limit: int = 20,
    ) -> ContextBuildResult:
        """构建完整上下文（异步）。

        Args:
            user_input: 用户输入。
            user_id: 用户ID。
            include_system_prompt: 是否包含系统 Prompt。
            include_memory: 是否包含记忆。
            include_file_context: 是否包含文件上下文。
            resolve_references: 是否解析 @引用。
            max_tokens: 最大 Token 预算。
            scene: 场景类型。
            history: 历史消息。
            history_limit: 历史消息数量限制。

        Returns:
            ContextBuildResult: 构建结果。
        """
        start_time = time.time()
        self._build_count += 1

        options = ContextBuildOptions(
            user_input=user_input,
            user_id=user_id,
            include_system_prompt=include_system_prompt,
            include_memory=include_memory,
            include_file_context=include_file_context,
            resolve_references=resolve_references,
            max_tokens=max_tokens,
            scene=scene,
            history=history or [],
            history_limit=history_limit,
        )

        return await self._build(options, start_time)

    def build_context_sync(
        self,
        user_input: str = "",
        user_id: str = "",
        include_system_prompt: bool = True,
        include_memory: bool = True,
        include_file_context: bool = False,
        resolve_references: bool = False,
        max_tokens: int = 4096,
        scene: str = "",
        history: list[dict[str, str]] | None = None,
        history_limit: int = 20,
    ) -> ContextBuildResult:
        """构建完整上下文（同步）。"""
        start_time = time.time()
        self._build_count += 1

        options = ContextBuildOptions(
            user_input=user_input,
            user_id=user_id,
            include_system_prompt=include_system_prompt,
            include_memory=include_memory,
            include_file_context=include_file_context,
            resolve_references=resolve_references,
            max_tokens=max_tokens,
            scene=scene,
            history=history or [],
            history_limit=history_limit,
        )

        return self._build_sync(options, start_time)

    async def _build(
        self,
        options: ContextBuildOptions,
        start_time: float,
    ) -> ContextBuildResult:
        """异步执行构建。"""
        result = ContextBuildResult()
        errors: list[dict[str, str]] = []

        unified_context = await self._pipeline.build_context(
            user_input=options.user_input,
            user_id=options.user_id,
        )
        result.unified_context = unified_context

        if options.include_system_prompt:
            result.system_prompt = self._build_system_prompt(unified_context)

        if options.include_memory:
            memories = await self._build_memories(
                unified_context.memories,
                unified_context.scene.type,
                options.max_tokens,
            )
            result.memories = memories

        result.messages = self._build_messages(
            options=options,
            system_prompt=result.system_prompt,
            unified_context=unified_context,
        )

        result.stats = self._compute_stats(
            options=options,
            result=result,
            start_time=start_time,
        )

        if errors:
            result.status = "partial"
            result.errors = errors

        return result

    def _build_sync(
        self,
        options: ContextBuildOptions,
        start_time: float,
    ) -> ContextBuildResult:
        """同步执行构建。"""
        result = ContextBuildResult()
        errors: list[dict[str, str]] = []

        unified_context = self._pipeline.build_context_sync(
            user_input=options.user_input,
            user_id=options.user_id,
        )
        result.unified_context = unified_context

        if options.include_system_prompt:
            result.system_prompt = self._build_system_prompt(unified_context)

        if options.include_memory:
            memories = self._llm_context_builder.build_simple(
                unified_context.memories,
                scene=unified_context.scene.type,
            )
            result.memories = [m["content"] for m in memories]

        result.messages = self._build_messages(
            options=options,
            system_prompt=result.system_prompt,
            unified_context=unified_context,
        )

        result.stats = self._compute_stats(
            options=options,
            result=result,
            start_time=start_time,
        )

        if errors:
            result.status = "partial"
            result.errors = errors

        return result

    def _build_system_prompt(self, context: UnifiedContext) -> str:
        """构建系统 Prompt。

        Args:
            context: 统一上下文。

        Returns:
            系统 Prompt 字符串。
        """
        self._cache_checks += 1

        if self._cache_enabled and self._system_prompt_cache is not None:
            if time.time() - self._cache_timestamp < self._cache_ttl:
                self._cache_hits += 1
                return self._system_prompt_cache

        time_slot = context.time_context.time_slot
        scene = context.scene.type

        prompt_parts = [
            f"当前时间: {time_slot}",
            f"当前场景: {scene}",
        ]

        if context.emotion.type != "neutral":
            prompt_parts.append(
                f"用户情绪: {context.emotion.type} (强度: {context.emotion.intensity:.1f})"
            )

        prompt_parts.append("请根据当前场景和用户情绪提供合适的回应。")

        system_prompt = "\n".join(prompt_parts)

        if self._cache_enabled:
            self._system_prompt_cache = system_prompt
            self._cache_timestamp = time.time()

        return system_prompt

    async def _build_memories(
        self,
        raw_memories: list[dict[str, Any]],
        scene: str,
        max_tokens: int,
    ) -> list[str]:
        """异步构建记忆列表。

        Args:
            raw_memories: 原始记忆。
            scene: 场景类型。
            max_tokens: 最大 Token。

        Returns:
            记忆内容列表。
        """
        if not raw_memories:
            return []

        result = self._llm_context_builder.build(
            raw_memories,
            scene=scene,
            max_tokens=max_tokens,
        )

        return [m.content for m in result.memories]

    def _build_messages(
        self,
        options: ContextBuildOptions,
        system_prompt: str,
        unified_context: UnifiedContext,
    ) -> list[dict[str, str]]:
        """构建消息列表。

        Args:
            options: 构建选项。
            system_prompt: 系统 Prompt。
            unified_context: 统一上下文。

        Returns:
            消息列表。
        """
        messages: list[dict[str, str]] = []

        if system_prompt and options.include_system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if options.history:
            limited_history = options.history[-options.history_limit :]
            for msg in limited_history:
                messages.append({
                    "role": msg.get("role", "user"),
                    "content": msg.get("content", ""),
                })

        if options.user_input:
            messages.append({"role": "user", "content": options.user_input})

        return messages

    def _compute_stats(
        self,
        options: ContextBuildOptions,
        result: ContextBuildResult,
        start_time: float,
    ) -> ContextStats:
        """计算构建统计。

        Args:
            options: 构建选项。
            result: 构建结果。
            start_time: 开始时间。

        Returns:
            ContextStats: 构建统计。
        """
        build_time = (time.time() - start_time) * 1000
        self._total_build_time += build_time

        total_tokens = sum(len(m.get("content", "")) // 4 for m in result.messages)

        return ContextStats(
            total_messages=len(result.messages),
            estimated_tokens=total_tokens,
            memory_count=len(result.memories),
            file_context_count=0,
            reference_count=0,
            build_time_ms=build_time,
        )

    @property
    def build_count(self) -> int:
        """构建次数。"""
        return self._build_count

    @property
    def average_build_time_ms(self) -> float:
        """平均构建耗时。"""
        if self._build_count == 0:
            return 0.0
        return self._total_build_time / self._build_count

    @property
    def cache_hit_rate(self) -> float:
        """缓存命中率。"""
        if self._cache_checks == 0:
            return 0.0
        return self._cache_hits / self._cache_checks

    def clear_cache(self) -> None:
        """清除缓存。"""
        self._system_prompt_cache = None
        self._cache_timestamp = 0.0
        self._cache_hits = 0
        self._cache_checks = 0

    def reset_stats(self) -> None:
        """重置统计。"""
        self._build_count = 0
        self._total_build_time = 0.0
        self._cache_hits = 0
        self._cache_checks = 0

"""V2: 视觉记忆 — 屏幕场景的记忆存储与跨模态检索。

现有 MemoryEngine.store_multimodal 已支持文本+图像联合编码，
本模块在此基础上增加"视觉记忆"层：

1. 场景记忆（Scene Memory）：将 ScreenScene 存储为可检索的记忆条目
2. 操作轨迹记忆（Operation Trace）：记录"在什么场景下做了什么操作，结果如何"
3. 跨模态关联（Cross-Modal Association）：文本描述↔屏幕场景的双向关联
4. 场景匹配（Scene Matching）：当前屏幕与历史场景的相似度匹配，实现"见过类似界面"

核心价值：
- Agent遇到类似界面时，可检索历史操作轨迹，复用成功经验
- 跨模态检索：用"设置页面"文本查询匹配到曾经见过的设置界面截图
- 操作轨迹沉淀：自动记录感知-行动闭环的结果，供R4反思知识复用

Usage:
    from agent.memory.visual_memory import VisualMemory
    vm = VisualMemory(memory_engine)
    await vm.store_scene(scene, action="点击确定", result="成功")
    matches = await vm.match_scene(current_scene)
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("visual_memory")


@dataclass
class OperationTrace:
    scene_type: str
    app_name: str
    window_title: str
    action: str
    result: str
    success: bool
    duration_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def trace_id(self) -> str:
        raw = f"{self.scene_type}:{self.app_name}:{self.action}:{self.timestamp}"
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "scene_type": self.scene_type,
            "app_name": self.app_name,
            "window_title": self.window_title,
            "action": self.action,
            "result": self.result,
            "success": self.success,
            "duration_ms": self.duration_ms,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
        }


@dataclass
class SceneMatch:
    scene_id: str
    similarity: float
    scene_type: str
    app_name: str
    window_title: str
    operation_traces: list[OperationTrace] = field(default_factory=list)
    success_rate: float = 0.0


class VisualMemory:
    """V2: 视觉记忆管理器.

    在 MemoryEngine 之上提供视觉记忆特化能力：
    - 场景记忆存储与检索
    - 操作轨迹记录与复用
    - 跨模态关联（文本↔场景）
    - 场景匹配（当前↔历史）

    设计原则：
    - 不替代 MemoryEngine，而是其上的特化层
    - 所有存储最终走 MemoryEngine.store_multimodal，复用其向量编码
    - 非阻塞：存储/检索失败不阻断主流程
    """

    _SCENE_MEMORY_TYPE = "visual_scene"
    _TRACE_MEMORY_TYPE = "operation_trace"
    _MAX_TRACES_PER_SCENE = 20

    def __init__(self, memory_engine: Any = None) -> None:
        self._memory = memory_engine
        self._trace_cache: dict[str, list[OperationTrace]] = {}
        self._MAX_TRACE_CACHE = 100

    async def store_scene(
        self,
        scene: Any,
        action: str = "",
        result: str = "",
        success: bool = True,
        screenshot_path: str = "",
        duration_ms: float = 0.0,
    ) -> str:
        """存储屏幕场景为视觉记忆.

        Args:
            scene: ScreenScene 对象（来自 screen_semantics.py）
            action: 在此场景下执行的操作描述
            result: 操作结果描述
            success: 操作是否成功
            screenshot_path: 关联的截图路径
            duration_ms: 操作耗时

        Returns:
            str: 记忆条目ID
        """
        if self._memory is None:
            return ""

        try:
            scene_type = getattr(scene, "scene_type", None)
            scene_type_str = scene_type.value if hasattr(scene_type, "value") else str(scene_type or "unknown")
            app_name = getattr(scene, "app_name", "") or ""
            window_title = getattr(scene, "window_title", "") or ""
            summary = getattr(scene, "summary", "") or ""
            scene_confidence = getattr(scene, "scene_confidence", 0.0)

            content_parts = [f"[场景记忆] {app_name} - {scene_type_str}"]
            if window_title:
                content_parts.append(f"窗口: {window_title}")
            if summary:
                content_parts.append(summary)
            if action:
                content_parts.append(f"操作: {action} → {'成功' if success else '失败'}")
                if result:
                    content_parts.append(f"结果: {result}")

            content = "；".join(content_parts)

            metadata: dict[str, Any] = {
                "visual_memory": True,
                "scene_type": scene_type_str,
                "app_name": app_name,
                "window_title": window_title,
                "scene_confidence": scene_confidence,
                "action": action,
                "success": success,
            }

            if hasattr(scene, "regions") and scene.regions:
                metadata["region_types"] = [r.region_type.value if hasattr(r.region_type, "value") else str(r.region_type) for r in scene.regions]

            if hasattr(scene, "interactive_elements") and scene.interactive_elements:
                metadata["interactive_count"] = len(scene.interactive_elements)

            scene_id = await self._memory.store_multimodal(
                content=content,
                image_path=screenshot_path,
                memory_type=self._SCENE_MEMORY_TYPE,
                scene=scene_type_str,
                metadata=metadata,
            )

            if action:
                trace = OperationTrace(
                    scene_type=scene_type_str,
                    app_name=app_name,
                    window_title=window_title,
                    action=action,
                    result=result,
                    success=success,
                    duration_ms=duration_ms,
                    metadata={"scene_id": scene_id},
                )
                self._cache_trace(trace)

            log.info(
                "V2: visual scene stored",
                scene_id=scene_id,
                scene_type=scene_type_str,
                app=app_name,
                has_action=bool(action),
            )

            return scene_id

        except Exception as e:
            log.warning("V2: failed to store visual scene", error=str(e))
            return ""

    async def match_scene(self, current_scene: Any, limit: int = 5, min_similarity: float = 0.3) -> list[SceneMatch]:
        """场景匹配：当前屏幕与历史场景的相似度匹配.

        Args:
            current_scene: 当前 ScreenScene 对象
            limit: 最多返回的匹配数
            min_similarity: 最小相似度阈值

        Returns:
            list[SceneMatch]: 按相似度降序的匹配结果
        """
        if self._memory is None:
            return []

        try:
            scene_type = getattr(current_scene, "scene_type", None)
            scene_type_str = scene_type.value if hasattr(scene_type, "value") else str(scene_type or "unknown")
            app_name = getattr(current_scene, "app_name", "") or ""
            window_title = getattr(current_scene, "window_title", "") or ""

            query_parts = [app_name, scene_type_str]
            if window_title:
                query_parts.append(window_title)
            query = " ".join(p for p in query_parts if p)

            if not query:
                return []

            results = await self._memory.search_multimodal(
                query=query,
                limit=limit * 3,
                memory_type=self._SCENE_MEMORY_TYPE,
                min_relevance=min_similarity,
            )

            matches: list[SceneMatch] = []
            for r in results:
                meta = r.get("metadata", {}) or {}
                if not meta.get("visual_memory"):
                    continue

                similarity = r.get("relevance_score", 0.0)
                if similarity < min_similarity:
                    continue

                hist_scene_type = meta.get("scene_type", "unknown")
                hist_app = meta.get("app_name", "")
                hist_title = meta.get("window_title", "")

                if hist_scene_type == scene_type_str:
                    similarity = min(1.0, similarity + 0.15)
                if hist_app and hist_app == app_name:
                    similarity = min(1.0, similarity + 0.1)

                scene_id = r.get("id", "")
                traces = self._trace_cache.get(scene_id, [])

                success_count = sum(1 for t in traces if t.success)
                success_rate = success_count / len(traces) if traces else 0.0

                matches.append(SceneMatch(
                    scene_id=scene_id,
                    similarity=similarity,
                    scene_type=hist_scene_type,
                    app_name=hist_app,
                    window_title=hist_title,
                    operation_traces=traces[:5],
                    success_rate=success_rate,
                ))

            matches.sort(key=lambda m: m.similarity, reverse=True)

            log.info(
                "V2: scene matching completed",
                query_scene=scene_type_str,
                matches=len(matches[:limit]),
                top_similarity=matches[0].similarity if matches else 0.0,
            )

            return matches[:limit]

        except Exception as e:
            log.warning("V2: scene matching failed", error=str(e))
            return []

    async def get_successful_actions(self, scene: Any, limit: int = 5) -> list[OperationTrace]:
        """获取在类似场景下的成功操作轨迹，供操作复用.

        Args:
            scene: 当前 ScreenScene
            limit: 最多返回数

        Returns:
            list[OperationTrace]: 成功的操作轨迹列表
        """
        matches = await self.match_scene(scene, limit=3)
        traces: list[OperationTrace] = []
        for match in matches:
            successful = [t for t in match.operation_traces if t.success]
            traces.extend(successful)
        traces.sort(key=lambda t: t.timestamp, reverse=True)
        return traces[:limit]

    async def associate_text_to_scene(self, text_description: str, scene_id: str) -> None:
        """跨模态关联：建立文本描述↔场景的双向关联.

        Args:
            text_description: 文本描述（如"微信设置页面"）
            scene_id: 场景记忆ID
        """
        if self._memory is None:
            return

        try:
            await self._memory.store_multimodal(
                content=f"[场景关联] {text_description} → scene:{scene_id}",
                memory_type="visual_association",
                scene="cross_modal",
                metadata={
                    "visual_memory": True,
                    "association_type": "text_to_scene",
                    "text": text_description,
                    "target_scene_id": scene_id,
                },
            )
            log.debug("V2: text-scene association created", text=text_description[:30], scene_id=scene_id)
        except Exception as e:
            log.warning("V2: text-scene association failed", error=str(e))

    def _cache_trace(self, trace: OperationTrace) -> None:
        """缓存操作轨迹到内存."""
        key = f"{trace.scene_type}:{trace.app_name}"
        if key not in self._trace_cache:
            self._trace_cache[key] = []
        self._trace_cache[key].append(trace)
        if len(self._trace_cache[key]) > self._MAX_TRACES_PER_SCENE:
            self._trace_cache[key] = self._trace_cache[key][-self._MAX_TRACES_PER_SCENE:]
        if len(self._trace_cache) > self._MAX_TRACE_CACHE:
            oldest_key = next(iter(self._trace_cache))
            del self._trace_cache[oldest_key]

"""子系统注册中心 — 按依赖关系自动装配。

设计目的:
- 集中管理 AgentEngine 的子系统注册与启动
- 配合 dependencies.py 实现拓扑排序的自动初始化
- 隔离"装配逻辑"和"业务逻辑"，便于测试

使用方式:
    registry = SubsystemRegistry()
    registry.register_many(SUBSYSTEM_DEPS)
    results = await registry.boot_all(engine)  # 自动按拓扑序启动

不重复造轮子:
- 直接调用 dependencies.topological_order，不重新实现
- 内部用 asyncio 而非第三方库

遵循项目开发规则:
- 所有公共类/方法有 docstring
- 失败可降级（critical=False 时不阻断）
- 中文日志
"""
from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any, Callable

from agent.core.dependencies import SubsystemSpec, topological_order
from agent.core.logger import StructuredLogger

if TYPE_CHECKING:
    from agent.core.engine import AgentEngine

log = StructuredLogger("subsystem_registry")

# 进度回调类型: (当前阶段, 总阶段数, 阶段名, 已完成数, 阶段内总数)
ProgressCallback = Callable[[int, int, str, int, int], None]


class SubsystemRegistry:
    """集中管理 AgentEngine 的所有子系统注册 + 启动。

    Attributes:
        _specs: 已注册的子系统 spec 字典（按 name 索引）。
        _boot_results: 最近一次 boot_all 的结果。
        _boot_metrics: 最近一次 boot_all 的启动指标 {name: {duration_ms, success}}。
    """

    def __init__(self) -> None:
        self._specs: dict[str, SubsystemSpec] = {}
        self._boot_results: dict[str, Any] = {}
        self._boot_metrics: dict[str, dict[str, Any]] = {}

    # ── 注册 API ──

    def register(self, spec: SubsystemSpec) -> None:
        """注册单个子系统。

        Args:
            spec: 子系统声明。

        Raises:
            ValueError: 重复注册时。
        """
        if spec.name in self._specs:
            raise ValueError(
                f"重复注册子系统: {spec.name!r}。"
                f"已存在 factory={self._specs[spec.name].factory!r}，"
                f"新注册 factory={spec.factory!r}"
            )
        self._specs[spec.name] = spec

    def register_many(self, specs: list[SubsystemSpec]) -> None:
        """批量注册（按列表顺序）。"""
        for spec in specs:
            self.register(spec)

    # ── 查询 API ──

    @property
    def size(self) -> int:
        """已注册子系统数量。"""
        return len(self._specs)

    def get(self, name: str) -> SubsystemSpec | None:
        """按名查找 spec，未找到返回 None。"""
        return self._specs.get(name)

    def all_specs(self) -> list[SubsystemSpec]:
        """所有已注册 spec（插入顺序）。"""
        return list(self._specs.values())

    def topological_order(self) -> list[SubsystemSpec]:
        """返回拓扑排序后的 spec 列表。

        Raises:
            ValueError: 检测到循环依赖或未知依赖。
        """
        return topological_order(self.all_specs())

    # ── 启动 API ──

    async def boot_all(
        self,
        engine: "AgentEngine",
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        """按拓扑顺序并行启动所有子系统。

        实现细节:
        - 按依赖深度自动分层，同层子系统用 asyncio.gather 并行启动
        - 每完成一层调用 on_progress 回调报告进度
        - 每个子系统启动耗时记录到 boot_metrics

        Args:
            engine: AgentEngine 实例。子系统 factory 方法必须挂在 engine 上。
            on_progress: 可选的进度回调函数。
                签名: (stage_index, total_stages, stage_name, done_count, stage_total) -> None

        Returns:
            {子系统名: 启动结果} 的字典。失败时值为 None。

        Raises:
            ValueError: 依赖图存在循环或未知依赖。
            RuntimeError: critical 子系统失败时透传异常。
        """
        order = self.topological_order()
        stages = self._group_by_depth(order)
        total_stages = len(stages)

        log.info(
            "Booting subsystems in parallel stages",
            count=len(order),
            stages=total_stages,
        )

        results: dict[str, Any] = {}
        metrics: dict[str, dict[str, Any]] = {}

        for stage_idx, stage_specs in enumerate(stages, start=1):
            stage_name = self._stage_name(stage_idx, total_stages, stage_specs)

            # 并行启动当前阶段的所有子系统
            stage_tasks = [
                self._boot_single(engine, spec, results, metrics)
                for spec in stage_specs
            ]
            gathered = await asyncio.gather(*stage_tasks, return_exceptions=True)

            # 检查是否有 critical 异常被 gather 捕获，需要重新抛出
            for item in gathered:
                if isinstance(item, BaseException):
                    raise item

            done_in_stage = sum(
                1 for s in stage_specs if results.get(s.name) is not None
            )

            if on_progress:
                try:
                    on_progress(
                        stage_idx,
                        total_stages,
                        stage_name,
                        done_in_stage,
                        len(stage_specs),
                    )
                except Exception as e:
                    log.warning("Progress callback failed", error=str(e))

        self._boot_results = results
        self._boot_metrics = metrics
        self._log_boot_summary(metrics)
        return results

    # ── 内部辅助 ──

    def _group_by_depth(self, order: list[SubsystemSpec]) -> list[list[SubsystemSpec]]:
        """按依赖深度将拓扑排序后的 spec 分层。

        深度定义: 节点到根（无依赖节点）的最长路径长度。
        同深度的节点互相无依赖（或有已满足的依赖），可安全并行。

        Returns:
            分层列表，每层是同一深度的 spec 列表。
        """
        depth_map: dict[str, int] = {}
        for spec in order:
            if not spec.deps:
                depth_map[spec.name] = 0
            else:
                depth_map[spec.name] = max(
                    depth_map.get(dep, 0) for dep in spec.deps
                ) + 1

        max_depth = max(depth_map.values()) if depth_map else 0
        stages: list[list[SubsystemSpec]] = [[] for _ in range(max_depth + 1)]
        for spec in order:
            stages[depth_map[spec.name]].append(spec)

        # 过滤空层（理论上不应出现，但防御性处理）
        return [s for s in stages if s]

    def _stage_name(
        self, stage_idx: int, total: int, specs: list[SubsystemSpec]
    ) -> str:
        """生成阶段描述名。"""
        names = [s.name for s in specs[:3]]
        suffix = "..." if len(specs) > 3 else ""
        return f"Stage {stage_idx}/{total} ({', '.join(names)}{suffix})"

    async def _boot_single(
        self,
        engine: "AgentEngine",
        spec: SubsystemSpec,
        results: dict[str, Any],
        metrics: dict[str, dict[str, Any]],
    ) -> None:
        """启动单个子系统并记录指标。

        注意: 此方法直接修改传入的 results 和 metrics 字典（副作用），
        便于 asyncio.gather 并行调用时共享状态。
        """
        method = getattr(engine, spec.factory, None)
        if method is None:
            log.error(
                "Subsystem factory method not found",
                name=spec.name,
                factory=spec.factory,
            )
            metrics[spec.name] = {
                "duration_ms": 0,
                "success": False,
                "error": f"Missing method {spec.factory!r}",
            }
            if spec.critical:
                raise RuntimeError(
                    f"Critical subsystem '{spec.name}' "
                    f"缺少方法 {spec.factory!r}"
                )
            results[spec.name] = None
            return

        start = time.perf_counter()
        try:
            result = await method()
            results[spec.name] = result
            duration_ms = int((time.perf_counter() - start) * 1000)
            metrics[spec.name] = {
                "duration_ms": duration_ms,
                "success": True,
            }
            log.debug(
                "Subsystem ready",
                name=spec.name,
                duration_ms=duration_ms,
                critical=spec.critical,
            )
        except Exception as e:
            log.debug("registry 异常处理", error=str(e))
            duration_ms = int((time.perf_counter() - start) * 1000)
            metrics[spec.name] = {
                "duration_ms": duration_ms,
                "success": False,
                "error": str(e),
            }
            if spec.critical:
                log.error(
                    "Critical subsystem failed",
                    name=spec.name,
                    duration_ms=duration_ms,
                    error=str(e),
                )
                raise
            log.warning(
                "Subsystem init failed, continuing with degraded mode",
                name=spec.name,
                duration_ms=duration_ms,
                error=str(e),
            )
            results[spec.name] = None

    def _log_boot_summary(self, metrics: dict[str, dict[str, Any]]) -> None:
        """打印启动摘要报告。"""
        if not metrics:
            return

        total = len(metrics)
        success = sum(1 for m in metrics.values() if m.get("success"))
        durations = [m["duration_ms"] for m in metrics.values()]
        total_ms = sum(durations)
        avg_ms = total_ms // total if total else 0
        slowest = max(metrics.items(), key=lambda x: x[1]["duration_ms"])

        log.info(
            "Boot summary report",
            total=total,
            success=success,
            failed=total - success,
            total_ms=total_ms,
            avg_ms=avg_ms,
            slowest_name=slowest[0],
            slowest_ms=slowest[1]["duration_ms"],
        )

    # ── 兼容 API ──

    @property
    def boot_results(self) -> dict[str, Any]:
        """最近一次 boot_all 的结果。"""
        return dict(self._boot_results)

    @property
    def boot_metrics(self) -> dict[str, dict[str, Any]]:
        """最近一次 boot_all 的启动指标。

        Returns:
            {子系统名: {"duration_ms": int, "success": bool, "error": str|None}}
        """
        return dict(self._boot_metrics)

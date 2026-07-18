"""AgentEngine 子系统依赖声明测试 — TDD 阶段。

本模块验证：
1. SubsystemSpec 数据类不可变（frozen）
2. topological_order 基础拓扑排序
3. topological_order 检测循环依赖
4. topological_order 检测未知依赖
5. ConversationLoop 必须依赖 hook_manager（修复当前顺序 bug）
6. 真实 SUBSYSTEM_DEPS 列表无循环、无未知依赖
7. AgentEngine.initialize_v2() 启动后所有子系统就绪

设计原则:
- 不依赖真实 LLM/数据库（用 mock 替换）
- 测试独立可运行
- 先写失败测试，看到红色再实现

遵循项目开发规则:
- 测试文件命名: test_<模块名>.py
- 测试方法命名: test_<行为描述>
- 中文 docstring
"""
from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─────────────────────────────────────────────────────────────
# 1. SubsystemSpec 数据类测试
# ─────────────────────────────────────────────────────────────


class TestSubsystemSpec:
    """SubsystemSpec 应该是 frozen dataclass，实例不可变。"""

    def test_spec_is_immutable(self) -> None:
        """SubsystemSpec 实例创建后字段不可修改。"""
        from agent.core.dependencies import SubsystemSpec

        spec = SubsystemSpec(name="llm", factory="_init_llm", deps=(), critical=True)
        with pytest.raises((AttributeError, Exception)):
            spec.name = "modified"  # type: ignore[misc]

    def test_spec_equality(self) -> None:
        """两个相同 spec 应相等（dataclass 默认行为）。"""
        from agent.core.dependencies import SubsystemSpec

        a = SubsystemSpec(name="x", factory="fx", deps=("y",))
        b = SubsystemSpec(name="x", factory="fx", deps=("y",))
        assert a == b

    def test_spec_default_critical_true(self) -> None:
        """critical 默认 True（失败即整体不可用）。"""
        from agent.core.dependencies import SubsystemSpec

        spec = SubsystemSpec(name="x", factory="fx")
        assert spec.critical is True

    def test_spec_deps_is_tuple(self) -> None:
        """deps 字段是 tuple（不可变），支持 hashable。"""
        from agent.core.dependencies import SubsystemSpec

        spec = SubsystemSpec(name="x", factory="fx", deps=("a", "b"))
        assert isinstance(spec.deps, tuple)
        # 可作为 dict key
        _ = {spec: 1}


# ─────────────────────────────────────────────────────────────
# 2. topological_order 基础测试
# ─────────────────────────────────────────────────────────────


class TestTopologicalOrder:
    """拓扑排序应按依赖关系返回正确顺序。"""

    def test_empty_specs(self) -> None:
        """空列表返回空列表。"""
        from agent.core.dependencies import topological_order

        assert topological_order([]) == []

    def test_single_spec_no_deps(self) -> None:
        """单个无依赖 spec 应被返回。"""
        from agent.core.dependencies import SubsystemSpec, topological_order

        specs = [SubsystemSpec(name="a", factory="fa")]
        order = topological_order(specs)
        assert [s.name for s in order] == ["a"]

    def test_linear_deps(self) -> None:
        """线性依赖 a→b→c 应返回 [c, b, a]（被依赖的先）。"""
        from agent.core.dependencies import SubsystemSpec, topological_order

        specs = [
            SubsystemSpec(name="a", factory="fa", deps=("b",)),
            SubsystemSpec(name="b", factory="fb", deps=("c",)),
            SubsystemSpec(name="c", factory="fc"),
        ]
        order = topological_order(specs)
        names = [s.name for s in order]
        # a 在 b 之后，b 在 c 之后
        assert names.index("a") > names.index("b")
        assert names.index("b") > names.index("c")

    def test_diamond_deps(self) -> None:
        """菱形依赖 d 依赖 b,c；b,c 都依赖 a → a 必须最早。"""
        from agent.core.dependencies import SubsystemSpec, topological_order

        specs = [
            SubsystemSpec(name="d", factory="fd", deps=("b", "c")),
            SubsystemSpec(name="b", factory="fb", deps=("a",)),
            SubsystemSpec(name="c", factory="fc", deps=("a",)),
            SubsystemSpec(name="a", factory="fa"),
        ]
        order = topological_order(specs)
        names = [s.name for s in order]
        assert names.index("a") < names.index("b")
        assert names.index("a") < names.index("c")
        assert names.index("b") < names.index("d")
        assert names.index("c") < names.index("d")

    def test_detects_cycle(self) -> None:
        """循环依赖 a→b→a 应抛出 ValueError。"""
        from agent.core.dependencies import SubsystemSpec, topological_order

        specs = [
            SubsystemSpec(name="a", factory="fa", deps=("b",)),
            SubsystemSpec(name="b", factory="fb", deps=("a",)),
        ]
        with pytest.raises(ValueError, match="循环依赖"):
            topological_order(specs)

    def test_detects_three_node_cycle(self) -> None:
        """三节点循环 a→b→c→a 应被检测。"""
        from agent.core.dependencies import SubsystemSpec, topological_order

        specs = [
            SubsystemSpec(name="a", factory="fa", deps=("b",)),
            SubsystemSpec(name="b", factory="fb", deps=("c",)),
            SubsystemSpec(name="c", factory="fc", deps=("a",)),
        ]
        with pytest.raises(ValueError, match="循环依赖"):
            topological_order(specs)

    def test_detects_missing_dep(self) -> None:
        """依赖未声明的子系统应抛出 ValueError。"""
        from agent.core.dependencies import SubsystemSpec, topological_order

        specs = [
            SubsystemSpec(name="a", factory="fa", deps=("nonexistent",)),
        ]
        with pytest.raises(ValueError, match="未知子系统"):
            topological_order(specs)


# ─────────────────────────────────────────────────────────────
# 3. SUBSYSTEM_DEPS 真实依赖图测试
# ─────────────────────────────────────────────────────────────


class TestSubsystemDeps:
    """真实的 SUBSYSTEM_DEPS 列表必须自洽。"""

    def test_subsystem_deps_is_not_empty(self) -> None:
        """SUBSYSTEM_DEPS 应该声明所有 27 个子系统。"""
        from agent.core.dependencies import SUBSYSTEM_DEPS

        assert len(SUBSYSTEM_DEPS) >= 20, (
            f"预期至少 20 个子系统，实际 {len(SUBSYSTEM_DEPS)}。"
            "如果新增了子系统，请在 SUBSYSTEM_DEPS 中声明。"
        )

    def test_no_duplicate_names(self) -> None:
        """不应有重复的子系统名。"""
        from agent.core.dependencies import SUBSYSTEM_DEPS

        names = [s.name for s in SUBSYSTEM_DEPS]
        duplicates = [n for n in names if names.count(n) > 1]
        assert not duplicates, f"重复的子系统名: {set(duplicates)}"

    def test_all_deps_resolvable(self) -> None:
        """所有声明的依赖必须在 SUBSYSTEM_DEPS 中能找到。"""
        from agent.core.dependencies import SUBSYSTEM_DEPS

        declared = {s.name for s in SUBSYSTEM_DEPS}
        for spec in SUBSYSTEM_DEPS:
            for dep in spec.deps:
                assert dep in declared, (
                    f"子系统 '{spec.name}' 依赖未声明的 '{dep}'"
                )

    def test_no_cycles(self) -> None:
        """SUBSYSTEM_DEPS 不得有循环依赖。"""
        from agent.core.dependencies import SUBSYSTEM_DEPS, topological_order

        # 不应抛异常
        topological_order(SUBSYSTEM_DEPS)

    def test_conversation_depends_on_hook_manager(self) -> None:
        """🚨 回归测试: ConversationLoop 必须依赖 hook_manager。

        当前 engine.py:440-449 的 bug:
        - ConversationLoop 构造时传入 hook_manager=self.hook_manager
        - 但 hook_manager 在 engine.py:601 才初始化
        - 导致 self.hook_manager 是 None 时被传入

        SUBSYSTEM_DEPS 必须强制此顺序，杜绝 bug 重现。
        """
        from agent.core.dependencies import SUBSYSTEM_DEPS

        specs_by_name = {s.name: s for s in SUBSYSTEM_DEPS}
        assert "conversation" in specs_by_name, "SUBSYSTEM_DEPS 缺少 conversation"
        assert "hook_manager" in specs_by_name, "SUBSYSTEM_DEPS 缺少 hook_manager"

        conv_spec = specs_by_name["conversation"]
        assert "hook_manager" in conv_spec.deps, (
            "🚨 BUG: conversation 必须声明依赖 hook_manager，"
            "否则会重蹈当前 engine.py 的顺序 bug"
        )

    def test_loop_dependencies_complete(self) -> None:
        """LoopController 必须显式声明所有依赖。"""
        from agent.core.dependencies import SUBSYSTEM_DEPS

        specs_by_name = {s.name: s for s in SUBSYSTEM_DEPS}
        loop_spec = specs_by_name.get("loop")
        assert loop_spec is not None, "缺少 loop 子系统"

        required = {"llm", "trajectory_db", "tool_registry", "canary_manager", "constraints"}
        missing = required - set(loop_spec.deps)
        assert not missing, f"loop 缺少依赖: {missing}"

    def test_llm_has_no_deps(self) -> None:
        """llm 是基础依赖，不应依赖其他子系统。"""
        from agent.core.dependencies import SUBSYSTEM_DEPS

        llm_spec = next(s for s in SUBSYSTEM_DEPS if s.name == "llm")
        assert llm_spec.deps == (), f"llm 不应有依赖，实际: {llm_spec.deps}"


# ─────────────────────────────────────────────────────────────
# 4. SubsystemRegistry 测试
# ─────────────────────────────────────────────────────────────


class TestSubsystemRegistry:
    """SubsystemRegistry 提供集中注册 + 启动能力。"""

    def test_register_and_count(self) -> None:
        """注册后可通过 registry 看到。"""
        from agent.core.dependencies import SubsystemSpec
        from agent.core.registry import SubsystemRegistry

        reg = SubsystemRegistry()
        reg.register(SubsystemSpec(name="a", factory="fa"))
        reg.register(SubsystemSpec(name="b", factory="fb", deps=("a",)))
        assert reg.size == 2

    def test_register_duplicate_raises(self) -> None:
        """重复注册应抛 ValueError。"""
        from agent.core.dependencies import SubsystemSpec
        from agent.core.registry import SubsystemRegistry

        reg = SubsystemRegistry()
        reg.register(SubsystemSpec(name="a", factory="fa"))
        with pytest.raises(ValueError, match="重复注册"):
            reg.register(SubsystemSpec(name="a", factory="fa2"))

    def test_boot_all_runs_in_order(self) -> None:
        """boot_all 应按拓扑顺序调用 factory。"""
        from agent.core.dependencies import SubsystemSpec
        from agent.core.registry import SubsystemRegistry

        call_order: list[str] = []

        class FakeEngine:
            async def _init_a(self) -> str:
                call_order.append("a")
                return "A"

            async def _init_b(self) -> str:
                call_order.append("b")
                return "B"

        reg = SubsystemRegistry()
        reg.register(SubsystemSpec(name="b", factory="_init_b", deps=("a",)))
        reg.register(SubsystemSpec(name="a", factory="_init_a"))

        # 用 asyncio 运行
        import asyncio
        results = asyncio.run(reg.boot_all(FakeEngine()))

        assert call_order == ["a", "b"], f"启动顺序错误: {call_order}"
        assert results == {"a": "A", "b": "B"}

    def test_boot_all_non_critical_continues_on_error(self) -> None:
        """非 critical 子系统失败应降级，不中断后续启动。"""
        from agent.core.dependencies import SubsystemSpec
        from agent.core.registry import SubsystemRegistry

        class FakeEngine:
            async def _init_a(self) -> str:
                raise RuntimeError("boom")

            async def _init_b(self) -> str:
                return "B"

        reg = SubsystemRegistry()
        reg.register(SubsystemSpec(name="a", factory="_init_a", critical=False))
        reg.register(SubsystemSpec(name="b", factory="_init_b"))

        import asyncio
        results = asyncio.run(reg.boot_all(FakeEngine()))

        assert results["a"] is None
        assert results["b"] == "B"

    def test_boot_all_critical_raises(self) -> None:
        """critical 子系统失败应传播异常。"""
        from agent.core.dependencies import SubsystemSpec
        from agent.core.registry import SubsystemRegistry

        class FakeEngine:
            async def _init_a(self) -> str:
                raise RuntimeError("critical failure")

        reg = SubsystemRegistry()
        reg.register(SubsystemSpec(name="a", factory="_init_a", critical=True))

        import asyncio
        with pytest.raises(RuntimeError, match="critical failure"):
            asyncio.run(reg.boot_all(FakeEngine()))


# ─────────────────────────────────────────────────────────────
# 5. AgentEngine.initialize_v2() 集成测试
# ─────────────────────────────────────────────────────────────


class TestAgentEngineInitializeV2:
    """AgentEngine.initialize_v2() 应正确启动所有子系统。"""

    async def test_initialize_v2_has_correct_signature(self) -> None:
        """initialize_v2 方法必须存在且签名正确。"""
        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        assert hasattr(engine, "initialize_v2"), "initialize_v2 方法必须存在"
        assert callable(engine.initialize_v2), "initialize_v2 必须是可调用的"

    async def test_engine_has_init_methods_for_all_subsystems(self) -> None:
        """AgentEngine 必须为 SUBSYSTEM_DEPS 中的每个子系统提供 _init_xxx 方法。"""
        from agent.core.engine import AgentEngine
        from agent.core.dependencies import SUBSYSTEM_DEPS

        engine = AgentEngine()
        missing_methods = []
        for spec in SUBSYSTEM_DEPS:
            if not hasattr(engine, spec.factory):
                missing_methods.append(spec.factory)

        assert not missing_methods, (
            f"以下 _init_xxx 方法缺失: {missing_methods}。"
            "请在 engine.py 中为每个 SUBSYSTEM_DEPS 声明添加对应的初始化方法。"
        )

    async def test_engine_has_registry_after_initialize_v2(self) -> None:
        """initialize_v2 启动后 engine._registry 必须被设置。"""
        from agent.core.engine import AgentEngine
        from agent.core.dependencies import SUBSYSTEM_DEPS
        from agent.core.registry import SubsystemRegistry

        engine = AgentEngine()
        assert engine._registry is None, "初始化前 _registry 应为 None"

        await engine.initialize_v2()

        assert engine._registry is not None, "初始化后 _registry 必须不为 None"
        assert isinstance(engine._registry, SubsystemRegistry)
        assert len(engine._registry._specs) == len(SUBSYSTEM_DEPS)

    async def test_registry_topological_order_respects_hook_before_conversation(self) -> None:
        """registry 的拓扑排序必须保证 hook_manager 在 conversation 之前。"""
        from agent.core.engine import AgentEngine
        from agent.core.dependencies import SUBSYSTEM_DEPS

        engine = AgentEngine()
        await engine.initialize_v2()

        reg = engine._registry
        order = [s.name for s in reg.topological_order()]

        hook_idx = order.index("hook_manager")
        conv_idx = order.index("conversation")

        assert hook_idx < conv_idx, (
            f"🚨 hook_manager 应在 conversation 之前启动。"
            f"实际顺序: hook_manager={hook_idx}, conversation={conv_idx}。"
            f"完整顺序: {order}"
        )


# ─────────────────────────────────────────────────────────────
# 6. 并行启动测试 (P0)
# ─────────────────────────────────────────────────────────────

class TestParallelBoot:
    """boot_all 应并行启动无依赖的子系统。"""

    async def test_parallel_boot_faster_than_sequential(self) -> None:
        """并行启动应比串行快（至少 1.5x）。"""
        from agent.core.registry import SubsystemRegistry
        from agent.core.dependencies import SubsystemSpec

        delays = {"a": 0.05, "b": 0.05, "c": 0.05}

        class DummyEngine:
            async def _init_a(self):
                await asyncio.sleep(delays["a"])
                return "a"
            async def _init_b(self):
                await asyncio.sleep(delays["b"])
                return "b"
            async def _init_c(self):
                await asyncio.sleep(delays["c"])
                return "c"

        engine = DummyEngine()
        registry = SubsystemRegistry()
        # a, b, c 互相无依赖，应并行
        registry.register_many([
            SubsystemSpec("a", "_init_a"),
            SubsystemSpec("b", "_init_b"),
            SubsystemSpec("c", "_init_c"),
        ])

        start = time.time()
        results = await registry.boot_all(engine)
        elapsed = time.time() - start

        assert results == {"a": "a", "b": "b", "c": "c"}
        # 串行需 ~150ms，并行应 < 100ms
        assert elapsed < 0.12, f"并行启动太慢: {elapsed:.3f}s，可能未真正并行"

    async def test_parallel_preserves_deps(self) -> None:
        """并行启动仍须尊重依赖顺序。"""
        from agent.core.registry import SubsystemRegistry
        from agent.core.dependencies import SubsystemSpec

        call_order: list[str] = []

        class DummyEngine:
            async def _init_parent(self):
                call_order.append("parent")
                return "parent"
            async def _init_child(self):
                call_order.append("child")
                return "child"

        engine = DummyEngine()
        registry = SubsystemRegistry()
        registry.register_many([
            SubsystemSpec("parent", "_init_parent"),
            SubsystemSpec("child", "_init_child", ("parent",)),
        ])

        await registry.boot_all(engine)
        assert call_order == ["parent", "child"], f"依赖顺序被破坏: {call_order}"


# ─────────────────────────────────────────────────────────────
# 7. 阶段报告 + 指标收集测试 (P1 + P2)
# ─────────────────────────────────────────────────────────────

class TestBootMetricsAndProgress:
    """boot_all 应收集启动指标并支持进度回调。"""

    async def test_boot_metrics_recorded(self) -> None:
        """启动后 metrics 应包含每个子系统的耗时。"""
        from agent.core.registry import SubsystemRegistry
        from agent.core.dependencies import SubsystemSpec

        class DummyEngine:
            async def _init_a(self):
                await asyncio.sleep(0.01)
                return "a"
            async def _init_b(self):
                await asyncio.sleep(0.02)
                return "b"

        engine = DummyEngine()
        registry = SubsystemRegistry()
        registry.register_many([
            SubsystemSpec("a", "_init_a"),
            SubsystemSpec("b", "_init_b"),
        ])

        await registry.boot_all(engine)
        metrics = registry.boot_metrics

        assert "a" in metrics, "metrics 应包含子系统 a"
        assert "b" in metrics, "metrics 应包含子系统 b"
        assert metrics["a"]["duration_ms"] >= 10, "a 的耗时应 >= 10ms"
        assert metrics["b"]["duration_ms"] >= 20, "b 的耗时应 >= 20ms"
        assert metrics["a"]["success"] is True
        assert metrics["b"]["success"] is True

    async def test_progress_callback_called(self) -> None:
        """进度回调应在每阶段后被调用。"""
        from agent.core.registry import SubsystemRegistry
        from agent.core.dependencies import SubsystemSpec

        class DummyEngine:
            async def _init_a(self):
                return "a"
            async def _init_b(self):
                return "b"
            async def _init_c(self):
                return "c"

        engine = DummyEngine()
        registry = SubsystemRegistry()
        registry.register_many([
            SubsystemSpec("a", "_init_a"),
            SubsystemSpec("b", "_init_b"),
            SubsystemSpec("c", "_init_c", ("a",)),
        ])

        progress_calls: list[dict[str, Any]] = []

        def on_progress(stage: int, total: int, name: str, done: int, count: int) -> None:
            progress_calls.append({
                "stage": stage, "total": total, "name": name,
                "done": done, "count": count,
            })

        await registry.boot_all(engine, on_progress=on_progress)

        assert len(progress_calls) > 0, "进度回调应至少被调用一次"
        # 最后一调应是完成状态
        assert progress_calls[-1]["done"] == progress_calls[-1]["count"]


# ─────────────────────────────────────────────────────────────
# 8. 配置预验证测试 (P3)
# ─────────────────────────────────────────────────────────────

class TestConfigPreValidation:
    """initialize_v2 应在启动前验证必要配置。"""

    async def test_missing_required_config_raises_early(self) -> None:
        """缺少必要配置时应立即报错，不启动任何子系统。"""
        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        # 模拟缺少必要配置
        engine._required_configs = ["OPENAI_API_KEY"]  # type: ignore[attr-defined]
        engine._validate_required_config = lambda: ["OPENAI_API_KEY"]  # type: ignore[attr-defined]

        with pytest.raises(RuntimeError, match="缺少必要配置"):
            await engine.initialize_v2()

        # 不应创建 registry（启动被阻断）
        assert engine._registry is None, "配置验证失败时不应创建 registry"

    async def test_valid_config_proceeds(self) -> None:
        """配置完整时应正常启动。"""
        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        # 模拟配置完整
        engine._validate_required_config = lambda: []  # type: ignore[attr-defined]

        await engine.initialize_v2()
        assert engine._registry is not None

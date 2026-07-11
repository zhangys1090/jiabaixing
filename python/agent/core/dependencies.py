"""AgentEngine 子系统依赖声明 — 单一事实源。

设计目的:
- 把 27 步线性初始化改为基于依赖图的拓扑排序
- 运行时检查依赖关系，杜绝"隐式顺序"bug（如 hook_manager 在 conversation 之后初始化）
- 失败可降级：非 critical 子系统失败不阻断整体启动

使用方式:
    from agent.core.dependencies import SUBSYSTEM_DEPS, topological_order

    for spec in topological_order(SUBSYSTEM_DEPS):
        await getattr(engine, spec.factory)()

不重复造轮子:
- 用 dataclass(frozen=True) 表达不可变 spec（标准库）
- 手写 DFS 拓扑排序（无需 networkx 等重依赖，~30 行即可）

遵循项目开发规则:
- 所有公共类/方法必须有 docstring
- type hints 完整
- 4 空格缩进，ruff 兼容
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agent.core.engine import AgentEngine


@dataclass(frozen=True)
class SubsystemSpec:
    """单个子系统的声明：名称、初始化方法、依赖、是否关键。

    Attributes:
        name: 子系统名（如 "llm", "memory"），必须唯一。
        factory: AgentEngine 上的方法名（不带括号），如 "_init_memory"。
            约定：方法应为 async def 且无参数（依赖通过 self 访问）。
        deps: 依赖的子系统名 tuple。必须为 tuple（不可变，支持 hash）。
        critical: 是否关键。True 表示失败即整体不可用（抛异常）；
            False 表示失败可降级，记录 warning 后继续。
    """

    name: str
    factory: str
    deps: tuple[str, ...] = field(default=())
    critical: bool = True

    def __post_init__(self) -> None:
        """校验字段合法性，避免运行时才报错。"""
        if not self.name:
            raise ValueError("SubsystemSpec.name 不能为空")
        if not self.factory:
            raise ValueError(f"SubsystemSpec({self.name!r}).factory 不能为空")
        if not isinstance(self.deps, tuple):
            # 自动转换 list → tuple，保留 frozen 语义
            object.__setattr__(self, "deps", tuple(self.deps))
        for dep in self.deps:
            if not isinstance(dep, str):
                raise TypeError(
                    f"SubsystemSpec({self.name!r}).deps 应为 str 元组，"
                    f"收到 {type(dep).__name__}"
                )


def topological_order(specs: list[SubsystemSpec]) -> list[SubsystemSpec]:
    """对子系统列表按依赖关系做拓扑排序。

    算法: DFS 后序遍历，O(V+E)。先访问所有依赖，再访问自身。

    Args:
        specs: 子系统声明列表。

    Returns:
        按依赖顺序排列的 SubsystemSpec 列表（被依赖的在前）。

    Raises:
        ValueError: 检测到循环依赖或未知依赖时抛出。
            错误信息包含完整路径，便于定位。
    """
    by_name: dict[str, SubsystemSpec] = {s.name: s for s in specs}
    visited: set[str] = set()
    on_stack: set[str] = set()  # 当前 DFS 路径上的节点（用于检测环）
    order: list[SubsystemSpec] = []

    def visit(spec: SubsystemSpec, path: tuple[str, ...] = ()) -> None:
        """DFS 访问单个节点，path 记录当前路径用于错误信息。"""
        if spec.name in visited:
            return
        if spec.name in on_stack:
            # 找到环：path + (重复节点) 就是完整环
            cycle_path = path + (spec.name,)
            raise ValueError(
                f"检测到循环依赖: {' -> '.join(cycle_path)}"
            )
        on_stack.add(spec.name)
        for dep in spec.deps:
            if dep not in by_name:
                raise ValueError(
                    f"子系统 '{spec.name}' 依赖未知子系统 '{dep}'。"
                    f"请在 SUBSYSTEM_DEPS 中先声明 '{dep}'。"
                )
            visit(by_name[dep], path + (spec.name,))
        on_stack.discard(spec.name)
        visited.add(spec.name)
        order.append(spec)

    for spec in specs:
        visit(spec)

    return order


# ─────────────────────────────────────────────────────────────
# 真实依赖图 — AgentEngine 全部 27+ 子系统
# ─────────────────────────────────────────────────────────────
#
# 维护规则:
# 1. 新增子系统必须在此声明 + 在 engine.py 加对应 _init_xxx 方法
# 2. deps 必须严格按真实依赖声明（即使当前代码里看着能跑），
#    避免未来重构时埋雷
# 3. 失败可降级的子系统（如网络相关）标 critical=False
#
# 历史 bug 修复:
# - engine.py:440-449 ConversationLoop 引用 hook_manager，但 hook_manager
#   在 line 601 才创建 → 已修复为 conversation 显式 deps=("hook_manager",)
#
SUBSYSTEM_DEPS: list[SubsystemSpec] = [
    # ── 基础设施层 (无依赖) ──
    SubsystemSpec("llm", "_init_llm", critical=False),  # LLM 不可用时降级
    SubsystemSpec("_redis_cache", "_init_redis_cache", critical=False),
    # ── 数据层 ──
    SubsystemSpec("trajectory_db", "_init_trajectory_db", critical=False),
    SubsystemSpec("memory", "_init_memory", ("llm",), critical=False),
    # ── 工具层 (并行) ──
    SubsystemSpec("tool_registry", "_init_tool_registry", critical=False),
    SubsystemSpec("toolset_registry", "_init_toolset_registry", ("tool_registry",), critical=False),
    SubsystemSpec("mcp_tool_bridge", "_init_mcp_tool_bridge", ("tool_registry",), critical=False),
    # ── 安全/校验层 ──
    SubsystemSpec("permission_guard", "_init_permission_guard", critical=False),
    SubsystemSpec("schema_validator", "_init_schema_validator", critical=False),
    SubsystemSpec("tool_call_guard", "_init_tool_call_guard", critical=False),
    SubsystemSpec("approval_manager", "_init_approval_manager", critical=False),
    # ── 灰度/约束层 (Loop 前置) ──
    SubsystemSpec("canary_manager", "_init_canary_manager", critical=False),
    SubsystemSpec("constraints", "_init_constraints", critical=False),
    # ── 钩子层 (修复: 必须在 conversation 之前) ──
    SubsystemSpec("hook_manager", "_init_hook_manager", critical=False),
    # ── 控制层 (LoopController 依赖) ──
    SubsystemSpec(
        "loop",
        "_init_loop",
        (
            "llm",
            "trajectory_db",
            "tool_registry",
            "canary_manager",
            "constraints",
            "memory",
        ),
        critical=False,
    ),
    SubsystemSpec("evolution", "_init_evolution", critical=False),
    # ── 对话层 (依赖 hook_manager 修复顺序 bug) ──
    SubsystemSpec(
        "conversation",
        "_init_conversation",
        (
            "llm",
            "tool_registry",
            "permission_guard",
            "schema_validator",
            "tool_call_guard",
            "approval_manager",
            "hook_manager",  # ← 关键修复点
        ),
        critical=False,
    ),
    # ── 上下文层 ──
    SubsystemSpec("context_file_registry", "_init_context_file_registry", critical=False),
    SubsystemSpec("context_reference_resolver", "_init_context_reference_resolver", critical=False),
    SubsystemSpec("context_manager", "_init_context_manager", critical=False),
    SubsystemSpec("context_compressor", "_init_context_compressor", critical=False),
    SubsystemSpec("context_window_manager", "_init_context_window_manager", critical=False),
    SubsystemSpec(
        "unified_context_orchestrator",
        "_init_unified_context_orchestrator",
        ("context_file_registry",),
        critical=False,
    ),
    # ── 治理层 ──
    SubsystemSpec("persona", "_init_persona", critical=False),
    SubsystemSpec("security", "_init_security", critical=False),
    SubsystemSpec("verification", "_init_verification", critical=False),
    SubsystemSpec("output_guardrail", "_init_output_guardrail", critical=False),
    # ── 业务能力层 ──
    SubsystemSpec("skill_registry", "_init_skill_registry", critical=False),
    SubsystemSpec("session_store", "_init_session_store", critical=False),
    SubsystemSpec("persistence", "_init_persistence", ("memory", "trajectory_db"), critical=False),
    SubsystemSpec("curator", "_init_curator", ("memory",), critical=False),
    SubsystemSpec("trajectory_flywheel", "_init_trajectory_flywheel", ("trajectory_db",), critical=False),
    SubsystemSpec("feedback_loops", "_init_feedback_loops", ("evolution", "memory"), critical=False),
    # ── 进化扩展层 ──
    SubsystemSpec("performance_monitor", "_init_performance_monitor", critical=False),
    SubsystemSpec(
        "evolution_trigger",
        "_init_evolution_trigger",
        ("performance_monitor", "evolution"),
        critical=False,
    ),
    SubsystemSpec("fewshot_generalizer", "_init_fewshot_generalizer", critical=False),
    SubsystemSpec("strategy_adapter", "_init_strategy_adapter", critical=False),
    SubsystemSpec("learning_signals", "_init_learning_signals", critical=False),
    SubsystemSpec("incremental_planner", "_init_incremental_planner", critical=False),
    SubsystemSpec("plan_quality_checker", "_init_plan_quality_checker", critical=False),
    SubsystemSpec("reflection_applier", "_init_reflection_applier", critical=False),
    SubsystemSpec("priority_scorer", "_init_priority_scorer", critical=False),
    SubsystemSpec("evolution_orchestrator", "_init_evolution_orchestrator", ("evolution",), critical=False),
    SubsystemSpec("multi_agent_orchestrator", "_init_multi_agent_orchestrator", ("llm",), critical=False),
    # ── 协议层 ──
    SubsystemSpec("a2a_manager", "_init_a2a_manager", critical=False),
    SubsystemSpec("a2a_self_card", "_init_a2a_self_card", ("a2a_manager",), critical=False),
    SubsystemSpec("a2a_auth_interceptor", "_init_a2a_auth_interceptor", critical=False),
    # ── 编排层 ──
    SubsystemSpec("agent_registry", "_init_agent_registry", critical=False),
    SubsystemSpec(
        "orchestrator",
        "_init_orchestrator",
        ("agent_registry", "a2a_manager", "a2a_self_card", "a2a_auth_interceptor"),
        critical=False,
    ),
    # ── 后台任务层 ──
    SubsystemSpec("cron_scheduler", "_init_cron_scheduler", critical=False),
    SubsystemSpec("sandbox", "_init_sandbox", critical=False),
    SubsystemSpec("batch_processor", "_init_batch_processor", critical=False),
    SubsystemSpec("think_scrubber", "_init_think_scrubber", critical=False),
    # ── 监控层 ──
    SubsystemSpec("production_metrics", "_init_production_metrics", critical=False),
    SubsystemSpec(
        "feedback_loop",
        "_init_feedback_loop",
        ("evolution", "canary_manager"),
        critical=False,
    ),
    # ── 新增: 搜索/发现层 ──
    SubsystemSpec("web_search", "_init_web_search", ("llm",), critical=False),
    SubsystemSpec("tool_search", "_init_tool_search", ("tool_registry",), critical=False),
    # ── 新增: 安全增强层 ──
    SubsystemSpec("path_security", "_init_path_security", critical=False),
    SubsystemSpec("url_safety", "_init_url_safety", critical=False),
    SubsystemSpec("ssl_guard", "_init_ssl_guard", critical=False),
    SubsystemSpec("redaction", "_init_redaction", critical=False),
    # ── 新增: 错误处理层 ──
    SubsystemSpec("error_classifier", "_init_error_classifier", critical=False),
    # ── 新增: 会话增强层 ──
    SubsystemSpec("title_generator", "_init_title_generator", critical=False),
    SubsystemSpec("session_recap", "_init_session_recap", critical=False),
    SubsystemSpec("session_search_index", "_init_session_search_index", ("memory",), critical=False),
    SubsystemSpec("session_lineage", "_init_session_lineage", ("session_search_index",), critical=False),
    # ── 新增: 凭据增强层 ──
    SubsystemSpec("credential_store", "_init_credential_store", critical=False),
    SubsystemSpec("credential_discovery", "_init_credential_discovery", ("credential_store",), critical=False),
    # ── 新增: 评估层 ──
    SubsystemSpec("eval_runner", "_init_eval_runner", ("llm",), critical=False),
    # ── 新增: Gateway 层 ──
    SubsystemSpec("gateway_dispatcher", "_init_gateway_dispatcher", critical=False),
    # ── 新增: A2A 增强层 ──
    SubsystemSpec("a2a_task_manager", "_init_a2a_task_manager", ("a2a_manager",), critical=False),
    SubsystemSpec("a2a_discovery", "_init_a2a_discovery", ("a2a_manager",), critical=False),
    SubsystemSpec("a2a_trust_manager", "_init_a2a_trust_manager", ("a2a_manager",), critical=False),
    # ── 用户体验层 (T0) ──
    SubsystemSpec("clarify", "_init_clarify", critical=False),
    SubsystemSpec("todo_manager", "_init_todo_manager", critical=False),
    SubsystemSpec("code_executor", "_init_code_executor", critical=False),
    SubsystemSpec("delegate", "_init_delegate", ("llm",), critical=False),
    SubsystemSpec("write_approval", "_init_write_approval", critical=False),
    # ── 效率层 (T1) ──
    SubsystemSpec("lazy_deps", "_init_lazy_deps", critical=False),
    SubsystemSpec("coding_context", "_init_coding_context", critical=False),
    SubsystemSpec("subdirectory_hints", "_init_subdirectory_hints", critical=False),
    SubsystemSpec("tool_result_cache", "_init_tool_result_cache", critical=False),
    SubsystemSpec("conversation_compressor", "_init_conversation_compressor", critical=False),
    # ── 安全可控层 (T2) ──
    SubsystemSpec("budget_guard", "_init_budget_guard", critical=False),
    SubsystemSpec("osv_checker", "_init_osv_checker", critical=False),
    SubsystemSpec("disk_cleaner", "_init_disk_cleaner", critical=False),
    SubsystemSpec("security_guidance", "_init_security_guidance", critical=False),
    # ── 差异化层 (T3+T4) ──
    SubsystemSpec("voice_mode", "_init_voice_mode", critical=False),
    SubsystemSpec("workspace", "_init_workspace", critical=False),
    SubsystemSpec("i18n", "_init_i18n", critical=False),
    SubsystemSpec("plugin_manager", "_init_plugin_manager", critical=False),
    # ── P3-P5 扩展节点 ──
    SubsystemSpec("skill_hub", "_init_skill_hub", critical=False),
    SubsystemSpec("skill_audit", "_init_skill_audit", critical=False),
    SubsystemSpec("profile_manager", "_init_profile_manager", critical=False),
    SubsystemSpec("async_delegator", "_init_async_delegator", ("llm",), critical=False),
    SubsystemSpec("memory_providers", "_init_memory_providers", critical=False),
    SubsystemSpec("proxy_server", "_init_proxy_server", critical=False),
    SubsystemSpec("dashboard_auth", "_init_dashboard_auth", critical=False),
    SubsystemSpec("hot_reloader", "_init_hot_reloader", critical=False),
    SubsystemSpec("shutdown_forensics", "_init_shutdown_forensics", critical=False),
    SubsystemSpec("relay_adapter", "_init_relay_adapter", critical=False),
    # ── P6 扩展节点 ──
    SubsystemSpec("batch_trajectory", "_init_batch_trajectory", critical=False),
    SubsystemSpec("stream_diag", "_init_stream_diag", critical=False),
    SubsystemSpec("nous_rate_guard", "_init_nous_rate_guard", critical=False),
    SubsystemSpec("portal_tags", "_init_portal_tags", critical=False),
]

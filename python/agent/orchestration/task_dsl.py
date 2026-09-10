"""任务编排 DSL（Task Orchestration DSL）。

提供声明式 DSL 语法来定义任务编排，替代繁琐的命令式 API 调用。

DSL 语法设计：
1. 顺序链式：task("A").then("B").then("C")
2. 并行分组：parallel("A", "B", "C")
3. 条件分支：branch("A", when=cond, then="B", else_="C")
4. 重试策略：task("A").retry(max_retries=3, backoff="exponential")
5. 超时控制：task("A").timeout(5000)
6. 优先级：task("A").priority("high")
7. 完整示例：
   pipeline("数据采集")
     .parallel("fetch_api", "scrape_web", "read_db")
     .then("merge_data")
     .branch("quality_check",
       when=lambda r: r["quality"] > 0.8,
       then="export",
       else_="clean_and_recheck")
     .then("notify")
     .timeout(60000)
     .build()

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- DSL 产出 OrchestrationExecutor 可直接执行的 DAG
- 非侵入式：纯增量模块，不修改 OrchestrationExecutor
"""

from __future__ import annotations

import ast as _ast
import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.orchestration.executor import (
    OrchestrationExecutor,
    OrchestrationConfig,
    OrchestrationResult,
    TaskNode,
    TaskStatus,
    TaskPriority,
)
from agent.core.logger import StructuredLogger
log = StructuredLogger("task_dsl")



# ---------------------------------------------------------------------------
# 安全的 DSL 条件求值器
#
# 历史实现使用 `eval(cond_str, {"__builtins__": {}}, row)` 解析 `when=` 条件，
# 即使清空 __builtins__，攻击方仍可通过属性遍历
# (如 `obj.__class__.__mro__[1].__subclasses__()`) 逃逸沙箱执行任意代码。
# 这里改为 AST 白名单校验 + 受限求值：仅允许比较/布尔/算术运算与对行字段的
# 名引用，禁止属性访问(Attribute)、调用(Call)、导入、下标(Subscript)等，
# 从根本上杜绝代码执行。
# ---------------------------------------------------------------------------
_ALLOWED_COND_NODES = (
    _ast.Expression, _ast.BoolOp, _ast.UnaryOp, _ast.BinOp, _ast.Compare,
    _ast.Name, _ast.Constant, _ast.Load,
    _ast.And, _ast.Or, _ast.Not, _ast.USub, _ast.UAdd,
    _ast.Add, _ast.Sub, _ast.Mult, _ast.Div, _ast.FloorDiv, _ast.Mod, _ast.Pow,
    _ast.BitAnd, _ast.BitOr, _ast.BitXor, _ast.LShift, _ast.RShift,
    _ast.Eq, _ast.NotEq, _ast.Lt, _ast.LtE, _ast.Gt, _ast.GtE, _ast.In, _ast.NotIn,
)


def _validate_dsl_condition(node: _ast.AST) -> None:
    for child in _ast.walk(node):
        if not isinstance(child, _ALLOWED_COND_NODES):
            raise ValueError(f"DSL 条件含不允许的语法节点: {type(child).__name__}")


def _compile_dsl_condition(expr: str) -> Callable[[dict], bool]:
    """将 DSL `when=` 条件字符串编译为安全的条件函数。

    仅允许比较/布尔/算术运算与对行字段(dict 键)的引用。任何属性访问、函数
    调用、导入、下标、格式化字符串等均被拒绝（编译期即失败，而非运行时逃逸）。
    """
    try:
        tree = _ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise ValueError(f"DSL 条件语法错误: {e}") from e
    _validate_dsl_condition(tree)
    code = compile(tree, "<dsl_condition>", "eval")
    _SAFE_GLOBALS = {"__builtins__": {}, "abs": abs, "len": len, "min": min, "max": max, "round": round, "int": int, "float": float, "str": str, "bool": bool}

    def _cond(row: dict) -> bool:
        try:
            return bool(eval(code, _SAFE_GLOBALS, row))
        except Exception as _exc:
            log.warning("task_dsl._compile_dsl_condition 条件求值失败", error=str(_exc), expr=expr[:80])
            return False

    return _cond


class RetryStrategy(str, Enum):
    NONE = "none"
    FIXED = "fixed"
    EXPONENTIAL = "exponential"
    LINEAR = "linear"


@dataclass
class RetryPolicy:
    max_retries: int = 0
    strategy: RetryStrategy = RetryStrategy.NONE
    base_delay_ms: float = 1000.0
    max_delay_ms: float = 30000.0


@dataclass
class TaskSpec:
    name: str
    executor: Callable[..., Awaitable[Any]] | None = None
    dependencies: list[str] = field(default_factory=list)
    priority: TaskPriority = TaskPriority.NORMAL
    timeout_ms: int = 60000
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)
    condition: Callable[[dict], bool] | None = None
    on_success: str | None = None
    on_failure: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    task_id: str = ""


class TaskBuilder:
    """单个任务的构建器。"""

    def __init__(self, name: str, executor: Callable[..., Awaitable[Any]] | None = None) -> None:
        self._spec = TaskSpec(
            name=name,
            executor=executor,
            task_id=f"task_{uuid.uuid4().hex[:8]}",
        )

    def with_executor(self, executor: Callable[..., Awaitable[Any]]) -> TaskBuilder:
        self._spec.executor = executor
        return self

    def depends_on(self, *task_names: str) -> TaskBuilder:
        self._spec.dependencies.extend(task_names)
        return self

    def priority(self, level: str) -> TaskBuilder:
        priority_map = {
            "critical": TaskPriority.CRITICAL,
            "high": TaskPriority.HIGH,
            "normal": TaskPriority.NORMAL,
            "low": TaskPriority.LOW,
        }
        self._spec.priority = priority_map.get(level.lower(), TaskPriority.NORMAL)
        return self

    def timeout(self, ms: int) -> TaskBuilder:
        self._spec.timeout_ms = ms
        return self

    def retry(self, max_retries: int = 3, strategy: str = "exponential", base_delay_ms: float = 1000.0) -> TaskBuilder:
        self._spec.retry_policy = RetryPolicy(
            max_retries=max_retries,
            strategy=RetryStrategy(strategy),
            base_delay_ms=base_delay_ms,
        )
        return self

    def when(self, condition: Callable[[dict], bool]) -> TaskBuilder:
        self._spec.condition = condition
        return self

    def on_success(self, next_task: str) -> TaskBuilder:
        self._spec.on_success = next_task
        return self

    def on_failure(self, next_task: str) -> TaskBuilder:
        self._spec.on_failure = next_task
        return self

    def meta(self, **kwargs: Any) -> TaskBuilder:
        self._spec.metadata.update(kwargs)
        return self

    def build_spec(self) -> TaskSpec:
        return self._spec


class PipelineBuilder:
    """流水线构建器：支持链式 then/parallel/branch 语法。"""

    def __init__(self, name: str = "pipeline") -> None:
        self._name = name
        self._specs: list[TaskSpec] = []
        self._last_task_ids: list[str] = []
        self._MAX_LAST_TASK_IDS = 1000
        self._default_timeout_ms = 60000
        self._default_retry_policy = RetryPolicy()

    def task(self, name: str, executor: Callable[..., Awaitable[Any]] | None = None) -> PipelineBuilder:
        spec = TaskSpec(
            name=name,
            executor=executor,
            dependencies=list(self._last_task_ids),
            task_id=f"task_{uuid.uuid4().hex[:8]}",
        )
        self._specs.append(spec)
        self._last_task_ids = [spec.task_id]
        return self

    def then(self, name: str, executor: Callable[..., Awaitable[Any]] | None = None) -> PipelineBuilder:
        return self.task(name, executor)

    def parallel(self, *task_defs: str | tuple[str, Callable[..., Awaitable[Any]]]) -> PipelineBuilder:
        parallel_ids: list[str] = []
        for td in task_defs:
            if isinstance(td, tuple):
                tname, texec = td
            else:
                tname, texec = td, None
            spec = TaskSpec(
                name=tname,
                executor=texec,
                dependencies=list(self._last_task_ids),
                task_id=f"task_{uuid.uuid4().hex[:8]}",
            )
            self._specs.append(spec)
            parallel_ids.append(spec.task_id)
        self._last_task_ids = parallel_ids
        return self

    def branch(
        self,
        name: str,
        when: Callable[[dict], bool] | None = None,
        then: str | None = None,
        else_: str | None = None,
    ) -> PipelineBuilder:
        branch_spec = TaskSpec(
            name=name,
            dependencies=list(self._last_task_ids),
            condition=when,
            task_id=f"task_{uuid.uuid4().hex[:8]}",
        )
        self._specs.append(branch_spec)

        branch_ids: list[str] = [branch_spec.task_id]

        if then:
            then_spec = TaskSpec(
                name=then,
                dependencies=[branch_spec.task_id],
                task_id=f"task_{uuid.uuid4().hex[:8]}",
            )
            then_spec.metadata["branch"] = "then"
            self._specs.append(then_spec)
            branch_ids.append(then_spec.task_id)

        if else_:
            else_spec = TaskSpec(
                name=else_,
                dependencies=[branch_spec.task_id],
                task_id=f"task_{uuid.uuid4().hex[:8]}",
            )
            else_spec.metadata["branch"] = "else"
            self._specs.append(else_spec)
            branch_ids.append(else_spec.task_id)

        self._last_task_ids = branch_ids
        return self

    def timeout(self, ms: int) -> PipelineBuilder:
        self._default_timeout_ms = ms
        for spec in self._specs:
            spec.timeout_ms = ms
        return self

    def retry(self, max_retries: int = 3, strategy: str = "exponential") -> PipelineBuilder:
        self._default_retry_policy = RetryPolicy(
            max_retries=max_retries,
            strategy=RetryStrategy(strategy),
        )
        for spec in self._specs:
            spec.retry_policy = self._default_retry_policy
        return self

    def priority(self, level: str) -> PipelineBuilder:
        priority_map = {
            "critical": TaskPriority.CRITICAL,
            "high": TaskPriority.HIGH,
            "normal": TaskPriority.NORMAL,
            "low": TaskPriority.LOW,
        }
        p = priority_map.get(level.lower(), TaskPriority.NORMAL)
        for spec in self._specs:
            spec.priority = p
        return self

    def build(self, config: OrchestrationConfig | None = None) -> OrchestrationExecutor:
        executor = OrchestrationExecutor(config or OrchestrationConfig())
        for spec in self._specs:
            exec_fn = spec.executor or self._make_placeholder(spec.name)
            executor.add_task_with_id(
                task_id=spec.task_id,
                name=spec.name,
                executor=exec_fn,
                dependencies=spec.dependencies,
                priority=spec.priority,
                timeout_ms=spec.timeout_ms,
                max_retries=spec.retry_policy.max_retries,
                metadata=spec.metadata,
            )
        return executor

    def build_specs(self) -> list[TaskSpec]:
        return list(self._specs)

    def _make_placeholder(self, name: str) -> Callable[..., Awaitable[Any]]:
        async def _placeholder(**kwargs: Any) -> str:
            return f"placeholder: {name}"
        return _placeholder


class TaskDSLParser:
    """DSL 文本解析器：将 DSL 文本解析为 PipelineBuilder。"""

    KEYWORD_TASK = "task"
    KEYWORD_THEN = "then"
    KEYWORD_PARALLEL = "parallel"
    KEYWORD_BRANCH = "branch"
    KEYWORD_WHEN = "when"
    KEYWORD_ELSE = "else"
    KEYWORD_TIMEOUT = "timeout"
    KEYWORD_RETRY = "retry"
    KEYWORD_PRIORITY = "priority"

    def parse(self, dsl_text: str) -> PipelineBuilder:
        lines = [l.strip() for l in dsl_text.strip().split("\n") if l.strip() and not l.strip().startswith("#")]
        if not lines:
            return PipelineBuilder("empty")

        first_line = lines[0]
        pipeline_name = "dsl_pipeline"
        if first_line.startswith("pipeline"):
            pipeline_name = first_line.split(None, 1)[1].strip().strip('"').strip("'") if len(first_line.split(None, 1)) > 1 else "dsl_pipeline"
            lines = lines[1:]

        builder = PipelineBuilder(pipeline_name)

        for line in lines:
            self._parse_line(line, builder)

        return builder

    def _parse_line(self, line: str, builder: PipelineBuilder) -> None:
        if line.startswith("task "):
            name = line[5:].strip().strip('"').strip("'")
            builder.task(name)
        elif line.startswith("then "):
            name = line[5:].strip().strip('"').strip("'")
            builder.then(name)
        elif line.startswith("parallel "):
            task_names = [t.strip().strip('"').strip("'") for t in line[9:].split(",")]
            builder.parallel(*task_names)
        elif line.startswith("branch "):
            parts = line[7:].strip()
            name = parts.split()[0].strip('"').strip("'")
            when_fn = None
            then_name = None
            else_name = None

            when_match = re.search(r'when\s*=\s*(\S+)', parts)
            then_match = re.search(r'then\s*=\s*"([^"]+)"', parts)
            else_match = re.search(r'else\s*=\s*"([^"]+)"', parts)

            if when_match:
                cond_str = when_match.group(1)
                try:
                    when_fn = _compile_dsl_condition(cond_str)
                except ValueError as e:
                    log.warning(
                        "分支条件编译失败，忽略该分支的 when 条件",
                        condition=cond_str,
                        error=str(e),
                    )
                    when_fn = None
            if then_match:
                then_name = then_match.group(1)
            if else_match:
                else_name = else_match.group(1)

            builder.branch(name, when=when_fn, then=then_name, else_=else_name)
        elif line.startswith("timeout "):
            ms = int(re.search(r'\d+', line).group())
            builder.timeout(ms)
        elif line.startswith("retry "):
            match = re.search(r'(\d+)', line)
            max_retries = int(match.group(1)) if match else 3
            strategy = "exponential" if "exponential" in line else "fixed"
            builder.retry(max_retries=max_retries, strategy=strategy)
        elif line.startswith("priority "):
            level = line[9:].strip().lower()
            builder.priority(level)


def pipeline(name: str = "pipeline") -> PipelineBuilder:
    return PipelineBuilder(name)


def task(name: str, executor: Callable[..., Awaitable[Any]] | None = None) -> TaskBuilder:
    return TaskBuilder(name, executor)

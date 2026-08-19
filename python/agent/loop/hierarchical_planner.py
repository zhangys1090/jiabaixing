"""分层任务分解 (Hierarchical Task Decomposition) 规划器。

将复杂任务自动拆解为多层子任务树，支持：
- 递归分解：任务 → 子任务 → 子子任务
- 依赖图：子任务间的前置依赖关系
- 并行执行：无依赖的子任务可并行调度
- 结果聚合：子任务结果合并为最终输出
- 子 Agent 委派：每个子任务可委派给专门的子 Agent

核心架构：
    RootTask (L0)
    ├── SubTask A (L1, 可并行)
    │   ├── Step A1 (L2)
    │   └── Step A2 (L2)
    ├── SubTask B (L1, 依赖 A)
    │   └── Step B1 (L2)
    └── Aggregator (L1, 依赖 A+B)

Usage:
    planner = HierarchicalPlanner(llm=llm)
    task_tree = await planner.decompose("构建一个完整的Web应用")
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.loop.types import ExecutionPlan, LoopContext, PlanStep
from agent.core.logger import log_ignored


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


class TaskStatus(str, Enum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


class TaskNature(str, Enum):
    ANALYSIS = "analysis"
    CREATION = "creation"
    MODIFICATION = "modification"
    QUERY = "query"
    DECISION = "decision"
    COORDINATION = "coordination"
    UNKNOWN = "unknown"


@dataclass
class SubTask:
    id: str
    description: str
    parent_id: str | None = None
    children: list["SubTask"] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    assigned_agent: str = ""
    tool_name: str = ""
    status: TaskStatus = TaskStatus.PENDING
    nature: TaskNature = TaskNature.UNKNOWN
    priority: int = 0
    estimated_effort: int = 1
    result: str = ""
    error: str = ""

    @property
    def is_leaf(self) -> bool:
        return len(self.children) == 0

    @property
    def is_ready(self) -> bool:
        return self.status == TaskStatus.READY

    def flatten(self) -> list["SubTask"]:
        result: list[SubTask] = [self]
        for child in self.children:
            result.extend(child.flatten())
        return result

    def leaf_tasks(self) -> list["SubTask"]:
        if not self.children:
            return [self]
        result: list[SubTask] = []
        for child in self.children:
            result.extend(child.leaf_tasks())
        return result


@dataclass
class TaskTree:
    root: SubTask
    max_depth: int = 0
    total_tasks: int = 0
    parallel_groups: list[list[str]] = field(default_factory=list)

    def all_tasks(self) -> list[SubTask]:
        return self.root.flatten()

    def ready_tasks(self) -> list[SubTask]:
        return [t for t in self.all_tasks() if t.is_ready]

    def mark_done(self, task_id: str, result: str = "") -> None:
        for t in self.all_tasks():
            if t.id == task_id:
                t.status = TaskStatus.DONE
                t.result = result
                self._propagate_ready(t)
                return

    def mark_failed(self, task_id: str, error: str = "") -> None:
        for t in self.all_tasks():
            if t.id == task_id:
                t.status = TaskStatus.FAILED
                t.error = error
                return

    def _propagate_ready(self, completed: SubTask) -> None:
        for t in self.all_tasks():
            if t.status != TaskStatus.PENDING:
                continue
            if not t.dependencies:
                continue
            if all(
                self._get_task(dep).status == TaskStatus.DONE
                for dep in t.dependencies
                if self._get_task(dep)
            ):
                t.status = TaskStatus.READY

    def _get_task(self, task_id: str) -> SubTask | None:
        for t in self.all_tasks():
            if t.id == task_id:
                return t
        return None

    def compute_parallel_groups(self) -> None:
        all_tasks = {t.id: t for t in self.all_tasks()}
        completed: set[str] = set()
        self.parallel_groups = []

        while len(completed) < len(all_tasks):
            ready: list[str] = []
            for tid, task in all_tasks.items():
                if tid in completed:
                    continue
                if all(dep in completed for dep in task.dependencies):
                    ready.append(tid)
            if not ready:
                break
            self.parallel_groups.append(ready)
            completed.update(ready)


@dataclass
class HTDConfig:
    enabled: bool = True
    max_depth: int = 3
    max_tasks: int = 30
    min_decompose_length: int = 50
    auto_parallelize: bool = True


class HierarchicalPlanner:
    """分层任务分解规划器。

    递归地将复杂任务分解为可执行的子任务树。
    支持依赖分析、并行组识别和子 Agent 委派。
    """

    def __init__(
        self,
        llm: LLMProtocol | None = None,
        config: HTDConfig | None = None,
    ) -> None:
        self._llm = llm
        self._config = config or HTDConfig()
        self._task_counter = 0

    async def decompose(
        self,
        input_text: str,
        context: LoopContext | None = None,
    ) -> TaskTree | None:
        if not self._config.enabled:
            return None

        if len(input_text) < self._config.min_decompose_length:
            root = SubTask(
                id=self._next_id(),
                description=input_text,
                status=TaskStatus.READY,
                nature=TaskNature.QUERY,
            )
            return TaskTree(root=root, total_tasks=1)

        if not self._llm:
            return None

        nature = await self._classify_task(input_text)
        root = SubTask(
            id=self._next_id(),
            description=input_text,
            nature=nature,
            status=TaskStatus.READY,
            priority=10,
        )

        await self._recursive_decompose(root, input_text, depth=0)
        all_tasks = root.flatten()
        tree = TaskTree(
            root=root,
            max_depth=max(t.depth_in_tree() for t in all_tasks),
            total_tasks=len(all_tasks),
        )

        if self._config.auto_parallelize:
            tree.compute_parallel_groups()

        return tree

    async def _recursive_decompose(
        self,
        task: SubTask,
        original_input: str,
        depth: int,
    ) -> None:
        if depth >= self._config.max_depth:
            return

        if self._task_counter >= self._config.max_tasks:
            return

        if not self._should_decompose(task, original_input):
            task.status = TaskStatus.READY
            return

        subtasks = await self._llm_decompose(task, original_input)
        if not subtasks or len(subtasks) <= 1:
            task.status = TaskStatus.READY
            return

        for st_data in subtasks:
            child = SubTask(
                id=self._next_id(),
                description=st_data["description"],
                parent_id=task.id,
                dependencies=[f"{task.id}_{dep}" if dep.isdigit() else dep
                              for dep in st_data.get("dependencies", [])],
                tool_name=st_data.get("tool_name", ""),
                nature=self._parse_nature(st_data.get("nature", "unknown")),
                priority=st_data.get("priority", 0),
                estimated_effort=st_data.get("estimated_effort", 1),
            )
            task.children.append(child)

        for child in task.children:
            await self._recursive_decompose(child, original_input, depth + 1)

    async def _classify_task(self, input_text: str) -> TaskNature:
        if not self._llm:
            return TaskNature.UNKNOWN

        try:
            prompt = (
                f"分析以下任务的性质，返回一个类别:\n"
                f"任务: {input_text[:200]}\n\n"
                f"类别: analysis(分析), creation(创建), modification(修改), "
                f"query(查询), decision(决策), coordination(协调), unknown(未知)\n"
                f"只返回一个单词。"
            )
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            text = str(resp.get("content", "unknown")).strip().lower()
            for nature in TaskNature:
                if nature.value in text:
                    return nature
        except Exception as _exc:
            log_ignored(None, "hierarchical_planner.HierarchicalPlanner._classify_task", _exc)
        return TaskNature.UNKNOWN

    async def _llm_decompose(
        self,
        task: SubTask,
        original_input: str,
    ) -> list[dict[str, Any]]:
        if not self._llm:
            return []

        prompt = (
            f"将以下子任务分解为更小的可执行步骤（2-6个）。\n\n"
            f"原始任务: {original_input[:200]}\n"
            f"当前子任务: {task.description[:200]}\n\n"
            f"请用JSON格式输出:\n"
            f'{{\n'
            f'  "subtasks": [\n'
            f'    {{\n'
            f'      "description": "步骤描述",\n'
            f'      "dependencies": [],\n'
            f'      "toolName": "需要的工具名(可选)",\n'
            f'      "nature": "analysis/creation/modification/query/decision",\n'
            f'      "priority": 0-10,\n'
            f'      "estimatedEffort": 1-5\n'
            f'    }}\n'
            f'  ]\n'
            f'}}'
        )

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            text = str(resp.get("content", "{}"))
            match = re.search(r"\{[\s\S]*\}", text)
            if match:
                parsed = json.loads(match.group())
                return parsed.get("subtasks", [])
        except Exception as _exc:
            log_ignored(None, "hierarchical_planner.HierarchicalPlanner._llm_decompose", _exc)

        return []

    def _should_decompose(self, task: SubTask, original_input: str) -> bool:
        if len(task.description) < self._config.min_decompose_length:
            return False
        if task.nature in (TaskNature.QUERY, TaskNature.UNKNOWN):
            return len(task.description) > 100
        return True

    def _next_id(self) -> str:
        self._task_counter += 1
        return f"htd_{self._task_counter}"

    @staticmethod
    def _parse_nature(text: str) -> TaskNature:
        for nature in TaskNature:
            if nature.value in text.lower():
                return nature
        return TaskNature.UNKNOWN

    def to_execution_plan(self, tree: TaskTree) -> ExecutionPlan:
        """将任务树转换为 ExecutionPlan。

        按拓扑顺序排列叶子任务，尊重依赖关系。
        """
        leaf_tasks = tree.root.leaf_tasks()
        task_map = {t.id: t for t in tree.all_tasks()}

        steps: list[PlanStep] = []
        for lt in leaf_tasks:
            deps = self._resolve_leaf_deps(lt, task_map)
            steps.append(PlanStep(
                id=lt.id,
                description=lt.description,
                tool_name=lt.tool_name or None,
                dependencies=deps,
            ))

        reasoning = (
            f"HTD 分解: {tree.total_tasks} 个子任务, "
            f"{len(leaf_tasks)} 个可执行步骤, "
            f"最大深度 {tree.max_depth}"
        )
        if tree.parallel_groups:
            reasoning += f", {len(tree.parallel_groups)} 个并行组"

        return ExecutionPlan(steps=steps, reasoning=reasoning)

    def _resolve_leaf_deps(
        self,
        task: SubTask,
        task_map: dict[str, SubTask],
    ) -> list[str]:
        deps: list[str] = []
        for dep_id in task.dependencies:
            dep_task = task_map.get(dep_id)
            if dep_task and dep_task.is_leaf:
                deps.append(dep_id)
            elif dep_task:
                leaf_deps = self._resolve_leaf_deps(dep_task, task_map)
                deps.extend(leaf_deps)
        return list(set(deps))


def _patch_subtask_depth():
    """为 SubTask 添加 depth_in_tree 方法。"""
    def depth_in_tree(self: SubTask) -> int:
        if not self.parent_id:
            return 0
        return 1

    SubTask.depth_in_tree = depth_in_tree  # type: ignore[attr-defined]


_patch_subtask_depth()

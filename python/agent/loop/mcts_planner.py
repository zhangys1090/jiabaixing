"""MCTS (Monte Carlo Tree Search) 规划器。

在 Tree-of-Thoughts 基础上引入蒙特卡洛树搜索，通过模拟推演
选择最优执行路径。相比 ToT 的简单候选评估，MCTS 能：
- 探索更大的搜索空间
- 平衡探索 (exploration) 与利用 (exploitation)
- 通过 rollout 模拟预估长期收益
- 支持增量式规划（边执行边搜索）

核心算法：
1. Selection: 从根节点开始，按 UCB1 公式选择最有潜力的子节点
2. Expansion: 为选中节点生成候选动作
3. Simulation: 快速模拟到终止状态，获取预估收益
4. Backpropagation: 将模拟结果回传到祖先节点

Usage:
    planner = MCTSPlanner(llm=llm)
    plan = await planner.plan("分析用户行为数据并生成报告")
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent.loop.types import ExecutionPlan, LoopContext, PlanStep
from agent.core.logger import log_ignored, StructuredLogger
import logging
log = StructuredLogger("mcts_planner")
logger = logging.getLogger(__name__)


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


DEFAULT_EXPLORATION = 1.414
DEFAULT_MAX_ITERATIONS = 30
DEFAULT_MAX_DEPTH = 5
DEFAULT_ROLLOUT_DEPTH = 3


@dataclass
class MCTSConfig:
    enabled: bool = True
    exploration_constant: float = DEFAULT_EXPLORATION
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    max_depth: int = DEFAULT_MAX_DEPTH
    rollout_depth: int = DEFAULT_ROLLOUT_DEPTH
    time_limit_ms: float = 30000.0
    beam_width: int = 3


@dataclass
class MCTSNode:
    id: str
    description: str
    parent: "MCTSNode | None" = None
    children: list["MCTSNode"] = field(default_factory=list)
    visits: int = 0
    total_reward: float = 0.0
    is_terminal: bool = False
    depth: int = 0
    tool_name: str = ""

    @property
    def avg_reward(self) -> float:
        if self.visits == 0:
            return 0.0
        return self.total_reward / self.visits

    def ucb1(self, parent_visits: int, exploration: float) -> float:
        if self.visits == 0:
            return float("inf")
        exploitation = self.avg_reward
        exploration_term = exploration * math.sqrt(
            math.log(parent_visits) / self.visits
        )
        return exploitation + exploration_term

    def best_child(self, exploration: float = DEFAULT_EXPLORATION) -> "MCTSNode":
        if not self.children:
            raise ValueError("No children")
        return max(self.children, key=lambda c: c.ucb1(self.visits, exploration))

    def best_child_by_reward(self) -> "MCTSNode":
        if not self.children:
            raise ValueError("No children")
        return max(self.children, key=lambda c: c.avg_reward)


@dataclass
class MCTSMeta:
    iterations: int = 0
    nodes_explored: int = 0
    best_path: list[str] = field(default_factory=list)
    best_reward: float = 0.0
    duration_ms: float = 0.0


class MCTSPlanner:
    """MCTS 规划器 — 蒙特卡洛树搜索驱动的最优路径规划。"""

    def __init__(
        self,
        llm: LLMProtocol | None = None,
        config: MCTSConfig | None = None,
    ) -> None:
        self._llm = llm
        self._config = config or MCTSConfig()
        self._node_counter = 0
        self._tree_size = 0

    async def plan(
        self,
        input_text: str,
        context: LoopContext | None = None,
    ) -> tuple[ExecutionPlan, MCTSMeta | None]:
        if not self._config.enabled:
            return ExecutionPlan(steps=[], reasoning="MCTS 已禁用"), None

        if not self._llm:
            return ExecutionPlan(steps=[], reasoning="无 LLM 可用"), None

        start_time = time.time()
        self._node_counter = 0

        root = MCTSNode(
            id=self._next_id(),
            description="根节点: " + input_text[:50],
            is_terminal=False,
            depth=0,
        )

        iteration = 0
        while iteration < self._config.max_iterations:
            elapsed = (time.time() - start_time) * 1000
            if elapsed > self._config.time_limit_ms:
                break

            node = self._select(root)
            if not node.is_terminal and node.depth < self._config.max_depth:
                node = await self._expand(node, input_text)
            reward = await self._simulate(node, input_text)
            self._backpropagate(node, reward)
            iteration += 1

        if not root.children:
            return ExecutionPlan(steps=[], reasoning="MCTS 未生成有效路径"), None

        best = root.best_child_by_reward()
        path = self._extract_path(best)
        steps = self._path_to_steps(path)

        meta = MCTSMeta(
            iterations=iteration,
            nodes_explored=self._node_counter,
            best_path=[n.description for n in path],
            best_reward=best.avg_reward,
            duration_ms=(time.time() - start_time) * 1000,
        )

        return ExecutionPlan(
            steps=steps,
            reasoning=f"MCTS 搜索完成: {iteration} 次迭代, 最佳路径奖励 {best.avg_reward:.3f}",
        ), meta

    def _select(self, node: MCTSNode) -> MCTSNode:
        current = node
        while current.children and not current.is_terminal:
            if current.depth >= self._config.max_depth:
                break
            current = current.best_child(self._config.exploration_constant)
        return current

    async def _expand(self, node: MCTSNode, input_text: str) -> MCTSNode:
        candidates = await self._generate_actions(node, input_text)
        if not candidates:
            node.is_terminal = True
            return node

        for action in candidates[:self._config.beam_width]:
            child = MCTSNode(
                id=self._next_id(),
                description=action["description"],
                parent=node,
                depth=node.depth + 1,
                tool_name=action.get("tool_name", ""),
                is_terminal=action.get("is_terminal", False),
            )
            node.children.append(child)

        return node.children[0] if node.children else node

    async def _simulate(self, node: MCTSNode, input_text: str) -> float:
        if node.is_terminal:
            return 1.0

        if not self._llm:
            return 0.5

        current = node
        total_reward = 0.0
        depth = 0

        while depth < self._config.rollout_depth and not current.is_terminal:
            depth += 1
            try:
                prompt = (
                    f"你正在模拟执行一个子任务。请评估当前步骤的预期成功率(0.0-1.0)。\n\n"
                    f"原始任务: {input_text[:200]}\n"
                    f"当前步骤: {current.description[:200]}\n\n"
                    f"请只返回一个 0.0 到 1.0 之间的数字。"
                )
                resp = await self._llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    use_cache=False,
                )
                text = str(resp.get("content", "0.5"))
                match = re.search(r"(0\.\d+|1\.0|1)", text)
                reward = float(match.group(1)) if match else 0.5
                total_reward += reward
            except Exception as e:
                logger.warning("mcts_planner._rollout 奖励评估失败", error=str(e))
                total_reward += 0.3

            if depth < self._config.rollout_depth:
                next_desc = await self._rollout_next(current, input_text)
                if next_desc:
                    current = MCTSNode(
                        id=self._next_id(),
                        description=next_desc,
                        depth=current.depth + 1,
                    )
                else:
                    break

        return total_reward / max(depth, 1)

    def _backpropagate(self, node: MCTSNode, reward: float) -> None:
        current: MCTSNode | None = node
        while current is not None:
            current.visits += 1
            current.total_reward += reward
            current = current.parent

    async def _generate_actions(
        self,
        node: MCTSNode,
        input_text: str,
    ) -> list[dict[str, Any]]:
        if not self._llm:
            return []

        context_str = ""
        if node.parent:
            context_str = f"\n父步骤: {node.parent.description[:100]}"

        prompt = (
            f"为以下任务生成可能的下一步动作（最多{self._config.beam_width}个）。\n\n"
            f"任务: {input_text[:200]}\n"
            f"当前步骤: {node.description[:200]}"
            f"{context_str}\n\n"
            f"请用JSON格式输出:\n"
            f'{{\n'
            f'  "actions": [\n'
            f'    {{"description": "动作描述", "toolName": "工具名(可选)", "isTerminal": false}}\n'
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
                return parsed.get("actions", [])
        except Exception as _exc:
            logger.warning("mcts_planner 异常处理", error=str(_exc))
            log_ignored(None, "mcts_planner.MCTSPlanner._generate_actions", _exc)

        return []

    async def _rollout_next(
        self,
        node: MCTSNode,
        input_text: str,
    ) -> str | None:
        if not self._llm:
            return None

        try:
            prompt = (
                f"快速推测下一步: {node.description[:150]}\n"
                f"任务: {input_text[:100]}\n"
                f"请用一句话描述下一步动作。"
            )
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            return str(resp.get("content", "")).strip()
        except Exception as _exc:
            log.warning("MCTS 快速推测失败", error=str(_exc))
            return None

    def _extract_path(self, node: MCTSNode) -> list[MCTSNode]:
        path: list[MCTSNode] = []
        current: MCTSNode | None = node
        while current is not None and current.parent is not None:
            path.append(current)
            current = current.parent
        path.reverse()
        return path

    def _path_to_steps(self, path: list[MCTSNode]) -> list[PlanStep]:
        steps: list[PlanStep] = []
        for i, node in enumerate(path):
            step_id = f"mcts_{i + 1}"
            deps: list[str] = []
            if i > 0:
                deps = [f"mcts_{i}"]
            steps.append(PlanStep(
                id=step_id,
                description=node.description,
                tool_name=node.tool_name or None,
                dependencies=deps,
            ))
        return steps

    def _next_id(self) -> str:
        self._node_counter += 1
        return f"n{self._node_counter}"


async def mcts_plan_with_fallback(
    llm: LLMProtocol | None,
    input_text: str,
    context: LoopContext | None = None,
    config: MCTSConfig | None = None,
    timeout_ms: float = 30000,
) -> tuple[ExecutionPlan, dict[str, Any] | None]:
    """MCTS 规划，超时后回退到简单规划。

    在指定时间内尝试 MCTS 搜索，超时则返回简单步骤分解。
    适用于对延迟敏感的生产环境。

    Args:
        llm: LLM 实例。
        input_text: 用户输入。
        context: 循环上下文。
        config: MCTS 配置。
        timeout_ms: 超时时间（毫秒）。

    Returns:
        (执行计划, MCTS 元信息) 元组。
    """
    if llm is None:
        return ExecutionPlan(steps=[], reasoning="无 LLM 可用"), None

    planner = MCTSPlanner(llm=llm, config=config)

    try:
        plan, meta = await asyncio.wait_for(
            planner.plan(input_text, context),
            timeout=timeout_ms / 1000,
        )
        if meta:
            return plan, {
                "iterations": meta.iterations,
                "nodes_explored": meta.nodes_explored,
                "best_reward": meta.best_reward,
                "duration_ms": meta.duration_ms,
                "planner": "mcts",
            }
        return plan, None
    except asyncio.TimeoutError:
        steps = [
            PlanStep(id="s1", description="分析任务需求", tool_name=None),
            PlanStep(id="s2", description="执行核心操作", tool_name=None, dependencies=["s1"]),
            PlanStep(id="s3", description="验证结果并输出", tool_name=None, dependencies=["s2"]),
        ]
        return (
            ExecutionPlan(steps=steps, reasoning="MCTS 超时，使用默认计划"),
            {"planner": "fallback", "reason": "timeout"},
        )

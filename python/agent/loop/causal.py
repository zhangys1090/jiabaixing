from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from agent.llm.provider import LLMProvider


@dataclass
class CausalGraphNode:
    id: str
    description: str
    type: str = "action"


@dataclass
class CausalGraphEdge:
    from_id: str
    to_id: str
    reason: str = ""
    type: str = "dependency"


@dataclass
class FailurePropagation:
    source: str
    affects: list[str] = field(default_factory=list)
    reason: str = ""


@dataclass
class CausalGraph:
    nodes: list[CausalGraphNode] = field(default_factory=list)
    edges: list[CausalGraphEdge] = field(default_factory=list)
    parallel_groups: list[list[str]] = field(default_factory=list)
    failure_propagation: list[FailurePropagation] = field(default_factory=list)


@dataclass
class DependencyAnalysis:
    depends_on: list[str] = field(default_factory=list)
    blocks: list[str] = field(default_factory=list)


@dataclass
class FailureImpact:
    affected_steps: list[str] = field(default_factory=list)
    severity: str = "low"


_EMPTY_GRAPH = CausalGraph()


class CausalModeler:
    def __init__(self, llm: LLMProvider | None = None) -> None:
        self.llm = llm

    async def build_causal_model(self, task: str) -> CausalGraph:
        if not self.llm:
            return CausalGraph(
                nodes=[], edges=[], parallel_groups=[], failure_propagation=[]
            )

        prompt = (
            "请分析以下任务，构建因果关系图。返回 JSON 格式：\n"
            "{\n"
            '  "nodes": [{ "id": "step1", "description": "步骤描述", "type": "action" | "analysis" }],\n'
            '  "edges": [{ "from": "step1", "to": "step2", "type": "dependency", "reason": "依赖原因" }],\n'
            '  "parallelGroups": [["step1", "step2"]],\n'
            '  "failurePropagation": [{ "source": "step1", "affects": ["step2"], "reason": "失败原因" }]\n'
            "}\n\n"
            f"任务: {task}"
        )

        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            json_match = re.search(r"\{[\s\S]*\}", content)
            if not json_match:
                return CausalGraph()

            parsed = json.loads(json_match.group())
            return self._validate_graph(parsed)
        except Exception:
            return CausalGraph()

    def analyze_dependencies(
        self, graph: CausalGraph, step_id: str
    ) -> DependencyAnalysis:
        depends_on: list[str] = []
        blocks: list[str] = []

        for edge in graph.edges:
            if edge.to_id == step_id and edge.from_id not in depends_on:
                depends_on.append(edge.from_id)
            if edge.from_id == step_id and edge.to_id not in blocks:
                blocks.append(edge.to_id)

        return DependencyAnalysis(depends_on=depends_on, blocks=blocks)

    def find_parallel_groups(self, graph: CausalGraph) -> list[list[str]]:
        dependencies: dict[str, set[str]] = {}
        for node in graph.nodes:
            dependencies[node.id] = set()
        for edge in graph.edges:
            deps = dependencies.get(edge.to_id)
            if deps is not None:
                deps.add(edge.from_id)

        groups: list[list[str]] = []
        node_ids = [n.id for n in graph.nodes]

        for i in range(len(node_ids)):
            for j in range(i + 1, len(node_ids)):
                a = node_ids[i]
                b = node_ids[j]
                a_deps = dependencies.get(a, set())
                b_deps = dependencies.get(b, set())

                if a not in b_deps and b not in a_deps:
                    merged = False
                    for group in groups:
                        if a in group and b not in group:
                            can_merge = all(
                                b not in dependencies.get(m, set())
                                and m not in dependencies.get(b, set())
                                for m in group
                            )
                            if can_merge:
                                group.append(b)
                                merged = True
                                break
                    if not merged:
                        groups.append([a, b])

        return groups

    def get_failure_impact(
        self, graph: CausalGraph, step_id: str
    ) -> FailureImpact:
        affected_steps: list[str] = []
        visited: set[str] = {step_id}

        queue = [step_id]
        while queue:
            current = queue.pop(0)
            for edge in graph.edges:
                if edge.from_id == current and edge.to_id not in visited:
                    visited.add(edge.to_id)
                    affected_steps.append(edge.to_id)
                    queue.append(edge.to_id)

        for propagation in graph.failure_propagation:
            if propagation.source == step_id:
                for affected in propagation.affects:
                    if affected not in affected_steps:
                        affected_steps.append(affected)

        total_nodes = len(graph.nodes)
        impact_ratio = len(affected_steps) / total_nodes if total_nodes > 0 else 0.0
        severity = (
            "high" if impact_ratio >= 0.5 else "medium" if impact_ratio >= 0.25 else "low"
        )

        return FailureImpact(affected_steps=affected_steps, severity=severity)

    def _validate_graph(self, parsed: Any) -> CausalGraph:
        if not parsed or not isinstance(parsed, dict):
            return CausalGraph()

        nodes = []
        for n in parsed.get("nodes", []):
            if isinstance(n, dict) and "id" in n:
                nodes.append(
                    CausalGraphNode(
                        id=n["id"],
                        description=n.get("description", ""),
                        type=n.get("type", "action"),
                    )
                )

        edges = []
        for e in parsed.get("edges", []):
            if isinstance(e, dict) and "from" in e and "to" in e:
                edges.append(
                    CausalGraphEdge(
                        from_id=e["from"],
                        to_id=e["to"],
                        reason=e.get("reason", ""),
                        type=e.get("type", "dependency"),
                    )
                )

        parallel_groups = []
        for pg in parsed.get("parallelGroups", []):
            if isinstance(pg, list):
                parallel_groups.append(pg)

        failure_propagation = []
        for fp in parsed.get("failurePropagation", []):
            if isinstance(fp, dict) and "source" in fp:
                failure_propagation.append(
                    FailurePropagation(
                        source=fp["source"],
                        affects=fp.get("affects", []),
                        reason=fp.get("reason", ""),
                    )
                )

        return CausalGraph(
            nodes=nodes,
            edges=edges,
            parallel_groups=parallel_groups,
            failure_propagation=failure_propagation,
        )

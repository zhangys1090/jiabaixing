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

    def simulate_intervention(
        self,
        graph: CausalGraph,
        step_id: str,
        remove: bool = True,
    ) -> CausalGraph:
        """干预模拟：移除或修改某步骤后观察因果图的变化.

        当 remove=True 时，从图中删除该节点及其所有入边/出边，
        并重新计算受影响节点的失败传播链。

        Args:
            graph: 原始因果图.
            step_id: 要干预的步骤 ID.
            remove: True 表示移除该步骤，False 表示保留但标记为干预点.

        Returns:
            CausalGraph: 干预后的新因果图（不修改原图）.
        """
        # 深拷贝以避免修改原图
        new_nodes = [CausalGraphNode(id=n.id, description=n.description, type=n.type) for n in graph.nodes]
        new_edges = [CausalGraphEdge(from_id=e.from_id, to_id=e.to_id, reason=e.reason, type=e.type) for e in graph.edges]
        new_parallel = [list(pg) for pg in graph.parallel_groups]
        new_failure = [FailurePropagation(source=fp.source, affects=list(fp.affects), reason=fp.reason) for fp in graph.failure_propagation]

        if remove:
            # 移除节点
            new_nodes = [n for n in new_nodes if n.id != step_id]
            # 移除涉及该节点的边
            new_edges = [e for e in new_edges if e.from_id != step_id and e.to_id != step_id]
            # 清理并行组
            new_parallel = [[nid for nid in pg if nid != step_id] for pg in new_parallel]
            new_parallel = [pg for pg in new_parallel if len(pg) >= 2]
            # 清理失败传播
            new_failure = [fp for fp in new_failure if fp.source != step_id]
            for fp in new_failure:
                fp.affects = [a for a in fp.affects if a != step_id]
        else:
            # 标记干预（在描述中追加标记）
            for n in new_nodes:
                if n.id == step_id:
                    n.description = f"[干预] {n.description}"

        return CausalGraph(
            nodes=new_nodes,
            edges=new_edges,
            parallel_groups=new_parallel,
            failure_propagation=new_failure,
        )

    def rank_by_criticality(self, graph: CausalGraph) -> list[tuple[str, float]]:
        """按关键度排序节点：被依赖越多越关键.

        关键度计算：入度权重 0.3 + 出度权重 0.7（出度=被依赖数，
        出度越高说明越多人依赖它，越关键）。归一化到 0-1。

        Args:
            graph: 因果图.

        Returns:
            list[tuple[str, float]]: (step_id, criticality_score) 列表，按分数降序.
        """
        if not graph.nodes:
            return []

        # 构建邻接统计
        in_degree: dict[str, int] = {n.id: 0 for n in graph.nodes}
        out_degree: dict[str, int] = {n.id: 0 for n in graph.nodes}

        for edge in graph.edges:
            if edge.from_id in out_degree:
                out_degree[edge.from_id] += 1
            if edge.to_id in in_degree:
                in_degree[edge.to_id] += 1

        # 失败传播中的被依赖也计入出度
        for fp in graph.failure_propagation:
            if fp.source in out_degree:
                out_degree[fp.source] += len(fp.affects)

        max_in = max(in_degree.values()) if in_degree else 1
        max_out = max(out_degree.values()) if out_degree else 1
        max_in = max(max_in, 1)
        max_out = max(max_out, 1)

        scores: list[tuple[str, float]] = []
        for node in graph.nodes:
            normalized_in = in_degree[node.id] / max_in
            normalized_out = out_degree[node.id] / max_out
            criticality = 0.3 * normalized_in + 0.7 * normalized_out
            scores.append((node.id, round(criticality, 4)))

        scores.sort(key=lambda x: x[1], reverse=True)
        return scores

    def detect_cycles(self, graph: CausalGraph) -> list[list[str]]:
        """检测因果图中的循环依赖.

        使用 DFS 着色法检测所有环路。

        Args:
            graph: 因果图.

        Returns:
            list[list[str]]: 环路列表，每条环路是节点 ID 的有序列表.
        """
        # 构建邻接表
        adj: dict[str, list[str]] = {n.id: [] for n in graph.nodes}
        for edge in graph.edges:
            if edge.from_id in adj:
                adj[edge.from_id].append(edge.to_id)

        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = {nid: WHITE for nid in adj}
        path: list[str] = []
        cycles: list[list[str]] = []

        def dfs(node: str) -> None:
            color[node] = GRAY
            path.append(node)
            for neighbor in adj.get(node, []):
                if neighbor not in color:
                    continue
                if color[neighbor] == GRAY:
                    # 找到环
                    cycle_start = path.index(neighbor)
                    cycle = path[cycle_start:] + [neighbor]
                    cycles.append(cycle)
                elif color[neighbor] == WHITE:
                    dfs(neighbor)
            path.pop()
            color[node] = BLACK

        for nid in adj:
            if color.get(nid) == WHITE:
                dfs(nid)

        return cycles

    def suggest_mitigations(self, graph: CausalGraph, step_id: str) -> list[str]:
        """为高风险步骤建议缓解措施.

        根据步骤的关键度、失败传播范围和依赖结构生成缓解建议。

        Args:
            graph: 因果图.
            step_id: 目标步骤 ID.

        Returns:
            list[str]: 缓解措施建议列表.
        """
        suggestions: list[str] = []

        # 检查节点是否存在
        node_exists = any(n.id == step_id for n in graph.nodes)
        if not node_exists:
            return [f"步骤 {step_id} 不存在于因果图中"]

        # 1. 关键度评估
        criticality_rank = self.rank_by_criticality(graph)
        rank_map = {sid: (i, score) for i, (sid, score) in enumerate(criticality_rank)}
        if step_id in rank_map:
            rank, score = rank_map[step_id]
            if score >= 0.7:
                suggestions.append(f"该步骤关键度极高 (排名 #{rank + 1}, 分数 {score:.2f})，建议添加备用方案")
            elif score >= 0.4:
                suggestions.append(f"该步骤关键度中等 (排名 #{rank + 1}, 分数 {score:.2f})，建议增加超时和重试机制")

        # 2. 失败影响评估
        impact = self.get_failure_impact(graph, step_id)
        if impact.severity == "high":
            suggestions.append(f"失败影响范围广 (影响 {len(impact.affected_steps)} 个步骤)，建议添加断路器机制")
        elif impact.severity == "medium":
            suggestions.append(f"失败影响中等 (影响 {len(impact.affected_steps)} 个步骤)，建议添加降级策略")

        # 3. 依赖分析
        deps = self.analyze_dependencies(graph, step_id)
        if len(deps.depends_on) > 2:
            suggestions.append(f"依赖 {len(deps.depends_on)} 个上游步骤，建议减少依赖或添加并行备选路径")
        if len(deps.blocks) > 1:
            suggestions.append(f"阻塞 {len(deps.blocks)} 个下游步骤，建议将此步骤拆分为更细粒度的子步骤")

        # 4. 循环检测
        cycles = self.detect_cycles(graph)
        for cycle in cycles:
            if step_id in cycle:
                suggestions.append(f"检测到循环依赖: {' → '.join(cycle)}，建议打破循环或引入中间步骤")
                break

        if not suggestions:
            suggestions.append("该步骤风险较低，当前无需特殊缓解措施")

        return suggestions

    def export_dot(self, graph: CausalGraph) -> str:
        """导出 Graphviz DOT 格式的因果图.

        用于可视化因果图结构。节点按类型着色，边标注依赖原因。

        Args:
            graph: 因果图.

        Returns:
            str: DOT 格式字符串.
        """
        # 节点类型 → 颜色映射
        type_colors: dict[str, str] = {
            "action": "#4CAF50",
            "analysis": "#2196F3",
            "decision": "#FF9800",
            "output": "#9C27B0",
        }

        lines: list[str] = []
        lines.append("digraph CausalGraph {")
        lines.append('    rankdir=TB;')
        lines.append('    node [shape=box, style="rounded,filled", fontname="sans-serif"];')
        lines.append('    edge [fontname="sans-serif", fontsize=10];')
        lines.append("")

        # 节点
        for node in graph.nodes:
            color = type_colors.get(node.type, "#E0E0E0")
            label = node.description.replace('"', '\\"')
            lines.append(f'    "{node.id}" [label="{label}", fillcolor="{color}"];')

        lines.append("")

        # 边
        for edge in graph.edges:
            label = edge.reason.replace('"', '\\"') if edge.reason else ""
            style = "dashed" if edge.type == "optional" else "solid"
            attr = f'style={style}'
            if label:
                attr += f', label="{label}"'
            lines.append(f'    "{edge.from_id}" -> "{edge.to_id}" [{attr}];')

        # 并行组（子图）
        for i, group in enumerate(graph.parallel_groups):
            lines.append("")
            lines.append(f"    subgraph cluster_parallel_{i} {{")
            lines.append('        style=dotted;')
            lines.append(f'        label="并行组 {i + 1}";')
            for nid in group:
                lines.append(f'        "{nid}";')
            lines.append("    }")

        lines.append("}")
        return "\n".join(lines)

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

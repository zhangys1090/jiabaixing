"""学习图（Learning Graph）。

显式建模技能/记忆/经验节点之间的关系，支撑长期演化。
与 evolution/skill_engine.py（技能创建）互补，提供关系图谱和路径查询。

核心功能：
  - 节点管理：技能/记忆/经验/决策 四类节点
  - 边管理：依赖/派生/相关/前置 四类关系
  - 路径查询：从 A 到 B 的学习路径
  - 影响分析：修改某节点后的影响传播
  - 拓扑排序：学习顺序推荐
  - 持久化到 SQLite

集成示例::

    from agent.evolution.learning_graph import LearningGraph

    graph = LearningGraph()
    graph.add_skill("code_review", difficulty=3)
    graph.add_skill("code_fix", difficulty=4)
    graph.add_dependency("code_fix", "code_review")
    path = graph.learning_path("code_review", "code_fix")
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import StructuredLogger

log = StructuredLogger("learning_graph")


class NodeType(str, Enum):
    SKILL = "skill"
    MEMORY = "memory"
    EXPERIENCE = "experience"
    DECISION = "decision"


class EdgeType(str, Enum):
    DEPENDS_ON = "depends_on"
    DERIVED_FROM = "derived_from"
    RELATED_TO = "related_to"
    PREREQUISITE = "prerequisite"


@dataclass
class GraphNode:
    id: str
    type: NodeType
    name: str
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: float = 0.0
    updated_at: float = 0.0
    weight: float = 1.0

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = time.time()
        if not self.updated_at:
            self.updated_at = self.created_at


@dataclass
class GraphEdge:
    source_id: str
    target_id: str
    type: EdgeType
    weight: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = time.time()


@dataclass
class LearningPath:
    start: str
    end: str
    nodes: list[str]
    edges: list[tuple[str, str, str]]
    total_weight: float
    length: int


@dataclass
class ImpactAnalysis:
    node_id: str
    direct_dependents: list[str]
    transitive_dependents: list[str]
    total_impacted: int
    impact_paths: list[list[str]]


class LearningGraph:
    """学习图。

    显式建模技能/记忆/经验节点间的关系，
    支撑学习路径推荐、影响分析和演化决策。
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "learning_graph.db"
        self._nodes: dict[str, GraphNode] = {}
        self._edges: list[GraphEdge] = []
        self._adj: dict[str, list[tuple[str, GraphEdge]]] = defaultdict(list)
        self._rev_adj: dict[str, list[tuple[str, GraphEdge]]] = defaultdict(list)
        self._init_db()
        self._load_from_db()

    def _init_db(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._path))
        conn.execute("""
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                weight REAL DEFAULT 1.0,
                created_at REAL,
                updated_at REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS edges (
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                type TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                metadata TEXT DEFAULT '{}',
                created_at REAL,
                PRIMARY KEY (source_id, target_id, type)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)")
        conn.commit()
        conn.close()

    def _load_from_db(self) -> None:
        conn = sqlite3.connect(str(self._path))
        for row in conn.execute("SELECT id, type, name, metadata, weight, created_at, updated_at FROM nodes"):
            self._nodes[row[0]] = GraphNode(
                id=row[0],
                type=NodeType(row[1]),
                name=row[2],
                metadata=safe_json_loads(row[3], {}, context="learning_graph.node_metadata"),
                weight=row[4],
                created_at=row[5],
                updated_at=row[6],
            )
        for row in conn.execute("SELECT source_id, target_id, type, weight, metadata, created_at FROM edges"):
            edge = GraphEdge(
                source_id=row[0],
                target_id=row[1],
                type=EdgeType(row[2]),
                weight=row[3],
                metadata=safe_json_loads(row[4], {}, context="learning_graph.edge_metadata"),
                created_at=row[5],
            )
            self._edges.append(edge)
            self._adj[edge.source_id].append((edge.target_id, edge))
            self._rev_adj[edge.target_id].append((edge.source_id, edge))
        conn.close()

    def _persist_node(self, node: GraphNode) -> None:
        conn = sqlite3.connect(str(self._path))
        conn.execute(
            "INSERT OR REPLACE INTO nodes (id, type, name, metadata, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (node.id, node.type.value, node.name, json.dumps(node.metadata, ensure_ascii=False), node.weight, node.created_at, node.updated_at),
        )
        conn.commit()
        conn.close()

    def _persist_edge(self, edge: GraphEdge) -> None:
        conn = sqlite3.connect(str(self._path))
        conn.execute(
            "INSERT OR REPLACE INTO edges (source_id, target_id, type, weight, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (edge.source_id, edge.target_id, edge.type.value, edge.weight, json.dumps(edge.metadata, ensure_ascii=False), edge.created_at),
        )
        conn.commit()
        conn.close()

    def add_node(self, node_id: str, node_type: NodeType, name: str, metadata: dict[str, Any] | None = None, weight: float = 1.0) -> GraphNode:
        node = GraphNode(id=node_id, type=node_type, name=name, metadata=metadata or {}, weight=weight)
        self._nodes[node_id] = node
        self._persist_node(node)
        return node

    def add_skill(self, skill_id: str, difficulty: int = 1, name: str = "", metadata: dict[str, Any] | None = None) -> GraphNode:
        meta = metadata or {}
        meta["difficulty"] = difficulty
        return self.add_node(skill_id, NodeType.SKILL, name or skill_id, meta, weight=difficulty)

    def add_memory(self, memory_id: str, name: str = "", metadata: dict[str, Any] | None = None) -> GraphNode:
        return self.add_node(memory_id, NodeType.MEMORY, name or memory_id, metadata or {})

    def add_experience(self, exp_id: str, name: str = "", metadata: dict[str, Any] | None = None) -> GraphNode:
        return self.add_node(exp_id, NodeType.EXPERIENCE, name or exp_id, metadata or {})

    def add_decision(self, dec_id: str, name: str = "", metadata: dict[str, Any] | None = None) -> GraphNode:
        return self.add_node(dec_id, NodeType.DECISION, name or dec_id, metadata or {})

    def get_node(self, node_id: str) -> GraphNode | None:
        return self._nodes.get(node_id)

    def remove_node(self, node_id: str) -> bool:
        if node_id not in self._nodes:
            return False
        del self._nodes[node_id]
        self._edges = [e for e in self._edges if e.source_id != node_id and e.target_id != node_id]
        self._adj.pop(node_id, None)
        self._rev_adj.pop(node_id, None)
        for key in list(self._adj.keys()):
            self._adj[key] = [(t, e) for t, e in self._adj[key] if t != node_id]
        for key in list(self._rev_adj.keys()):
            self._rev_adj[key] = [(s, e) for s, e in self._rev_adj[key] if s != node_id]
        conn = sqlite3.connect(str(self._path))
        conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        conn.execute("DELETE FROM edges WHERE source_id = ? OR target_id = ?", (node_id, node_id))
        conn.commit()
        conn.close()
        return True

    def add_edge(self, source_id: str, target_id: str, edge_type: EdgeType, weight: float = 1.0, metadata: dict[str, Any] | None = None) -> GraphEdge | None:
        if source_id not in self._nodes or target_id not in self._nodes:
            log.warning("边端点不存在", source=source_id, target=target_id)
            return None
        edge = GraphEdge(source_id=source_id, target_id=target_id, type=edge_type, weight=weight, metadata=metadata or {})
        self._edges.append(edge)
        self._adj[source_id].append((target_id, edge))
        self._rev_adj[target_id].append((source_id, edge))
        self._persist_edge(edge)
        return edge

    def add_dependency(self, skill_id: str, depends_on: str) -> GraphEdge | None:
        return self.add_edge(skill_id, depends_on, EdgeType.DEPENDS_ON)

    def add_derivation(self, derived_id: str, from_id: str) -> GraphEdge | None:
        return self.add_edge(derived_id, from_id, EdgeType.DERIVED_FROM)

    def add_relation(self, a_id: str, b_id: str) -> GraphEdge | None:
        edge1 = self.add_edge(a_id, b_id, EdgeType.RELATED_TO)
        self.add_edge(b_id, a_id, EdgeType.RELATED_TO)
        return edge1

    def add_prerequisite(self, skill_id: str, prereq_id: str) -> GraphEdge | None:
        return self.add_edge(skill_id, prereq_id, EdgeType.PREREQUISITE)

    def get_dependencies(self, node_id: str) -> list[str]:
        return [t for t, e in self._adj.get(node_id, []) if e.type in (EdgeType.DEPENDS_ON, EdgeType.PREREQUISITE)]

    def get_dependents(self, node_id: str) -> list[str]:
        return [s for s, e in self._rev_adj.get(node_id, []) if e.type in (EdgeType.DEPENDS_ON, EdgeType.PREREQUISITE)]

    def learning_path(self, start_id: str, end_id: str) -> LearningPath | None:
        if start_id not in self._nodes or end_id not in self._nodes:
            return None

        visited: set[str] = {start_id}
        queue: deque[tuple[str, list[str], list[tuple[str, str, str]], float]] = deque()
        queue.append((start_id, [start_id], [], 0.0))

        while queue:
            current, path, edge_path, total_w = queue.popleft()
            if current == end_id:
                return LearningPath(
                    start=start_id,
                    end=end_id,
                    nodes=path,
                    edges=edge_path,
                    total_weight=total_w,
                    length=len(path) - 1,
                )

            for neighbor, edge in self._adj.get(current, []):
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((
                        neighbor,
                        path + [neighbor],
                        edge_path + [(current, neighbor, edge.type.value)],
                        total_w + edge.weight,
                    ))

        return None

    def impact_analysis(self, node_id: str, max_depth: int = 10) -> ImpactAnalysis:
        direct = self.get_dependents(node_id)
        transitive: set[str] = set()
        impact_paths: list[list[str]] = []

        visited: set[str] = {node_id}
        queue: deque[tuple[str, list[str], int]] = deque()
        for d in direct:
            queue.append((d, [node_id, d], 1))

        while queue:
            current, path, depth = queue.popleft()
            if depth > max_depth:
                continue
            transitive.add(current)
            impact_paths.append(path)
            for dep, _ in self._rev_adj.get(current, []):
                if dep not in visited and dep != node_id:
                    visited.add(dep)
                    queue.append((dep, path + [dep], depth + 1))

        return ImpactAnalysis(
            node_id=node_id,
            direct_dependents=direct,
            transitive_dependents=list(transitive - set(direct)),
            total_impacted=len(direct) + len(transitive - set(direct)),
            impact_paths=impact_paths[:20],
        )

    def topological_sort(self) -> list[str]:
        in_degree: dict[str, int] = defaultdict(int)
        for node_id in self._nodes:
            in_degree[node_id]
        for edge in self._edges:
            if edge.type in (EdgeType.DEPENDS_ON, EdgeType.PREREQUISITE):
                in_degree[edge.source_id] += 1

        queue = deque(nid for nid, deg in in_degree.items() if deg == 0)
        result: list[str] = []

        while queue:
            node_id = queue.popleft()
            result.append(node_id)
            for neighbor, edge in self._adj.get(node_id, []):
                if edge.type in (EdgeType.DEPENDS_ON, EdgeType.PREREQUISITE):
                    in_degree[neighbor] -= 1
                    if in_degree[neighbor] == 0:
                        queue.append(neighbor)

        return result

    def get_stats(self) -> dict[str, Any]:
        type_counts: dict[str, int] = defaultdict(int)
        for node in self._nodes.values():
            type_counts[node.type.value] += 1
        edge_type_counts: dict[str, int] = defaultdict(int)
        for edge in self._edges:
            edge_type_counts[edge.type.value] += 1
        return {
            "total_nodes": len(self._nodes),
            "total_edges": len(self._edges),
            "nodes_by_type": dict(type_counts),
            "edges_by_type": dict(edge_type_counts),
        }

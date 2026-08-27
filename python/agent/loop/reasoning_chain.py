"""动态推理深度 + 推理链验证。

设计目标：
1. 动态推理深度：根据任务复杂度和感知状态自动调节推理深度
   - shallow (1层): 简单任务，快速响应
   - medium (2-3层): 中等任务，适度推理
   - deep (4-5层): 复杂任务，深度推理
   - exhaustive (6+层): 极复杂任务，穷举推理
2. 推理链验证：对推理链进行逻辑一致性、事实一致性、完整性验证
3. 推理链压缩：对过长的推理链进行压缩，保留关键推理步骤

推理链结构：
   Claim → Evidence → Inference → Conclusion
   每个节点包含：内容、置信度、来源、依赖关系

验证策略：
   - consistency: 逻辑一致性验证（前后矛盾检测）
   - factuality: 事实一致性验证（与已知事实对比）
   - completeness: 完整性验证（遗漏检测）
   - redundancy: 冗余检测（重复推理步骤合并）

Usage:
    engine = ReasoningChainEngine(llm=llm)
    chain = await engine.reason("分析系统性能瓶颈")
    verified = await engine.verify(chain)
    compressed = engine.compress(chain)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("reasoning_chain_engine")


class ReasoningDepth(str, Enum):
    SHALLOW = "shallow"
    MEDIUM = "medium"
    DEEP = "deep"
    EXHAUSTIVE = "exhaustive"


class VerificationStrategy(str, Enum):
    CONSISTENCY = "consistency"
    FACTUALITY = "factuality"
    COMPLETENESS = "completeness"
    REDUNDANCY = "redundancy"


class ChainNodeType(str, Enum):
    CLAIM = "claim"
    EVIDENCE = "evidence"
    INFERENCE = "inference"
    CONCLUSION = "conclusion"
    ASSUMPTION = "assumption"
    COUNTER_ARGUMENT = "counter_argument"


@dataclass
class ChainNode:
    id: str
    content: str
    node_type: ChainNodeType = ChainNodeType.INFERENCE
    confidence: float = 0.8
    source: str = ""
    parent_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReasoningChain:
    id: str = ""
    query: str = ""
    nodes: list[ChainNode] = field(default_factory=list)
    depth: ReasoningDepth = ReasoningDepth.MEDIUM
    created_at: float = 0.0
    total_confidence: float = 0.0
    verified: bool = False
    verification_result: dict[str, Any] = field(default_factory=dict)

    def add_node(self, node: ChainNode) -> None:
        self.nodes.append(node)
        self._recalculate_confidence()

    def get_node(self, node_id: str) -> ChainNode | None:
        for n in self.nodes:
            if n.id == node_id:
                return n
        return None

    def get_children(self, node_id: str) -> list[ChainNode]:
        return [n for n in self.nodes if node_id in n.parent_ids]

    def get_roots(self) -> list[ChainNode]:
        return [n for n in self.nodes if not n.parent_ids]

    def get_leaves(self) -> list[ChainNode]:
        child_ids: set[str] = set()
        for n in self.nodes:
            for pid in n.parent_ids:
                child_ids.add(pid)
        return [n for n in self.nodes if n.id not in child_ids]

    def _recalculate_confidence(self) -> None:
        if not self.nodes:
            self.total_confidence = 0.0
            return
        weights = {
            ChainNodeType.CLAIM: 0.8,
            ChainNodeType.EVIDENCE: 1.0,
            ChainNodeType.INFERENCE: 0.7,
            ChainNodeType.CONCLUSION: 0.9,
            ChainNodeType.ASSUMPTION: 0.5,
            ChainNodeType.COUNTER_ARGUMENT: 0.6,
        }
        total_weight = 0.0
        weighted_sum = 0.0
        for n in self.nodes:
            w = weights.get(n.node_type, 0.7)
            weighted_sum += n.confidence * w
            total_weight += w
        self.total_confidence = weighted_sum / total_weight if total_weight > 0 else 0.0


@dataclass
class VerificationResult:
    passed: bool = True
    strategy: VerificationStrategy = VerificationStrategy.CONSISTENCY
    issues: list[str] = field(default_factory=list)
    score: float = 1.0
    details: dict[str, Any] = field(default_factory=dict)


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


_DEPTH_CONFIG: dict[ReasoningDepth, dict[str, Any]] = {
    ReasoningDepth.SHALLOW: {"max_layers": 1, "max_nodes": 3, "min_confidence": 0.6},
    ReasoningDepth.MEDIUM: {"max_layers": 3, "max_nodes": 8, "min_confidence": 0.7},
    ReasoningDepth.DEEP: {"max_layers": 5, "max_nodes": 15, "min_confidence": 0.8},
    ReasoningDepth.EXHAUSTIVE: {"max_layers": 8, "max_nodes": 25, "min_confidence": 0.85},
}


class ReasoningChainEngine:
    def __init__(self, llm: Any | None = None) -> None:
        self._llm = llm
        self._chain_counter = 0

    def determine_depth(
        self,
        query: str,
        complexity: str = "moderate",
        perception_state: Any | None = None,
    ) -> ReasoningDepth:
        depth_map = {
            "simple": ReasoningDepth.SHALLOW,
            "moderate": ReasoningDepth.MEDIUM,
            "complex": ReasoningDepth.DEEP,
        }
        depth = depth_map.get(complexity, ReasoningDepth.MEDIUM)

        if perception_state:
            scene = getattr(perception_state, "scene", None)
            if scene and hasattr(scene, "scene_type"):
                if scene.scene_type in ("debugging", "refactoring"):
                    depth = ReasoningDepth.DEEP
                elif scene.scene_type == "multi_step":
                    if depth == ReasoningDepth.SHALLOW:
                        depth = ReasoningDepth.MEDIUM

            emotion = getattr(perception_state, "emotion", None)
            if emotion and hasattr(emotion, "emotion_type"):
                if emotion.emotion_type in ("frustrated", "anxious"):
                    if depth.value < ReasoningDepth.DEEP.value:
                        depth = ReasoningDepth.DEEP

        high_risk_keywords = ["删除", "格式化", "重置", "清空", "覆盖", "不可逆", "生产环境"]
        if any(kw in query for kw in high_risk_keywords):
            if depth.value < ReasoningDepth.DEEP.value:
                depth = ReasoningDepth.DEEP

        return depth

    async def reason(
        self,
        query: str,
        complexity: str = "moderate",
        perception_state: Any | None = None,
        max_iterations: int | None = None,
    ) -> ReasoningChain:
        start = time.time()
        depth = self.determine_depth(query, complexity, perception_state)
        config = _DEPTH_CONFIG[depth]

        self._chain_counter += 1
        chain = ReasoningChain(
            id=f"chain_{self._chain_counter}_{int(start)}",
            query=query,
            depth=depth,
            created_at=start,
        )

        claim_node = ChainNode(
            id=f"{chain.id}_claim",
            content=query,
            node_type=ChainNodeType.CLAIM,
            confidence=1.0,
            source="user_input",
        )
        chain.add_node(claim_node)

        if self._llm:
            try:
                await self._llm_reason(chain, config, max_iterations)
            except Exception as e:
                log.warning("LLM reasoning failed, falling back to rule-based", error=str(e))
                self._rule_based_reason(chain, config)
        else:
            self._rule_based_reason(chain, config)

        conclusion_node = ChainNode(
            id=f"{chain.id}_conclusion",
            content=self._synthesize_conclusion(chain),
            node_type=ChainNodeType.CONCLUSION,
            confidence=chain.total_confidence,
            source="synthesis",
            parent_ids=[n.id for n in chain.get_leaves() if n.node_type != ChainNodeType.CONCLUSION],
        )
        chain.add_node(conclusion_node)

        duration_ms = (time.time() - start) * 1000
        log.info(
            "Reasoning chain built",
            chain_id=chain.id,
            depth=depth.value,
            nodes=len(chain.nodes),
            confidence=round(chain.total_confidence, 3),
            duration_ms=round(duration_ms, 1),
        )
        return chain

    async def _llm_reason(
        self,
        chain: ReasoningChain,
        config: dict[str, Any],
        max_iterations: int | None = None,
    ) -> None:
        max_layers = config["max_layers"]
        max_nodes = config["max_nodes"]
        iterations = max_iterations or max_layers

        for layer in range(iterations):
            if len(chain.nodes) >= max_nodes:
                break

            current_leaves = chain.get_leaves()
            if not current_leaves:
                break

            leaf = current_leaves[0]
            prompt = (
                f"基于以下推理节点，生成下一步推理：\n"
                f"当前节点: {leaf.content}\n"
                f"推理层级: {layer + 1}/{iterations}\n"
                f"查询: {chain.query}\n\n"
                f"请生成1-2个推理步骤，每个步骤包含：\n"
                f"1. 推理内容\n"
                f"2. 置信度(0-1)\n"
                f"3. 类型(inference/evidence/assumption/counter_argument)\n"
                f"用JSON格式输出: [{{\"content\": \"...\", \"confidence\": 0.8, \"type\": \"inference\"}}]"
            )

            response = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")

            import json
            import re
            json_match = re.search(r"\[[\s\S]*\]", content)
            if json_match:
                try:
                    steps = json.loads(json_match.group())
                    for step in steps[:2]:
                        node_type_str = step.get("type", "inference")
                        try:
                            node_type = ChainNodeType(node_type_str)
                        except ValueError:
                            node_type = ChainNodeType.INFERENCE
                        node = ChainNode(
                            id=f"{chain.id}_l{layer}_{len(chain.nodes)}",
                            content=step.get("content", ""),
                            node_type=node_type,
                            confidence=float(step.get("confidence", 0.7)),
                            source="llm_reasoning",
                            parent_ids=[leaf.id],
                        )
                        chain.add_node(node)
                except (json.JSONDecodeError, ValueError) as e:
                    log.debug("Failed to parse LLM reasoning steps", error=str(e))
                    break
            else:
                break

    def _rule_based_reason(self, chain: ReasoningChain, config: dict[str, Any]) -> None:
        max_nodes = config["max_nodes"]
        query = chain.query.lower()

        evidence_keywords = {
            "分析": ChainNodeType.EVIDENCE,
            "数据": ChainNodeType.EVIDENCE,
            "报告": ChainNodeType.EVIDENCE,
            "统计": ChainNodeType.EVIDENCE,
            "假设": ChainNodeType.ASSUMPTION,
            "可能": ChainNodeType.ASSUMPTION,
            "但是": ChainNodeType.COUNTER_ARGUMENT,
            "然而": ChainNodeType.COUNTER_ARGUMENT,
            "因此": ChainNodeType.INFERENCE,
            "所以": ChainNodeType.INFERENCE,
            "推断": ChainNodeType.INFERENCE,
        }

        claim = chain.get_roots()[0] if chain.get_roots() else None
        if not claim:
            return

        parent_id = claim.id
        layer = 0
        for keyword, node_type in evidence_keywords.items():
            if len(chain.nodes) >= max_nodes:
                break
            if keyword in query:
                node = ChainNode(
                    id=f"{chain.id}_rule_l{layer}_{len(chain.nodes)}",
                    content=f"基于关键词'{keyword}'的推理：{query}",
                    node_type=node_type,
                    confidence=0.7,
                    source="rule_based",
                    parent_ids=[parent_id],
                )
                chain.add_node(node)
                parent_id = node.id
                layer += 1

    def _synthesize_conclusion(self, chain: ReasoningChain) -> str:
        if not chain.nodes:
            return "无推理结果"
        leaves = chain.get_leaves()
        if leaves:
            contents = [n.content for n in leaves if n.node_type != ChainNodeType.CONCLUSION]
            if contents:
                return f"综合推理结论: {'; '.join(contents[:3])}"
        return f"推理结论: {chain.query}"

    async def verify(
        self,
        chain: ReasoningChain,
        strategies: list[VerificationStrategy] | None = None,
    ) -> dict[str, VerificationResult]:
        if strategies is None:
            strategies = [
                VerificationStrategy.CONSISTENCY,
                VerificationStrategy.COMPLETENESS,
                VerificationStrategy.REDUNDANCY,
            ]

        results: dict[str, VerificationResult] = {}
        for strategy in strategies:
            if strategy == VerificationStrategy.CONSISTENCY:
                results["consistency"] = self._verify_consistency(chain)
            elif strategy == VerificationStrategy.FACTUALITY:
                results["factuality"] = await self._verify_factuality(chain)
            elif strategy == VerificationStrategy.COMPLETENESS:
                results["completeness"] = self._verify_completeness(chain)
            elif strategy == VerificationStrategy.REDUNDANCY:
                results["redundancy"] = self._verify_redundancy(chain)

        overall_passed = all(r.passed for r in results.values())
        overall_score = sum(r.score for r in results.values()) / len(results) if results else 0.0
        chain.verified = True
        chain.verification_result = {
            "passed": overall_passed,
            "overall_score": round(overall_score, 3),
            "strategies": {k: {"passed": v.passed, "score": v.score} for k, v in results.items()},
        }

        log.info(
            "Chain verification completed",
            chain_id=chain.id,
            passed=overall_passed,
            score=round(overall_score, 3),
        )
        return results

    def _verify_consistency(self, chain: ReasoningChain) -> VerificationResult:
        issues: list[str] = []
        node_contents: dict[str, str] = {n.id: n.content.lower() for n in chain.nodes}

        contradiction_pairs = [
            ("是", "不是"), ("有", "没有"), ("可以", "不可以"),
            ("正确", "错误"), ("成功", "失败"), ("需要", "不需要"),
        ]
        for positive, negative in contradiction_pairs:
            pos_nodes = [nid for nid, c in node_contents.items() if positive in c]
            neg_nodes = [nid for nid, c in node_contents.items() if negative in c]
            if pos_nodes and neg_nodes:
                for pn in pos_nodes:
                    for nn in neg_nodes:
                        if self._are_related(chain, pn, nn):
                            issues.append(f"潜在矛盾: 节点包含'{positive}'和'{negative}'")

        score = max(0.0, 1.0 - len(issues) * 0.2)
        return VerificationResult(
            passed=len(issues) == 0,
            strategy=VerificationStrategy.CONSISTENCY,
            issues=issues,
            score=score,
        )

    def _are_related(self, chain: ReasoningChain, node_id_a: str, node_id_b: str) -> bool:
        visited: set[str] = set()
        queue = [node_id_a]
        while queue:
            current = queue.pop(0)
            if current == node_id_b:
                return True
            if current in visited:
                continue
            visited.add(current)
            node = chain.get_node(current)
            if node:
                queue.extend(node.parent_ids)
                children = chain.get_children(current)
                queue.extend(c.id for c in children)
        return False

    async def _verify_factuality(self, chain: ReasoningChain) -> VerificationResult:
        if not self._llm:
            return VerificationResult(
                passed=True,
                strategy=VerificationStrategy.FACTUALITY,
                score=0.7,
                details={"note": "No LLM available, factuality check skipped"},
            )

        claims = [n for n in chain.nodes if n.node_type in (ChainNodeType.CLAIM, ChainNodeType.ASSUMPTION)]
        if not claims:
            return VerificationResult(
                passed=True,
                strategy=VerificationStrategy.FACTUALITY,
                score=1.0,
            )

        issues: list[str] = []
        for claim_node in claims[:3]:
            try:
                prompt = (
                    f"验证以下陈述的事实准确性（仅回答是/否/不确定）：\n"
                    f"陈述: {claim_node.content}\n\n"
                    f"回答格式: {{\"factual\": true/false/null, \"reason\": \"...\"}}"
                )
                response = await self._llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    use_cache=True,
                )
                content = response.get("content", "").lower()
                if "false" in content or "否" in content:
                    issues.append(f"事实存疑: {claim_node.content[:50]}")
            except Exception as e:
                log.debug("Factuality check failed for node", node_id=claim_node.id, error=str(e))

        score = max(0.0, 1.0 - len(issues) * 0.3)
        return VerificationResult(
            passed=len(issues) == 0,
            strategy=VerificationStrategy.FACTUALITY,
            issues=issues,
            score=score,
        )

    def _verify_completeness(self, chain: ReasoningChain) -> VerificationResult:
        issues: list[str] = []
        roots = chain.get_roots()
        leaves = chain.get_leaves()

        if not roots:
            issues.append("推理链没有根节点")
        if not leaves:
            issues.append("推理链没有叶节点")

        has_evidence = any(n.node_type == ChainNodeType.EVIDENCE for n in chain.nodes)
        has_inference = any(n.node_type == ChainNodeType.INFERENCE for n in chain.nodes)
        has_conclusion = any(n.node_type == ChainNodeType.CONCLUSION for n in chain.nodes)

        if not has_evidence and chain.depth.value >= ReasoningDepth.MEDIUM.value:
            issues.append("中等深度以上推理链缺少证据节点")
        if not has_inference and len(chain.nodes) > 2:
            issues.append("多节点推理链缺少推理节点")
        if not has_conclusion:
            issues.append("推理链缺少结论节点")

        orphan_nodes = [
            n for n in chain.nodes
            if n.node_type != ChainNodeType.CLAIM
            and not n.parent_ids
            and n.node_type != ChainNodeType.CONCLUSION
        ]
        if orphan_nodes:
            issues.append(f"存在 {len(orphan_nodes)} 个孤立节点（无父节点）")

        score = max(0.0, 1.0 - len(issues) * 0.15)
        return VerificationResult(
            passed=len(issues) == 0,
            strategy=VerificationStrategy.COMPLETENESS,
            issues=issues,
            score=score,
        )

    def _verify_redundancy(self, chain: ReasoningChain) -> VerificationResult:
        issues: list[str] = []
        seen_contents: dict[str, str] = {}

        for node in chain.nodes:
            content_key = node.content.lower().strip()[:100]
            if content_key in seen_contents:
                issues.append(
                    f"节点 {node.id} 与 {seen_contents[content_key]} 内容重复"
                )
            else:
                seen_contents[content_key] = node.id

        similar_pairs: list[tuple[str, str]] = []
        nodes = chain.nodes
        for i, n1 in enumerate(nodes):
            for n2 in nodes[i + 1:]:
                if n1.id == n2.id:
                    continue
                words1 = set(n1.content.lower().split())
                words2 = set(n2.content.lower().split())
                if words1 and words2:
                    overlap = len(words1 & words2) / min(len(words1), len(words2))
                    if overlap > 0.8 and (n1.id, n2.id) not in similar_pairs:
                        similar_pairs.append((n1.id, n2.id))
                        if len(similar_pairs) > 2:
                            issues.append(f"节点 {n1.id} 与 {n2.id} 高度相似（>80%词重叠）")

        score = max(0.0, 1.0 - len(issues) * 0.1)
        return VerificationResult(
            passed=len(issues) == 0,
            strategy=VerificationStrategy.REDUNDANCY,
            issues=issues,
            score=score,
        )

    def compress(self, chain: ReasoningChain, target_ratio: float = 0.6) -> ReasoningChain:
        if len(chain.nodes) <= 3:
            return chain

        essential_types = {ChainNodeType.CLAIM, ChainNodeType.CONCLUSION, ChainNodeType.EVIDENCE}
        essential_nodes = [n for n in chain.nodes if n.node_type in essential_types]
        optional_nodes = [n for n in chain.nodes if n.node_type not in essential_types]

        target_count = max(3, int(len(chain.nodes) * target_ratio))
        if len(essential_nodes) >= target_count:
            kept_nodes = essential_nodes[:target_count]
        else:
            remaining = target_count - len(essential_nodes)
            optional_sorted = sorted(optional_nodes, key=lambda n: n.confidence, reverse=True)
            kept_nodes = essential_nodes + optional_sorted[:remaining]

        kept_ids = {n.id for n in kept_nodes}
        for node in kept_nodes:
            node.parent_ids = [pid for pid in node.parent_ids if pid in kept_ids]

        compressed = ReasoningChain(
            id=f"{chain.id}_compressed",
            query=chain.query,
            nodes=kept_nodes,
            depth=chain.depth,
            created_at=chain.created_at,
            verified=chain.verified,
            verification_result=chain.verification_result,
        )
        compressed._recalculate_confidence()

        log.info(
            "Chain compressed",
            original_nodes=len(chain.nodes),
            compressed_nodes=len(kept_nodes),
            ratio=round(len(kept_nodes) / len(chain.nodes), 2),
        )
        return compressed

    # ─── D3: 反事实推理 ───

    async def counterfactual(
        self,
        chain: ReasoningChain,
        alternative_hypothesis: str = "",
    ) -> dict[str, Any]:
        """对关键决策生成反事实路径评估。

        分析"如果不这样做会怎样"，对比原路径与替代路径的预期结果，
        帮助Agent做出更鲁棒的决策。

        Args:
            chain: 原始推理链
            alternative_hypothesis: 替代假设（空则自动生成）

        Returns:
            dict: 包含 original_summary, counterfactual_paths, recommendation
        """
        inferences = [n for n in chain.nodes if n.node_type == ChainNodeType.INFERENCE]
        if not inferences:
            return {"original_summary": "无推理节点可分析", "counterfactual_paths": [], "recommendation": "insufficient_data"}

        original_summary = "; ".join(n.content[:60] for n in inferences[:3])
        counterfactual_paths: list[dict[str, Any]] = []

        if self._llm:
            for inf_node in inferences[:2]:
                try:
                    alt = alternative_hypothesis or f"如果不{inf_node.content[:30]}"
                    prompt = (
                        f"反事实推理分析：\n"
                        f"原推理: {inf_node.content}\n"
                        f"替代假设: {alt}\n"
                        f"原始查询: {chain.query}\n\n"
                        f"请分析替代假设下的可能结果，用JSON格式输出：\n"
                        f'{{"outcome": "可能结果", "probability": 0.3, "risk": "low/medium/high", "reasoning": "推理过程"}}'
                    )
                    response = await self._llm.chat(
                        messages=[{"role": "user", "content": prompt}],
                        use_cache=False,
                    )
                    content = response.get("content", "")
                    import json, re
                    json_match = re.search(r"\{[\s\S]*\}", content)
                    if json_match:
                        try:
                            cf = json.loads(json_match.group())
                            counterfactual_paths.append({
                                "original_inference": inf_node.content[:60],
                                "alternative": alt,
                                "outcome": cf.get("outcome", ""),
                                "probability": float(cf.get("probability", 0.5)),
                                "risk": cf.get("risk", "medium"),
                                "reasoning": cf.get("reasoning", ""),
                            })
                        except (json.JSONDecodeError, ValueError):
                            pass
                except Exception as e:
                    log.debug("Counterfactual analysis failed for node", node_id=inf_node.id, error=str(e))
        else:
            for inf_node in inferences[:2]:
                alt = alternative_hypothesis or f"不执行: {inf_node.content[:30]}"
                counterfactual_paths.append({
                    "original_inference": inf_node.content[:60],
                    "alternative": alt,
                    "outcome": "可能失败或结果不同",
                    "probability": 0.5,
                    "risk": "medium",
                    "reasoning": "无LLM，基于规则的保守估计",
                })

        high_risk_count = sum(1 for p in counterfactual_paths if p.get("risk") == "high")
        if high_risk_count > 0:
            recommendation = "proceed_with_caution"
        elif any(p.get("probability", 0) > 0.7 for p in counterfactual_paths):
            recommendation = "consider_alternative"
        else:
            recommendation = "proceed_as_planned"

        log.info(
            "D3: counterfactual analysis completed",
            chain_id=chain.id,
            paths=len(counterfactual_paths),
            recommendation=recommendation,
        )
        return {
            "original_summary": original_summary,
            "counterfactual_paths": counterfactual_paths,
            "recommendation": recommendation,
        }

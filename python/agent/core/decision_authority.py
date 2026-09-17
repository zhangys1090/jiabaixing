"""
D4 DecisionAuthority — Python 侧实现

FINAL Authority 原则：
  本模块是 Python 进程内的唯一 FINAL Decision Authority。
  TS 侧 DecisionAuthority 是 TS 进程内的唯一 FINAL。
  两者不嵌套、不互相 override。
  跨进程通信只传递 Decision ID（decisionId/goalId/snapshotId），
  不传递 Decision 语义（chosen/rejected/reason）——
  每个进程只服从自己执行上下文内的 FINAL。

职责：
  ✅ decide() → FINAL Decision（本进程唯一裁决点）
  ✅ decideWithProposers() → 从注册的 Proposer 收集候选 + 裁决
  ✅ 完整审计 trail（selectionReason, rejectedCandidates, proposerSet）
  ❌ 不做安全检查（→ ActionAuthority / permission_guard）
  ❌ 不执行动作（→ tool_registry.execute）
  ❌ 不修改 Goal/State
  ❌ 不服从任何其他进程的 Decision Authority
"""
from __future__ import annotations

import json
import time
from typing import Any

from agent.core.authority_types import (
    CanonicalDecisionSnapshot,
    Decision,
    DecisionCandidate,
    DecisionContext,
    DecisionProposer,
    Goal,
    GoalStatus,
    ProposedAction,
    _gen_id,
)
from agent.core.goal_authority import GoalAuthority
from agent.core.learning_authority import LearningAuthority
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("decision_authority")


class LLMProposer:
    """将 LLM tool_calls 转为 DecisionCandidate[] 的 Proposer。

    M4 fix: 支持 decideWithProposers() 调用模式。
    - 直接调用 propose(goal, snapshot, tool_calls_raw=...) 时走显式参数。
    - decideWithProposers() 调用 propose(goal, snapshot) 时，从 pending_tool_calls 取。
    """

    def __init__(self) -> None:
        self.proposerId = "llm"
        self.pending_tool_calls: list[dict[str, Any]] | None = None

    async def propose(
        self,
        goal: Goal,
        snapshot: CanonicalDecisionSnapshot,
        tool_calls_raw: list[dict[str, Any]] | None = None,
    ) -> list[DecisionCandidate]:
        raw = tool_calls_raw or self.pending_tool_calls
        if not raw:
            return []
        # ML8 fix: 记忆真正影响决策 — 把 snapshot.memory 的 relevantMemories
        # 拼进候选 reasoning，让"检索到的经验"成为裁决的可追溯依据，
        # 而不是只存在于快照里无人消费（此前 Memory→State→Decision 断链）。
        memory_hint = self._memory_reasoning_hint(snapshot)
        candidates: list[DecisionCandidate] = []
        for i, tc_raw in enumerate(raw):
            fn = tc_raw.get("function", {})
            name = fn.get("name", "")
            args_str = fn.get("arguments", "{}")
            candidates.append(DecisionCandidate(
                candidateId=_gen_id("C"),
                proposerId=self.proposerId,
                action=ProposedAction(
                    type="tool_call",
                    payload={"name": name, "arguments": args_str, "id": tc_raw.get("id", "")},
                ),
                confidence=0.85,
                reasoning=(
                    f"LLM chose tool {name} for goal '{goal.description[:50]}'"
                    f"{memory_hint}"
                ),
                estimatedGoalProgress=min(1.0, goal.progress + 0.3),
            ))
        return candidates

    @staticmethod
    def _memory_reasoning_hint(snapshot: CanonicalDecisionSnapshot) -> str:
        """从快照提取相关记忆摘要（最多 3 条、单条截断 120 字符）。

        Returns:
            追加到 reasoning 的记忆提示串；无相关记忆时为空串（不伪造）。
        """
        try:
            mem = getattr(snapshot, "memory", None)
            if mem is None:
                return ""
            rel = getattr(mem, "relevantMemories", None) or []
            if not rel:
                return ""
            snippets: list[str] = []
            for h in rel[:3]:
                if not isinstance(h, dict):
                    continue
                content = str(h.get("content", "") or "").strip()
                if not content:
                    continue
                mtype = str(h.get("memoryType", h.get("memory_type", "")) or "").strip()
                snippet = content[:120]
                snippets.append(f"[{mtype}] {snippet}" if mtype else snippet)
            if not snippets:
                return ""
            return " | memory: " + "; ".join(snippets)
        except Exception:
            return ""


class SkillProposer:
    """将 skill match 结果转为 DecisionCandidate[] 的 Proposer。"""

    def __init__(self) -> None:
        self.proposerId = "skill"

    async def propose(
        self,
        goal: Goal,
        snapshot: CanonicalDecisionSnapshot,
        matched_skills: list[dict[str, Any]] | None = None,
    ) -> list[DecisionCandidate]:
        if not matched_skills:
            return []
        candidates: list[DecisionCandidate] = []
        for skill in matched_skills:
            candidates.append(DecisionCandidate(
                candidateId=_gen_id("C"),
                proposerId=self.proposerId,
                action=ProposedAction(
                    type="skill_call",
                    payload=skill,
                ),
                confidence=skill.get("confidence", 0.5),
                reasoning=f"Skill match: {skill.get('name', 'unknown')}",
                estimatedGoalProgress=min(1.0, goal.progress + skill.get("confidence", 0.5) * 0.2),
            ))
        return candidates


class RecoveryProposer:
    """基于**实测工具可靠性**的替补候选 Proposer —— 真实第二意见来源。

    为什么需要它（D4-M4 遗留缺陷）:
        ``LLMProposer`` 只是把 LLM 已经定好的 tool_calls 原样包成候选，
        ``SkillProposer`` 因 ``decideWithProposers`` 从不传 ``matched_skills``
        而恒返回空列表。于是候选集只有一个来源，
        ``accept_threshold = top * 0.7`` 在单候选时恒真、排序是恒等操作 ——
        DecisionAuthority 退化为**幂等映射**：证明了"决策被记录"，
        没有证明"决策被审视过"。

    本 Proposer 提供真实的第二意见，依据是系统**已经在采集**的数据:
        - ``ToolSelectionMemory.get_stats(name).success_rate``（已接线、真实累积）
        - ``ToolRegistry.get_by_category`` + ``ToolDefinition.parameters``（schema 兼容性）

    安全边界（关键，勿放宽）:
        只在**参数 schema 兼容**时才提替补 —— 替补工具的全部必填参数名必须
        已存在于原实参键集中。否则同一份 arguments 对替补无效，盲目替换会
        引入新的失败，比"没有第二意见"更糟。
        无可兼容替补时返回空列表，由 DecisionAuthority 如实记录竞争缺失
        （``competitionDegraded=True``），绝不伪造候选。

    纯度（开发标准 §9.3）:
        本类只产生 DecisionCandidate，不执行任何动作、不访问环境。

    Attributes:
        proposerId: 固定为 "recovery"。
        pending_tool_calls: 与 LLMProposer 同款的显式传参通道 ——
            ``decideWithProposers`` 只传 (goal, snapshot)，故由调用方在
            裁决前把本轮原始 tool_calls 挂在这里。
        last_skip_reason: 最近一次未产生候选的原因（观测用）。
    """

    def __init__(
        self,
        *,
        tool_registry: Any = None,
        tool_selection_memory: Any = None,
        min_samples: int = 3,
        poor_success_rate: float = 0.5,
        max_candidates: int = 2,
    ) -> None:
        """初始化。

        Args:
            tool_registry: ToolRegistry，用于查 category 与参数 schema。
            tool_selection_memory: ToolSelectionMemory，用于查实测成功率。
            min_samples: 最小样本量。低于该值不提替补 —— 避免用小样本噪声
                干扰裁决（宁可没有第二意见，也不要用噪声投票）。
            poor_success_rate: 成功率低于该值才认为原工具不可靠。
            max_candidates: 单个原动作最多提几个替补。
        """
        self.proposerId = "recovery"
        self.pending_tool_calls: list[dict[str, Any]] | None = None
        self.last_skip_reason: str = ""
        self._tool_registry = tool_registry
        self._tsm = tool_selection_memory
        self._min_samples = min_samples
        self._poor_success_rate = poor_success_rate
        self._max_candidates = max_candidates

    def bind(
        self,
        *,
        tool_registry: Any = None,
        tool_selection_memory: Any = None,
    ) -> None:
        """注入数据源。两者都已就绪时本 Proposer 才会产出候选。"""
        if tool_registry is not None:
            self._tool_registry = tool_registry
        if tool_selection_memory is not None:
            self._tsm = tool_selection_memory

    @property
    def ready(self) -> bool:
        """数据源是否齐备。未就绪时 propose() 恒返回空列表。"""
        return self._tool_registry is not None and self._tsm is not None

    async def propose(
        self,
        goal: Goal,
        snapshot: CanonicalDecisionSnapshot,
        tool_calls_raw: list[dict[str, Any]] | None = None,
    ) -> list[DecisionCandidate]:
        """为实测不可靠的动作提出 schema 兼容的替补候选。

        Args:
            goal: 当前目标。
            snapshot: 规范决策快照。
            tool_calls_raw: 本轮 LLM 原始 tool_calls；None 时取 pending_tool_calls。

        Returns:
            DecisionCandidate 列表；无可兼容替补时为空列表。
        """
        raw = tool_calls_raw or self.pending_tool_calls
        self.last_skip_reason = ""
        if not raw:
            return []
        if not self.ready:
            self.last_skip_reason = "data_sources_not_bound"
            return []

        candidates: list[DecisionCandidate] = []
        for tc_raw in raw:
            fn = tc_raw.get("function", {}) if isinstance(tc_raw, dict) else {}
            name = fn.get("name", "")
            if not name:
                continue

            stats = self._tsm.get_stats(name)
            if stats is None or stats.call_count < self._min_samples:
                self.last_skip_reason = f"insufficient_samples:{name}"
                continue
            if stats.success_rate >= self._poor_success_rate:
                self.last_skip_reason = f"reliable_enough:{name}"
                continue

            definition = self._tool_registry.get_definition(name)
            if definition is None:
                self.last_skip_reason = f"unknown_definition:{name}"
                continue

            args = self._parse_args(fn.get("arguments", "{}"))
            if args is None:
                self.last_skip_reason = f"unparsable_args:{name}"
                continue
            arg_keys = set(args.keys())

            substitutes, skip_reason = self._find_substitutes(definition, name, arg_keys, stats)
            if not substitutes:
                self.last_skip_reason = skip_reason
                continue

            for alt, alt_stats in substitutes:
                candidates.append(DecisionCandidate(
                    candidateId=_gen_id("C"),
                    proposerId=self.proposerId,
                    action=ProposedAction(
                        type="tool_call",
                        payload={
                            "name": alt.name,
                            "arguments": json.dumps(args, ensure_ascii=False),
                            "id": tc_raw.get("id", ""),
                        },
                    ),
                    confidence=float(alt_stats.success_rate),
                    reasoning=(
                        f"recovery: {name} measured success_rate="
                        f"{stats.success_rate:.2f} (n={stats.call_count}) below "
                        f"{self._poor_success_rate}; schema-compatible substitute "
                        f"{alt.name} success_rate={alt_stats.success_rate:.2f} "
                        f"(n={alt_stats.call_count}) on args={sorted(arg_keys)}"
                    ),
                    estimatedGoalProgress=min(
                        1.0, goal.progress + 0.2 * float(alt_stats.success_rate)
                    ),
                ))
        return candidates

    # ---------------------------------------------------------------- 内部

    @staticmethod
    def _parse_args(raw: Any) -> dict[str, Any] | None:
        """解析 LLM 传入的 arguments。非法 JSON 返回 None（不猜）。"""
        if isinstance(raw, dict):
            return raw
        if not isinstance(raw, str) or not raw.strip():
            return {}
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def _find_substitutes(
        self,
        definition: Any,
        name: str,
        arg_keys: set[str],
        stats: Any,
    ) -> tuple[list[tuple[Any, Any]], str]:
        """在同 category 内找 schema 兼容且实测更可靠的替补。

        兼容判据: 替补的全部**必填**参数名 ⊆ 原实参键集。
        质量判据: 替补成功率严格高于原工具，且样本量达标。

        Returns:
            ([(ToolDefinition, ToolStats)], skip_reason)。
            找到时 skip_reason 为空串；未找到时给出**精确**原因
            —— 区分"没有兼容替补"与"有兼容替补但不够好"，
            避免诊断标签本身产生误导。
        """
        category = getattr(definition, "category", None)
        if category is None:
            return [], f"definition_without_category:{name}"
        try:
            same_category = self._tool_registry.get_by_category(category)
        except Exception:
            return [], f"category_lookup_failed:{name}"

        scored: list[tuple[Any, Any]] = []
        compatible_but_weak = 0
        for alt in same_category:
            alt_name = getattr(alt, "name", "")
            if not alt_name or alt_name == name:
                continue
            required = {
                p.name for p in getattr(alt, "parameters", [])
                if getattr(p, "required", False)
            }
            if not required.issubset(arg_keys):
                continue
            alt_stats = self._tsm.get_stats(alt_name)
            if alt_stats is None or alt_stats.call_count < self._min_samples:
                continue
            if alt_stats.success_rate <= stats.success_rate:
                compatible_but_weak += 1
                continue
            scored.append((alt, alt_stats))

        scored.sort(key=lambda x: x[1].success_rate, reverse=True)
        if scored:
            return scored[: self._max_candidates], ""
        if compatible_but_weak:
            return [], f"substitute_not_better:{name}"
        return [], f"no_schema_compatible_substitute:{name}"



class DecisionAuthority:
    _instance: DecisionAuthority | None = None

    @classmethod
    def getInstance(cls) -> DecisionAuthority:
        if cls._instance is None:
            cls._instance = DecisionAuthority()
        return cls._instance

    @classmethod
    def resetInstance(cls) -> None:
        cls._instance = None

    def __init__(self) -> None:
        self._proposers: dict[str, DecisionProposer] = {}
        self._decision_history: dict[str, list[Decision]] = {}
        # L0 ActionAuthority 需要 按 decisionId 回查裁决（防伪造身份 / 验证候选确被接受）
        self._decision_index: dict[str, Decision] = {}
        # M5 修复（2026-09-17）：实测成功率注入打分。
        # Proposer 的 confidence 是**乐观估计**（LLMProposer 硬编码 0.85），
        # 与工具的真实历史表现无关 —— 导致"实测很差的工具排在实测很好的替补前面"。
        self._tool_selection_memory: Any = None
        self._min_evidence_samples = 3
        # World 预测进决策（2026-09-17）：世界模型对拟执行动作的低置信度预判
        # 作为**当轮风险惩罚**注入打分 —— 此前预测结果只打日志，World 节点惰性。
        self._world_model_risk: dict[str, float] | None = None

    def set_world_model_risk(self, risk: dict[str, float] | None) -> None:
        """注入本轮世界模型风险表 {工具名: 置信度}。

        只含**低置信度**预判的动作。每轮裁决前由主循环写入、裁决后由
        主循环清除（None）—— 风险是**当轮**信息，不跨轮累积。
        """
        self._world_model_risk = risk or None

    def _world_model_penalty(self, candidate: DecisionCandidate) -> float:
        """世界模型低置信度惩罚系数；无风险时为 1.0。"""
        if not self._world_model_risk:
            return 1.0
        payload = (
            candidate.action.payload
            if isinstance(candidate.action.payload, dict) else {}
        )
        name = str(payload.get("name", "") or "")
        conf = self._world_model_risk.get(name)
        if conf is None:
            return 1.0
        # 低置信度预测 → 压低该候选 30%；预测值越低惩罚越重（下限 0.6）
        penalty = max(0.6, 1.0 - (1.0 - float(conf)) * 2.0)
        return penalty

    def set_tool_selection_memory(self, memory: Any) -> None:
        """注入工具选择记忆（实测成功率来源）。None 表示无实测数据。"""
        self._tool_selection_memory = memory

    def _evidence_confidence(self, candidate: DecisionCandidate) -> float | None:
        """该候选动作的**实测**成功率；样本不足返回 None（不猜）。

        样本下限与 RecoveryProposer 对齐（min_samples=3）——
        宁可没有证据，也不用小样本噪声投票。
        """
        if self._tool_selection_memory is None:
            return None
        payload = (
            candidate.action.payload
            if isinstance(candidate.action.payload, dict) else {}
        )
        name = str(payload.get("name", "") or "")
        if not name:
            return None
        try:
            stats = self._tool_selection_memory.get_stats(name)
        except Exception:
            return None
        if stats is None or getattr(stats, "call_count", 0) < self._min_evidence_samples:
            return None
        return float(stats.success_rate)

    def getDecisionById(self, decisionId: str) -> Decision | None:
        """按 decisionId 回查裁决（L0 ActionAuthority 的 provenance 校验用）。

        Args:
            decisionId: 裁决 ID。

        Returns:
            Decision 或 None（不存在 / 未记录）。
        """
        return self._decision_index.get(decisionId)

    def registerProposer(self, proposer: DecisionProposer) -> None:
        self._proposers[proposer.proposerId] = proposer

    async def decide(self, context: DecisionContext) -> Decision:
        goalAuth = GoalAuthority.getInstance()
        goal = goalAuth.getGoal(context.goalId)
        if goal is None:
            raise ValueError(f"goal {context.goalId} not found")
        if goal.status != GoalStatus.ACTIVE:
            raise ValueError(f"goal {context.goalId} is {goal.status.value}, not active")

        candidates = context.candidates
        if not candidates:
            raise ValueError(f"no candidates for goal {context.goalId}")

        # D5: LearningAuthority — 依历史 Evidence 信念调整候选（Evidence→Belief→Decision 闭环）
        learning = LearningAuthority.getInstance()
        adjusted = [learning.adjust_candidate(c) for c in candidates]
        learned_count = sum(
            1 for a, o in zip(adjusted, candidates)
            if a.confidence != o.confidence or a.estimatedGoalProgress != o.estimatedGoalProgress
        )

        # M5 修复：打分时**实测成功率优先于 proposer 的乐观估计**。
        # 有实测数据的候选用实测值算 confidence；没有的沿用 proposer 值。
        # 这使"实测很差的工具"不再靠硬编码 0.85 压过"实测很好的替补"。
        scored: list[tuple[DecisionCandidate, float]] = []
        measured_used = 0
        wm_penalized = 0
        for c in adjusted:
            ev = self._evidence_confidence(c)
            wm_p = self._world_model_penalty(c)
            if wm_p < 1.0:
                wm_penalized += 1
            if ev is not None:
                scored.append((c, self._score_candidate(
                    DecisionCandidate(
                        candidateId=c.candidateId, proposerId=c.proposerId,
                        action=c.action, confidence=ev * wm_p,
                        reasoning=c.reasoning,
                        estimatedGoalProgress=c.estimatedGoalProgress,
                    ),
                    goal.progress,
                )))
                measured_used += 1
            else:
                scored.append((c, self._score_candidate(
                    DecisionCandidate(
                        candidateId=c.candidateId, proposerId=c.proposerId,
                        action=c.action, confidence=c.confidence * wm_p,
                        reasoning=c.reasoning,
                        estimatedGoalProgress=c.estimatedGoalProgress,
                    ),
                    goal.progress,
                )))
        scored.sort(key=lambda x: x[1], reverse=True)

        chosen = scored[0][0]
        chosen_score = scored[0][1]

        accept_threshold = chosen_score * 0.7
        accepted = [s[0] for s in scored if s[1] >= accept_threshold]
        rejected = [s[0] for s in scored if s[1] < accept_threshold]

        proposer_set = sorted({c.proposerId for c in candidates})
        # 竞争度审计（2026-09-17）：只有**来源数** ≥ 2 时，这次裁决才是有竞争的裁决。
        # 单来源下 accept_threshold = top * 0.7 恒真、排序是恒等操作 ——
        # 必须让这件事可观测，否则"DecisionAuthority 是唯一 FINAL selector"
        # 在语义上为空、却从外部看不出来（这正是 D4-M4 遗留缺陷的隐蔽之处）。
        competition_degraded = len(proposer_set) < 2

        selection_reason = self._build_selection_reason(chosen, chosen_score, goal.progress, len(accepted))
        if learned_count:
            selection_reason += f" learningAdjustments={learned_count}"
        selection_reason += (
            f" competition={'single-source' if competition_degraded else 'multi-source'}"
            f" proposers={len(proposer_set)} candidates={len(candidates)}"
            f" scoring={'measured' if measured_used else 'proposer'}"
            f" measuredCandidates={measured_used}"
            f" wmPenalized={wm_penalized}"
        )

        decision = Decision(
            decisionId=_gen_id("D"),
            goalId=context.goalId,
            snapshotId=context.snapshot.snapshotId,
            candidateIds=[c.candidateId for c in candidates],
            chosenCandidateId=chosen.candidateId,
            chosen=chosen,
            acceptedCandidates=accepted,
            rejectedCandidates=rejected,
            selectionReason=selection_reason,
            proposerSet=proposer_set,
            vetoReason=None,
            timestamp=time.time(),
            proposerCount=len(proposer_set),
            candidateCount=len(candidates),
            competitionDegraded=competition_degraded,
        )

        if competition_degraded:
            log.warning(
                "DecisionAuthority: single-proposer decision — FINAL 裁决无竞争候选",
                decisionId=decision.decisionId,
                goalId=context.goalId,
                proposerSet=proposer_set,
                candidateCount=len(candidates),
                hint="候选来源只有 1 个，accept_threshold 恒真、排序为恒等",
            )

        # L0: 建立 decisionId → Decision 索引（provenance 回查用）
        self._decision_index[decision.decisionId] = decision

        if context.goalId not in self._decision_history:
            self._decision_history[context.goalId] = []
        self._decision_history[context.goalId].append(decision)

        # D5: 登记 provenance（decisionId→proposer/actionName），供 Evidence 写回时学习
        try:
            learning.record_decision(decision)
        except Exception as _lrn_exc:
            log_ignored(log, "DecisionAuthority.record_decision", _lrn_exc)

        # D6: Decision 持久化（Risk 1 — TS 交叉验证数据源）。失败不阻断裁决。
        try:
            from agent.core.memory_authority import MemoryAuthority

            MemoryAuthority.getInstance().persist_decision(decision)
        except Exception as _persist_exc:
            log_ignored(log, "DecisionAuthority.persist_decision", _persist_exc)

        return decision

    async def decideWithProposers(
        self,
        goalId: str,
        snapshot: CanonicalDecisionSnapshot,
    ) -> Decision:
        goalAuth = GoalAuthority.getInstance()
        goal = goalAuth.getGoal(goalId)
        if goal is None:
            raise ValueError(f"goal {goalId} not found")

        all_candidates: list[DecisionCandidate] = []
        proposer_count = 0
        for proposer in self._proposers.values():
            proposer_count += 1
            try:
                cands = await proposer.propose(goal, snapshot)
                all_candidates.extend(cands)
            except Exception as _prop_exc:
                # 单个 proposer 失败不中断其它 proposer，但必须可观测（P2-1 红线）
                log_ignored(log, "DecisionAuthority.decideWithProposers", _prop_exc)

        if not all_candidates:
            raise ValueError(f"no candidates from {proposer_count} proposers")

        context = DecisionContext(
            goalId=goalId,
            snapshot=snapshot,
            candidates=all_candidates,
        )
        return await self.decide(context)

    def getDecisionHistory(self, goalId: str) -> list[Decision]:
        return self._decision_history.get(goalId, [])

    def _score_candidate(self, candidate: DecisionCandidate, currentProgress: float) -> float:
        progress_weight = 0.6
        confidence_weight = 0.4
        return (
            confidence_weight * candidate.confidence
            + progress_weight * candidate.estimatedGoalProgress
        )

    def _build_selection_reason(
        self,
        chosen: DecisionCandidate,
        score: float,
        currentProgress: float,
        acceptedCount: int = 1,
    ) -> str:
        return (
            f"proposer={chosen.proposerId} "
            f"confidence={chosen.confidence:.2f} "
            f"estimatedProgress={chosen.estimatedGoalProgress:.2f} "
            f"score={score:.4f} "
            f"currentProgress={currentProgress:.2f} "
            f"acceptedCount={acceptedCount}"
        )

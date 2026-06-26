from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("plan_quality_checker")


@dataclass
class QualityCheckerConfig:
    pass_threshold: float = 0.6
    enable_risk_detection: bool = True
    enable_cycle_detection: bool = True


@dataclass
class QualityIssue:
    severity: str
    description: str
    step_id: str = ""
    suggestion: str = ""


@dataclass
class PlanQualityResult:
    quality_score: float
    is_passed: bool
    completeness_score: float = 0.0
    feasibility_score: float = 0.0
    issues: list[QualityIssue] = field(default_factory=list)


_HIGH_RISK_KEYWORDS = [
    "删除", "移除", "清空", "格式化", "drop", "delete", "remove",
    "truncate", "rm ", "重要文件", "生产环境",
]


class PlanQualityChecker:
    def __init__(self, config: QualityCheckerConfig | None = None) -> None:
        self._config = config or QualityCheckerConfig()
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    def check_plan(self, plan: list[dict[str, Any]]) -> PlanQualityResult:
        if not self._enabled:
            return PlanQualityResult(
                quality_score=1.0,
                is_passed=True,
                completeness_score=1.0,
                feasibility_score=1.0,
                issues=[],
            )

        if not plan:
            return PlanQualityResult(
                quality_score=0.0,
                is_passed=False,
                completeness_score=0.0,
                feasibility_score=0.0,
                issues=[QualityIssue(
                    severity="critical",
                    description="计划为空，没有可执行的步骤",
                    suggestion="请添加至少一个执行步骤",
                )],
            )

        issues: list[QualityIssue] = []
        completeness_score = self._check_completeness(plan, issues)
        feasibility_score = self._check_feasibility(plan, issues)

        if self._config.enable_cycle_detection:
            self._check_cycles(plan, issues)

        if self._config.enable_risk_detection:
            self._check_risks(plan, issues)

        penalty = 0.0
        for issue in issues:
            if issue.severity == "critical":
                penalty += 0.3
            elif issue.severity == "warning":
                penalty += 0.1
            else:
                penalty += 0.05

        quality_score = max(0.0, (completeness_score + feasibility_score) / 2 - penalty)
        is_passed = quality_score >= self._config.pass_threshold

        return PlanQualityResult(
            quality_score=quality_score,
            is_passed=is_passed,
            completeness_score=completeness_score,
            feasibility_score=feasibility_score,
            issues=issues,
        )

    def _check_completeness(
        self,
        plan: list[dict[str, Any]],
        issues: list[QualityIssue],
    ) -> float:
        if not plan:
            return 0.0

        total = len(plan)
        with_desc = sum(1 for s in plan if s.get("description", "").strip())
        with_tool = sum(1 for s in plan if s.get("tool", "").strip())

        desc_ratio = with_desc / total
        tool_ratio = with_tool / total

        for s in plan:
            if not s.get("description", "").strip():
                issues.append(QualityIssue(
                    severity="warning",
                    description=f"步骤 {s.get('id', '?')} 缺少描述",
                    step_id=s.get("id", ""),
                    suggestion="为步骤添加描述信息",
                ))
            if not s.get("tool", "").strip():
                issues.append(QualityIssue(
                    severity="warning",
                    description=f"步骤 {s.get('id', '?')} 缺少执行工具",
                    step_id=s.get("id", ""),
                    suggestion="为步骤指定执行工具",
                ))

        return (desc_ratio + tool_ratio) / 2

    def _check_feasibility(
        self,
        plan: list[dict[str, Any]],
        issues: list[QualityIssue],
    ) -> float:
        if not plan:
            return 0.0

        step_ids = {s.get("id", "") for s in plan}
        valid_deps = 0
        total_deps = 0

        for s in plan:
            deps = s.get("dependencies", [])
            for dep in deps:
                total_deps += 1
                if dep in step_ids:
                    valid_deps += 1
                else:
                    issues.append(QualityIssue(
                        severity="warning",
                        description=f"步骤 {s.get('id', '?')} 依赖不存在的步骤 {dep}",
                        step_id=s.get("id", ""),
                        suggestion="检查依赖关系是否正确",
                    ))

        if total_deps == 0:
            return 1.0
        return valid_deps / total_deps

    def _check_cycles(
        self,
        plan: list[dict[str, Any]],
        issues: list[QualityIssue],
    ) -> None:
        adj: dict[str, list[str]] = {}
        for s in plan:
            sid = s.get("id", "")
            adj[sid] = s.get("dependencies", [])

        visited: set[str] = set()
        rec_stack: set[str] = set()

        def dfs(node: str) -> bool:
            visited.add(node)
            rec_stack.add(node)
            for neighbor in adj.get(node, []):
                if neighbor not in visited:
                    if dfs(neighbor):
                        return True
                elif neighbor in rec_stack:
                    return True
            rec_stack.discard(node)
            return False

        for sid in adj:
            if sid not in visited:
                if dfs(sid):
                    issues.append(QualityIssue(
                        severity="critical",
                        description="检测到循环依赖",
                        suggestion="请移除循环依赖关系",
                    ))
                    return

    def _check_risks(
        self,
        plan: list[dict[str, Any]],
        issues: list[QualityIssue],
    ) -> None:
        for s in plan:
            desc = s.get("description", "").lower()
            for kw in _HIGH_RISK_KEYWORDS:
                if kw.lower() in desc:
                    issues.append(QualityIssue(
                        severity="warning",
                        description=f"高风险操作: 步骤 {s.get('id', '?')} 包含'{kw}'",
                        step_id=s.get("id", ""),
                        suggestion="请确认该操作的安全性",
                    ))
                    break

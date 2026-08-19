"""进化与学习子系统。

提供技能管理、安全审计、自进化引擎等核心能力。
"""

from agent.evolution.skill_hub import SkillHub
from agent.evolution.skill_audit import SkillAuditor, RiskLevel
from agent.evolution.feedback_collector import FeedbackCollector
from agent.evolution.llm_capability_detector import (
    LLMCapabilityDetector,
    CapabilityDiff,
    LLMCapabilities,
)
from agent.evolution.capability_evolution_linkage import (
    CapabilityEvolutionLinkage,
    LinkageResult,
    evolution_rollback_handlers,
)
from agent.evolution.cross_session_loop import (
    CrossSessionLoopManager,
    SessionMetrics,
    CrossSessionTrend,
    LoopSnapshot,
    MetricAggregation,
)

__all__ = [
    "SkillHub",
    "SkillAuditor",
    "RiskLevel",
    "FeedbackCollector",
    "LLMCapabilityDetector",
    "CapabilityDiff",
    "LLMCapabilities",
    "CapabilityEvolutionLinkage",
    "LinkageResult",
    "evolution_rollback_handlers",
    "CrossSessionLoopManager",
    "SessionMetrics",
    "CrossSessionTrend",
    "LoopSnapshot",
    "MetricAggregation",
]

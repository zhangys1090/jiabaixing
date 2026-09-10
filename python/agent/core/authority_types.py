"""
D4 Authority — Python 侧 Authority 实现

与 TS 侧 authority 模块共享语义契约：
  - Goal: stable identity, plan versioned, evidence-based progress
  - CanonicalDecisionSnapshot: read model, activeGoalIds[]
  - Decision: proposer/authority separation, full audit trail
  - Evidence: outcome bridge

Python 侧独立实现，不依赖 TS bridge 调用。
ID 生成格式与 TS 侧一致，确保跨语言 trace 关联。
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class GoalStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


class GoalPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class Goal:
    goalId: str
    description: str
    originalInput: str
    status: GoalStatus = GoalStatus.ACTIVE
    priority: GoalPriority = GoalPriority.MEDIUM
    progress: float = 0.0
    parentGoalId: str | None = None
    createdAt: float = field(default_factory=time.time)
    updatedAt: float = field(default_factory=time.time)
    successCondition: str = ""
    abandonmentCondition: str = ""
    currentStage: str = "created"
    planVersion: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class GoalEvidence:
    evidenceId: str
    goalId: str
    decisionId: str
    observation: Any = None
    actionName: str = ""
    actionParams: dict[str, Any] = field(default_factory=dict)
    expectedEffect: str = ""
    actualEffect: str = ""
    progressDelta: float = 0.0
    timestamp: float = field(default_factory=time.time)


@dataclass
class GoalStatusEvaluation:
    status: GoalStatus
    reason: str


@dataclass
class SelfView:
    agentId: str
    activeGoalIds: list[str] = field(default_factory=list)
    currentStage: str = "unknown"
    safetyStatus: str = "nominal"


@dataclass
class WorldView:
    observation: Any = None
    platform: str = "desktop"
    timestamp: float = field(default_factory=time.time)


@dataclass
class MemoryView:
    relevantMemories: list[dict[str, Any]] = field(default_factory=list)
    query: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class ContextView:
    systemPrompt: str = ""
    conversationHistory: list[dict[str, Any]] = field(default_factory=list)
    fileContexts: list[str] = field(default_factory=list)
    personaSummary: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class CapabilitySet:
    availableTools: list[str] = field(default_factory=list)
    availableSkills: list[str] = field(default_factory=list)
    desktopAvailable: bool = False
    bridgeAvailable: bool = False


@dataclass
class CanonicalDecisionSnapshot:
    snapshotId: str
    timestamp: float
    activeGoalIds: list[str]
    self: SelfView
    world: WorldView
    memory: MemoryView
    context: ContextView
    capabilities: CapabilitySet


@dataclass
class ProposedAction:
    type: str
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class DecisionCandidate:
    candidateId: str
    proposerId: str
    action: ProposedAction
    confidence: float
    reasoning: str = ""
    estimatedGoalProgress: float = 0.0


@dataclass
class Decision:
    decisionId: str
    goalId: str
    snapshotId: str
    candidateIds: list[str]
    chosenCandidateId: str
    chosen: DecisionCandidate
    acceptedCandidates: list[DecisionCandidate] = field(default_factory=list)
    rejectedCandidates: list[DecisionCandidate] = field(default_factory=list)
    selectionReason: str = ""
    proposerSet: list[str] = field(default_factory=list)
    vetoReason: str | None = None
    timestamp: float = field(default_factory=time.time)


class DecisionProposer(Protocol):
    proposerId: str

    async def propose(
        self,
        goal: Goal,
        snapshot: CanonicalDecisionSnapshot,
    ) -> list[DecisionCandidate]: ...


@dataclass
class DecisionContext:
    goalId: str
    snapshot: CanonicalDecisionSnapshot
    candidates: list[DecisionCandidate]

"""
D4 StateAuthority — Python 侧实现

职责：
  ✅ captureSnapshot() → CanonicalDecisionSnapshot（只读、冻结、标识）
  ✅ 通过 StateReadProviders 读取各域 owner 的 state
  ❌ 不拥有底层 state
  ❌ 不写入任何 state
  ❌ 不做决策
"""
from __future__ import annotations

import time
from typing import Any, Callable, Coroutine, Protocol

from agent.core.authority_types import (
    CanonicalDecisionSnapshot,
    CapabilitySet,
    ContextView,
    MemoryView,
    SelfView,
    WorldView,
    _gen_id,
)
from agent.core.goal_authority import GoalAuthority


class StateReadProviders(Protocol):
    def getAgentId(self) -> str: ...
    def getSafetyStatus(self) -> str: ...
    async def readWorldState(self) -> WorldView: ...
    async def readMemory(self, query: str) -> MemoryView: ...
    async def readContext(self, goalIds: list[str]) -> ContextView: ...
    async def readCapabilities(self) -> CapabilitySet: ...


class StateAuthority:
    _instance: StateAuthority | None = None

    @classmethod
    def getInstance(cls) -> StateAuthority:
        if cls._instance is None:
            cls._instance = StateAuthority()
        return cls._instance

    @classmethod
    def resetInstance(cls) -> None:
        cls._instance = None

    def __init__(self) -> None:
        self._providers: StateReadProviders | None = None
        self._memory_provider: Callable[[str], Any] | None = None
        self._latest_snapshot: CanonicalDecisionSnapshot | None = None

    def registerProviders(self, providers: StateReadProviders) -> None:
        self._providers = providers

    def registerMemoryProvider(
        self, read_memory: Callable[[str], Any]
    ) -> None:
        """D6: 独立注册 readMemory（coroutine(query)->MemoryView）。

        允许在全量 StateReadProviders 就绪前，先接通"检索服务 Decision"
        （D6 验收②）。幂等，后注册覆盖前者。
        """
        self._memory_provider = read_memory

    async def captureSnapshot(
        self,
        activeGoalIds: list[str] | None = None,
    ) -> CanonicalDecisionSnapshot:
        goalAuth = GoalAuthority.getInstance()

        if activeGoalIds is not None:
            goals = [g for gid in activeGoalIds if (g := goalAuth.getGoal(gid)) is not None]
        else:
            goals = goalAuth.getActiveGoals()

        resolvedGoalIds = [g.goalId for g in goals]
        primaryDescription = goals[0].description if goals else ""

        # D6: 无全量 providers 时，独立记忆 provider 仍可服务 Decision（验收②）
        if self._providers is None:
            memory = MemoryView(query=primaryDescription)
            if self._memory_provider is not None and primaryDescription:
                try:
                    memory = await self._memory_provider(primaryDescription)
                except Exception:
                    memory = MemoryView(query=primaryDescription)

            snapshot = CanonicalDecisionSnapshot(
                snapshotId=_gen_id("SS"),
                timestamp=time.time(),
                activeGoalIds=resolvedGoalIds,
                self=SelfView(
                    agentId="python-agent",
                    activeGoalIds=resolvedGoalIds,
                    currentStage=goals[0].currentStage if goals else "unknown",
                    safetyStatus="nominal",
                ),
                world=WorldView(),
                memory=memory,
                context=ContextView(),
                capabilities=CapabilitySet(),
            )
            self._latest_snapshot = snapshot
            return snapshot

        providers = self._providers
        try:
            world = await providers.readWorldState()
        except Exception:
            world = WorldView()

        try:
            memory = await providers.readMemory(primaryDescription)
        except Exception:
            memory = MemoryView(query=primaryDescription)

        try:
            context = await providers.readContext(resolvedGoalIds)
        except Exception:
            context = ContextView()

        try:
            capabilities = await providers.readCapabilities()
        except Exception:
            capabilities = CapabilitySet()

        self_view = SelfView(
            agentId=providers.getAgentId(),
            activeGoalIds=resolvedGoalIds,
            currentStage=goals[0].currentStage if goals else "unknown",
            safetyStatus=providers.getSafetyStatus(),
        )

        snapshot = CanonicalDecisionSnapshot(
            snapshotId=_gen_id("SS"),
            timestamp=time.time(),
            activeGoalIds=resolvedGoalIds,
            self=self_view,
            world=world,
            memory=memory,
            context=context,
            capabilities=capabilities,
        )
        self._latest_snapshot = snapshot
        return snapshot

    def getLatestSnapshot(self) -> CanonicalDecisionSnapshot | None:
        return self._latest_snapshot

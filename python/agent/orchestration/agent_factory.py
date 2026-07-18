from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("agent_factory")


class AgentScene(str, Enum):
    """Agent工作场景枚举。

    定义Agent可处理的领域场景，用于场景检测和Agent分配。
    """

    CODING = "coding"
    FILE = "file"
    DESKTOP = "desktop"
    MEMORY = "memory"
    NETWORK = "network"


_SCENE_KEYWORDS: dict[AgentScene, list[str]] = {
    AgentScene.CODING: [
        "代码", "编程", "编译", "重构", "debug", "bug", "测试",
        "接口", "API", "函数", "类", "模块", "review", "修复",
        "生成代码", "分析代码", "code", "python", "typescript",
    ],
    AgentScene.FILE: [
        "文件", "目录", "文件夹", "打开", "搜索", "查找",
        "读", "写", "创建", "删除", "编辑", "列表", "grep",
        "file", "directory", "folder",
    ],
    AgentScene.DESKTOP: [
        "桌面", "截图", "点击", "窗口", "应用", "程序",
        "自动化", "屏幕", "鼠标", "键盘", "desktop", "screenshot",
    ],
    AgentScene.MEMORY: [
        "记忆", "记住", "回忆", "存储", "检索", "遗忘",
        "偏好", "习惯", "知识库", "memory", "recall",
    ],
    AgentScene.NETWORK: [
        "网络", "请求", "下载", "上传", "API调用", "HTTP",
        "爬虫", "抓取", "network", "request", "fetch",
    ],
}


@dataclass
class AgentCapability:
    """Agent能力描述。

    Attributes:
        scene: 所属场景。
        name: 能力名称。
        description: 能力描述。
        tools: 关联的工具列表。
        priority: 优先级（数值越大越优先）。
    """

    scene: AgentScene
    name: str
    description: str = ""
    tools: list[str] = field(default_factory=list)
    priority: int = 0


@dataclass
class AgentConfig:
    """Agent配置。

    Attributes:
        scene: 工作场景。
        name: Agent名称。
        description: 描述。
        max_concurrent_tasks: 最大并发任务数。
        timeout_ms: 任务超时（毫秒）。
        capabilities: 能力列表。
    """

    scene: AgentScene
    name: str = ""
    description: str = ""
    max_concurrent_tasks: int = 3
    timeout_ms: int = 60000
    capabilities: list[AgentCapability] = field(default_factory=list)


class AgentExecutor(Protocol):
    """Agent执行器协议——定义Agent执行任务的标准接口。

    实现者需提供execute方法，接收任务描述和上下文，返回执行结果。
    """

    async def execute(self, task: str, context: dict[str, Any] | None = None) -> Any: ...


class BaseAgent:
    """基础Agent——封装Agent配置、执行和统计。

    管理任务执行生命周期，追踪任务计数、成功率和平均耗时。

    Usage:
        config = AgentConfig(scene=AgentScene.CODING)
        agent = BaseAgent(config, executor=my_executor)
        result = await agent.execute("写一个排序函数")
        stats = agent.get_stats()
    """
    def __init__(self, config: AgentConfig, executor: AgentExecutor | None = None) -> None:
        self.config = config
        self._executor = executor
        self._task_count = 0
        self._success_count = 0
        self._failure_count = 0
        self._total_duration_ms = 0.0

    @property
    def name(self) -> str:
        return self.config.name or self.config.scene.value

    @property
    def scene(self) -> AgentScene:
        return self.config.scene

    async def execute(self, task: str, context: dict[str, Any] | None = None) -> Any:
        start = time.time()
        self._task_count += 1
        try:
            if self._executor:
                result = await self._executor.execute(task, context)
            else:
                result = {"task": task, "agent": self.name, "status": "completed"}
            self._success_count += 1
            self._total_duration_ms += (time.time() - start) * 1000
            return result
        except Exception as e:
            self._failure_count += 1
            self._total_duration_ms += (time.time() - start) * 1000
            raise

    def get_stats(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "scene": self.config.scene.value,
            "task_count": self._task_count,
            "success_count": self._success_count,
            "failure_count": self._failure_count,
            "success_rate": self._success_count / self._task_count if self._task_count > 0 else 0.0,
            "avg_duration_ms": self._total_duration_ms / self._task_count if self._task_count > 0 else 0.0,
        }


class AgentFactory:
    """Agent工厂——创建、管理和缓存Agent实例。

    单例模式，支持按场景创建Agent、注册执行器，以及按关键词检测场景。
    缓存已创建的Agent实例，避免重复创建。

    Usage:
        factory = AgentFactory.get_instance()
        factory.register_executor(AgentScene.CODING, my_executor)
        agent = factory.create_agent(AgentScene.CODING)
        scene = factory.detect_scene("帮我写一个Python脚本")
    """
    _instance: AgentFactory | None = None
    _cache: dict[str, BaseAgent] = {}

    def __init__(self) -> None:
        self._agents: dict[str, BaseAgent] = {}
        self._executors: dict[AgentScene, AgentExecutor] = {}

    @classmethod
    def get_instance(cls) -> AgentFactory:
        if cls._instance is None:
            cls._instance = AgentFactory()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None
        cls._cache.clear()

    def register_executor(self, scene: AgentScene, executor: AgentExecutor) -> None:
        self._executors[scene] = executor

    def create_agent(self, scene: AgentScene, name: str = "", executor: AgentExecutor | None = None) -> BaseAgent:
        cache_key = f"{scene.value}_{name}"
        if cache_key in self._agents:
            return self._agents[cache_key]

        config = AgentConfig(
            scene=scene,
            name=name or scene.value,
            capabilities=[AgentCapability(scene=scene, name=f"{scene.value}_default")],
        )

        agent_executor = executor or self._executors.get(scene)
        agent = BaseAgent(config=config, executor=agent_executor)
        self._agents[cache_key] = agent
        log.info("Agent created", name=agent.name, scene=scene.value)
        return agent

    def create_all_agents(self) -> list[BaseAgent]:
        return [self.create_agent(scene) for scene in AgentScene]

    def select_agent_by_goal(self, goal: str) -> BaseAgent:
        lower_goal = goal.lower()

        for scene in AgentScene:
            keywords = _SCENE_KEYWORDS.get(scene, [])
            if any(kw.lower() in lower_goal for kw in keywords):
                log.info("Goal matched scene", scene=scene.value, goal=goal[:50])
                return self.create_agent(scene)

        log.info("Goal unmatched, using default coding agent")
        return self.create_agent(AgentScene.CODING)

    def get_agent(self, name: str) -> BaseAgent | None:
        return self._agents.get(name)

    def get_all_agents(self) -> list[BaseAgent]:
        return list(self._agents.values())

    def clear(self) -> None:
        self._agents.clear()


@dataclass
class SubTaskResult:
    task_id: str
    agent_name: str
    success: bool
    result: Any = None
    error: str | None = None
    duration_ms: float = 0.0


@dataclass
class AggregatedResult:
    success: bool
    summary: str = ""
    total_tasks: int = 0
    completed_tasks: int = 0
    failed_tasks: int = 0
    duration_ms: float = 0.0
    sub_results: list[SubTaskResult] = field(default_factory=list)
    quality_score: float = 0.0
    conflicts: list[str] = field(default_factory=list)


@dataclass
class TaskComplexity:
    complexity: str = "simple"
    estimated_steps: int = 1
    parallelizable: bool = False
    recommended_agents: int = 1


class TaskComplexityAnalyzer:
    _COMPLEXITY_KEYWORDS: dict[str, list[str]] = {
        "very_complex": ["同时", "并行", "多个", "综合", "端到端", "全栈", "架构"],
        "complex": ["拆解", "分析", "对比", "整合", "重构", "迁移", "优化"],
        "medium": ["修改", "添加", "创建", "实现", "编写", "搜索"],
    }

    def analyze(self, goal: str) -> TaskComplexity:
        complexity = "simple"
        estimated_steps = 1
        parallelizable = False

        for level, keywords in self._COMPLEXITY_KEYWORDS.items():
            if any(kw in goal for kw in keywords):
                complexity = level
                break

        if complexity == "very_complex":
            estimated_steps = 5
            parallelizable = True
        elif complexity == "complex":
            estimated_steps = 3
            parallelizable = True
        elif complexity == "medium":
            estimated_steps = 2

        recommended = min(estimated_steps, 5) if parallelizable else 1

        return TaskComplexity(
            complexity=complexity,
            estimated_steps=estimated_steps,
            parallelizable=parallelizable,
            recommended_agents=recommended,
        )


class MultiAgentOrchestrator:
    def __init__(self, factory: AgentFactory | None = None, llm: Any | None = None) -> None:
        self._factory = factory or AgentFactory.get_instance()
        self._complexity_analyzer = TaskComplexityAnalyzer()
        self._history: list[AggregatedResult] = []
        self._llm = llm

    async def process_goal(self, goal: str, context: dict[str, Any] | None = None) -> AggregatedResult:
        start = time.time()
        log.info("Processing goal", goal=goal[:80])

        complexity = self._complexity_analyzer.analyze(goal)
        log.info(
            "Complexity analyzed",
            level=complexity.complexity,
            steps=complexity.estimated_steps,
            parallelizable=complexity.parallelizable,
        )

        if not complexity.parallelizable or complexity.recommended_agents <= 1:
            return await self._process_simple(goal, context, start)

        return await self._process_complex(goal, context, complexity, start)

    async def _process_simple(
        self,
        goal: str,
        context: dict[str, Any] | None,
        start: float,
    ) -> AggregatedResult:
        agent = self._factory.select_agent_by_goal(goal)
        try:
            result = await agent.execute(goal, context)
            duration = (time.time() - start) * 1000
            aggregated = AggregatedResult(
                success=True,
                summary=f"目标完成: {goal[:60]}",
                total_tasks=1,
                completed_tasks=1,
                failed_tasks=0,
                duration_ms=duration,
                sub_results=[
                    SubTaskResult(
                        task_id=f"task_{uuid.uuid4().hex[:8]}",
                        agent_name=agent.name,
                        success=True,
                        result=result,
                        duration_ms=duration,
                    )
                ],
            )
        except Exception as e:
            duration = (time.time() - start) * 1000
            aggregated = AggregatedResult(
                success=False,
                summary=f"目标失败: {str(e)[:60]}",
                total_tasks=1,
                completed_tasks=0,
                failed_tasks=1,
                duration_ms=duration,
                sub_results=[
                    SubTaskResult(
                        task_id=f"task_{uuid.uuid4().hex[:8]}",
                        agent_name=agent.name,
                        success=False,
                        error=str(e),
                        duration_ms=duration,
                    )
                ],
            )

        self._history.append(aggregated)
        return aggregated

    async def _process_complex(
        self,
        goal: str,
        context: dict[str, Any] | None,
        complexity: TaskComplexity,
        start: float,
    ) -> AggregatedResult:
        import asyncio

        sub_goals = await self._decompose_goal_semantic(goal, complexity, self._llm)
        agents = [self._factory.select_agent_by_goal(sg) for sg in sub_goals]

        tasks = []
        for i, (sub_goal, agent) in enumerate(zip(sub_goals, agents)):
            tasks.append(self._execute_sub_task(i, sub_goal, agent, context))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        sub_results: list[SubTaskResult] = []
        completed = 0
        failed = 0

        for i, r in enumerate(results):
            if isinstance(r, Exception):
                sub_results.append(SubTaskResult(
                    task_id=f"task_{i}",
                    agent_name=agents[i].name if i < len(agents) else "unknown",
                    success=False,
                    error=str(r),
                ))
                failed += 1
            else:
                sub_results.append(r)
                if r.success:
                    completed += 1
                else:
                    failed += 1

        duration = (time.time() - start) * 1000
        aggregated = AggregatedResult(
            success=failed == 0,
            summary=f"目标{'完成' if failed == 0 else '部分完成'}: {goal[:60]}",
            total_tasks=len(sub_goals),
            completed_tasks=completed,
            failed_tasks=failed,
            duration_ms=duration,
            sub_results=sub_results,
        )

        self._history.append(aggregated)
        return aggregated

    async def _execute_sub_task(
        self,
        index: int,
        goal: str,
        agent: BaseAgent,
        context: dict[str, Any] | None,
    ) -> SubTaskResult:
        task_start = time.time()
        try:
            result = await agent.execute(goal, context)
            return SubTaskResult(
                task_id=f"task_{index}",
                agent_name=agent.name,
                success=True,
                result=result,
                duration_ms=(time.time() - task_start) * 1000,
            )
        except Exception as e:
            return SubTaskResult(
                task_id=f"task_{index}",
                agent_name=agent.name,
                success=False,
                error=str(e),
                duration_ms=(time.time() - task_start) * 1000,
            )

    def _decompose_goal(self, goal: str, complexity: TaskComplexity) -> list[str]:
        parts = [p.strip() for p in goal.replace("并且", "，").replace("然后", "，").replace("同时", "，").split("，") if p.strip()]
        if not parts:
            parts = [goal]
        while len(parts) < complexity.recommended_agents and parts:
            parts.append(parts[-1])
        return parts[:complexity.recommended_agents]

    async def _decompose_goal_semantic(
        self,
        goal: str,
        complexity: TaskComplexity,
        llm: Any | None = None,
    ) -> list[str]:
        """语义化目标分解: 使用 LLM 将复杂目标分解为独立子任务。

        当 LLM 不可用时，回退到关键词分割。

        Args:
            goal: 原始目标。
            complexity: 复杂度分析结果。
            llm: 可选的 LLM 提供者。

        Returns:
            子目标列表。
        """
        if not llm:
            return self._decompose_goal(goal, complexity)

        try:
            prompt = (
                "将以下任务分解为独立的子任务，每行一个子任务。\n"
                "要求:\n"
                "1. 每个子任务应该是可独立执行的\n"
                "2. 子任务之间尽量减少依赖\n"
                f"3. 最多分解为 {complexity.recommended_agents} 个子任务\n"
                "4. 只输出子任务，不要编号和额外说明\n\n"
                f"原始任务: {goal}"
            )
            result = await llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=True,
            )
            content = result.get("content", "")
            sub_goals = [
                line.strip().lstrip("0123456789.-) ")
                for line in content.strip().split("\n")
                if line.strip()
            ]
            if sub_goals:
                return sub_goals[:complexity.recommended_agents]
        except Exception as e:
            log.warning("Semantic decomposition failed, falling back to keyword", error=str(e))

        return self._decompose_goal(goal, complexity)

    async def process_goal_with_loop(
        self,
        goal: str,
        context: dict[str, Any] | None = None,
        loop_controller: Any | None = None,
    ) -> AggregatedResult:
        """使用 LoopController 执行目标，打通编排层与执行层。

        当提供 loop_controller 时，直接调用 LoopController.run() 执行任务，
        而非通过简单的 BaseAgent.execute()。

        Args:
            goal: 用户目标。
            context: 上下文。
            loop_controller: LoopController 实例。

        Returns:
            AggregatedResult: 聚合结果。
        """
        import time as _t

        start = _t.time()

        if not loop_controller:
            return await self.process_goal(goal, context)

        complexity = self._complexity_analyzer.analyze(goal)

        if not complexity.parallelizable or complexity.recommended_agents <= 1:
            try:
                from agent.loop.types import AgentResult as LoopAgentResult
                result = await loop_controller.run(goal, session_id=f"orch-{uuid.uuid4().hex[:8]}")
                duration = (_t.time() - start) * 1000
                return AggregatedResult(
                    success=result.success,
                    summary=result.response[:200] if result.response else "",
                    total_tasks=1,
                    completed_tasks=1 if result.success else 0,
                    failed_tasks=0 if result.success else 1,
                    duration_ms=duration,
                    sub_results=[
                        SubTaskResult(
                            task_id=f"task_{uuid.uuid4().hex[:8]}",
                            agent_name="loop_controller",
                            success=result.success,
                            result=result.response,
                            duration_ms=duration,
                        )
                    ],
                    quality_score=result.quality_score if hasattr(result, 'quality_score') else 0.0,
                )
            except Exception as e:
                duration = (_t.time() - start) * 1000
                return AggregatedResult(
                    success=False,
                    summary=f"执行失败: {str(e)[:100]}",
                    total_tasks=1,
                    completed_tasks=0,
                    failed_tasks=1,
                    duration_ms=duration,
                    sub_results=[
                        SubTaskResult(
                            task_id=f"task_{uuid.uuid4().hex[:8]}",
                            agent_name="loop_controller",
                            success=False,
                            error=str(e),
                            duration_ms=duration,
                        )
                    ],
                )

        sub_goals = await self._decompose_goal_semantic(
            goal, complexity,
            llm=getattr(loop_controller, 'llm', None),
        )

        import asyncio
        tasks = []
        for i, sub_goal in enumerate(sub_goals):
            tasks.append(self._execute_sub_task_with_loop(
                i, sub_goal, loop_controller, context,
            ))
        results = await asyncio.gather(*tasks, return_exceptions=True)

        sub_results: list[SubTaskResult] = []
        completed = 0
        failed = 0

        for i, r in enumerate(results):
            if isinstance(r, Exception):
                sub_results.append(SubTaskResult(
                    task_id=f"task_{i}",
                    agent_name="loop_controller",
                    success=False,
                    error=str(r),
                ))
                failed += 1
            else:
                sub_results.append(r)
                if r.success:
                    completed += 1
                else:
                    failed += 1

        duration = (_t.time() - start) * 1000
        aggregated = AggregatedResult(
            success=failed == 0,
            summary=f"目标{'完成' if failed == 0 else '部分完成'}: {goal[:60]}",
            total_tasks=len(sub_goals),
            completed_tasks=completed,
            failed_tasks=failed,
            duration_ms=duration,
            sub_results=sub_results,
        )
        self._history.append(aggregated)
        return aggregated

    async def _execute_sub_task_with_loop(
        self,
        index: int,
        goal: str,
        loop_controller: Any,
        context: dict[str, Any] | None,
    ) -> SubTaskResult:
        """使用 LoopController 执行子任务。"""
        import time as _t

        task_start = _t.time()
        try:
            result = await loop_controller.run(
                goal,
                session_id=f"orch-sub-{index}-{uuid.uuid4().hex[:6]}",
            )
            return SubTaskResult(
                task_id=f"task_{index}",
                agent_name="loop_controller",
                success=result.success,
                result=result.response,
                duration_ms=(_t.time() - task_start) * 1000,
            )
        except Exception as e:
            return SubTaskResult(
                task_id=f"task_{index}",
                agent_name="loop_controller",
                success=False,
                error=str(e),
                duration_ms=(_t.time() - task_start) * 1000,
            )

    def get_history(self, limit: int = 50) -> list[AggregatedResult]:
        return self._history[-limit:]

    def get_stats(self) -> dict[str, Any]:
        if not self._history:
            return {"total_goals": 0, "success_rate": 0.0, "avg_duration_ms": 0.0}

        total = len(self._history)
        successes = sum(1 for r in self._history if r.success)
        avg_duration = sum(r.duration_ms for r in self._history) / total

        return {
            "total_goals": total,
            "success_rate": successes / total,
            "avg_duration_ms": avg_duration,
        }


class AgentRegistry:
    """Agent注册中心——管理Agent的注册、发现、状态跟踪和健康检查。

    单例模式，支持按名称、场景和能力匹配查找Agent。
    追踪每个Agent的运行状态（idle/busy/error），提供健康检查。

    Usage:
        registry = AgentRegistry.get_instance()
        registry.register("code_agent", agent, scene=AgentScene.CODING)
        agent = registry.find_by_capability("代码生成")
        status = registry.get_status("code_agent")
    """

    _instance: AgentRegistry | None = None

    def __init__(self) -> None:
        self._agents: dict[str, BaseAgent] = {}
        self._agent_scenes: dict[str, AgentScene] = {}
        self._agent_states: dict[str, str] = {}
        self._agent_health: dict[str, dict[str, Any]] = {}

    @classmethod
    def get_instance(cls) -> AgentRegistry:
        if cls._instance is None:
            cls._instance = AgentRegistry()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def register(
        self,
        name: str,
        agent: BaseAgent,
        scene: AgentScene | None = None,
    ) -> None:
        """注册Agent到注册中心。

        Args:
            name: Agent名称。
            agent: Agent实例。
            scene: 所属场景，None则从agent.config读取。
        """
        self._agents[name] = agent
        self._agent_scenes[name] = scene or agent.config.scene
        self._agent_states[name] = "idle"
        self._agent_health[name] = {
            "last_check": time.time(),
            "status": "healthy",
            "error_count": 0,
        }

    def unregister(self, name: str) -> bool:
        """注销Agent。

        Args:
            name: Agent名称。

        Returns:
            bool: 是否成功注销。
        """
        self._agents.pop(name, None)
        self._agent_scenes.pop(name, None)
        self._agent_states.pop(name, None)
        self._agent_health.pop(name, None)
        return True

    def get(self, name: str) -> BaseAgent | None:
        """按名称获取Agent。

        Args:
            name: Agent名称。

        Returns:
            BaseAgent | None: Agent实例或None。
        """
        return self._agents.get(name)

    def get_by_scene(self, scene: AgentScene) -> list[BaseAgent]:
        """按场景获取所有Agent。

        Args:
            scene: 场景枚举。

        Returns:
            list[BaseAgent]: 匹配的Agent列表。
        """
        return [
            agent
            for name, agent in self._agents.items()
            if self._agent_scenes.get(name) == scene
        ]

    def find_by_capability(self, capability: str, threshold: float = 0.5) -> BaseAgent | None:
        """按能力描述匹配Agent。

        Args:
            capability: 能力描述关键词。
            threshold: 匹配阈值（0-1），越高越严格。

        Returns:
            BaseAgent | None: 最佳匹配的Agent或None。
        """
        low = capability.lower()
        best: tuple[BaseAgent, float] | None = None

        for name, agent in self._agents.items():
            score = 0.0
            for cap in agent.config.capabilities:
                if cap.name.lower() in low or low in cap.name.lower():
                    score = max(score, 0.9)
                if cap.description and (
                    low in cap.description.lower() or cap.description.lower() in low
                ):
                    score = max(score, 0.7)
            if score >= threshold and (best is None or score > best[1]):
                best = (agent, score)

        return best[0] if best else None

    def set_state(self, name: str, state: str) -> None:
        """设置Agent运行状态。

        Args:
            name: Agent名称。
            state: 状态（idle/busy/error）。
        """
        if name in self._agent_states:
            self._agent_states[name] = state

    def get_state(self, name: str) -> str:
        """获取Agent运行状态。

        Args:
            name: Agent名称。

        Returns:
            str: 状态字符串。
        """
        return self._agent_states.get(name, "unknown")

    def get_status(self, name: str) -> dict[str, Any]:
        """获取Agent完整状态信息。

        Args:
            name: Agent名称。

        Returns:
            dict: 包含状态、健康、统计等信息。
        """
        agent = self._agents.get(name)
        if not agent:
            return {"name": name, "status": "not_found"}

        return {
            "name": name,
            "scene": self._agent_scenes.get(name, AgentScene.CODING).value,
            "state": self._agent_states.get(name, "unknown"),
            "health": self._agent_health.get(name, {}),
            "stats": agent.get_stats(),
        }

    def get_all_status(self) -> dict[str, dict[str, Any]]:
        """获取所有Agent的状态。

        Returns:
            dict: {name: status_dict}。
        """
        return {name: self.get_status(name) for name in self._agents}

    def get_idle_agents(self) -> list[BaseAgent]:
        """获取所有空闲Agent。

        Returns:
            list[BaseAgent]: 空闲Agent列表。
        """
        return [
            agent
            for name, agent in self._agents.items()
            if self._agent_states.get(name) == "idle"
        ]

    def check_health(self, name: str) -> bool:
        """检查Agent健康状态。

        Args:
            name: Agent名称。

        Returns:
            bool: 是否健康。
        """
        if name not in self._agents:
            return False
        health = self._agent_health.get(name, {})
        health["last_check"] = time.time()
        return health.get("status") == "healthy"

    def report_error(self, name: str) -> None:
        """报告Agent错误。

        Args:
            name: Agent名称。
        """
        if name in self._agent_health:
            self._agent_health[name]["error_count"] += 1
            self._agent_states[name] = "error"
            if self._agent_health[name]["error_count"] >= 3:
                self._agent_health[name]["status"] = "unhealthy"

    def report_recovery(self, name: str) -> None:
        """报告Agent恢复。

        Args:
            name: Agent名称。
        """
        if name in self._agent_health:
            self._agent_health[name]["error_count"] = 0
            self._agent_health[name]["status"] = "healthy"
            self._agent_states[name] = "idle"

    def get_agent_count(self) -> int:
        """获取注册的Agent总数。

        Returns:
            int: Agent数量。
        """
        return len(self._agents)


class OrchestratorAgent:
    """顶层协调Agent——目标拆解、Agent分配、扇出执行和结果聚合。

    整合目标分解、Agent选择、SubAgentFanout和ResultAggregator，
    提供完整的多Agent协调工作流：分析 → 拆解 → 分配 → 执行 → 聚合 → 重规划。

    支持 A2A 协议远程 Agent 发现：当本地 AgentRegistry 无合适 Agent 时，
    通过 A2AClient 主动发现远程 Agent 并委派任务，遵循"本地优先"策略。

    Usage:
        orchestrator = OrchestratorAgent(
            registry=registry,
            agent_factory=factory,
            a2a_manager=a2a_manager,
            a2a_remote_endpoints=["http://remote:8765"],
            self_agent_id="agent:jiabaixing",
        )
        result = await orchestrator.orchestrate("重构整个项目")
        print(f"成功: {result.success}, 耗时: {result.duration_ms}ms")
    """

    def __init__(
        self,
        registry: AgentRegistry | None = None,
        agent_factory: AgentFactory | None = None,
        max_retries: int = 2,
        a2a_manager: Any | None = None,
        a2a_remote_endpoints: list[str] | None = None,
        self_agent_id: str = "agent:jiabaixing",
        a2a_poll_interval_seconds: float = 0.5,
        a2a_task_timeout_seconds: float = 30.0,
        a2a_auth_interceptor: Any | None = None,
    ) -> None:
        """初始化顶层协调 Agent.

        Args:
            registry: 本地 Agent 注册中心. None 则使用全局单例.
            agent_factory: Agent 工厂. None 则使用全局单例.
            max_retries: 失败重试次数.
            a2a_manager: A2A 协议管理器，用于本地 Task 状态管理. None 则不启用 A2A.
            a2a_remote_endpoints: 远程 A2A Agent 端点 URL 列表，用于主动发现远程 Agent.
            self_agent_id: 本机 Agent ID，作为 A2A Task 的 from_agent_id.
            a2a_poll_interval_seconds: A2A 远程 Task 状态轮询间隔（秒）.
            a2a_task_timeout_seconds: A2A 远程 Task 总超时（秒）.
            a2a_auth_interceptor: A2A 出站鉴权拦截器，注入到 A2AClient 用于出站凭据注入.
        """
        self._registry = registry or AgentRegistry.get_instance()
        self._agent_factory = agent_factory or AgentFactory.get_instance()
        self._max_retries = max_retries
        self._complexity_analyzer = TaskComplexityAnalyzer()
        self._aggregator: Any = None
        # A2A 远程发现能力
        self._a2a_manager = a2a_manager
        self._a2a_remote_endpoints = list(a2a_remote_endpoints or [])
        self._self_agent_id = self_agent_id
        self._a2a_poll_interval = max(0.05, a2a_poll_interval_seconds)
        self._a2a_task_timeout = max(1.0, a2a_task_timeout_seconds)
        self._a2a_auth_interceptor = a2a_auth_interceptor

    def _get_aggregator(self) -> Any:
        if self._aggregator is None:
            from agent.orchestration.result_aggregator import ResultAggregator
            self._aggregator = ResultAggregator()
        return self._aggregator

    def _a2a_enabled(self) -> bool:
        """判断 A2A 远程发现能力是否启用.

        Returns:
            bool: 启用返回 True.
        """
        return bool(self._a2a_remote_endpoints)

    async def _delegate_via_a2a(self, goal: str) -> dict[str, Any] | None:
        """通过 A2A 协议委派任务给远程 Agent.

        遍历远程端点列表，按 task-execution 能力发现远程 Agent，
        找到后调用 create_task 委派任务并轮询直到完成或超时。

        Args:
            goal: 任务描述.

        Returns:
            dict | None: 远程执行结果，无可用远程 Agent 或超时返回 None.
        """
        if not self._a2a_enabled():
            return None

        # 延迟导入，避免模块加载循环
        from agent.a2a import A2AClient, A2ACapabilityType, A2ATaskStatus

        for endpoint in self._a2a_remote_endpoints:
            client = A2AClient(
                endpoint,
                auth_interceptor=self._a2a_auth_interceptor,
            )
            try:
                # 1. 发现远程 Agent — 按 task-execution 能力筛选
                remote_agents = await client.discover_agents(
                    capability=A2ACapabilityType.TASK_EXECUTION
                )
                if not remote_agents:
                    continue

                remote_agent = remote_agents[0]

                # 将发现的远程 Agent Card 设置为 target_card，用于后续出站鉴权头注入
                client.set_target_card(remote_agent)

                # 2. 创建委派 Task
                task = await client.create_task(
                    from_agent_id=self._self_agent_id,
                    to_agent_id=remote_agent.id,
                    description=goal,
                    input_data={"source": "orchestrator_a2a_fallback"},
                )
                if task is None:
                    continue

                # 3. 轮询 Task 状态直到终态或超时
                import asyncio as _asyncio
                elapsed = 0.0
                while elapsed < self._a2a_task_timeout:
                    await _asyncio.sleep(self._a2a_poll_interval)
                    elapsed += self._a2a_poll_interval
                    current = await client.get_task(task.id)
                    if current is None:
                        break
                    if current.status == A2ATaskStatus.COMPLETED:
                        return {
                            "goal": goal,
                            "status": "completed",
                            "via": "a2a",
                            "remote_agent": remote_agent.id,
                            "remote_endpoint": endpoint,
                            "output": current.output,
                        }
                    if current.status in (A2ATaskStatus.FAILED, A2ATaskStatus.CANCELLED):
                        return {
                            "goal": goal,
                            "status": "failed",
                            "via": "a2a",
                            "remote_agent": remote_agent.id,
                            "error": current.error or f"remote task {current.status.value}",
                        }
                # 超时
                return {
                    "goal": goal,
                    "status": "timeout",
                    "via": "a2a",
                    "remote_agent": remote_agent.id,
                    "error": f"a2a task timeout after {self._a2a_task_timeout}s",
                }
            except Exception as e:
                log.warning("A2A delegation failed", endpoint=endpoint, error=str(e))
                continue
            finally:
                await client.close()

        return None

    async def orchestrate(
        self,
        goal: str,
        context: dict[str, Any] | None = None,
        strategy: str | None = None,
    ) -> AggregatedResult:
        """协调多Agent完成目标。

        Args:
            goal: 目标描述。
            context: 上下文。
            strategy: 执行策略（parallel/sequential/adaptive），None则自动选择。

        Returns:
            AggregatedResult: 协调结果。
        """
        start = time.time()
        log.info("OrchestratorAgent: 开始协调", goal=goal[:80])

        complexity = self._complexity_analyzer.analyze(goal)
        log.info("复杂度分析", level=complexity.complexity)

        if complexity.complexity == "simple":
            return await self._execute_simple(goal, context, start)

        return await self._execute_with_retry(goal, context, complexity, strategy, start)

    async def _execute_simple(
        self,
        goal: str,
        context: dict[str, Any] | None,
        start: float,
    ) -> AggregatedResult:
        agent = self._agent_factory.select_agent_by_goal(goal)
        try:
            result = await agent.execute(goal, context)
            return AggregatedResult(
                success=True,
                summary=f"已执行: {goal[:60]}",
                total_tasks=1,
                completed_tasks=1,
                duration_ms=(time.time() - start) * 1000,
            )
        except Exception as e:
            return AggregatedResult(
                success=False,
                summary=f"执行失败: {str(e)[:60]}",
                total_tasks=1,
                failed_tasks=1,
                duration_ms=(time.time() - start) * 1000,
            )

    async def _execute_with_retry(
        self,
        goal: str,
        context: dict[str, Any] | None,
        complexity: TaskComplexity,
        strategy: str | None,
        start: float,
    ) -> AggregatedResult:
        last_result: AggregatedResult | None = None

        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                log.info(f"重规划: 第{attempt}次重试", goal=goal[:60])

            sub_goals = self._decompose_goal(goal, complexity, last_result)
            tasks = self._assign_agents(sub_goals)

            fanout_result = await self._execute_fanout(tasks, strategy)

            import json
            sub_results = [
                SubTaskResult(
                    task_id=f"task_{i}",
                    agent_name=t.assigned_to or "unknown",
                    success=not t.error,
                    result=t.result,
                    error=t.error,
                    duration_ms=0.0,
                )
                for i, t in enumerate(tasks)
            ]

            aggregated = AggregatedResult(
                success=fanout_result.all_succeeded,
                summary=f"第{attempt + 1}轮: {fanout_result.success_count}/{fanout_result.total_count} 成功",
                total_tasks=fanout_result.total_count,
                completed_tasks=fanout_result.success_count,
                failed_tasks=fanout_result.failed_count,
                duration_ms=(time.time() - start) * 1000,
                sub_results=sub_results,
            )

            if aggregated.success:
                return aggregated

            last_result = aggregated

        return last_result or AggregatedResult(
            success=False,
            summary=f"达到最大重试次数({self._max_retries})",
            duration_ms=(time.time() - start) * 1000,
        )

    def _decompose_goal(
        self,
        goal: str,
        complexity: TaskComplexity,
        last_result: AggregatedResult | None = None,
    ) -> list[str]:
        if last_result and last_result.failed_tasks > 0:
            failed_goals = [
                sr.error or f"任务{sr.task_id}"
                for sr in last_result.sub_results
                if not sr.success
            ]
            return failed_goals[:complexity.recommended_agents]

        parts = [p.strip() for p in goal.replace("并且", "，").replace("然后", "，").replace("同时", "，").split("，") if p.strip()]
        if not parts:
            parts = [goal]

        result = parts[:complexity.recommended_agents]
        while len(result) < complexity.recommended_agents:
            result.append(result[-1] if result else goal)
        return result

    def _assign_agents(self, sub_goals: list[str]) -> list[TaskNode]:
        from agent.orchestration.fanout import TaskNode as FanoutTaskNode

        nodes: list[FanoutTaskNode] = []
        for i, sg in enumerate(sub_goals):
            agent = self._agent_factory.select_agent_by_goal(sg)
            node = FanoutTaskNode(
                id=f"sub_{i}_{uuid.uuid4().hex[:6]}",
                goal=sg,
                assigned_to=agent.name,
            )
            nodes.append(node)
        return nodes

    async def _execute_fanout(
        self,
        tasks: list[TaskNode],
        strategy: str | None = None,
    ) -> Any:
        from agent.orchestration.fanout import SubAgentFanout, FanoutConfig, FanoutStrategy

        config = FanoutConfig(
            max_fanout=min(len(tasks), 5),
            strategy=strategy if strategy else "adaptive",
            task_timeout_ms=60_000.0,
            continue_on_partial_failure=True,
        )

        fanout = SubAgentFanout(config=config)
        return await fanout.fanout(tasks, executor=self._create_executor())

    def _create_executor(self) -> Any:
        registry = self._registry
        orchestrator_ref = self

        class RegistryExecutor:
            async def execute(self_node, task: TaskNode) -> Any:
                # 本地优先策略：先查本地 AgentRegistry
                agent = registry.get(task.assigned_to or "")
                if agent:
                    registry.set_state(task.assigned_to or "", "busy")
                    try:
                        result = await agent.execute(task.goal)
                        registry.set_state(task.assigned_to or "", "idle")
                        return result
                    except Exception:
                        registry.report_error(task.assigned_to or "")
                        raise
                # 本地无合适 Agent → 通过 A2A 协议发现远程 Agent 委派任务
                # 此前该分支返回 {"status": "no_agent_available"}，导致跨 Agent 协作能力闲置
                if orchestrator_ref._a2a_enabled():
                    a2a_result = await orchestrator_ref._delegate_via_a2a(task.goal)
                    if a2a_result is not None:
                        return a2a_result
                return {"goal": task.goal, "status": "no_agent_available"}

        return RegistryExecutor()

    def get_history(self) -> list[AggregatedResult]:
        """获取历史协调结果。

        Returns:
            list[AggregatedResult]: 历史结果列表。
        """
        return self._aggregator.get_history() if self._aggregator else []

"""细粒度策略自适应模块。

按任务类型独立调优策略参数，实现精细化的策略管理。

主要功能：
- 按任务类型独立管理策略参数
- 基于反馈自动调整策略
- 策略效果评估和对比
- 策略版本管理和回滚

Usage:
    adapter = StrategyAdapter()
    adapter.record_outcome("task_type_1", "strategy_a", success=True)
    best = adapter.get_best_strategy("task_type_1")
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("strategy_adapter")


@dataclass
class PromptStrategy:
    reasoning_freedom: str = "structured"
    enable_chain_of_thought: bool = False
    enable_few_shot: bool = True
    max_examples: int = 3


@dataclass
class PlanningStrategy:
    enable_tot: bool = False
    enable_causal_modeling: bool = False
    max_plan_depth: int = 3
    enable_debate: bool = False
    enable_dynamic_replanning: bool = False


@dataclass
class ToolUseStrategy:
    tool_chain_complexity: str = "simple"
    enable_tool_chaining: bool = False
    max_tool_calls_per_round: int = 3
    enable_parallel_tools: bool = False


@dataclass
class ReflectionStrategy:
    depth: str = "shallow"
    enable_deep_reflection: bool = False
    max_retries: int = 1
    enable_self_correction: bool = False


@dataclass
class ExecutionStrategy:
    enable_adaptive_control: bool = False
    risk_assessment_threshold: float = 0.5
    enable_parallel_execution: bool = False


@dataclass
class StrategyConfig:
    version: str = "1.0.0"
    prompt: PromptStrategy = field(default_factory=PromptStrategy)
    planning: PlanningStrategy = field(default_factory=PlanningStrategy)
    tool_use: ToolUseStrategy = field(default_factory=ToolUseStrategy)
    reflection: ReflectionStrategy = field(default_factory=ReflectionStrategy)
    execution: ExecutionStrategy = field(default_factory=ExecutionStrategy)
    applied_at: float = 0.0
    llm_overall_score: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        from dataclasses import asdict
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StrategyConfig:
        prompt_data = data.get("prompt", {})
        planning_data = data.get("planning", {})
        tool_use_data = data.get("tool_use", {})
        reflection_data = data.get("reflection", {})
        execution_data = data.get("execution", {})
        return cls(
            version=data.get("version", "1.0.0"),
            prompt=PromptStrategy(**{k: v for k, v in prompt_data.items() if k in PromptStrategy.__dataclass_fields__}),
            planning=PlanningStrategy(**{k: v for k, v in planning_data.items() if k in PlanningStrategy.__dataclass_fields__}),
            tool_use=ToolUseStrategy(**{k: v for k, v in tool_use_data.items() if k in ToolUseStrategy.__dataclass_fields__}),
            reflection=ReflectionStrategy(**{k: v for k, v in reflection_data.items() if k in ReflectionStrategy.__dataclass_fields__}),
            execution=ExecutionStrategy(**{k: v for k, v in execution_data.items() if k in ExecutionStrategy.__dataclass_fields__}),
            applied_at=data.get("applied_at", 0.0),
            llm_overall_score=data.get("llm_overall_score", 0.0),
        )


@dataclass
class StrategyParams:
    """策略参数。"""

    strategy_name: str
    params: dict[str, Any] = field(default_factory=dict)
    success_count: int = 0
    failure_count: int = 0
    total_reward: float = 0.0
    usage_count: int = 0
    last_used: float = 0.0
    version: int = 1


@dataclass
class TaskTypeStrategy:
    """任务类型的策略集合。"""

    task_type: str
    strategies: dict[str, StrategyParams] = field(default_factory=dict)
    current_strategy: str = ""
    exploration_rate: float = 0.1  # 探索率
    total_tasks: int = 0
    total_successes: int = 0


@dataclass
class StrategyRecommendation:
    """策略推荐。"""

    strategy_name: str
    confidence: float
    expected_success_rate: float
    reason: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class StrategyAdapterMetrics:
    """策略自适应统计指标。"""

    total_task_types: int = 0
    total_strategies: int = 0
    avg_success_rate: float = 0.0
    total_adaptations: int = 0
    exploration_count: int = 0
    exploitation_count: int = 0


class StrategyAdapter:
    """细粒度策略适配器。

    按任务类型独立管理和调优策略参数，
    基于多臂老虎机算法实现探索-利用平衡。
    """

    def __init__(
        self,
        default_exploration_rate: float = 0.1,
        min_usage_for_adaptation: int = 5,
        adaptation_interval: int = 10,
        enabled: bool = True,
        data_dir: str | None = None,
    ) -> None:
        """初始化策略适配器。

        Args:
            default_exploration_rate: 默认探索率。
            min_usage_for_adaptation: 自适应所需的最少使用次数。
            adaptation_interval: 自适应间隔（每N次任务调整一次）。
            enabled: 是否启用。
            data_dir: 数据目录。
        """
        self._default_exploration = default_exploration_rate
        self._min_usage = min_usage_for_adaptation
        self._adaptation_interval = adaptation_interval
        self._enabled = enabled
        self._data_dir = data_dir

        # 按任务类型存储策略
        self._task_strategies: dict[str, TaskTypeStrategy] = {}

        # 当前配置
        self._current_config: StrategyConfig | None = None
        self._adaptation_history: list[dict[str, Any]] = []
        self._callbacks: dict[str, Any] = {}

        # 统计
        self._stats = {
            "total_adaptations": 0,
            "exploration_count": 0,
            "exploitation_count": 0,
            "total_outcomes": 0,
        }

        # 实时信号累积（供 record_signal 使用）
        self._signal_buffer: list[dict[str, Any]] = []
        self._signal_scores: dict[str, float] = {}
        self._current_model_family: str = "generic"
        self._prompt_registry: Any = None

        log.info(
            "StrategyAdapter initialized",
            enabled=enabled,
            exploration_rate=default_exploration_rate,
            min_usage=min_usage_for_adaptation,
        )

    def register_strategy(
        self,
        task_type: str,
        strategy_name: str,
        params: dict[str, Any] | None = None,
    ) -> None:
        """注册策略。

        Args:
            task_type: 任务类型。
            strategy_name: 策略名称。
            params: 策略参数。
        """
        if task_type not in self._task_strategies:
            self._task_strategies[task_type] = TaskTypeStrategy(
                task_type=task_type,
                exploration_rate=self._default_exploration,
            )

        task_strategy = self._task_strategies[task_type]

        if strategy_name not in task_strategy.strategies:
            task_strategy.strategies[strategy_name] = StrategyParams(
                strategy_name=strategy_name,
                params=params or {},
            )

            # 如果是第一个策略，设为当前策略
            if not task_strategy.current_strategy:
                task_strategy.current_strategy = strategy_name

            log.debug(
                "Strategy registered",
                task_type=task_type,
                strategy=strategy_name,
            )

    def record_outcome(
        self,
        task_type: str,
        strategy_name: str,
        success: bool,
        reward: float = 0.0,
    ) -> None:
        """记录策略执行结果。

        Args:
            task_type: 任务类型。
            strategy_name: 策略名称。
            success: 是否成功。
            reward: 奖励值。
        """
        if not self._enabled:
            return

        # 确保任务类型和策略存在
        if task_type not in self._task_strategies:
            self.register_strategy(task_type, strategy_name)

        task_strategy = self._task_strategies[task_type]
        if strategy_name not in task_strategy.strategies:
            self.register_strategy(task_type, strategy_name)

        strategy = task_strategy.strategies[strategy_name]

        # 更新统计
        strategy.usage_count += 1
        strategy.last_used = time.time()
        strategy.total_reward += reward

        if success:
            strategy.success_count += 1
            task_strategy.total_successes += 1
        else:
            strategy.failure_count += 1

        task_strategy.total_tasks += 1
        self._stats["total_outcomes"] += 1

        # 检查是否需要自适应调整
        if task_strategy.total_tasks % self._adaptation_interval == 0:
            self._adapt_strategy(task_type)

        log.debug(
            "Outcome recorded",
            task_type=task_type,
            strategy=strategy_name,
            success=success,
            reward=reward,
        )

    def get_best_strategy(self, task_type: str) -> StrategyRecommendation | None:
        """获取任务类型的最佳策略。

        使用epsilon-greedy算法平衡探索和利用。

        Args:
            task_type: 任务类型。

        Returns:
            StrategyRecommendation | None: 策略推荐。
        """
        if not self._enabled:
            return None

        task_strategy = self._task_strategies.get(task_type)
        if not task_strategy or not task_strategy.strategies:
            return None

        import random

        # 探索：随机选择一个策略
        if random.random() < task_strategy.exploration_rate:
            strategies = list(task_strategy.strategies.values())
            if strategies:
                chosen = random.choice(strategies)
                self._stats["exploration_count"] += 1
                return StrategyRecommendation(
                    strategy_name=chosen.strategy_name,
                    confidence=0.3,
                    expected_success_rate=self._get_success_rate(chosen),
                    reason="探索新策略",
                    params=dict(chosen.params),
                )

        # 利用：选择成功率最高的策略
        best_strategy = None
        best_success_rate = -1.0

        for strategy in task_strategy.strategies.values():
            success_rate = self._get_success_rate(strategy)
            if success_rate > best_success_rate:
                best_success_rate = success_rate
                best_strategy = strategy

        if best_strategy:
            self._stats["exploitation_count"] += 1
            confidence = min(
                0.95,
                0.5 + best_success_rate * 0.3 + best_strategy.usage_count * 0.01,
            )
            return StrategyRecommendation(
                strategy_name=best_strategy.strategy_name,
                confidence=confidence,
                expected_success_rate=best_success_rate,
                reason=f"基于 {best_strategy.usage_count} 次使用的最优策略",
                params=dict(best_strategy.params),
            )

        return None

    def get_strategy_params(
        self, task_type: str, strategy_name: str
    ) -> dict[str, Any] | None:
        """获取策略参数。

        Args:
            task_type: 任务类型。
            strategy_name: 策略名称。

        Returns:
            dict | None: 策略参数。
        """
        task_strategy = self._task_strategies.get(task_type)
        if not task_strategy:
            return None

        strategy = task_strategy.strategies.get(strategy_name)
        if not strategy:
            return None

        return dict(strategy.params)

    def update_strategy_params(
        self,
        task_type: str,
        strategy_name: str,
        params: dict[str, Any],
    ) -> bool:
        """更新策略参数。

        Args:
            task_type: 任务类型。
            strategy_name: 策略名称。
            params: 新参数。

        Returns:
            bool: 是否成功。
        """
        task_strategy = self._task_strategies.get(task_type)
        if not task_strategy:
            return False

        strategy = task_strategy.strategies.get(strategy_name)
        if not strategy:
            return False

        strategy.params.update(params)
        strategy.version += 1

        log.info(
            "Strategy params updated",
            task_type=task_type,
            strategy=strategy_name,
            version=strategy.version,
        )

        return True

    def _adapt_strategy(self, task_type: str) -> None:
        """自适应调整策略。

        根据历史表现调整策略参数和探索率。

        Args:
            task_type: 任务类型。
        """
        task_strategy = self._task_strategies.get(task_type)
        if not task_strategy:
            return

        # 1. 调整探索率（随着经验增加，降低探索率）
        total_tasks = task_strategy.total_tasks
        if total_tasks > self._min_usage * 2:
            # 经验足够时降低探索率
            task_strategy.exploration_rate = max(
                0.01,
                self._default_exploration * (self._min_usage / total_tasks),
            )

        # 2. 调整当前最佳策略
        best = self.get_best_strategy(task_type)
        if best:
            task_strategy.current_strategy = best.strategy_name

        # 3. 对表现差的策略降低权重（通过参数调整）
        for strategy in task_strategy.strategies.values():
            if strategy.usage_count >= self._min_usage:
                success_rate = self._get_success_rate(strategy)
                if success_rate < 0.3:
                    # 表现差的策略，增加惩罚
                    strategy.total_reward -= 0.1

        self._stats["total_adaptations"] += 1

        log.debug(
            "Strategy adapted",
            task_type=task_type,
            current_strategy=task_strategy.current_strategy,
            exploration_rate=task_strategy.exploration_rate,
        )

    def _get_success_rate(self, strategy: StrategyParams) -> float:
        """计算策略的成功率。

        使用拉普拉斯平滑避免小样本偏差。

        Args:
            strategy: 策略参数。

        Returns:
            float: 成功率。
        """
        total = strategy.success_count + strategy.failure_count
        if total == 0:
            return 0.5  # 无数据时给中等评分

        # 拉普拉斯平滑
        smoothed_success = strategy.success_count + 1
        smoothed_total = total + 2

        return smoothed_success / smoothed_total

    def get_task_types(self) -> list[str]:
        """获取所有任务类型。

        Returns:
            list[str]: 任务类型列表。
        """
        return list(self._task_strategies.keys())

    def get_strategies(self, task_type: str) -> list[str]:
        """获取任务类型的所有策略。

        Args:
            task_type: 任务类型。

        Returns:
            list[str]: 策略名称列表。
        """
        task_strategy = self._task_strategies.get(task_type)
        if not task_strategy:
            return []
        return list(task_strategy.strategies.keys())

    def get_strategy_stats(
        self, task_type: str, strategy_name: str
    ) -> dict[str, Any] | None:
        """获取策略统计信息。

        Args:
            task_type: 任务类型。
            strategy_name: 策略名称。

        Returns:
            dict | None: 统计信息。
        """
        task_strategy = self._task_strategies.get(task_type)
        if not task_strategy:
            return None

        strategy = task_strategy.strategies.get(strategy_name)
        if not strategy:
            return None

        return {
            "strategy_name": strategy.strategy_name,
            "success_count": strategy.success_count,
            "failure_count": strategy.failure_count,
            "usage_count": strategy.usage_count,
            "success_rate": self._get_success_rate(strategy),
            "total_reward": strategy.total_reward,
            "last_used": strategy.last_used,
            "version": strategy.version,
        }

    def record_signal(self, signal_type: str, value: float = 0.0) -> None:
        """记录实时学习信号，用于微调策略参数。

        由 EvolutionOrchestrator 在每轮交互后调用，
        累积信号用于驱动策略自适应微调。

        Args:
            signal_type: 信号类型（如 "high_failure_rate", "high_quality_streak", "slow_response"）。
            value: 信号值（-1.0 到 1.0，负值表示惩罚，正值表示奖励）。
        """
        if not self._enabled:
            return

        self._signal_buffer.append({
            "type": signal_type,
            "value": value,
            "timestamp": time.time(),
        })

        if len(self._signal_buffer) > 20:
            self._signal_buffer = self._signal_buffer[-20:]

        current = self._signal_scores.get(signal_type, 0.0)
        self._signal_scores[signal_type] = current * 0.7 + value * 0.3

        if len(self._signal_buffer) >= 5:
            self._apply_signal_micro_adaptation()

    def _apply_signal_micro_adaptation(self) -> None:
        """根据累积信号进行微调。"""
        recent = self._signal_buffer[-5:]
        avg_value = sum(s["value"] for s in recent) / len(recent)

        if avg_value < -0.3 and self._current_config:
            self._current_config.reflection.max_retries = min(
                4, self._current_config.reflection.max_retries + 1
            )
            self._current_config.reflection.enable_deep_reflection = True
            self._current_config.execution.risk_assessment_threshold = max(
                0.3, self._current_config.execution.risk_assessment_threshold - 0.1
            )
        elif avg_value > 0.3 and self._current_config:
            self._current_config.reflection.max_retries = max(
                1, self._current_config.reflection.max_retries - 1
            )
            self._current_config.execution.risk_assessment_threshold = min(
                0.95, self._current_config.execution.risk_assessment_threshold + 0.05
            )

    def set_model_family(self, model_name: str) -> None:
        """设置当前使用的模型家族，用于选择最佳 prompt 模板。

        Args:
            model_name: 模型名称（如 "claude-sonnet-4-20250514"）。
        """
        from agent.evolution.prompt_templates import _detect_model_family
        self._current_model_family = _detect_model_family(model_name)
        log.debug("Model family set", model_name=model_name, family=self._current_model_family)

    def get_prompt_template(self, category: str, **kwargs: Any) -> str:
        """获取当前模型家族对应的 prompt 模板。

        Args:
            category: 模板类别（"planning", "evaluation", "reflection", "code_generation", "tool_calling"）。
            **kwargs: 模板渲染参数。

        Returns:
            str: 渲染后的 prompt 模板文本。
        """
        try:
            from agent.evolution.prompt_templates import get_prompt_template_registry
            if self._prompt_registry is None:
                self._prompt_registry = get_prompt_template_registry()
            template = self._prompt_registry.get_template(
                self._current_model_family, category
            )
            return template.render(**kwargs)
        except Exception:
            return kwargs.get("user_input", "")

    def get_metrics(self) -> StrategyAdapterMetrics:
        """获取统计指标。

        Returns:
            StrategyAdapterMetrics: 统计指标。
        """
        total_task_types = len(self._task_strategies)
        total_strategies = sum(
            len(ts.strategies) for ts in self._task_strategies.values()
        )

        # 计算平均成功率
        all_success_rates = []
        for ts in self._task_strategies.values():
            for s in ts.strategies.values():
                if s.usage_count > 0:
                    all_success_rates.append(self._get_success_rate(s))

        avg_success_rate = (
            sum(all_success_rates) / len(all_success_rates)
            if all_success_rates
            else 0.0
        )

        return StrategyAdapterMetrics(
            total_task_types=total_task_types,
            total_strategies=total_strategies,
            avg_success_rate=avg_success_rate,
            total_adaptations=self._stats["total_adaptations"],
            exploration_count=self._stats["exploration_count"],
            exploitation_count=self._stats["exploitation_count"],
        )

    def reset(self) -> None:
        """重置适配器。"""
        self._task_strategies.clear()
        self._stats = {
            "total_adaptations": 0,
            "exploration_count": 0,
            "exploitation_count": 0,
            "total_outcomes": 0,
        }
        log.info("StrategyAdapter reset")

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("StrategyAdapter enabled state changed", enabled=value)

    def get_default_config(self) -> StrategyConfig:
        return StrategyConfig()

    def get_current_config(self) -> StrategyConfig | None:
        return self._current_config

    def set_callbacks(self, callbacks: dict[str, Any]) -> None:
        self._callbacks = callbacks

    async def adapt(self, caps: Any) -> StrategyConfig:
        reasoning = getattr(caps, "reasoning_depth", 0) / 9.0
        tool_acc = getattr(caps, "tool_calling_accuracy", 0)
        code_gen = getattr(caps, "code_generation", 0) / 9.0
        struct_out = getattr(caps, "structured_output", 0)
        overall = reasoning * 0.30 + tool_acc * 0.25 + code_gen * 0.25 + struct_out * 0.20

        model_family = getattr(caps, "model_family", "")
        if model_family:
            self._current_model_family = model_family
        prompt = self._build_prompt_for_model(reasoning, overall, caps)
        planning = self._build_planning(reasoning, overall)
        tool_use = self._build_tool_use(tool_acc, overall)
        reflection = self._build_reflection(reasoning, overall)
        execution = self._build_execution(overall)

        config = StrategyConfig(
            prompt=prompt,
            planning=planning,
            tool_use=tool_use,
            reflection=reflection,
            execution=execution,
            applied_at=time.time(),
            llm_overall_score=overall,
        )
        self._current_config = config
        self._adaptation_history.append({
            "provider": getattr(caps, "provider", ""),
            "score": overall,
            "applied_at": config.applied_at,
        })
        if len(self._adaptation_history) > 50:
            self._adaptation_history = self._adaptation_history[-50:]

        if "on_strategy_adapted" in self._callbacks:
            try:
                self._callbacks["on_strategy_adapted"](config)
            except Exception as _exc:
                log_ignored(log, "strategy_adapter.StrategyAdapter.adapt", _exc)

        return config

    @staticmethod
    def _build_prompt(reasoning: float, overall: float) -> PromptStrategy:
        if reasoning >= 0.7:
            return PromptStrategy(
                reasoning_freedom="open",
                enable_chain_of_thought=True,
                enable_few_shot=True,
                max_examples=5,
            )
        elif reasoning >= 0.4:
            return PromptStrategy(
                reasoning_freedom="guided",
                enable_chain_of_thought=True,
                enable_few_shot=True,
                max_examples=3,
            )
        return PromptStrategy()

    def _build_prompt_for_model(
        self, reasoning: float, overall: float, caps: Any = None
    ) -> PromptStrategy:
        """根据模型家族构建最优 prompt 策略。

        利用模型特有能力的策略：
        - Claude: 启用 extended thinking，更自由的推理
        - GPT: 利用 structured output 原生支持
        - DeepSeek: 中文优化，更多 few-shot 示例
        - Gemini: 简洁指令，减少冗余
        - 通用: 默认策略

        Args:
            reasoning: 推理能力评分 (0.0-1.0)。
            overall: 综合评分 (0.0-1.0)。
            caps: 能力画像 (LLMCapabilities)，可选。

        Returns:
            PromptStrategy: 模型家族优化的 prompt 策略。
        """
        family = self._current_model_family
        extended_thinking = getattr(caps, "extended_thinking", False) if caps else False
        structured_native = getattr(caps, "structured_output_native", False) if caps else False

        if family == "claude":
            return PromptStrategy(
                reasoning_freedom="open",
                enable_chain_of_thought=extended_thinking,
                enable_few_shot=True,
                max_examples=5 if reasoning >= 0.6 else 3,
            )
        elif family == "gpt":
            return PromptStrategy(
                reasoning_freedom="structured" if structured_native else "guided",
                enable_chain_of_thought=overall >= 0.5,
                enable_few_shot=True,
                max_examples=4 if reasoning >= 0.6 else 2,
            )
        elif family == "deepseek":
            return PromptStrategy(
                reasoning_freedom="guided",
                enable_chain_of_thought=True,
                enable_few_shot=True,
                max_examples=5,
            )
        elif family == "gemini":
            return PromptStrategy(
                reasoning_freedom="guided",
                enable_chain_of_thought=False,
                enable_few_shot=False,
                max_examples=2,
            )
        return StrategyAdapter._build_prompt(reasoning, overall)

    @staticmethod
    def _build_planning(reasoning: float, overall: float) -> PlanningStrategy:
        if overall >= 0.7:
            return PlanningStrategy(
                enable_tot=True,
                enable_causal_modeling=True,
                max_plan_depth=6,
                enable_debate=True,
                enable_dynamic_replanning=True,
            )
        elif overall >= 0.4:
            return PlanningStrategy(
                enable_tot=False,
                enable_causal_modeling=False,
                max_plan_depth=4,
                enable_debate=False,
                enable_dynamic_replanning=True,
            )
        return PlanningStrategy()

    @staticmethod
    def _build_tool_use(tool_acc: float, overall: float) -> ToolUseStrategy:
        if tool_acc >= 0.8 and overall >= 0.7:
            return ToolUseStrategy(
                tool_chain_complexity="complex",
                enable_tool_chaining=True,
                max_tool_calls_per_round=8,
                enable_parallel_tools=True,
            )
        elif tool_acc >= 0.7:
            return ToolUseStrategy(
                tool_chain_complexity="moderate",
                enable_tool_chaining=True,
                max_tool_calls_per_round=5,
                enable_parallel_tools=False,
            )
        return ToolUseStrategy()

    @staticmethod
    def _build_reflection(reasoning: float, overall: float) -> ReflectionStrategy:
        if reasoning >= 0.7:
            return ReflectionStrategy(
                depth="deep",
                enable_deep_reflection=True,
                max_retries=4,
                enable_self_correction=True,
            )
        elif reasoning >= 0.4:
            return ReflectionStrategy(
                depth="moderate",
                enable_deep_reflection=False,
                max_retries=2,
                enable_self_correction=False,
            )
        return ReflectionStrategy(enable_self_correction=False)

    @staticmethod
    def _build_execution(overall: float) -> ExecutionStrategy:
        if overall >= 0.6:
            return ExecutionStrategy(
                enable_adaptive_control=True,
                risk_assessment_threshold=0.9,
                enable_parallel_execution=True,
            )
        elif overall >= 0.25:
            return ExecutionStrategy(
                enable_adaptive_control=False,
                risk_assessment_threshold=0.8,
                enable_parallel_execution=False,
            )
        return ExecutionStrategy()

    def get_adaptation_history(self) -> list[dict[str, Any]]:
        return list(self._adaptation_history)

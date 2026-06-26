"""
循环观察者

【功能】
增强 Agent 主循环的可观测性，让工作过程可见

【设计原则】
- 非侵入式：通过事件监听实现，不修改主循环逻辑
- 可配置：默认关闭，通过配置或环境变量开启
- 轻量级：不影响主循环性能
- 结构化：结构化的追踪数据，便于分析和展示

【追踪内容】
- 循环阶段状态（Planner/Executor/Evaluator/Reporter）
- 工具调用详情（名称、参数、结果、耗时）
- 思考过程摘要
- 错误和异常
- 性能指标

【使用场景】
- 调试和问题定位
- 性能分析和优化
- 用户透明度展示
- 学习和教学

@module observer
@version 0.1.0
@status Beta - 功能基本完成，测试中
@since 2026-06-24
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("loop_observer")

# ========== 常量定义 ==========

# 最大历史记录数
MAX_HISTORY_SIZE = 100

# 默认摘要最大长度
DEFAULT_SUMMARY_MAX_LENGTH = 50

# AI 输出摘要最大长度
AI_OUTPUT_SUMMARY_MAX_LENGTH = 100

# 工具结果摘要最大长度
TOOL_RESULT_SUMMARY_MAX_LENGTH = 100

# 参数摘要最大键数
PARAMS_SUMMARY_MAX_KEYS = 5

# 参数值摘要最大长度
PARAM_VALUE_SUMMARY_MAX_LENGTH = 20

# 最近工具调用默认数量
DEFAULT_RECENT_TOOL_CALLS = 10

# 环境变量：是否启用观察者
ENV_OBSERVER_ENABLED = "LOOP_OBSERVER_ENABLED"

# 环境变量：是否启用详细模式
ENV_OBSERVER_VERBOSE = "LOOP_OBSERVER_VERBOSE"


class LoopPhase(str, Enum):
    """循环阶段"""
    PLANNER = "planner"
    EXECUTOR = "executor"
    EVALUATOR = "evaluator"
    REPORTER = "reporter"
    IDLE = "idle"


@dataclass
class ToolCallRecord:
    """工具调用记录"""
    id: str = ""
    tool_name: str = ""
    params_summary: str = ""
    start_time: float = 0.0
    end_time: float | None = None
    duration: float | None = None
    success: bool | None = None
    result_summary: str | None = None
    error: str | None = None
    retry_count: int = 0


@dataclass
class PhaseRecord:
    """阶段记录"""
    phase: LoopPhase = LoopPhase.IDLE
    start_time: float = 0.0
    end_time: float | None = None
    duration: float | None = None
    input_summary: str | None = None
    output_summary: str | None = None
    success: bool | None = None
    error: str | None = None


@dataclass
class LoopTrace:
    """循环追踪记录"""
    trace_id: str = ""
    start_time: float = 0.0
    end_time: float | None = None
    total_duration: float | None = None
    phases: list[PhaseRecord] = field(default_factory=list)
    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    current_phase: LoopPhase = LoopPhase.IDLE
    success: bool | None = None
    error: str | None = None
    user_input_summary: str | None = None
    ai_output_summary: str | None = None


@dataclass
class LoopStatistics:
    """循环统计"""
    total_loops: int = 0
    successful_loops: int = 0
    failed_loops: int = 0
    average_duration: float = 0.0
    total_tool_calls: int = 0
    tool_success_rate: float = 0.0
    average_tool_duration: float = 0.0
    phase_durations: dict[str, float] = field(default_factory=dict)


class LoopObserver:
    """循环观察者"""

    _instance: LoopObserver | None = None

    def __init__(self) -> None:
        # 是否启用
        self._enabled = False

        # 是否输出详细调试信息
        self._verbose = False

        # 当前追踪
        self._current_trace: LoopTrace | None = None

        # 追踪历史
        self._trace_history: list[LoopTrace] = []

        # 最大历史记录数
        self._max_history_size = MAX_HISTORY_SIZE

        # 统计数据
        self._statistics = LoopStatistics(
            phase_durations={
                LoopPhase.PLANNER.value: 0.0,
                LoopPhase.EXECUTOR.value: 0.0,
                LoopPhase.EVALUATOR.value: 0.0,
                LoopPhase.REPORTER.value: 0.0,
                LoopPhase.IDLE.value: 0.0,
            }
        )

        # 各阶段总耗时
        self._phase_total_durations: dict[str, float] = {
            LoopPhase.PLANNER.value: 0.0,
            LoopPhase.EXECUTOR.value: 0.0,
            LoopPhase.EVALUATOR.value: 0.0,
            LoopPhase.REPORTER.value: 0.0,
            LoopPhase.IDLE.value: 0.0,
        }

        # 各阶段计数
        self._phase_counts: dict[str, int] = {
            LoopPhase.PLANNER.value: 0,
            LoopPhase.EXECUTOR.value: 0,
            LoopPhase.EVALUATOR.value: 0,
            LoopPhase.REPORTER.value: 0,
            LoopPhase.IDLE.value: 0,
        }

        # 工具总耗时
        self._tool_total_duration = 0.0

        # 成功的工具调用数（全局统计）
        self._successful_tool_calls = 0

        # 检查环境变量决定是否启用
        if os.environ.get(ENV_OBSERVER_ENABLED, "").lower() == "true":
            self._enabled = True
            self._verbose = os.environ.get(ENV_OBSERVER_VERBOSE, "").lower() == "true"

        log.info(f"🔍 循环观察者已初始化 ({'已启用' if self._enabled else '已禁用'})")

    @classmethod
    def get_instance(cls) -> LoopObserver:
        """获取单例实例"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """重置单例实例（测试用）"""
        cls._instance = None

    @classmethod
    def create_test_instance(cls) -> LoopObserver:
        """创建测试用独立实例（测试用）"""
        return cls()

    # ========== 循环追踪 ==========

    def start_loop(self, user_input: str | None = None) -> str:
        """开始循环追踪"""
        if not self._enabled:
            return ""

        trace_id = f"loop_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"

        self._current_trace = LoopTrace(
            trace_id=trace_id,
            start_time=time.time(),
            phases=[],
            tool_calls=[],
            current_phase=LoopPhase.IDLE,
            user_input_summary=(
                self._summarize(user_input, 50) if user_input else None
            ),
        )

        if self._verbose:
            log.info(f"🔍 [追踪开始] {trace_id}")

        return trace_id

    def end_loop(
        self,
        success: bool,
        error: str | None = None,
        ai_output: str | None = None,
    ) -> None:
        """结束循环追踪"""
        if not self._enabled or not self._current_trace:
            return

        trace = self._current_trace
        trace.end_time = time.time()
        trace.total_duration = trace.end_time - trace.start_time
        trace.success = success
        trace.error = error
        trace.ai_output_summary = (
            self._summarize(ai_output, 100) if ai_output else None
        )
        trace.current_phase = LoopPhase.IDLE

        # 更新统计
        self._statistics.total_loops += 1
        if success:
            self._statistics.successful_loops += 1
        else:
            self._statistics.failed_loops += 1

        # 更新平均耗时
        total_duration = (
            self._statistics.average_duration * (self._statistics.total_loops - 1)
            + trace.total_duration
        )
        self._statistics.average_duration = (
            total_duration / self._statistics.total_loops
        )

        # 添加到历史
        self._trace_history.append(trace)
        if len(self._trace_history) > self._max_history_size:
            self._trace_history.pop(0)

        if self._verbose:
            status = "✅ 成功" if success else "❌ 失败"
            log.info(
                f"🔍 [追踪结束] {trace.trace_id} {status} "
                f"耗时 {trace.total_duration * 1000:.0f}ms"
            )

        self._current_trace = None

    # ========== 阶段追踪 ==========

    def start_phase(
        self,
        phase: LoopPhase,
        input_summary: str | None = None,
    ) -> None:
        """开始阶段"""
        if not self._enabled or not self._current_trace:
            return

        phase_record = PhaseRecord(
            phase=phase,
            start_time=time.time(),
            input_summary=(
                self._summarize(input_summary, 50) if input_summary else None
            ),
        )

        self._current_trace.phases.append(phase_record)
        self._current_trace.current_phase = phase

        if self._verbose:
            log.info(f"🔍 [阶段开始] {phase.value}")

    def end_phase(
        self,
        phase: LoopPhase,
        success: bool = True,
        output_summary: str | None = None,
        error: str | None = None,
    ) -> None:
        """结束阶段"""
        if not self._enabled or not self._current_trace:
            return

        phase_record = next(
            (p for p in self._current_trace.phases
             if p.phase == phase and p.end_time is None),
            None,
        )
        if not phase_record:
            return

        phase_record.end_time = time.time()
        phase_record.duration = phase_record.end_time - phase_record.start_time
        phase_record.success = success
        phase_record.error = error
        phase_record.output_summary = (
            self._summarize(output_summary, 50) if output_summary else None
        )

        # 更新统计
        phase_key = phase.value
        self._phase_counts[phase_key] += 1
        self._phase_total_durations[phase_key] += phase_record.duration
        if self._phase_counts[phase_key] > 0:
            self._statistics.phase_durations[phase_key] = (
                self._phase_total_durations[phase_key]
                / self._phase_counts[phase_key]
            )

        if self._verbose:
            status = "✅" if success else "❌"
            log.info(
                f"🔍 [阶段结束] {phase.value} {status} "
                f"耗时 {phase_record.duration * 1000:.0f}ms"
            )

    # ========== 工具调用追踪 ==========

    def start_tool_call(
        self,
        tool_name: str,
        params: dict[str, Any] | None = None,
    ) -> str:
        """开始工具调用"""
        if not self._enabled or not self._current_trace:
            return ""

        call_id = f"tool_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"

        tool_call = ToolCallRecord(
            id=call_id,
            tool_name=tool_name,
            params_summary=self._summarize_params(params) if params else "",
            start_time=time.time(),
            retry_count=0,
        )

        self._current_trace.tool_calls.append(tool_call)

        if self._verbose:
            log.info(f"🔍 [工具调用] {tool_name} 开始")

        return call_id

    def end_tool_call(
        self,
        call_id: str,
        success: bool,
        result: Any = None,
        error: str | None = None,
    ) -> None:
        """结束工具调用"""
        if not self._enabled or not self._current_trace:
            return

        tool_call = next(
            (t for t in self._current_trace.tool_calls if t.id == call_id),
            None,
        )
        if not tool_call:
            return

        tool_call.end_time = time.time()
        tool_call.duration = tool_call.end_time - tool_call.start_time
        tool_call.success = success
        tool_call.result_summary = (
            self._summarize(str(result), 100) if result is not None else None
        )
        tool_call.error = error

        # 更新统计
        self._statistics.total_tool_calls += 1
        self._tool_total_duration += tool_call.duration

        if success:
            self._successful_tool_calls += 1

        if self._statistics.total_tool_calls > 0:
            self._statistics.average_tool_duration = (
                self._tool_total_duration / self._statistics.total_tool_calls
            )

            # 全局工具成功率
            self._statistics.tool_success_rate = (
                self._successful_tool_calls / self._statistics.total_tool_calls
            )

        if self._verbose:
            status = "✅" if success else "❌"
            log.info(
                f"🔍 [工具完成] {tool_call.tool_name} {status} "
                f"耗时 {tool_call.duration * 1000:.0f}ms"
            )

    def record_tool_retry(self, call_id: str) -> None:
        """记录工具重试"""
        if not self._enabled or not self._current_trace:
            return

        tool_call = next(
            (t for t in self._current_trace.tool_calls if t.id == call_id),
            None,
        )
        if tool_call:
            tool_call.retry_count += 1

            if self._verbose:
                log.info(
                    f"🔍 [工具重试] {tool_call.tool_name} "
                    f"(第 {tool_call.retry_count} 次重试)"
                )

    # ========== 查询方法 ==========

    def get_current_trace(self) -> LoopTrace | None:
        """获取当前追踪"""
        return self._current_trace

    def get_trace_history(self, limit: int | None = None) -> list[LoopTrace]:
        """获取历史追踪"""
        if limit:
            return list(self._trace_history[-limit:])
        return list(self._trace_history)

    def get_statistics(self) -> LoopStatistics:
        """获取统计数据"""
        return LoopStatistics(
            total_loops=self._statistics.total_loops,
            successful_loops=self._statistics.successful_loops,
            failed_loops=self._statistics.failed_loops,
            average_duration=self._statistics.average_duration,
            total_tool_calls=self._statistics.total_tool_calls,
            tool_success_rate=self._statistics.tool_success_rate,
            average_tool_duration=self._statistics.average_tool_duration,
            phase_durations=dict(self._statistics.phase_durations),
        )

    def get_recent_tool_calls(self, limit: int = 10) -> list[ToolCallRecord]:
        """获取最近的工具调用"""
        if not self._current_trace:
            return []
        return list(self._current_trace.tool_calls[-limit:])

    # ========== 控制方法 ==========

    def enable(self, verbose: bool = False) -> None:
        """启用观察者"""
        self._enabled = True
        self._verbose = verbose
        log.info(f"🔍 循环观察者已启用 (verbose={verbose})")

    def disable(self) -> None:
        """禁用观察者"""
        self._enabled = False
        self._verbose = False
        log.info("🔍 循环观察者已禁用")

    def is_enabled(self) -> bool:
        """检查是否启用"""
        return self._enabled

    def reset_statistics(self) -> None:
        """重置统计数据"""
        self._statistics = LoopStatistics(
            phase_durations={
                LoopPhase.PLANNER.value: 0.0,
                LoopPhase.EXECUTOR.value: 0.0,
                LoopPhase.EVALUATOR.value: 0.0,
                LoopPhase.REPORTER.value: 0.0,
                LoopPhase.IDLE.value: 0.0,
            }
        )

        self._phase_total_durations = {
            LoopPhase.PLANNER.value: 0.0,
            LoopPhase.EXECUTOR.value: 0.0,
            LoopPhase.EVALUATOR.value: 0.0,
            LoopPhase.REPORTER.value: 0.0,
            LoopPhase.IDLE.value: 0.0,
        }

        self._phase_counts = {
            LoopPhase.PLANNER.value: 0,
            LoopPhase.EXECUTOR.value: 0,
            LoopPhase.EVALUATOR.value: 0,
            LoopPhase.REPORTER.value: 0,
            LoopPhase.IDLE.value: 0,
        }

        self._tool_total_duration = 0.0
        self._successful_tool_calls = 0
        self._trace_history = []

        log.info("🔍 循环观察者统计已重置")

    # ========== 辅助方法 ==========

    def _summarize(self, text: str, max_length: int) -> str:
        """文本摘要"""
        if len(text) <= max_length:
            return text
        return text[:max_length] + "..."

    def _summarize_params(self, params: dict[str, Any]) -> str:
        """参数摘要"""
        try:
            keys = list(params.keys())
            if len(keys) == 0:
                return "{}"

            summary_parts: list[str] = []
            for key in keys[:PARAMS_SUMMARY_MAX_KEYS]:
                value = params[key]
                if isinstance(value, str):
                    value_str = self._summarize(value, PARAM_VALUE_SUMMARY_MAX_LENGTH)
                elif isinstance(value, (dict, list)):
                    value_str = "[object]"
                else:
                    value_str = str(value)
                summary_parts.append(f"{key}={value_str}")

            extra = f"...(+{len(keys) - PARAMS_SUMMARY_MAX_KEYS})" if len(keys) > PARAMS_SUMMARY_MAX_KEYS else ""
            return ", ".join(summary_parts) + extra
        except Exception:
            return "[params]"

    def generate_trace_report(self, trace: LoopTrace) -> str:
        """生成格式化的追踪报告"""
        lines: list[str] = []

        lines.append(f"循环追踪报告: {trace.trace_id}")
        lines.append(f"状态: {'✅ 成功' if trace.success else '❌ 失败'}")
        lines.append(f"总耗时: {trace.total_duration * 1000:.0f}ms" if trace.total_duration else "总耗时: -")
        lines.append("")

        lines.append("阶段列表:")
        for phase in trace.phases:
            status = "✅" if phase.success else "❌"
            duration = f"{phase.duration * 1000:.0f}ms" if phase.duration else "-"
            lines.append(f"  {status} {phase.phase.value}: {duration}")
        lines.append("")

        lines.append(f"工具调用 ({len(trace.tool_calls)} 次):")
        for tool in trace.tool_calls:
            status = "✅" if tool.success else "❌"
            duration = f"{tool.duration * 1000:.0f}ms" if tool.duration else "-"
            lines.append(
                f"  {status} {tool.tool_name}: {duration} "
                f"(重试 {tool.retry_count} 次)"
            )

        return "\n".join(lines)

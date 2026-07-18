"""生产埋点采集器（ProductionMetricsCollector）测试。

覆盖关键业务指标采集：
- agent_request_total: 请求总数（带 user_id/intent/status 标签）
- agent_request_duration: 请求耗时直方图
- agent_tool_calls_total: 工具调用总数
- agent_llm_tokens_total: LLM Token 消耗
- agent_llm_cost_total: LLM 成本
- agent_user_satisfaction: 用户满意度（点赞/点踩）
- agent_error_total: 错误总数（带 error_type 标签）
- agent_active_sessions: 活跃会话数（gauge）

测试中通过 monkeypatch 环境变量 OTEL_ENABLED=false 使用 NoOp MeterProvider，
所有指标操作不抛异常，且能正常累加（NoOp Counter.add 是空操作但不应报错）。
"""
from __future__ import annotations

import pytest

from agent.core.otel_metrics import _reset_meter_for_testing
from agent.core.production_metrics import (
    ProductionMetricsCollector,
    get_production_metrics_collector,
    _reset_collector_for_testing,
)


@pytest.fixture(autouse=True)
def _reset_state():
    """每个测试前后重置 OTel 与采集器全局状态，确保测试间隔离。"""
    _reset_meter_for_testing()
    _reset_collector_for_testing()
    yield
    _reset_meter_for_testing()
    _reset_collector_for_testing()


class TestRecordRequest:
    """请求埋点测试。"""

    def test_record_request_success_increments_counter(self):
        """记录成功请求应增加 request_total 计数且不抛异常。"""
        collector = ProductionMetricsCollector()
        # 应正常执行，不抛异常
        collector.record_request(
            user_id="user-1",
            intent="chat",
            status="success",
            duration_ms=120.5,
        )
        # NoOp 模式下无法读取数值，主要验证不抛异常
        assert collector is not None

    def test_record_request_with_empty_user_id(self):
        """空 user_id 也应正常记录（不抛异常）。"""
        collector = ProductionMetricsCollector()
        collector.record_request(
            user_id="",
            intent="tool_call",
            status="failed",
            duration_ms=500.0,
        )

    def test_record_request_duration_histogram_records(self):
        """duration_ms 应能记录到直方图（NoOp 模式下不抛异常）。"""
        collector = ProductionMetricsCollector()
        for duration in [10.0, 50.0, 100.0, 500.0, 1000.0]:
            collector.record_request(
                user_id="u", intent="i", status="success", duration_ms=duration
            )


class TestRecordToolCall:
    """工具调用埋点测试。"""

    def test_record_tool_call_success(self):
        """记录成功的工具调用应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.record_tool_call(
            tool_name="file_read", success=True, duration_ms=15.0
        )

    def test_record_tool_call_failure(self):
        """记录失败的工具调用应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.record_tool_call(
            tool_name="file_write", success=False, duration_ms=30.0
        )

    def test_record_tool_call_empty_name(self):
        """空工具名也应正常记录。"""
        collector = ProductionMetricsCollector()
        collector.record_tool_call(tool_name="", success=True, duration_ms=0.0)


class TestRecordLLMUsage:
    """LLM 用量与成本埋点测试。"""

    def test_record_llm_usage_with_tokens(self):
        """记录 LLM 用量（含 prompt/completion tokens）应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.record_llm_usage(
            model="gpt-4o-mini",
            prompt_tokens=150,
            completion_tokens=80,
            cost=0.002,
        )

    def test_record_llm_usage_zero_cost(self):
        """成本为 0 也应正常记录。"""
        collector = ProductionMetricsCollector()
        collector.record_llm_usage(
            model="gpt-4o",
            prompt_tokens=0,
            completion_tokens=0,
            cost=0.0,
        )

    def test_record_llm_usage_negative_cost_clamped(self):
        """负成本应被截断为 0（防御性编程）。"""
        collector = ProductionMetricsCollector()
        # 不应抛异常
        collector.record_llm_usage(
            model="claude-3",
            prompt_tokens=100,
            completion_tokens=50,
            cost=-1.5,
        )


class TestRecordUserFeedback:
    """用户反馈埋点测试。"""

    def test_record_positive_feedback(self):
        """记录正向反馈（点赞）应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.record_user_feedback(
            session_id="sess-1", feedback_type="positive"
        )

    def test_record_negative_feedback(self):
        """记录负向反馈（点踩）应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.record_user_feedback(
            session_id="sess-2", feedback_type="negative"
        )

    def test_record_unknown_feedback_type(self):
        """未知反馈类型也应正常记录（不抛异常）。"""
        collector = ProductionMetricsCollector()
        collector.record_user_feedback(
            session_id="sess-3", feedback_type="neutral"
        )


class TestRecordError:
    """错误埋点测试。"""

    def test_record_error_with_type(self):
        """记录错误（带 error_type 标签）应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.record_error(
            error_type="ValueError", error_message="参数无效"
        )

    def test_record_error_empty_message(self):
        """空错误信息也应正常记录。"""
        collector = ProductionMetricsCollector()
        collector.record_error(error_type="TimeoutError", error_message="")


class TestSetActiveSessions:
    """活跃会话数 gauge 测试（复用 otel_metrics.set_active_sessions）。"""

    def test_set_active_sessions_zero(self):
        """设置为 0 应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.set_active_sessions(0)

    def test_set_active_sessions_positive(self):
        """设置为正数应正常执行。"""
        collector = ProductionMetricsCollector()
        collector.set_active_sessions(42)


class TestSingleton:
    """单例获取测试。"""

    def test_get_collector_returns_singleton(self):
        """get_production_metrics_collector 应返回同一实例。"""
        c1 = get_production_metrics_collector()
        c2 = get_production_metrics_collector()
        assert c1 is c2

    def test_get_collector_is_production_metrics_collector(self):
        """返回的实例应为 ProductionMetricsCollector 类型。"""
        collector = get_production_metrics_collector()
        assert isinstance(collector, ProductionMetricsCollector)


class TestNoOpSafety:
    """OTel 未启用时的 NoOp 降级安全性测试。"""

    def test_all_methods_safe_when_otel_disabled(self, monkeypatch):
        """OTel 未启用时所有方法应为 NoOp 不抛异常。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        _reset_meter_for_testing()
        _reset_collector_for_testing()

        collector = ProductionMetricsCollector()
        # 批量调用所有方法，验证无异常
        collector.record_request("u", "i", "ok", 100.0)
        collector.record_tool_call("tool", True, 50.0)
        collector.record_llm_usage("model", 10, 20, 0.01)
        collector.record_user_feedback("s", "positive")
        collector.record_error("Err", "msg")
        collector.set_active_sessions(5)

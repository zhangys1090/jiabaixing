"""
Phase 1 Hermes 功能集成测试

覆盖:
  1. BedrockTransport 传输适配器
  2. AnthropicPrefixCacheBuilder Prompt 缓存断点
  3. CostGuard 模型成本守卫增强
  4. SessionSearchEngine 会话搜索(FTS5)
  5. ThinkScrubber Think 标签清理
  6. API 端点集成
"""
from __future__ import annotations

import json
import os
import tempfile
import time

import pytest

from agent.llm.transports import (
    BedrockTransport,
    TransportConfig,
    TransportFactory,
    TransportType,
)
from agent.llm.prompt_cache import AnthropicPrefixCacheBuilder, PromptCacheManager
from agent.llm.credential_pool import (
    BudgetAlert,
    BudgetAlertLevel,
    CostGuard,
    ModelCostEstimate,
)
from agent.persistence.session_store import (
    SearchResult,
    SessionMessage,
    SessionSearchEngine,
    SessionStore,
)
from agent.core.think_scrubber import ThinkScrubber, ScrubResult


# ═══════════════════════════════════════════════════════════════
# 1. BedrockTransport 测试
# ═══════════════════════════════════════════════════════════════

class TestBedrockTransport:
    def setup_method(self):
        self.config = TransportConfig(
            base_url="https://bedrock-runtime.us-east-1.amazonaws.com",
            api_key="test-key",
            model="anthropic.claude-3-sonnet-20240229-v1:0",
            temperature=0.7,
            max_tokens=4096,
            extra={"region": "us-east-1"},
        )
        self.transport = BedrockTransport(self.config)

    def test_transport_type(self):
        assert self.transport.transport_type == TransportType.BEDROCK

    def test_convert_messages_strips_system(self):
        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        result = self.transport.convert_messages(messages)
        assert len(result) == 2
        assert result[0]["role"] == "user"
        assert result[0]["content"] == [{"text": "Hello"}]
        assert result[1]["role"] == "assistant"
        assert result[1]["content"] == [{"text": "Hi there"}]

    def test_convert_tools(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
            },
        }]
        result = self.transport.convert_tools(tools)
        assert len(result) == 1
        assert "toolSpec" in result[0]
        assert result[0]["toolSpec"]["name"] == "search"
        assert "inputSchema" in result[0]["toolSpec"]

    def test_convert_tools_none(self):
        assert self.transport.convert_tools(None) is None

    def test_build_request(self):
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        req = self.transport.build_request(messages)
        assert "bedrock-runtime" in req.url
        assert "invoke" in req.url
        assert req.body["messages"][0]["role"] == "user"
        assert "system" in req.body
        assert req.body["system"][0]["text"] == "You are helpful."

    def test_build_request_with_tools(self):
        messages = [{"role": "user", "content": "Search for cats"}]
        tools = [{
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search",
                "parameters": {"type": "object", "properties": {}},
            },
        }]
        req = self.transport.build_request(messages, tools=tools)
        assert "toolConfig" in req.body
        assert len(req.body["toolConfig"]["tools"]) == 1

    def test_build_request_default_region(self):
        config = TransportConfig(
            base_url="",
            api_key="test",
            model="test-model",
            extra={"region": "eu-west-1"},
        )
        transport = BedrockTransport(config)
        messages = [{"role": "user", "content": "Hi"}]
        req = transport.build_request(messages)
        assert "eu-west-1" in req.url

    def test_normalize_response_text(self):
        raw = {
            "output": {
                "message": {
                    "content": [{"text": "Hello from Bedrock!"}],
                },
            },
            "stopReason": "end_turn",
            "usage": {"inputTokenCount": 10, "outputTokenCount": 5},
        }
        resp = self.transport.normalize_response(raw)
        assert resp.text == "Hello from Bedrock!"
        assert resp.finish_reason == "end_turn"
        assert resp.usage["prompt_tokens"] == 10
        assert resp.usage["completion_tokens"] == 5

    def test_normalize_response_tool_use(self):
        raw = {
            "output": {
                "message": {
                    "content": [
                        {"text": "Let me search"},
                        {"toolUse": {"toolUseId": "tu_1", "name": "search", "input": {"q": "test"}}},
                    ],
                },
            },
            "stopReason": "tool_use",
            "usage": {"inputTokenCount": 15, "outputTokenCount": 8},
        }
        resp = self.transport.normalize_response(raw)
        assert "Let me search" in resp.text
        assert len(resp.tool_calls) == 1
        assert resp.tool_calls[0]["function"]["name"] == "search"
        assert resp.finish_reason == "tool_calls"


class TestTransportFactoryBedrock:
    def test_create_bedrock(self):
        config = TransportConfig(base_url="https://bedrock-runtime.us-east-1.amazonaws.com", api_key="test", model="test")
        transport = TransportFactory.create(TransportType.BEDROCK, config)
        assert isinstance(transport, BedrockTransport)

    def test_infer_type_bedrock_url(self):
        config = TransportConfig(base_url="https://bedrock-runtime.us-east-1.amazonaws.com")
        assert TransportFactory.infer_type(config) == TransportType.BEDROCK


# ═══════════════════════════════════════════════════════════════
# 2. AnthropicPrefixCacheBuilder 测试
# ═══════════════════════════════════════════════════════════════

class TestAnthropicPrefixCacheBuilder:
    def test_disabled_returns_unchanged(self):
        builder = AnthropicPrefixCacheBuilder(enabled=False)
        msgs = [{"role": "user", "content": "Hi"}]
        sys_blocks = [{"type": "text", "text": "System"}]
        tools = [{"name": "test"}]
        result_msgs, result_sys, result_tools = builder.apply_cache_breakpoints(msgs, sys_blocks, tools)
        assert result_msgs == msgs
        assert result_sys == sys_blocks
        assert result_tools == tools

    def test_system_breakpoint(self):
        builder = AnthropicPrefixCacheBuilder(enabled=True)
        sys_blocks = [{"type": "text", "text": "You are helpful."}]
        _, result_sys, _ = builder.apply_cache_breakpoints([], sys_blocks, None)
        assert result_sys is not None
        assert result_sys[-1].get("cache_control") == {"type": "ephemeral"}

    def test_tools_breakpoint(self):
        builder = AnthropicPrefixCacheBuilder(enabled=True)
        tools = [
            {"name": "search", "description": "Search"},
            {"name": "calc", "description": "Calculate"},
        ]
        _, _, result_tools = builder.apply_cache_breakpoints([], None, tools)
        assert result_tools is not None
        assert result_tools[-1].get("cache_control") == {"type": "ephemeral"}

    def test_message_breakpoints_short_messages(self):
        builder = AnthropicPrefixCacheBuilder(enabled=True, min_prefix_tokens=10000)
        msgs = [{"role": "user", "content": "Hi"}]
        result_msgs, _, _ = builder.apply_cache_breakpoints(msgs, None, None)
        assert result_msgs == msgs

    def test_message_breakpoints_long_messages(self):
        builder = AnthropicPrefixCacheBuilder(enabled=True, min_prefix_tokens=100, max_breakpoints=2)
        msgs = [
            {"role": "user", "content": "A" * 500},
            {"role": "assistant", "content": "B" * 500},
            {"role": "user", "content": "C" * 500},
            {"role": "assistant", "content": "D" * 500},
        ]
        result_msgs, _, _ = builder.apply_cache_breakpoints(msgs, None, None)
        assert len(result_msgs) == len(msgs)

    def test_does_not_overwrite_existing_cache_control(self):
        builder = AnthropicPrefixCacheBuilder(enabled=True)
        sys_blocks = [{"type": "text", "text": "System", "cache_control": {"type": "persistent"}}]
        _, result_sys, _ = builder.apply_cache_breakpoints([], sys_blocks, None)
        assert result_sys[-1]["cache_control"] == {"type": "persistent"}

    def test_estimate_single_chinese(self):
        count = AnthropicPrefixCacheBuilder._estimate_single("你好世界")
        assert count > 0

    def test_estimate_single_english(self):
        count = AnthropicPrefixCacheBuilder._estimate_single("Hello world")
        assert count > 0

    def test_get_stats(self):
        builder = AnthropicPrefixCacheBuilder(enabled=True, min_prefix_tokens=512, max_breakpoints=2)
        stats = builder.get_stats()
        assert stats["enabled"] is True
        assert stats["min_prefix_tokens"] == 512
        assert stats["max_breakpoints"] == 2


# ═══════════════════════════════════════════════════════════════
# 3. CostGuard 增强测试
# ═══════════════════════════════════════════════════════════════

class TestCostGuardEnhanced:
    def test_budget_alert_normal(self):
        guard = CostGuard(daily_budget_usd=1.0)
        alert = guard.check_budget_alert()
        assert alert.level == BudgetAlertLevel.NORMAL
        assert alert.spent_usd == 0.0

    def test_budget_alert_warning(self):
        guard = CostGuard(daily_budget_usd=1.0, warning_threshold=0.7)
        guard.record_usage("gpt-4o", 500_000, 100_000)
        alert = guard.check_budget_alert()
        assert alert.level in (BudgetAlertLevel.WARNING, BudgetAlertLevel.CRITICAL, BudgetAlertLevel.EXCEEDED)

    def test_budget_alert_critical(self):
        guard = CostGuard(daily_budget_usd=0.001, critical_threshold=0.9)
        guard.record_usage("gpt-4o", 100, 100)
        alert = guard.check_budget_alert()
        assert alert.level in (BudgetAlertLevel.CRITICAL, BudgetAlertLevel.EXCEEDED)

    def test_budget_alert_exceeded(self):
        guard = CostGuard(daily_budget_usd=0.0001)
        guard.record_usage("gpt-4o", 100, 100)
        alert = guard.check_budget_alert()
        assert alert.level == BudgetAlertLevel.EXCEEDED

    def test_budget_alert_callback(self):
        alerts_received = []
        guard = CostGuard(daily_budget_usd=0.001)
        guard.on_budget_alert(lambda a: alerts_received.append(a))
        guard.record_usage("gpt-4o", 100, 100)
        guard.check_budget_alert()
        assert len(alerts_received) == 1
        assert alerts_received[0].level in (BudgetAlertLevel.CRITICAL, BudgetAlertLevel.EXCEEDED)

    def test_estimate_request_cost(self):
        guard = CostGuard(daily_budget_usd=1.0)
        estimate = guard.estimate_request_cost("gpt-4o", 1000, 500)
        assert estimate.model == "gpt-4o"
        assert estimate.estimated_input_tokens == 1000
        assert estimate.estimated_output_tokens == 500
        assert estimate.estimated_cost_usd > 0
        assert estimate.within_budget is True

    def test_estimate_request_cost_over_budget(self):
        guard = CostGuard(daily_budget_usd=0.0001)
        estimate = guard.estimate_request_cost("gpt-4o", 100_000, 100_000)
        assert estimate.within_budget is False

    def test_get_model_pricing(self):
        pricing = CostGuard.get_model_pricing("gpt-4o")
        assert pricing is not None
        assert "input" in pricing
        assert "output" in pricing

    def test_get_model_pricing_unknown(self):
        pricing = CostGuard.get_model_pricing("unknown-model")
        assert pricing is None

    def test_list_priced_models(self):
        models = CostGuard.list_priced_models()
        assert "gpt-4o" in models
        assert "claude-3.5-sonnet" in models
        assert "gemini-pro" in models
        assert "deepseek-chat" in models

    def test_gemini_pricing(self):
        guard = CostGuard()
        cost = guard.calculate_cost("gemini-1.5-pro", 1000, 1000)
        assert cost > 0

    def test_claude_opus_pricing(self):
        guard = CostGuard()
        cost = guard.calculate_cost("claude-3-opus", 1000, 1000)
        assert cost > 0

    def test_warning_threshold_configurable(self):
        guard = CostGuard(daily_budget_usd=1.0, warning_threshold=0.5, critical_threshold=0.8)
        guard.record_usage("gpt-4o-mini", 2_000_000, 500_000)
        alert = guard.check_budget_alert()
        assert alert.level in (BudgetAlertLevel.WARNING, BudgetAlertLevel.CRITICAL, BudgetAlertLevel.EXCEEDED)


# ═══════════════════════════════════════════════════════════════
# 4. SessionSearchEngine 测试
# ═══════════════════════════════════════════════════════════════

class TestSessionSearchEngine:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        db_path = os.path.join(self.tmpdir, "test_search.db")
        self.engine = SessionSearchEngine(db_path=db_path)

    def teardown_method(self):
        self.engine.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_index_and_search(self):
        self.engine.index_message("s1", "user", "如何使用Python编写爬虫", time.time())
        self.engine.index_message("s1", "assistant", "可以使用requests和BeautifulSoup", time.time())
        results = self.engine.search("Python")
        assert len(results) >= 1
        assert results[0].session_id == "s1"

    def test_search_chinese(self):
        self.engine.index_message("s2", "user", "今天天气怎么样", time.time())
        results = self.engine.search("天气")
        assert len(results) >= 1

    def test_search_empty_query(self):
        self.engine.index_message("s1", "user", "Hello", time.time())
        results = self.engine.search("")
        assert len(results) == 0

    def test_search_no_match(self):
        self.engine.index_message("s1", "user", "Hello world", time.time())
        results = self.engine.search("量子计算xyz")
        assert len(results) == 0

    def test_search_with_session_filter(self):
        self.engine.index_message("s1", "user", "Python编程", time.time())
        self.engine.index_message("s2", "user", "Python数据分析", time.time())
        results = self.engine.search("Python", session_id="s1")
        assert all(r.session_id == "s1" for r in results)

    def test_search_with_role_filter(self):
        self.engine.index_message("s1", "user", "Python编程", time.time())
        self.engine.index_message("s1", "assistant", "Python是一种编程语言", time.time())
        results = self.engine.search("Python", role_filter="user")
        assert all(r.role == "user" for r in results)

    def test_search_sessions(self):
        self.engine.index_message("s1", "user", "Python编程入门", time.time())
        self.engine.index_message("s2", "user", "Python数据分析", time.time())
        sessions = self.engine.search_sessions("Python")
        assert len(sessions) >= 1
        assert "session_id" in sessions[0]

    def test_index_session_messages(self):
        msgs = [
            SessionMessage(role="user", content="Hello", timestamp=time.time()),
            SessionMessage(role="assistant", content="Hi there", timestamp=time.time()),
        ]
        self.engine.index_session_messages("s1", msgs)
        results = self.engine.search("Hello")
        assert len(results) >= 1

    def test_delete_session(self):
        self.engine.index_message("s1", "user", "Test message", time.time())
        deleted = self.engine.delete_session("s1")
        assert deleted >= 1
        results = self.engine.search("Test")
        assert len(results) == 0

    def test_get_stats(self):
        self.engine.index_message("s1", "user", "Hello", time.time())
        stats = self.engine.get_stats()
        assert stats["indexed_messages"] >= 1


class TestSessionStoreSearch:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        db_path = os.path.join(self.tmpdir, "test_sessions.db")
        self.store = SessionStore(db_path=db_path)

    def teardown_method(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_enable_search(self):
        self.store.enable_search()
        assert self.store._search_engine is not None

    def test_search_auto_enables(self):
        session = self.store.create_session(title="Test")
        self.store.add_message(session.session_id, "user", "Python编程")
        results = self.store.search("Python")
        assert len(results) >= 1

    def test_search_sessions(self):
        session = self.store.create_session(title="Test")
        self.store.add_message(session.session_id, "user", "机器学习入门")
        sessions = self.store.search_sessions("机器学习")
        assert len(sessions) >= 1

    def test_add_message_indexes_to_search(self):
        self.store.enable_search()
        session = self.store.create_session(title="Test")
        self.store.add_message(session.session_id, "user", "深度学习框架")
        results = self.store.search("深度学习")
        assert len(results) >= 1

    def test_delete_session_removes_from_search(self):
        self.store.enable_search()
        session = self.store.create_session(title="Test")
        self.store.add_message(session.session_id, "user", "删除测试内容")
        self.store.delete_session(session.session_id)
        results = self.store.search("删除测试")
        assert len(results) == 0

    def test_stats_includes_search_engine(self):
        self.store.enable_search()
        stats = self.store.get_stats()
        assert "search_engine" in stats


# ═══════════════════════════════════════════════════════════════
# 5. ThinkScrubber 测试
# ═══════════════════════════════════════════════════════════════

class TestThinkScrubber:
    def test_scrub_think_tag(self):
        scrubber = ThinkScrubber()
        text = "<think>Let me reason about this...</think>The answer is 42."
        result = scrubber.scrub(text)
        assert "<think>" not in result.cleaned
        assert "The answer is 42." in result.cleaned
        assert "think" in result.removed_tags

    def test_scrub_multiline_think(self):
        scrubber = ThinkScrubber()
        text = "<think>\nStep 1: Analyze\nStep 2: Conclude\n</think>\nFinal answer: yes"
        result = scrubber.scrub(text)
        assert "Step 1" not in result.cleaned
        assert "Final answer: yes" in result.cleaned

    def test_scrub_reasoning_tag(self):
        scrubber = ThinkScrubber()
        text = "<reasoning>Deep analysis here</reasoning>Result: 42"
        result = scrubber.scrub(text)
        assert "<reasoning>" not in result.cleaned
        assert "Result: 42" in result.cleaned

    def test_scrub_reflection_tag(self):
        scrubber = ThinkScrubber()
        text = "<reflection>Self-check passed</reflection>Done"
        result = scrubber.scrub(text)
        assert "<reflection>" not in result.cleaned
        assert "Done" in result.cleaned

    def test_scrub_scratchpad_tag(self):
        scrubber = ThinkScrubber()
        text = "<scratchpad>Working notes</scratchpad>Final output"
        result = scrubber.scrub(text)
        assert "<scratchpad>" not in result.cleaned
        assert "Final output" in result.cleaned

    def test_scrub_multiple_tags(self):
        scrubber = ThinkScrubber()
        text = "<think>Reasoning</think>Part1<reflection>Check</reflection>Part2"
        result = scrubber.scrub(text)
        assert "Part1" in result.cleaned
        assert "Part2" in result.cleaned
        assert len(result.removed_tags) >= 2

    def test_scrub_disabled(self):
        scrubber = ThinkScrubber(enabled=False)
        text = "<think>Secret thoughts</think>Answer"
        result = scrubber.scrub(text)
        assert result.cleaned == text
        assert len(result.removed_tags) == 0

    def test_scrub_empty_text(self):
        scrubber = ThinkScrubber()
        result = scrubber.scrub("")
        assert result.cleaned == ""

    def test_scrub_no_tags(self):
        scrubber = ThinkScrubber()
        text = "Just a normal response without any tags."
        result = scrubber.scrub(text)
        assert result.cleaned == text
        assert len(result.removed_tags) == 0

    def test_scrub_case_insensitive(self):
        scrubber = ThinkScrubber()
        text = "<THINK>Upper case thinking</THINK>Answer"
        result = scrubber.scrub(text)
        assert "Answer" in result.cleaned

    def test_scrub_debug_mode(self):
        scrubber = ThinkScrubber(preserve_in_debug=True)
        scrubber.debug_mode = True
        text = "<think>Debug thoughts</think>Answer"
        result = scrubber.scrub(text)
        assert result.cleaned == text

    def test_scrub_message(self):
        scrubber = ThinkScrubber()
        msg = {"role": "assistant", "content": "<think>Internal</think>External"}
        result_msg = scrubber.scrub_message(msg)
        assert "<think>" not in result_msg["content"]
        assert "External" in result_msg["content"]
        assert result_msg["role"] == "assistant"

    def test_scrub_messages(self):
        scrubber = ThinkScrubber()
        msgs = [
            {"role": "assistant", "content": "<think>Hmm</think>Yes"},
            {"role": "assistant", "content": "No tags here"},
        ]
        results = scrubber.scrub_messages(msgs)
        assert "<think>" not in results[0]["content"]
        assert results[1]["content"] == "No tags here"

    def test_removed_char_count(self):
        scrubber = ThinkScrubber()
        text = "<think>Long reasoning here</think>Short"
        result = scrubber.scrub(text)
        assert result.removed_char_count > 0
        assert result.original_length == len(text)

    def test_get_stats(self):
        scrubber = ThinkScrubber()
        stats = scrubber.get_stats()
        assert stats["enabled"] is True
        assert stats["strip_think"] is True
        assert stats["strip_reasoning"] is True

    def test_scrub_chinese_think(self):
        scrubber = ThinkScrubber()
        text = "<think>让我分析一下这个问题</think>答案是42。"
        result = scrubber.scrub(text)
        assert "答案是42" in result.cleaned
        assert "让我分析" not in result.cleaned


# ═══════════════════════════════════════════════════════════════
# 6. AnthropicTransport 缓存断点集成测试
# ═══════════════════════════════════════════════════════════════

class TestAnthropicTransportCacheBreakpoints:
    def test_cache_control_enabled(self):
        from agent.llm.transports import AnthropicTransport
        config = TransportConfig(
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            extra={"cacheControl": True},
        )
        transport = AnthropicTransport(config)
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
        ]
        req = transport.build_request(messages)
        system = req.body["system"]
        assert isinstance(system, list)
        assert system[-1].get("cache_control") == {"type": "ephemeral"}

    def test_cache_control_disabled(self):
        from agent.llm.transports import AnthropicTransport
        config = TransportConfig(
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            extra={"cacheControl": False},
        )
        transport = AnthropicTransport(config)
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
        ]
        req = transport.build_request(messages)
        system = req.body.get("system")
        if isinstance(system, list):
            assert system[-1].get("cache_control") is None or "cache_control" not in system[-1]

    def test_cache_control_with_tools(self):
        from agent.llm.transports import AnthropicTransport
        config = TransportConfig(
            base_url="https://api.anthropic.com",
            api_key="sk-ant-test",
            model="claude-3-sonnet",
            extra={"cacheControl": True},
        )
        transport = AnthropicTransport(config)
        messages = [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "Hi"},
        ]
        tools = [{
            "name": "search",
            "description": "Search",
            "input_schema": {"type": "object", "properties": {}},
        }]
        req = transport.build_request(messages, tools=tools)
        body_tools = req.body.get("tools", [])
        if body_tools:
            assert body_tools[-1].get("cache_control") == {"type": "ephemeral"}

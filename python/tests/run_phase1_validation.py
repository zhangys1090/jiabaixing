"""Quick validation script for Phase 1 Hermes integration."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

def test_bedrock_transport():
    from agent.llm.transports import BedrockTransport, TransportConfig, TransportType, TransportFactory
    config = TransportConfig(
        base_url="https://bedrock-runtime.us-east-1.amazonaws.com",
        api_key="test-key",
        model="anthropic.claude-3-sonnet-20240229-v1:0",
        extra={"region": "us-east-1"},
    )
    transport = BedrockTransport(config)
    assert transport.transport_type == TransportType.BEDROCK

    messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hello"},
    ]
    converted = transport.convert_messages(messages)
    assert len(converted) == 1
    assert converted[0]["role"] == "user"
    assert converted[0]["content"] == [{"text": "Hello"}]

    tools = [{"type": "function", "function": {"name": "search", "description": "Search", "parameters": {"type": "object", "properties": {}}}}]
    converted_tools = transport.convert_tools(tools)
    assert len(converted_tools) == 1
    assert "toolSpec" in converted_tools[0]

    req = transport.build_request(converted, tools=converted_tools)
    assert "bedrock-runtime" in req.url
    assert "toolConfig" in req.body

    raw = {
        "output": {"message": {"content": [{"text": "Hello from Bedrock!"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokenCount": 10, "outputTokenCount": 5},
    }
    resp = transport.normalize_response(raw)
    assert resp.text == "Hello from Bedrock!"
    assert resp.usage["prompt_tokens"] == 10

    factory_transport = TransportFactory.create(TransportType.BEDROCK, config)
    assert isinstance(factory_transport, BedrockTransport)

    inferred = TransportFactory.infer_type(TransportConfig(base_url="https://bedrock-runtime.us-east-1.amazonaws.com"))
    assert inferred == TransportType.BEDROCK

    print("  [PASS] BedrockTransport")


def test_anthropic_prefix_cache():
    from agent.llm.prompt_cache import AnthropicPrefixCacheBuilder

    builder = AnthropicPrefixCacheBuilder(enabled=True)

    _, sys_blocks, _ = builder.apply_cache_breakpoints(
        [], [{"type": "text", "text": "System"}], None
    )
    assert sys_blocks[-1].get("cache_control") == {"type": "ephemeral"}

    _, _, tools = builder.apply_cache_breakpoints(
        [], None, [{"name": "a"}, {"name": "b"}]
    )
    assert tools[-1].get("cache_control") == {"type": "ephemeral"}

    builder_disabled = AnthropicPrefixCacheBuilder(enabled=False)
    msgs = [{"role": "user", "content": "Hi"}]
    r_msgs, r_sys, r_tools = builder_disabled.apply_cache_breakpoints(msgs, None, None)
    assert r_msgs == msgs

    print("  [PASS] AnthropicPrefixCacheBuilder")


def test_cost_guard_enhanced():
    from agent.llm.credential_pool import CostGuard, BudgetAlertLevel

    guard = CostGuard(daily_budget_usd=1.0, warning_threshold=0.7, critical_threshold=0.9)

    alert = guard.check_budget_alert()
    assert alert.level == BudgetAlertLevel.NORMAL

    guard.record_usage("gpt-4o", 500_000, 100_000)
    alert = guard.check_budget_alert()
    assert alert.level in (BudgetAlertLevel.WARNING, BudgetAlertLevel.CRITICAL, BudgetAlertLevel.EXCEEDED)

    alerts_received = []
    guard.on_budget_alert(lambda a: alerts_received.append(a))
    guard.check_budget_alert()
    assert len(alerts_received) == 1

    estimate = guard.estimate_request_cost("gpt-4o", 1000, 500)
    assert estimate.model == "gpt-4o"
    assert estimate.estimated_cost_usd > 0
    assert estimate.within_budget is True

    pricing = CostGuard.get_model_pricing("gpt-4o")
    assert pricing is not None
    assert "input" in pricing

    models = CostGuard.list_priced_models()
    assert "gpt-4o" in models
    assert "gemini-pro" in models
    assert "claude-3.5-sonnet" in models

    print("  [PASS] CostGuard Enhanced")


def test_session_search():
    import tempfile
    import time
    from agent.persistence.session_store import SessionSearchEngine, SessionStore, SessionMessage

    tmpdir = tempfile.mkdtemp()
    db_path = os.path.join(tmpdir, "test_search.db")
    engine = SessionSearchEngine(db_path=db_path)

    engine.index_message("s1", "user", "如何使用Python编写爬虫", time.time())
    engine.index_message("s1", "assistant", "可以使用requests和BeautifulSoup", time.time())
    results = engine.search("Python")
    assert len(results) >= 1
    assert results[0].session_id == "s1"

    results_filtered = engine.search("Python", session_id="s1")
    assert all(r.session_id == "s1" for r in results_filtered)

    engine.delete_session("s1")
    results_after_delete = engine.search("Python")
    assert len(results_after_delete) == 0

    engine.close()

    db_path2 = os.path.join(tmpdir, "test_sessions.db")
    store = SessionStore(db_path=db_path2)
    store.enable_search()
    session = store.create_session(title="Test")
    store.add_message(session.session_id, "user", "深度学习框架比较")
    search_results = store.search("深度学习")
    assert len(search_results) >= 1

    store.close()
    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)

    print("  [PASS] SessionSearchEngine")


def test_think_scrubber():
    from agent.core.think_scrubber import ThinkScrubber

    scrubber = ThinkScrubber()

    result = scrubber.scrub("<think>Let me reason about this...</think>The answer is 42.")
    assert "<think>" not in result.cleaned
    assert "The answer is 42." in result.cleaned
    assert "think" in result.removed_tags

    result2 = scrubber.scrub("<reasoning>Deep analysis</reasoning>Result: 42")
    assert "<reasoning>" not in result2.cleaned
    assert "Result: 42" in result2.cleaned

    result3 = scrubber.scrub("<reflection>Self-check</reflection>Done")
    assert "Done" in result3.cleaned

    result4 = scrubber.scrub("<scratchpad>Notes</scratchpad>Final")
    assert "Final" in result4.cleaned

    scrubber_disabled = ThinkScrubber(enabled=False)
    text = "<think>Secret</think>Answer"
    result5 = scrubber_disabled.scrub(text)
    assert result5.cleaned == text

    scrubber_debug = ThinkScrubber(preserve_in_debug=True)
    scrubber_debug.debug_mode = True
    result6 = scrubber_debug.scrub("<think>Debug</think>Answer")
    assert result6.cleaned == "<think>Debug</think>Answer"

    msg_result = scrubber.scrub_message({"role": "assistant", "content": "<think>Internal</think>External"})
    assert "External" in msg_result["content"]

    msgs_result = scrubber.scrub_messages([
        {"role": "assistant", "content": "<think>Hmm</think>Yes"},
        {"role": "assistant", "content": "No tags"},
    ])
    assert "<think>" not in msgs_result[0]["content"]
    assert msgs_result[1]["content"] == "No tags"

    print("  [PASS] ThinkScrubber")


def test_anthropic_transport_cache():
    from agent.llm.transports import AnthropicTransport, TransportConfig

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

    print("  [PASS] AnthropicTransport Cache Breakpoints")


if __name__ == "__main__":
    print("=" * 60)
    print("Phase 1 Hermes Integration Validation")
    print("=" * 60)

    tests = [
        ("1. BedrockTransport", test_bedrock_transport),
        ("2. AnthropicPrefixCacheBuilder", test_anthropic_prefix_cache),
        ("3. CostGuard Enhanced", test_cost_guard_enhanced),
        ("4. SessionSearchEngine", test_session_search),
        ("5. ThinkScrubber", test_think_scrubber),
        ("6. AnthropicTransport Cache", test_anthropic_transport_cache),
    ]

    passed = 0
    failed = 0
    for name, test_fn in tests:
        try:
            test_fn()
            passed += 1
        except Exception as e:
            print(f"  [FAIL] {name}: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    print("=" * 60)

    if failed > 0:
        sys.exit(1)

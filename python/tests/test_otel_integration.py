"""OpenTelemetry 集成测试 — 验证审计断层修复后的端到端联通。

覆盖两个关键集成点：
1. LLM Token 计数：LLMProvider 在 _do_chat_via_litellm / _do_chat_via_transport
   成功调用后，通过 _record_llm_tokens 将 usage 记录到 OTel Counter。
2. 活跃会话 Gauge：AgentEngine.process_input 在进入时递增、
   在 finally 块递减，并通过 set_active_sessions 同步到 OTel ObservableGauge。

测试规则:
    - 不连接真实 LLM API，通过 unittest.mock 模拟 acompletion 响应
    - 不连接真实 OTLP collector，OTEL_ENABLED=false 时使用 NoOp Counter
    - 通过 spy/patch 验证 set_active_sessions 与 llm_tokens_counter 的调用
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.core.otel_metrics import (
    _reset_meter_for_testing,
    llm_tokens_counter,
    set_active_sessions,
)


@pytest.fixture(autouse=True)
def _reset_otel_state():
    """每个测试前后重置 OTel meter 全局状态，确保测试间隔离。"""
    _reset_meter_for_testing()
    yield
    _reset_meter_for_testing()


class TestLLMTokensRecorded:
    """LLM Token Counter 集成测试。"""

    def test_record_llm_tokens_calls_counter_add(self, monkeypatch):
        """测试 _record_llm_tokens 在传入 usage 时调用 counter.add。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        from agent.llm.provider import _record_llm_tokens

        # 用 spy 替换 llm_tokens_counter 返回的 Counter
        counter_spy = MagicMock()
        with patch(
            "agent.llm.provider.llm_tokens_counter", return_value=counter_spy
        ):
            _record_llm_tokens(
                model="gpt-4o",
                usage={"input_tokens": 100, "output_tokens": 50},
            )
        # 应分别针对 prompt 与 completion 调用 add
        assert counter_spy.add.call_count == 2
        # 第一次：prompt tokens
        first_call = counter_spy.add.call_args_list[0]
        assert first_call.args[0] == 100
        assert first_call.args[1] == {"model": "gpt-4o", "type": "prompt"}
        # 第二次：completion tokens
        second_call = counter_spy.add.call_args_list[1]
        assert second_call.args[0] == 50
        assert second_call.args[1] == {"model": "gpt-4o", "type": "completion"}

    def test_record_llm_tokens_skips_when_usage_none(self, monkeypatch):
        """测试 usage 为 None 或空字典时跳过记录。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        from agent.llm.provider import _record_llm_tokens

        counter_spy = MagicMock()
        with patch(
            "agent.llm.provider.llm_tokens_counter", return_value=counter_spy
        ):
            _record_llm_tokens(model="gpt-4o", usage=None)
            _record_llm_tokens(model="gpt-4o", usage={})

        assert counter_spy.add.call_count == 0

    @pytest.mark.asyncio
    async def test_llm_tokens_recorded_after_litellm_chat(self, monkeypatch):
        """测试 _do_chat_via_litellm 在成功调用后记录 token 到 OTel Counter。

        通过 mock litellm.acompletion 返回带 usage 的响应，验证
        _record_llm_tokens 被调用且传入正确的 model 与 usage 字典。
        """
        monkeypatch.setenv("OTEL_ENABLED", "false")

        # 构造 mock acompletion 响应（带 usage）
        mock_message = MagicMock()
        mock_message.content = "你好，我是家百星"
        mock_message.role = "assistant"
        mock_message.tool_calls = None
        mock_choice = MagicMock()
        mock_choice.message = mock_message
        mock_choice.finish_reason = "stop"
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_response.usage = MagicMock(
            prompt_tokens=120, completion_tokens=30
        )

        from agent.llm.provider import LLMProvider

        with patch(
            "agent.llm.provider.acompletion", new=AsyncMock(return_value=mock_response)
        ) as mock_acomplete, patch(
            "agent.llm.provider._record_llm_tokens"
        ) as record_spy:
            provider = LLMProvider()
            # 跳过 transport 路径，强制走 litellm
            provider._transport_cache.clear()
            with patch.object(
                provider, "_resolve_transport", return_value=None
            ):
                result = await provider._do_chat_via_litellm(
                    messages=[{"role": "user", "content": "你好"}],
                    tools=None,
                    stream=False,
                )

            # acompletion 应被调用
            assert mock_acomplete.called
            # 结果应包含 usage
            assert result.get("usage") == {"input_tokens": 120, "output_tokens": 30}
            # _record_llm_tokens 应被调用，传入 effective_model 与 usage
            assert record_spy.called
            call_args = record_spy.call_args
            # call_args.args[0] 是 model，call_args.args[1] 是 usage
            assert call_args.args[1] == {"input_tokens": 120, "output_tokens": 30}

    @pytest.mark.asyncio
    async def test_llm_tokens_recorded_after_transport_chat(self, monkeypatch):
        """测试 _do_chat_via_transport 在成功调用后记录 token 到 OTel Counter。

        通过 mock httpx 请求返回带 usage 的响应，验证 _record_llm_tokens 被调用。
        """
        monkeypatch.setenv("OTEL_ENABLED", "false")

        # 构造 mock transport 响应
        mock_transport_resp = MagicMock()
        mock_transport_resp.text = "测试响应"
        mock_transport_resp.role = "assistant"
        mock_transport_resp.finish_reason = "stop"
        mock_transport_resp.tool_calls = None
        mock_transport_resp.usage = {"prompt_tokens": 80, "completion_tokens": 20}

        mock_transport = MagicMock()
        mock_transport.convert_messages.return_value = []
        mock_transport.convert_tools.return_value = None
        mock_request = MagicMock()
        mock_request.method = "POST"
        mock_request.url = "http://example.com/v1/chat/completions"
        mock_request.headers = {}
        mock_request.body = {}
        mock_transport.build_request.return_value = mock_request
        mock_transport.normalize_response.return_value = mock_transport_resp

        # mock httpx.AsyncClient
        mock_http_resp = MagicMock()
        mock_http_resp.json.return_value = {}
        mock_http_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_http_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        from agent.llm.provider import LLMProvider

        with patch(
            "agent.llm.provider.httpx.AsyncClient", return_value=mock_client
        ), patch(
            "agent.llm.provider._record_llm_tokens"
        ) as record_spy:
            provider = LLMProvider()
            result = await provider._do_chat_via_transport(
                transport=mock_transport,
                messages=[{"role": "user", "content": "测试"}],
                tools=None,
            )

            assert result.get("usage") == {"input_tokens": 80, "output_tokens": 20}
            assert record_spy.called
            call_args = record_spy.call_args
            assert call_args.args[1] == {"input_tokens": 80, "output_tokens": 20}


class TestActiveSessionsGaugeUpdated:
    """活跃会话 Gauge 集成测试 — 验证 process_input 更新 gauge。"""

    @pytest.mark.asyncio
    async def test_active_sessions_gauge_updated(self, monkeypatch):
        """测试 AgentEngine.process_input 进入/退出时调用 set_active_sessions。

        验证:
        - 进入 process_input 时 _active_sessions 递增为 1，调用 set_active_sessions(1)
        - 退出 finally 块时 _active_sessions 递减为 0，调用 set_active_sessions(0)
        """
        monkeypatch.setenv("OTEL_ENABLED", "false")
        monkeypatch.setenv("REDIS_ENABLED", "false")

        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        # 不调用 initialize()，避免触发 LLM/Redis/OTel 等依赖初始化
        # 直接走 _process_simple 路径，需要 mock self.llm.chat
        engine.llm = MagicMock()
        engine.llm.chat = AsyncMock(return_value={"content": "测试响应"})

        # 用 spy 替换 engine 模块中的 set_active_sessions
        call_log: list[int] = []
        original_set = set_active_sessions

        def _spy(count: int) -> None:
            call_log.append(count)
            original_set(count)

        with patch("agent.core.engine.set_active_sessions", side_effect=_spy):
            result = await engine.process_input(
                message="你好",
                session_id="test-session",
                use_loop=False,
                use_tools=False,
            )

        # 应返回非空响应
        assert result.get("content") == "测试响应"
        # set_active_sessions 应被调用至少两次：递增到 1，递减到 0
        assert len(call_log) >= 2, f"expected >=2 calls, got {call_log}"
        assert call_log[0] == 1, f"first call should be 1, got {call_log[0]}"
        assert call_log[-1] == 0, f"last call should be 0, got {call_log[-1]}"
        # _active_sessions 内部状态应为 0
        assert engine._active_sessions == 0

    @pytest.mark.asyncio
    async def test_active_sessions_decremented_on_exception(self, monkeypatch):
        """测试 process_input 抛异常时 finally 块仍递减 gauge。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        monkeypatch.setenv("REDIS_ENABLED", "false")

        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        # 让所有路径都抛异常
        engine.llm = MagicMock()
        engine.llm.chat = AsyncMock(side_effect=RuntimeError("test error"))
        # 跳过 security/hook_manager 等检查
        engine.security = None
        engine.hook_manager = None
        engine.feedback_loops = None

        call_log: list[int] = []
        original_set = set_active_sessions

        def _spy(count: int) -> None:
            call_log.append(count)
            original_set(count)

        with patch("agent.core.engine.set_active_sessions", side_effect=_spy):
            with pytest.raises(RuntimeError, match="test error"):
                await engine.process_input(
                    message="触发异常",
                    session_id="test-err",
                    use_loop=False,
                    use_tools=False,
                )

        # 即使抛异常，finally 块也应递减
        assert len(call_log) >= 2, f"expected >=2 calls, got {call_log}"
        assert call_log[0] == 1
        assert call_log[-1] == 0
        assert engine._active_sessions == 0

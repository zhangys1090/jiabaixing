import asyncio, sys
from unittest.mock import patch
sys.path.insert(0, ".")

from agent.llm.provider import LLMProvider

class _Msg:
    content = "缓存内容-ABC"
    role = "assistant"
    tool_calls = None
class _Choice:
    message = _Msg()
    finish_reason = "stop"
class _Resp:
    choices = [_Choice()]
    usage = None

async def main():
    p = LLMProvider()
    p.tiered_cache.clear()
    msgs = [{"role": "user", "content": "W3 缓存键一致性验证"}]
    SYS = "你是家百星助手（真实 system prompt）"

    async def fake_acompletion(**kw):
        return _Resp()

    with patch("agent.llm.provider.acompletion", side_effect=fake_acompletion):
        r = await p._do_chat_via_litellm(msgs, None, False, None, system_prompt=SYS)
        print("写入完成 content =", r["content"])

    hit = p.tiered_cache.get(msgs, p.model, system_prompt=SYS, tools=None)
    print("读路径(真实 system_prompt) ->", repr(hit))
    print("stats:", p.tiered_cache.stats())
    p.tiered_cache.clear()
    return hit

hit = asyncio.run(main())
print("\n结论:", "PASS 缓存命中" if hit == "缓存内容-ABC" else "FAIL 仍未命中")

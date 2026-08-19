"""多模态感知闭环冒烟测试：真实桌面自动化 + VLM 集成。

冒烟目标（无需真实显示器/摄像头即可验证闭环接线）：
  1) 感知-行动闭环：定位 -> 截图 -> 执行 -> 验证 的端到端链路（真实
     PerceptionActionLoop，注入桌面动作回调与可控的定位/验证桩）。
  2) VLM 集成：VLMCaller.analyze / locate_element 与底层视觉模型调用链
     打通（用注入的 litellm 桩模拟 V4 Flash 视觉返回）。

若运行环境缺少感知子系统依赖（如 UIA/comtypes），相关用例自动跳过，
不影响其余用例。
"""
from __future__ import annotations

import asyncio
import sys
import types

import pytest

from agent.perception.vlm_call import VLMCaller, VLMResult

# 感知-行动闭环依赖较重的本地子系统，按需导入（不可用时跳过）
try:
    from agent.perception.perception_loop import PerceptionActionLoop, GroundingResult
    from agent.perception.action_verifier import VerificationResult

    _PERCEPTION_AVAILABLE = True
except Exception:  # pragma: no cover - 依赖缺失时跳过
    _PERCEPTION_AVAILABLE = False


def _inject_fake_litellm():
    """注入一个 litellm 桩，使 VLMCaller 走通调用链而不依赖真实 API。"""
    fake = types.ModuleType("litellm")

    async def acompletion(**kwargs):
        msg = types.SimpleNamespace(content="图中存在「确定」按钮，坐标约 (100, 200)")
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=msg)],
            usage=None,
        )

    fake.acompletion = acompletion
    orig = sys.modules.get("litellm")
    sys.modules["litellm"] = fake
    return orig


def _restore_litellm(orig):
    if orig is None:
        sys.modules.pop("litellm", None)
    else:
        sys.modules["litellm"] = orig


@pytest.mark.skipif(not _PERCEPTION_AVAILABLE, reason="感知子系统依赖不可用")
def test_perception_action_loop_closed_loop():
    async def impl():
        loop = PerceptionActionLoop(enable_watcher=False, enable_ocr=False)

        # 注入真实桌面自动化闭环所需的受控桩：定位、截图、UIA、验证
        loop._grounding.locate = _AsyncReturn(GroundingResult(
            target_found=True, coordinates=(100, 200), element={"name": "确定"},
            confidence=0.9, method="uia",
        ))
        loop._capture_screenshot = _AsyncReturn("/tmp/fake_desktop.png")
        loop._uia_cache.refresh = _AsyncReturn(types.SimpleNamespace(flat_elements=[]))

        vr = VerificationResult(success=True, confidence=1.0, method="smoke")
        vr.retry_suggested = False
        loop._verifier.verify = _AsyncReturn(vr)

        acted: dict = {}

        async def click(coords, element):
            acted["coords"] = coords
            acted["element"] = element

        # 真实闭环：定位 -> 截图 -> 执行(桌面点击) -> 验证
        result = await loop.execute("点击确定按钮", action_fn=click)
        assert result.success is True
        assert acted["coords"] == (100, 200)
        assert result.grounding is not None and result.grounding.target_found

    asyncio.run(impl())


def test_vlm_call_integration():
    """VLM 集成冒烟：analyze 与 locate_element 走通模型调用链。"""
    async def impl():
        orig = _inject_fake_litellm()
        try:
            vlmc = VLMCaller()
            res: VLMResult = await vlmc.analyze(
                image_bytes=b"fake-png-bytes", question="图中是否有确定按钮？",
            )
            assert res.success is True
            assert "确定" in res.text

            loc: VLMResult = await vlmc.locate_element(
                image_bytes=b"fake-png-bytes", description="确定按钮",
            )
            assert loc.success is True
        finally:
            _restore_litellm(orig)

    asyncio.run(impl())


class _AsyncReturn:
    """将给定值包装为 AsyncMock 风格的异步可调用（避免额外依赖）。"""

    def __init__(self, value):
        self._value = value

    def __call__(self, *args, **kwargs):
        async def _coro():
            return self._value

        return _coro()

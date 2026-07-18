from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToneParams:
    """语气参数 — 控制回复的风格特征。

    Attributes:
        temperature: 创造性温度（0=精确，1=自由）。
        formality: 正式程度（0=轻松，1=正式）。
        verbosity: 冗长程度（0=简洁，1=详细）。
        emoji_frequency: 表情符号频率（0=无，1=频繁）。
        proactive: 是否主动提供建议。
    """

    temperature: float = 0.7
    formality: float = 0.5
    verbosity: float = 0.5
    emoji_frequency: float = 0.3
    proactive: bool = True


_SCENE_TONES: dict[str, ToneParams] = {
    "development": ToneParams(temperature=0.3, formality=0.7, verbosity=0.4, emoji_frequency=0.1, proactive=True),
    "work": ToneParams(temperature=0.5, formality=0.8, verbosity=0.5, emoji_frequency=0.2, proactive=True),
    "comfort": ToneParams(temperature=0.9, formality=0.3, verbosity=0.6, emoji_frequency=0.5, proactive=False),
    "greeting": ToneParams(temperature=0.8, formality=0.3, verbosity=0.4, emoji_frequency=0.6, proactive=True),
    "briefing": ToneParams(temperature=0.3, formality=0.9, verbosity=0.3, emoji_frequency=0.1, proactive=False),
    "daily": ToneParams(temperature=0.7, formality=0.5, verbosity=0.5, emoji_frequency=0.3, proactive=True),
}


class PersonaCore:
    """人格核心 — 管理角色名称、特质和场景语气。

    根据不同场景（开发、工作、关怀、问候、简报、日常）自动调整
    回复风格，支持场景覆盖和特质动态增删。

    Usage:
        persona = PersonaCore()
        summary = persona.build_persona_summary()
        tone = persona.get_tone_for_scene("development")
        instruction = persona.build_scene_tone_instruction("work")
    """

    def __init__(self) -> None:
        """初始化人格核心，使用默认名称和特质。"""
        self._name: str = "贾百姓"
        self._traits: list[str] = ["友好", "专业", "有耐心", "善于学习"]
        self._scene_overrides: dict[str, ToneParams] = {}

    @property
    def name(self) -> str:
        """获取角色名称。"""
        return self._name

    def build_persona_summary(self) -> str:
        """构建人格摘要文本，用于注入系统提示。

        Returns:
            str: 格式化的人格摘要（如"你是贾百姓，友好、专业、有耐心、善于学习。"）。
        """
        traits = "、".join(self._traits)
        return f"你是{self._name}，{traits}。"

    def get_tone_for_scene(self, scene: str) -> ToneParams:
        """获取指定场景的语气参数。

        优先返回用户覆盖的语气，否则返回预设场景语气，最终降级到 daily。

        Args:
            scene: 场景名称（development/work/comfort/greeting/briefing/daily）。

        Returns:
            ToneParams: 语气参数实例。
        """
        if scene in self._scene_overrides:
            return self._scene_overrides[scene]
        return _SCENE_TONES.get(scene, _SCENE_TONES["daily"])

    def build_scene_tone_instruction(self, scene: str) -> str:
        """根据场景语气参数构建 LLM 指令文本。

        将 temperature、formality、verbosity、emoji_frequency、proactive
        五个维度转化为中文指令片段，用分号连接。

        Args:
            scene: 场景名称。

        Returns:
            str: 语气指令文本，空字符串表示无特殊指令。
        """
        tone = self.get_tone_for_scene(scene)
        instructions: list[str] = []
        if tone.temperature < 0.4:
            instructions.append("回答要精确、简洁，避免模糊")
        elif tone.temperature > 0.7:
            instructions.append("可以更自由、有创意地回答")

        if tone.formality > 0.7:
            instructions.append("使用正式、专业的语气")
        elif tone.formality < 0.4:
            instructions.append("使用轻松、亲切的语气")

        if tone.verbosity < 0.4:
            instructions.append("回答要简洁，不要冗长")
        elif tone.verbosity > 0.6:
            instructions.append("可以详细展开说明")

        if tone.emoji_frequency > 0.4:
            instructions.append("可以适当使用表情符号")
        elif tone.emoji_frequency < 0.2:
            instructions.append("避免使用表情符号")

        if tone.proactive:
            instructions.append("可以主动提供建议和后续步骤")

        return "；".join(instructions) if instructions else ""

    def set_scene_override(self, scene: str, tone: ToneParams) -> None:
        """设置场景的语气覆盖。

        Args:
            scene: 场景名称。
            tone: 自定义语气参数。
        """
        self._scene_overrides[scene] = tone

    def add_trait(self, trait: str) -> None:
        """添加人格特质（去重）。

        Args:
            trait: 特质名称。
        """
        if trait not in self._traits:
            self._traits.append(trait)

    def remove_trait(self, trait: str) -> None:
        """移除人格特质。

        Args:
            trait: 特质名称。
        """
        self._traits = [t for t in self._traits if t != trait]

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToneParams:
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
    def __init__(self) -> None:
        self._name: str = "贾百姓"
        self._traits: list[str] = ["友好", "专业", "有耐心", "善于学习"]
        self._scene_overrides: dict[str, ToneParams] = {}

    @property
    def name(self) -> str:
        return self._name

    def build_persona_summary(self) -> str:
        traits = "、".join(self._traits)
        return f"你是{self._name}，{traits}。"

    def get_tone_for_scene(self, scene: str) -> ToneParams:
        if scene in self._scene_overrides:
            return self._scene_overrides[scene]
        return _SCENE_TONES.get(scene, _SCENE_TONES["daily"])

    def build_scene_tone_instruction(self, scene: str) -> str:
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
        self._scene_overrides[scene] = tone

    def add_trait(self, trait: str) -> None:
        if trait not in self._traits:
            self._traits.append(trait)

    def remove_trait(self, trait: str) -> None:
        self._traits = [t for t in self._traits if t != trait]

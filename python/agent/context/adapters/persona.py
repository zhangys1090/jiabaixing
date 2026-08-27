from __future__ import annotations

from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ComponentDependency,
    ComponentPriority,
    ContextBuildRequest,
)
from agent.core.logger import log_ignored
import logging
logger = logging.getLogger(__name__)


class PersonaComponent(ContextComponent):
    """人格设定组件

    负责构建人格摘要和场景语气指令。
    """

    def __init__(self, persona_core=None) -> None:
        super().__init__()
        self._persona_core = persona_core

    @property
    def name(self) -> str:
        return "persona"

    @property
    def priority(self) -> int:
        return ComponentPriority.PERSONA

    @property
    def dependencies(self) -> list[ComponentDependency]:
        return [
            ComponentDependency(component_name="system_prompt", required=True),
        ]

    def can_handle(self, request: ContextBuildRequest) -> bool:
        return True

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行人设构建

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict: 输出数据
        """
        persona_summary = request.persona_summary
        tone_instruction = request.tone_instruction

        # 如果有 PersonaCore，使用它
        if self._persona_core is not None:
            try:
                if not persona_summary:
                    persona_summary = self._persona_core.build_persona_summary()
                if not tone_instruction:
                    tone_instruction = self._persona_core.build_scene_tone_instruction(
                        request.scene
                    )
            except Exception as _exc:
                logger.warning("persona 异常处理", error=str(_exc))
                # 如果 PersonaCore 调用失败，使用默认值
                log_ignored(None, "persona.PersonaComponent._execute", _exc)

        # 默认人格设定
        if not persona_summary:
            persona_summary = (
                "你叫贾百姓，是一个友好、专业、有耐心的AI助手。"
                "你善于学习和总结，能够帮助用户完成各种任务。"
            )

        if not tone_instruction:
            # 根据场景调整语气
            if request.scene == "development":
                tone_instruction = "请使用专业、严谨的技术语言回答问题。"
            elif request.scene == "work":
                tone_instruction = "请使用专业、高效的工作语言回答问题。"
            elif request.scene == "comfort":
                tone_instruction = "请使用温暖、安慰的语气回答问题。"
            else:
                tone_instruction = "请用简洁、友好的方式回答问题。"

        # 组合人格内容
        persona_content = f"# 人格设定\n{persona_summary}\n\n# 语气要求\n{tone_instruction}"

        # 添加到系统消息
        # 找到第一个 system 消息，追加内容
        for i, msg in enumerate(context.messages):
            if msg.get("role") == "system":
                context.messages[i] = {
                    "role": "system",
                    "content": msg["content"] + "\n\n" + persona_content,
                }
                break

        return {
            "persona_summary": persona_summary,
            "tone_instruction": tone_instruction,
            "scene": request.scene,
        }

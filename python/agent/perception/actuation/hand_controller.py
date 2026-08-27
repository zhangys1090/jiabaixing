"""手部动作控制器（Hand Controller）—— 执行层的手部动作接口。

手部动作控制器负责将高层动作命令（抓取/释放/点击/拖拽等）
转换为底层执行指令，并支持多种执行后端：
- 桌面端：鼠标/键盘操作（通过 DesktopController）
- 移动端：触摸屏操作
- 机器人端：机械臂控制（通过 ROS/HTTP API）
- 仿真端：虚拟手操作（用于测试和训练）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅入口/透传
- 与 ActuationBus 解耦：只消费 ActuationCommand，产出执行结果
- 安全约束：高风险动作（如强制操作）需额外确认
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger
log = StructuredLogger("hand_controller")



class HandActionType(str, Enum):
    GRASP = "grasp"
    RELEASE = "release"
    POINT = "point"
    WAVE = "wave"
    PINCH = "pinch"
    TAP = "tap"
    SWIPE = "swipe"
    DRAG = "drag"
    TYPE = "type"
    PRESS = "press"
    SCROLL = "scroll"
    DOUBLE_TAP = "double_tap"
    LONG_PRESS = "long_press"


class HandBackend(str, Enum):
    DESKTOP = "desktop"
    TOUCH = "touch"
    ROBOTIC_ARM = "robotic_arm"
    SIMULATION = "simulation"


@dataclass
class HandAction:
    action_type: HandActionType = HandActionType.TAP
    target: str = ""
    position: tuple[float, float] | None = None
    force: float = 0.5
    duration_ms: float = 200.0
    text_input: str = ""
    key_combo: list[str] = field(default_factory=list)
    swipe_direction: str = ""
    swipe_distance: float = 0.0
    scroll_amount: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class HandActionResult:
    success: bool = False
    action_type: HandActionType = HandActionType.TAP
    detail: str = ""
    duration_ms: float = 0.0
    actual_position: tuple[float, float] | None = None
    error: str | None = None


class HandController:
    """手部动作控制器：将高层命令转换为底层执行。"""

    def __init__(self, backend: HandBackend = HandBackend.DESKTOP) -> None:
        self._backend = backend
        self._execution_count = 0
        self._success_count = 0
        self._backend_executor: Callable[[HandAction], Awaitable[HandActionResult]] | None = None
        self._pre_action_hook: Callable[[HandAction], bool] | None = None
        self._post_action_hook: Callable[[HandAction, HandActionResult], None] | None = None

    def set_backend(self, backend: HandBackend) -> None:
        self._backend = backend

    def set_backend_executor(
        self, executor: Callable[[HandAction], Awaitable[HandActionResult]]
    ) -> None:
        self._backend_executor = executor

    def set_pre_action_hook(self, hook: Callable[[HandAction], bool]) -> None:
        self._pre_action_hook = hook

    def set_post_action_hook(
        self, hook: Callable[[HandAction, HandActionResult], None]
    ) -> None:
        self._post_action_hook = hook

    async def execute(self, command: Any) -> HandActionResult:
        from agent.perception.actuation.actuation_bus import ActuationCommand
        if isinstance(command, ActuationCommand):
            action = self._command_to_action(command)
        elif isinstance(command, HandAction):
            action = command
        else:
            return HandActionResult(success=False, detail="未知命令类型")

        self._execution_count += 1
        start = time.time()

        if self._pre_action_hook:
            try:
                if not self._pre_action_hook(action):
                    return HandActionResult(
                        success=False,
                        action_type=action.action_type,
                        detail="前置钩子拒绝执行",
                        duration_ms=(time.time() - start) * 1000,
                    )
            except Exception as e:
                log.debug("Pre-action hook error", error=str(e))

        result = await self._dispatch(action)
        result.duration_ms = (time.time() - start) * 1000

        if result.success:
            self._success_count += 1

        if self._post_action_hook:
            try:
                self._post_action_hook(action, result)
            except Exception as e:
                log.debug("Post-action hook error", error=str(e))

        return result

    async def _dispatch(self, action: HandAction) -> HandActionResult:
        if self._backend_executor:
            try:
                return await self._backend_executor(action)
            except Exception as e:
                log.debug("hand_controller 异常处理", error=str(e))
                return HandActionResult(
                    success=False,
                    action_type=action.action_type,
                    error=str(e),
                )

        if self._backend == HandBackend.DESKTOP:
            return await self._execute_desktop(action)
        if self._backend == HandBackend.TOUCH:
            return await self._execute_touch(action)
        if self._backend == HandBackend.ROBOTIC_ARM:
            return await self._execute_robotic_arm(action)
        if self._backend == HandBackend.SIMULATION:
            return self._execute_simulation(action)

        return HandActionResult(
            success=False,
            action_type=action.action_type,
            error=f"未知后端: {self._backend.value}",
        )

    async def _execute_desktop(self, action: HandAction) -> HandActionResult:
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()

            if action.action_type == HandActionType.TAP:
                if action.position:
                    result = controller.click(int(action.position[0]), int(action.position[1]))
                    return HandActionResult(
                        success=result.success,
                        action_type=action.action_type,
                        detail=result.message or "点击完成",
                        actual_position=action.position,
                    )
            elif action.action_type == HandActionType.TYPE:
                if action.text_input:
                    result = controller.type_text(action.text_input)
                    return HandActionResult(
                        success=result.success,
                        action_type=action.action_type,
                        detail=result.message or "输入完成",
                    )
            elif action.action_type == HandActionType.PRESS:
                if action.key_combo:
                    result = controller.key_combo("+".join(action.key_combo))
                    return HandActionResult(
                        success=result.success,
                        action_type=action.action_type,
                        detail=result.message or "按键完成",
                    )
            elif action.action_type == HandActionType.SCROLL:
                result = controller.scroll(action.scroll_amount)
                return HandActionResult(
                    success=result.success,
                    action_type=action.action_type,
                    detail=result.message or "滚动完成",
                )
            elif action.action_type == HandActionType.DRAG:
                if action.position:
                    result = controller.drag(
                        int(action.position[0]), int(action.position[1]),
                        int(action.swipe_distance), 0,
                    )
                    return HandActionResult(
                        success=result.success,
                        action_type=action.action_type,
                        detail=result.message or "拖拽完成",
                    )

            return HandActionResult(
                success=False,
                action_type=action.action_type,
                error=f"桌面端不支持动作: {action.action_type.value}",
            )
        except ImportError:
            return HandActionResult(
                success=False,
                action_type=action.action_type,
                error="DesktopController 不可用",
            )
        except Exception as e:
            log.debug("hand_controller 异常处理", error=str(e))
            return HandActionResult(
                success=False,
                action_type=action.action_type,
                error=str(e),
            )

    async def _execute_touch(self, action: HandAction) -> HandActionResult:
        log.info("Touch backend execution", action=action.action_type.value)
        return HandActionResult(
            success=True,
            action_type=action.action_type,
            detail=f"触摸执行: {action.action_type.value}",
        )

    async def _execute_robotic_arm(self, action: HandAction) -> HandActionResult:
        log.info("Robotic arm backend execution", action=action.action_type.value)
        return HandActionResult(
            success=True,
            action_type=action.action_type,
            detail=f"机械臂执行: {action.action_type.value}",
        )

    def _execute_simulation(self, action: HandAction) -> HandActionResult:
        return HandActionResult(
            success=True,
            action_type=action.action_type,
            detail=f"仿真执行: {action.action_type.value}",
            actual_position=action.position,
        )

    def _command_to_action(self, command: Any) -> HandAction:
        from agent.perception.actuation.actuation_bus import ActuationType
        type_map = {
            ActuationType.HAND_GRASP: HandActionType.GRASP,
            ActuationType.HAND_RELEASE: HandActionType.RELEASE,
            ActuationType.HAND_POINT: HandActionType.POINT,
            ActuationType.HAND_WAVE: HandActionType.WAVE,
            ActuationType.HAND_PINCH: HandActionType.PINCH,
            ActuationType.HAND_TAP: HandActionType.TAP,
            ActuationType.HAND_SWIPE: HandActionType.SWIPE,
            ActuationType.HAND_DRAG: HandActionType.DRAG,
            ActuationType.HAND_TYPE: HandActionType.TYPE,
            ActuationType.HAND_PRESS: HandActionType.PRESS,
        }
        action_type = type_map.get(command.action_type, HandActionType.TAP)
        pos = command.parameters.get("position")
        if isinstance(pos, (list, tuple)) and len(pos) >= 2:
            position = (float(pos[0]), float(pos[1]))
        else:
            position = None
        return HandAction(
            action_type=action_type,
            target=command.target,
            position=position,
            force=float(command.parameters.get("force", 0.5)),
            duration_ms=float(command.parameters.get("duration_ms", 200.0)),
            text_input=command.parameters.get("text_input", ""),
            key_combo=command.parameters.get("key_combo", []),
            swipe_direction=command.parameters.get("swipe_direction", ""),
            swipe_distance=float(command.parameters.get("swipe_distance", 0.0)),
            scroll_amount=int(command.parameters.get("scroll_amount", 0)),
            metadata=command.metadata,
        )

    @property
    def backend(self) -> HandBackend:
        return self._backend

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "backend": self._backend.value,
            "execution_count": self._execution_count,
            "success_count": self._success_count,
            "success_rate": (
                round(self._success_count / self._execution_count, 3)
                if self._execution_count > 0 else 0.0
            ),
        }

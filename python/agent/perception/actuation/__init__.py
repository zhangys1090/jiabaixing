"""执行层子包 —— 手脚动作控制器与执行总线。

执行层与感知层对称设计：
- 感知层（perception/）：外部世界 → SenseSample → SensoryFusion → 决策
- 执行层（perception/actuation/）：决策 → ActuationCommand → 执行器 → 本体感回流

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅入口/透传
- 每个执行动作产生 proprioception 本体感信号回流到 SensoryFusion
- 安全约束：所有物理动作必须经过 SafetyNet 预检 + ConstitutionGuard 宪法约束
- 非侵入式：未挂载执行器时行为不变
"""

from agent.perception.actuation.actuation_bus import ActuationBus, get_actuation_bus
from agent.perception.actuation.hand_controller import HandController
from agent.perception.actuation.locomotion_controller import LocomotionController
from agent.perception.actuation.haptic_feedback import HapticFeedbackDriver
from agent.perception.actuation.robotic_arm_driver import RoboticArmDriver
from agent.perception.actuation.aerial_locomotion_driver import AerialLocomotionDriver
from agent.perception.actuation.legged_locomotion_driver import LeggedLocomotionDriver
from agent.perception.actuation.haptic_device_drivers import (
    HapticDriverFactory,
    HapticDriverType,
    VibrationMotorDriver,
    ForceGloveDriver,
    HapticDisplayDriver,
    GamepadHapticDriver,
)
from agent.perception.actuation.actuation_perception_bridge import (
    ActuationPerceptionBridge,
    BridgeConfig,
    BridgeResult,
    VerificationStrategy,
)

__all__ = [
    "ActuationBus",
    "get_actuation_bus",
    "HandController",
    "LocomotionController",
    "HapticFeedbackDriver",
    "RoboticArmDriver",
    "AerialLocomotionDriver",
    "LeggedLocomotionDriver",
    "HapticDriverFactory",
    "HapticDriverType",
    "VibrationMotorDriver",
    "ForceGloveDriver",
    "HapticDisplayDriver",
    "GamepadHapticDriver",
    "ActuationPerceptionBridge",
    "BridgeConfig",
    "BridgeResult",
    "VerificationStrategy",
]

"""agent.perception 包公共导出。

按 perception_loop.py / sensory_fusion.py 模块 docstring 的约定，
对外暴露 PerceptionActionLoop 与 SensoryFusion，使
`from agent.perception import PerceptionActionLoop, SensoryFusion` 成立。

五感通道扩展导出：
- HapticChannel: 触觉通道
- OlfactoryChannel: 嗅觉通道
- GustatoryChannel: 味觉通道

听觉增强导出：
- AudioAnalyzer: 环境音分析器
- VoiceprintRecognizer: 声纹识别器
- AcousticEmotionPerceiver: 声学情绪感知器
"""
from agent.perception.perception_loop import PerceptionActionLoop
from agent.perception.sensory_fusion import SensoryFusion
from agent.perception.haptic_channel import HapticChannel, get_haptic_channel
from agent.perception.olfactory_channel import OlfactoryChannel, get_olfactory_channel
from agent.perception.gustatory_channel import GustatoryChannel, get_gustatory_channel
from agent.perception.audio_analyzer import AudioAnalyzer
from agent.perception.voiceprint import VoiceprintRecognizer
from agent.perception.acoustic_emotion import AcousticEmotionPerceiver

__all__ = [
    "PerceptionActionLoop",
    "SensoryFusion",
    "HapticChannel",
    "get_haptic_channel",
    "OlfactoryChannel",
    "get_olfactory_channel",
    "GustatoryChannel",
    "get_gustatory_channel",
    "AudioAnalyzer",
    "VoiceprintRecognizer",
    "AcousticEmotionPerceiver",
]

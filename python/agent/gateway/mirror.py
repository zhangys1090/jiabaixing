"""网关消息镜像（跨会话消息同步）。

将消息从一个会话镜像到另一个或多个会话：
  - 一对多镜像（广播到多个目标会话）
  - 条件镜像（根据消息内容/来源决定是否镜像）
  - 格式转换（不同平台格式适配）
  - 双向镜像（两个会话互相同步）
  - 镜像过滤（排除特定类型消息）

与 MessageDispatcher 的关系：
  - 作为 POST_DISPATCH Hook 注册
  - 分发后自动镜像到配置的目标会话

集成示例::

    from agent.gateway.mirror import MessageMirror

    mirror = MessageMirror()
    mirror.add_rule(MirrorRule(
        source_chat="slack#general",
        target_chats=["matrix#general", "whatsapp#team"],
    ))
    await mirror.mirror_message(message, result)
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.gateway.base import Message
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.mirror")


class MirrorDirection(str, Enum):
    ONE_WAY = "one_way"
    BIDIRECTIONAL = "bidirectional"


class MirrorStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    ERROR = "error"


@dataclass
class MirrorRule:
    id: str
    source_chat: str
    target_chats: list[str] = field(default_factory=list)
    direction: MirrorDirection = MirrorDirection.ONE_WAY
    condition: str = ""
    exclude_patterns: list[str] = field(default_factory=list)
    include_patterns: list[str] = field(default_factory=list)
    format_transform: str = ""
    enabled: bool = True
    status: MirrorStatus = MirrorStatus.ACTIVE
    mirror_count: int = 0
    last_mirrored: float = 0.0
    created_at: float = 0.0

    def __post_init__(self) -> None:
        if self.created_at == 0.0:
            self.created_at = time.time()


@dataclass
class MirrorResult:
    rule_id: str
    source_chat: str
    target_chat: str
    success: bool
    error: str = ""
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


@dataclass
class MirrorStats:
    total_rules: int = 0
    active_rules: int = 0
    total_mirrored: int = 0
    total_errors: int = 0
    last_activity: float = 0.0


class MessageMirror:
    """消息镜像管理器。

    管理跨会话消息镜像规则和执行。
    """

    def __init__(self) -> None:
        self._rules: dict[str, MirrorRule] = {}
        self._send_func: Callable[..., Awaitable[bool]] | None = None
        self._custom_conditions: dict[str, Callable[[Message], bool]] = {}
        self._stats = MirrorStats()

    def set_send_function(self, func: Callable[..., Awaitable[bool]]) -> None:
        self._send_func = func

    def register_condition(self, name: str, func: Callable[[Message], bool]) -> None:
        self._custom_conditions[name] = func

    def add_rule(self, rule: MirrorRule) -> None:
        self._rules[rule.id] = rule
        self._stats.total_rules = len(self._rules)
        self._stats.active_rules = len([r for r in self._rules.values() if r.enabled])
        log.info("镜像规则已添加", id=rule.id, source=rule.source_chat, targets=rule.target_chats)

    def remove_rule(self, rule_id: str) -> bool:
        rule = self._rules.pop(rule_id, None)
        if rule is None:
            return False
        self._stats.total_rules = len(self._rules)
        self._stats.active_rules = len([r for r in self._rules.values() if r.enabled])
        return True

    def pause_rule(self, rule_id: str) -> None:
        if rule_id in self._rules:
            self._rules[rule_id].status = MirrorStatus.PAUSED
            self._rules[rule_id].enabled = False

    def resume_rule(self, rule_id: str) -> None:
        if rule_id in self._rules:
            self._rules[rule_id].status = MirrorStatus.ACTIVE
            self._rules[rule_id].enabled = True

    def _should_mirror(self, rule: MirrorRule, message: Message) -> bool:
        if not rule.enabled or rule.status == MirrorStatus.PAUSED:
            return False

        if rule.source_chat != message.chat_id and rule.source_chat != "*":
            return False

        if rule.exclude_patterns:
            for pattern in rule.exclude_patterns:
                if re.search(pattern, message.content):
                    return False

        if rule.include_patterns:
            matched = any(re.search(p, message.content) for p in rule.include_patterns)
            if not matched:
                return False

        if rule.condition and rule.condition in self._custom_conditions:
            return self._custom_conditions[rule.condition](message)

        return True

    def _transform_content(self, content: str, transform: str) -> str:
        if not transform:
            return content
        if transform == "strip_markdown":
            content = re.sub(r"[#*_~`]", "", content)
            return content.strip()
        if transform == "plain_text":
            content = re.sub(r"<[^>]+>", "", content)
            content = re.sub(r"[#*_~`>\-]", "", content)
            return content.strip()
        return content

    async def mirror_message(self, message: Message, result: str = "") -> list[MirrorResult]:
        if self._send_func is None:
            return []

        all_results: list[MirrorResult] = []
        content_to_mirror = result or message.content

        for rule in self._rules.values():
            if not self._should_mirror(rule, message):
                continue

            transformed = self._transform_content(content_to_mirror, rule.format_transform)

            for target_chat in rule.target_chats:
                if target_chat == message.chat_id:
                    continue
                try:
                    success = await self._send_func(target_chat, transformed)
                    mr = MirrorResult(
                        rule_id=rule.id,
                        source_chat=message.chat_id,
                        target_chat=target_chat,
                        success=success,
                    )
                    all_results.append(mr)

                    if success:
                        rule.mirror_count += 1
                        rule.last_mirrored = time.time()
                        self._stats.total_mirrored += 1
                    else:
                        self._stats.total_errors += 1
                except Exception as e:
                    log.debug("mirror 异常处理", error=str(e))
                    mr = MirrorResult(
                        rule_id=rule.id,
                        source_chat=message.chat_id,
                        target_chat=target_chat,
                        success=False,
                        error=str(e),
                    )
                    all_results.append(mr)
                    self._stats.total_errors += 1

            if rule.direction == MirrorDirection.BIDIRECTIONAL:
                for target in rule.target_chats:
                    reverse_id = f"{rule.id}_rev_{target}"
                    if reverse_id not in self._rules:
                        reverse_rule = MirrorRule(
                            id=reverse_id,
                            source_chat=target,
                            target_chats=[rule.source_chat],
                            direction=MirrorDirection.ONE_WAY,
                            enabled=rule.enabled,
                            condition=rule.condition,
                            exclude_patterns=rule.exclude_patterns,
                            include_patterns=rule.include_patterns,
                            format_transform=rule.format_transform,
                        )
                        self._rules[reverse_id] = reverse_rule

        self._stats.last_activity = time.time()
        return all_results

    def get_rules(self) -> list[dict[str, Any]]:
        return [
            {
                "id": r.id,
                "source": r.source_chat,
                "targets": r.target_chats,
                "direction": r.direction.value,
                "enabled": r.enabled,
                "status": r.status.value,
                "mirror_count": r.mirror_count,
            }
            for r in self._rules.values()
        ]

    def get_stats(self) -> dict[str, Any]:
        self._stats.total_rules = len(self._rules)
        self._stats.active_rules = len([r for r in self._rules.values() if r.enabled])
        return {
            "total_rules": self._stats.total_rules,
            "active_rules": self._stats.active_rules,
            "total_mirrored": self._stats.total_mirrored,
            "total_errors": self._stats.total_errors,
        }

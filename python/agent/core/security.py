"""Backward-compatibility shim — all symbols re-exported from core.command_guard.

This module has been renamed to ``agent.core.command_guard`` to eliminate
the naming collision with the ``agent.security`` package.

Prefer importing from ``agent.core.command_guard`` directly.
All names here are re-exports and will be removed in a future version.
"""
from __future__ import annotations

import warnings

from agent.core.command_guard import (
    CommandGuard,
    SecurityCheckResult,
    SecurityGuard,
)
from agent.core.types import (
    Capability,
    DEFAULT_CAPABILITIES,
    RiskLevel,
)

DEFAULT_PERMISSIONS = DEFAULT_CAPABILITIES

warnings.warn(
    "agent.core.security is deprecated; use agent.core.command_guard instead.",
    DeprecationWarning,
    stacklevel=2,
)

__all__ = [
    "CommandGuard",
    "SecurityGuard",
    "SecurityCheckResult",
    "Capability",
    "DEFAULT_CAPABILITIES",
    "DEFAULT_PERMISSIONS",
    "RiskLevel",
]

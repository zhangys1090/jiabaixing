"""工具自愈 — 工具调用失败时自动修复与降级。

设计目标：
1. 参数修正：基于 Schema 校验错误信息自动修正参数
2. 替代工具：基于工具描述相似度推荐替代工具
3. 降级策略：基于历史成功率选择降级方案
4. 自愈记录：记录自愈过程供进化引擎学习

自愈流程：
  工具调用失败
    → 尝试参数修正（Schema 错误 → 修正参数 → 重试）
      → 尝试替代工具（描述相似度匹配 → 替代调用）
        → 尝试降级策略（历史成功率 → 降级方案）
          → 全部失败 → 返回原始错误

Usage:
    healer = ToolSelfHealing(tool_registry=registry, trajectory_db=db)
    result = await healer.heal("file_read", {"path": 123}, error)
    # result 可能来自修正后的参数调用或替代工具
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.core.logger import log_ignored
log = StructuredLogger("tool_self_healing")



class HealStrategy(str, Enum):
    PARAM_FIX = "param_fix"
    ALTERNATIVE_TOOL = "alternative_tool"
    DEGRADATION = "degradation"
    RETRY = "retry"
    NONE = "none"


@dataclass
class HealAttempt:
    strategy: HealStrategy
    original_tool: str
    original_params: dict[str, Any]
    fixed_params: dict[str, Any] | None = None
    alternative_tool: str = ""
    alternative_params: dict[str, Any] | None = None
    success: bool = False
    error: str = ""
    duration_ms: float = 0.0


@dataclass
class HealResult:
    original_tool: str
    original_error: str
    healed: bool
    result: Any = None
    strategy_used: HealStrategy = HealStrategy.NONE
    attempts: list[HealAttempt] = field(default_factory=list)
    total_duration_ms: float = 0.0


@dataclass
class ToolDegradationRule:
    original_tool: str
    fallback_tools: list[str]
    param_mapping: dict[str, str] = field(default_factory=dict)
    success_threshold: float = 0.5


_DEFAULT_DEGRADATION_RULES: list[ToolDegradationRule] = [
    ToolDegradationRule(
        original_tool="desktop_uia_invoke",
        fallback_tools=["desktop_automate"],
        param_mapping={"element_name": "target"},
    ),
    ToolDegradationRule(
        original_tool="desktop_uia_find",
        fallback_tools=["desktop_screenshot", "screen_parse"],
        param_mapping={"name": "query"},
    ),
    ToolDegradationRule(
        original_tool="lsp_diagnostics",
        fallback_tools=["code_analyze"],
        param_mapping={"file_path": "file_path"},
    ),
    ToolDegradationRule(
        original_tool="file_read",
        fallback_tools=["code_search"],
        param_mapping={"path": "query"},
    ),
    ToolDegradationRule(
        original_tool="web_fetch",
        fallback_tools=["web_search"],
        param_mapping={"url": "query"},
    ),
]

_PARAM_FIX_RULES: list[dict[str, Any]] = [
    {"error_pattern": "expected string", "fix": "to_string", "target_types": ["int", "float", "bool"]},
    {"error_pattern": "expected number", "fix": "to_number", "target_types": ["str"]},
    {"error_pattern": "expected boolean", "fix": "to_bool", "target_types": ["str"]},
    {"error_pattern": "expected array", "fix": "to_array", "target_types": ["str"]},
    {"error_pattern": "required parameter", "fix": "add_default", "target_types": []},
    {"error_pattern": "not found", "fix": "normalize_path", "target_types": ["str"]},
    {"error_pattern": "permission denied", "fix": "try_alternate_path", "target_types": ["str"]},
]


class ToolSelfHealing:
    def __init__(
        self,
        tool_registry: Any | None = None,
        trajectory_db: Any | None = None,
        llm: Any | None = None,
    ) -> None:
        self._tool_registry = tool_registry
        self._trajectory_db = trajectory_db
        self._llm = llm
        self._degradation_rules: dict[str, ToolDegradationRule] = {}
        self._heal_history: list[HealResult] = []
        self._max_history = 200

        for rule in _DEFAULT_DEGRADATION_RULES:
            self._degradation_rules[rule.original_tool] = rule

    async def heal(
        self,
        tool_name: str,
        params: dict[str, Any],
        error: str,
        error_type: str = "",
    ) -> HealResult:
        start = time.time()
        result = HealResult(
            original_tool=tool_name,
            original_error=error,
            healed=False,
        )

        param_fix = await self._try_param_fix(tool_name, params, error)
        result.attempts.append(param_fix)
        if param_fix.success:
            result.healed = True
            result.result = param_fix
            result.strategy_used = HealStrategy.PARAM_FIX
            result.total_duration_ms = (time.time() - start) * 1000
            self._record_heal(result)
            return result

        alt_result = await self._try_alternative_tool(tool_name, params, error)
        result.attempts.append(alt_result)
        if alt_result.success:
            result.healed = True
            result.result = alt_result
            result.strategy_used = HealStrategy.ALTERNATIVE_TOOL
            result.total_duration_ms = (time.time() - start) * 1000
            self._record_heal(result)
            return result

        degrad_result = await self._try_degradation(tool_name, params, error)
        result.attempts.append(degrad_result)
        if degrad_result.success:
            result.healed = True
            result.result = degrad_result
            result.strategy_used = HealStrategy.DEGRADATION
            result.total_duration_ms = (time.time() - start) * 1000
            self._record_heal(result)
            return result

        result.total_duration_ms = (time.time() - start) * 1000
        self._record_heal(result)
        return result

    async def _try_param_fix(
        self,
        tool_name: str,
        params: dict[str, Any],
        error: str,
    ) -> HealAttempt:
        attempt = HealAttempt(
            strategy=HealStrategy.PARAM_FIX,
            original_tool=tool_name,
            original_params=dict(params),
        )

        fixed_params = self._fix_params(params, error)
        if fixed_params == params:
            attempt.error = "No applicable param fix rule"
            return attempt

        attempt.fixed_params = fixed_params

        if self._tool_registry:
            try:
                tool_result = await self._tool_registry.execute(tool_name, fixed_params)
                if tool_result and getattr(tool_result, "success", True):
                    attempt.success = True
                    return attempt
            except Exception as e:
                log.debug("tool_self_healing 异常处理", error=str(e))
                attempt.error = str(e)

        attempt.error = "Fixed params still failed"
        return attempt

    async def _try_alternative_tool(
        self,
        tool_name: str,
        params: dict[str, Any],
        error: str,
    ) -> HealAttempt:
        attempt = HealAttempt(
            strategy=HealStrategy.ALTERNATIVE_TOOL,
            original_tool=tool_name,
            original_params=dict(params),
        )

        alternatives = self._find_alternative_tools(tool_name)
        if not alternatives:
            attempt.error = "No alternative tools found"
            return attempt

        for alt_tool in alternatives:
            alt_params = self._map_params(tool_name, alt_tool, params)
            attempt.alternative_tool = alt_tool
            attempt.alternative_params = alt_params

            if self._tool_registry:
                try:
                    tool_result = await self._tool_registry.execute(alt_tool, alt_params)
                    if tool_result and getattr(tool_result, "success", True):
                        attempt.success = True
                        return attempt
                except Exception as e:
                    log.debug("tool_self_healing 异常处理", error=str(e))
                    attempt.error = f"{alt_tool}: {e}"
                    continue

        attempt.error = "All alternative tools failed"
        return attempt

    async def _try_degradation(
        self,
        tool_name: str,
        params: dict[str, Any],
        error: str,
    ) -> HealAttempt:
        attempt = HealAttempt(
            strategy=HealStrategy.DEGRADATION,
            original_tool=tool_name,
            original_params=dict(params),
        )

        rule = self._degradation_rules.get(tool_name)
        if not rule:
            attempt.error = "No degradation rule for this tool"
            return attempt

        for fallback_tool in rule.fallback_tools:
            fallback_params = self._apply_param_mapping(rule.param_mapping, params)
            attempt.alternative_tool = fallback_tool
            attempt.alternative_params = fallback_params

            if self._tool_registry:
                try:
                    tool_result = await self._tool_registry.execute(fallback_tool, fallback_params)
                    if tool_result and getattr(tool_result, "success", True):
                        attempt.success = True
                        return attempt
                except Exception as e:
                    log.debug("tool_self_healing 异常处理", error=str(e))
                    attempt.error = f"{fallback_tool}: {e}"
                    continue

        attempt.error = "All degradation fallbacks failed"
        return attempt

    def _fix_params(
        self,
        params: dict[str, Any],
        error: str,
    ) -> dict[str, Any]:
        fixed = dict(params)
        error_lower = error.lower()

        for rule in _PARAM_FIX_RULES:
            pattern = rule["error_pattern"].lower()
            if pattern not in error_lower:
                continue

            fix_type = rule["fix"]
            for key, value in list(fixed.items()):
                if fix_type == "to_string" and not isinstance(value, str):
                    fixed[key] = str(value)
                elif fix_type == "to_number" and isinstance(value, str):
                    try:
                        fixed[key] = float(value) if "." in value else int(value)
                    except (ValueError, TypeError) as _exc:
                        log_ignored(log, "tool_self_healing.ToolSelfHealing._fix_params", _exc)
                elif fix_type == "to_bool" and isinstance(value, str):
                    if value.lower() in ("true", "1", "yes"):
                        fixed[key] = True
                    elif value.lower() in ("false", "0", "no"):
                        fixed[key] = False
                elif fix_type == "to_array" and isinstance(value, str):
                    if "," in value:
                        fixed[key] = [v.strip() for v in value.split(",")]
                    else:
                        fixed[key] = [value]
                elif fix_type == "normalize_path" and isinstance(value, str):
                    fixed[key] = value.replace("\\", "/").rstrip("/")
                elif fix_type == "try_alternate_path" and isinstance(value, str):
                    alt = value.replace("\\", "/")
                    if alt != value:
                        fixed[key] = alt

        if "required parameter" in error_lower:
            param_name = self._extract_missing_param(error)
            if param_name and param_name not in fixed:
                defaults: dict[str, Any] = {
                    "limit": 10,
                    "offset": 0,
                    "timeout": 30,
                    "recursive": False,
                    "verbose": False,
                    "format": "text",
                    "encoding": "utf-8",
                }
                if param_name in defaults:
                    fixed[param_name] = defaults[param_name]

        return fixed

    def _find_alternative_tools(self, tool_name: str) -> list[str]:
        alternatives: list[str] = []

        if self._tool_registry:
            all_tools = self._tool_registry.list_tools()
            target_prefix = tool_name.rsplit("_", 1)[0] if "_" in tool_name else ""

            for t in all_tools:
                t_name = t if isinstance(t, str) else getattr(t, "name", "")
                if t_name == tool_name:
                    continue
                if target_prefix and t_name.startswith(target_prefix):
                    alternatives.append(t_name)

        rule = self._degradation_rules.get(tool_name)
        if rule:
            for fb in rule.fallback_tools:
                if fb not in alternatives:
                    alternatives.append(fb)

        return alternatives[:5]

    def _map_params(
        self,
        original_tool: str,
        alt_tool: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        rule = self._degradation_rules.get(original_tool)
        if rule and rule.param_mapping:
            return self._apply_param_mapping(rule.param_mapping, params)
        return dict(params)

    def _apply_param_mapping(
        self,
        mapping: dict[str, str],
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if not mapping:
            return dict(params)

        result: dict[str, Any] = {}
        for src_key, dst_key in mapping.items():
            if src_key in params:
                result[dst_key] = params[src_key]

        for key, value in params.items():
            if key not in mapping and key not in result:
                result[key] = value

        return result

    def _extract_missing_param(self, error: str) -> str:
        import re
        patterns = [
            r"required parameter[:\s]+['\"]?(\w+)['\"]?",
            r"missing required[:\s]+['\"]?(\w+)['\"]?",
            r"'(\w+)' is required",
            r"parameter '(\w+)' is required",
        ]
        for pattern in patterns:
            match = re.search(pattern, error, re.IGNORECASE)
            if match:
                return match.group(1)
        return ""

    def _record_heal(self, result: HealResult) -> None:
        self._heal_history.append(result)
        if len(self._heal_history) > self._max_history:
            self._heal_history = self._heal_history[-self._max_history:]

    def get_stats(self) -> dict[str, Any]:
        total = len(self._heal_history)
        healed = sum(1 for h in self._heal_history if h.healed)

        strategy_counts: dict[str, int] = {}
        for h in self._heal_history:
            if h.healed:
                key = h.strategy_used.value
                strategy_counts[key] = strategy_counts.get(key, 0) + 1

        tool_heal_rates: dict[str, dict[str, int]] = {}
        for h in self._heal_history:
            tool = h.original_tool
            if tool not in tool_heal_rates:
                tool_heal_rates[tool] = {"total": 0, "healed": 0}
            tool_heal_rates[tool]["total"] += 1
            if h.healed:
                tool_heal_rates[tool]["healed"] += 1

        return {
            "total_attempts": total,
            "total_healed": healed,
            "heal_rate": round(healed / max(total, 1), 4),
            "strategy_breakdown": strategy_counts,
            "per_tool": tool_heal_rates,
        }

    def add_degradation_rule(self, rule: ToolDegradationRule) -> None:
        self._degradation_rules[rule.original_tool] = rule

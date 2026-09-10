"""工具输出限制器。

防止工具输出过大导致上下文窗口爆炸。支持按字符数、行数、
token 数等多种维度限制，智能截断并保留关键信息。

截断策略：
    1. 头部保留：保留输出的前 N 行（重要的开头信息）
    2. 尾部保留：保留输出的后 M 行（重要的结尾总结）
    3. 中间省略：用省略号标记中间被截断的部分
    4. 结构化数据优先保留摘要/统计信息
"""

from __future__ import annotations

import re
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger
log = StructuredLogger("output_limiter")


class TruncationStrategy(str, Enum):
    """截断策略枚举。

    Attributes:
        HEAD_ONLY: 只保留头部。
        TAIL_ONLY: 只保留尾部。
        HEAD_AND_TAIL: 头部+尾部（默认）。
        SMART: 智能截断——保留关键行（错误/警告/摘要）。
    """

    HEAD_ONLY = "head_only"
    TAIL_ONLY = "tail_only"
    HEAD_AND_TAIL = "head_and_tail"
    SMART = "smart"


@dataclass
class OutputLimitConfig:
    """单个工具的输出限制配置。

    Attributes:
        max_chars: 最大字符数。
        max_lines: 最大行数。
        max_tokens: 最大 token 数（粗略估算，1 token ≈ 4 字符）。
        head_lines: 头部保留行数。
        tail_lines: 尾部保留行数。
        strategy: 截断策略。
    """

    max_chars: int = 8000
    max_lines: int = 200
    max_tokens: int = 2000
    head_lines: int = 50
    tail_lines: int = 30
    strategy: TruncationStrategy = TruncationStrategy.HEAD_AND_TAIL


@dataclass
class TruncationResult:
    """截断结果。

    Attributes:
        output: 截断后的输出文本。
        was_truncated: 是否被截断。
        original_chars: 原始字符数。
        truncated_chars: 截断后字符数。
        original_lines: 原始行数。
        truncated_lines: 截断后行数。
        truncation_note: 截断说明（附加在输出末尾）。
    """

    output: str
    was_truncated: bool
    original_chars: int
    truncated_chars: int
    original_lines: int
    truncated_lines: int
    truncation_note: str = ""


# 各工具的默认限制配置
_DEFAULT_TOOL_LIMITS: dict[str, OutputLimitConfig] = {
    # 文件工具：输出可能很大
    "file_read": OutputLimitConfig(
        max_chars=10000, max_lines=300, max_tokens=2500,
        head_lines=80, tail_lines=40, strategy=TruncationStrategy.HEAD_AND_TAIL,
    ),
    "file_grep": OutputLimitConfig(
        max_chars=6000, max_lines=150, max_tokens=1500,
        head_lines=50, tail_lines=20, strategy=TruncationStrategy.SMART,
    ),
    "file_search": OutputLimitConfig(
        max_chars=5000, max_lines=100, max_tokens=1200,
        head_lines=40, tail_lines=15, strategy=TruncationStrategy.SMART,
    ),
    "file_list": OutputLimitConfig(
        max_chars=4000, max_lines=100, max_tokens=1000,
        head_lines=30, tail_lines=10, strategy=TruncationStrategy.HEAD_AND_TAIL,
    ),
    # 代码工具
    "code_search": OutputLimitConfig(
        max_chars=6000, max_lines=150, max_tokens=1500,
        head_lines=50, tail_lines=20, strategy=TruncationStrategy.SMART,
    ),
    # 网络工具
    "web_search": OutputLimitConfig(
        max_chars=5000, max_lines=80, max_tokens=1200,
        head_lines=40, tail_lines=10, strategy=TruncationStrategy.HEAD_AND_TAIL,
    ),
    "web_fetch": OutputLimitConfig(
        max_chars=8000, max_lines=200, max_tokens=2000,
        head_lines=60, tail_lines=30, strategy=TruncationStrategy.SMART,
    ),
    # 记忆工具
    "memory_recall": OutputLimitConfig(
        max_chars=4000, max_lines=80, max_tokens=1000,
        head_lines=40, tail_lines=15, strategy=TruncationStrategy.SMART,
    ),
    # 会话搜索
    "session_search": OutputLimitConfig(
        max_chars=5000, max_lines=100, max_tokens=1200,
        head_lines=50, tail_lines=20, strategy=TruncationStrategy.HEAD_AND_TAIL,
    ),
}

# 全局默认配置
_GLOBAL_DEFAULT = OutputLimitConfig()

# 智能截断：包含以下关键词的行优先保留
_SMART_KEYWORDS: list[str] = [
    r"error|错误|异常|exception|traceback",
    r"warning|警告",
    r"result|结果|summary|摘要|总计|total",
    r"found|找到|匹配|matched",
    r"fail|失败|success|成功",
    r"===|---|\*\*\*",
    r"def |class |function |import ",
    r"\d+\.\s",
]


class ToolOutputLimiter:
    """工具输出限制器。

    对工具输出进行大小限制和智能截断，防止上下文窗口爆炸。

    Usage:
        limiter = ToolOutputLimiter()
        result = limiter.limit("file_read", large_output)
        if result.was_truncated:
            log.warning("输出已截断", tool=tool_name)
    """

    def __init__(
        self,
        global_default: OutputLimitConfig | None = None,
        tool_specific: dict[str, OutputLimitConfig] | None = None,
    ) -> None:
        """初始化输出限制器。

        Args:
            global_default: 全局默认配置。
            tool_specific: 工具专属配置字典。
        """
        self._global_default = global_default or _GLOBAL_DEFAULT
        self._tool_limits: dict[str, OutputLimitConfig] = dict(_DEFAULT_TOOL_LIMITS)
        if tool_specific:
            self._tool_limits.update(tool_specific)

    def set_limit(self, tool_name: str, config: OutputLimitConfig) -> None:
        """设置指定工具的输出限制。

        Args:
            tool_name: 工具名称。
            config: 限制配置。
        """
        self._tool_limits[tool_name] = config

    def get_limit(self, tool_name: str) -> OutputLimitConfig:
        """获取指定工具的限制配置。

        Args:
            tool_name: 工具名称。

        Returns:
            OutputLimitConfig: 限制配置，无专属配置时返回全局默认。
        """
        return self._tool_limits.get(tool_name, self._global_default)

    def limit(
        self,
        tool_name: str,
        output: str,
        custom_config: OutputLimitConfig | None = None,
    ) -> TruncationResult:
        """对工具输出进行限制和截断。

        Args:
            tool_name: 工具名称（用于查找专属配置）。
            output: 原始输出文本。
            custom_config: 自定义配置（优先于工具专属和全局默认）。

        Returns:
            TruncationResult: 截断结果。
        """
        if not output:
            return TruncationResult(
                output=output,
                was_truncated=False,
                original_chars=0,
                truncated_chars=0,
                original_lines=0,
                truncated_lines=0,
            )

        config = custom_config or self.get_limit(tool_name)
        original_chars = len(output)
        lines = output.splitlines()
        original_lines = len(lines)

        # 无需截断
        if (
            original_chars <= config.max_chars
            and original_lines <= config.max_lines
            and self._estimate_tokens(output) <= config.max_tokens
        ):
            return TruncationResult(
                output=output,
                was_truncated=False,
                original_chars=original_chars,
                truncated_chars=original_chars,
                original_lines=original_lines,
                truncated_lines=original_lines,
            )

        # 根据策略截断
        if config.strategy == TruncationStrategy.HEAD_ONLY:
            truncated_lines = lines[: config.head_lines]
        elif config.strategy == TruncationStrategy.TAIL_ONLY:
            truncated_lines = lines[-config.tail_lines:]
        elif config.strategy == TruncationStrategy.SMART:
            truncated_lines = self._smart_truncate(lines, config)
        else:  # HEAD_AND_TAIL
            head = lines[: config.head_lines]
            tail = lines[-config.tail_lines:] if config.tail_lines > 0 else []
            if len(head) + len(tail) >= original_lines:
                truncated_lines = lines
            else:
                truncated_lines = head + ["", f"... [省略中间 {original_lines - len(head) - len(tail)} 行] ...", ""] + tail

        # 字符级二次截断
        result_text = "\n".join(truncated_lines)
        if len(result_text) > config.max_chars:
            result_text = result_text[: config.max_chars] + "\n... [字符超限，已截断]"

        truncated_chars = len(result_text)
        note = self._build_note(
            tool_name, original_chars, truncated_chars,
            original_lines, len(truncated_lines),
        )

        return TruncationResult(
            output=result_text,
            was_truncated=True,
            original_chars=original_chars,
            truncated_chars=truncated_chars,
            original_lines=original_lines,
            truncated_lines=len(truncated_lines),
            truncation_note=note,
        )

    def limit_result_dict(
        self,
        tool_name: str,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        """对工具结果字典进行输出限制（修改 output 字段）。

        Args:
            tool_name: 工具名称。
            result: 工具结果字典（需包含 output 字段）。

        Returns:
            dict: 处理后的结果字典，添加了 truncation_info 元数据。
        """
        output = result.get("output", "")
        if not isinstance(output, str):
            return result

        truncation = self.limit(tool_name, output)
        if not truncation.was_truncated:
            return result

        result["output"] = truncation.output + f"\n\n{truncation.truncation_note}"
        metadata = result.get("metadata", {}) or {}
        metadata["truncated"] = True
        metadata["original_chars"] = truncation.original_chars
        metadata["truncated_chars"] = truncation.truncated_chars
        metadata["original_lines"] = truncation.original_lines
        metadata["truncated_lines"] = truncation.truncated_lines
        result["metadata"] = metadata

        return result

    def _smart_truncate(self, lines: list[str], config: OutputLimitConfig) -> list[str]:
        """智能截断：优先保留含关键词的行。

        Args:
            lines: 原始行列表。
            config: 限制配置。

        Returns:
            list[str]: 截断后的行列表。
        """
        max_lines = config.max_lines
        if len(lines) <= max_lines:
            return lines

        # 标记每行的重要性（是否含关键词）
        patterns = [re.compile(p, re.IGNORECASE) for p in _SMART_KEYWORDS]

        # 策略：头部 + 关键词行 + 尾部
        head_count = min(config.head_lines, len(lines))
        tail_count = min(config.tail_lines, len(lines) - head_count)

        # 收集中间区域的关键词行
        middle_start = head_count
        middle_end = len(lines) - tail_count

        important_middle: list[tuple[int, str]] = []
        for i in range(middle_start, middle_end):
            for pattern in patterns:
                if pattern.search(lines[i]):
                    important_middle.append((i, lines[i]))
                    break

        # 计算剩余槽位给关键词行
        slots_for_important = max(0, max_lines - head_count - tail_count)
        important_middle = important_middle[:slots_for_important]

        # 按行号合并：头部 + 关键词行 + 尾部，中间插入省略标记
        result: list[str] = []
        last_idx = -1

        # 头部
        for i in range(head_count):
            result.append(lines[i])
            last_idx = i

        # 关键词行（按行号顺序）
        for idx, line in important_middle:
            if idx > last_idx + 1:
                skipped = idx - last_idx - 1
                if skipped > 0:
                    result.append("")
                    result.append(f"... [省略 {skipped} 行] ...")
                    result.append("")
            result.append(line)
            last_idx = idx

        # 尾部
        tail_start = len(lines) - tail_count
        if tail_start > last_idx + 1:
            skipped = tail_start - last_idx - 1
            if skipped > 0:
                result.append("")
                result.append(f"... [省略 {skipped} 行] ...")
                result.append("")

        for i in range(tail_start, len(lines)):
            result.append(lines[i])

        return result[:max_lines]

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """粗略估算 token 数（中文按字符计，英文按 4 字符/token）。

        Args:
            text: 待估算的文本。

        Returns:
            int: 估算的 token 数。
        """
        chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
        other_chars = len(text) - chinese_chars
        return chinese_chars + max(1, other_chars // 4)

    @staticmethod
    def _build_note(
        tool_name: str,
        original_chars: int,
        truncated_chars: int,
        original_lines: int,
        truncated_lines: int,
    ) -> str:
        """构建截断说明。

        Args:
            tool_name: 工具名称。
            original_chars: 原始字符数。
            truncated_chars: 截断后字符数。
            original_lines: 原始行数。
            truncated_lines: 截断后行数。

        Returns:
            str: 截断说明文本。
        """
        saved_pct = (1 - truncated_chars / original_chars) * 100 if original_chars > 0 else 0
        return (
            f"[输出已截断] 工具: {tool_name} | "
            f"原始: {original_chars}字符/{original_lines}行 → "
            f"保留: {truncated_chars}字符/{truncated_lines}行 "
            f"(节省 {saved_pct:.0f}%)"
        )

    def get_stats(self) -> dict[str, Any]:
        """获取限制器统计信息。

        Returns:
            dict: 包含受限制工具列表等信息。
        """
        return {
            "configured_tools": sorted(self._tool_limits.keys()),
            "global_default": {
                "max_chars": self._global_default.max_chars,
                "max_lines": self._global_default.max_lines,
                "max_tokens": self._global_default.max_tokens,
            },
        }


# 全局单例
_limiter: ToolOutputLimiter | None = None


def get_output_limiter() -> ToolOutputLimiter:
    """获取全局工具输出限制器单例。

    Returns:
        ToolOutputLimiter: 全局限制器实例。
    """
    global _limiter
    if _limiter is None:
        _limiter = ToolOutputLimiter()
    return _limiter


def limit_tool_output(tool_name: str, output: str) -> TruncationResult:
    """便捷函数：对工具输出进行限制。

    Args:
        tool_name: 工具名称。
        output: 原始输出文本。

    Returns:
        TruncationResult: 截断结果。
    """
    return get_output_limiter().limit(tool_name, output)

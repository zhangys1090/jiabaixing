"""工具自动发现 — AST 扫描工具目录，自动注册符合约定的工具。

约定：
1. 工具文件位于 tools/ 目录下，文件名匹配 *_tools.py 或 tool_*.py
2. 文件导出 TOOL_DEFINITION (ToolDefinition) 和 TOOL_EXECUTOR (callable)
3. AST 静态扫描确认文件包含 TOOL_DEFINITION 赋值，避免无效 import

环境变量：
    TOOL_AUTO_DISCOVERY=enabled|disabled  控制是否启用自动发现（默认 enabled）
    TOOL_AUTO_DISCOVERY_LOG=verbose       输出详细发现日志

Usage:
    from agent.tools.auto_discovery import ToolAutoDiscovery
    discoverer = ToolAutoDiscovery()
    count = discoverer.discover(registry)
"""

from __future__ import annotations

import ast
import importlib
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from agent.core.logger import StructuredLogger

if TYPE_CHECKING:
    from agent.tools.registry import ToolRegistry

log = StructuredLogger("auto_discovery")

EXCLUDE_FILES: set[str] = {
    "__init__.py",
    "registry.py",
    "toolset_registry.py",
    "toolset_sampling.py",
    "builtin_toolsets.py",
    "auto_discovery.py",
    "approval_manager.py",
    "async_delegation.py",
    "clarify_tool.py",
    "code_execution_tool.py",
    "delegate_tool.py",
    "mcp_tool_bridge.py",
    "output_limiter.py",
    "permission_guard.py",
    "schema_validator.py",
    "tool_call_guard.py",
    "tool_result_cache.py",
    "tool_search.py",
    "web_search_provider.py",
    "write_approval_tool.py",
    "session_search_tool.py",
    "browser_automation.py",
    "browser_tools.py",
}


def _is_enabled() -> bool:
    """检查自动发现是否启用。"""
    return os.getenv("TOOL_AUTO_DISCOVERY", "enabled").lower() != "disabled"


def _is_verbose() -> bool:
    return os.getenv("TOOL_AUTO_DISCOVERY_LOG", "").lower() == "verbose"


class ToolAutoDiscovery:
    """AST 扫描工具目录，自动发现并注册工具。

    两层扫描：
    1. AST 静态扫描：快速确认文件是否包含 TOOL_DEFINITION 赋值
    2. 动态 import：加载模块并获取 TOOL_DEFINITION / TOOL_EXECUTOR
    """

    TOOLS_DIR: Path = Path(__file__).parent

    def __init__(self) -> None:
        self._discovered: list[str] = []
        self._skipped: list[str] = []
        self._errors: list[tuple[str, str]] = []

    def discover(self, registry: "ToolRegistry") -> int:
        """扫描 tools/ 目录，自动注册所有符合约定的工具。

        Args:
            registry: 工具注册中心实例。

        Returns:
            int: 成功注册的工具数量。
        """
        if not _is_enabled():
            log.info("工具自动发现已禁用（TOOL_AUTO_DISCOVERY=disabled）")
            return 0

        count = 0
        for py_file in self._find_tool_files():
            if not self._has_tool_exports(py_file):
                self._skipped.append(py_file.stem)
                continue

            try:
                module = self._import_module(py_file)
                if hasattr(module, "TOOL_DEFINITION") and hasattr(module, "TOOL_EXECUTOR"):
                    definition = module.TOOL_DEFINITION
                    executor = module.TOOL_EXECUTOR

                    if registry.has(definition.name):
                        if _is_verbose():
                            log.debug(
                                "工具已存在，跳过自动发现",
                                tool_name=definition.name,
                                source=py_file.name,
                            )
                        self._skipped.append(definition.name)
                        continue

                    registry.register(definition, executor)
                    self._discovered.append(definition.name)
                    count += 1

                    if _is_verbose():
                        log.info(
                            "自动发现工具",
                            tool_name=definition.name,
                            category=definition.category.value,
                            source=py_file.name,
                        )
                else:
                    self._skipped.append(py_file.stem)
            except Exception as exc:
                self._errors.append((py_file.name, str(exc)))
                log.warning(
                    "工具自动发现失败",
                    file=py_file.name,
                    error=str(exc),
                )

        log.info(
            "工具自动发现完成",
            discovered=count,
            skipped=len(self._skipped),
            errors=len(self._errors),
        )
        return count

    def _find_tool_files(self) -> list[Path]:
        """发现工具文件：*_tools.py 或 tool_*.py，排除非工具文件。"""
        files: list[Path] = []
        for py_file in sorted(self.TOOLS_DIR.glob("*.py")):
            if py_file.name in EXCLUDE_FILES:
                continue
            if py_file.name.endswith("_tools.py") or py_file.name.startswith("tool_"):
                files.append(py_file)
        return files

    def _has_tool_exports(self, path: Path) -> bool:
        """AST 静态检查：文件是否包含 TOOL_DEFINITION 赋值。"""
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return False

        try:
            tree = ast.parse(source)
        except SyntaxError:
            return False

        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "TOOL_DEFINITION":
                        return True
            elif isinstance(node, ast.AnnAssign):
                target = node.target
                if isinstance(target, ast.Name) and target.id == "TOOL_DEFINITION":
                    return True

        return False

    def _import_module(self, path: Path) -> object:
        """动态导入工具模块。"""
        module_name = path.stem
        full_name = f"agent.tools.{module_name}"

        if full_name in sys.modules:
            return sys.modules[full_name]

        spec = importlib.util.spec_from_file_location(full_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"无法加载模块: {path}")

        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
        return module

    @property
    def discovered(self) -> list[str]:
        return self._discovered

    @property
    def skipped(self) -> list[str]:
        return self._skipped

    @property
    def errors(self) -> list[tuple[str, str]]:
        return self._errors

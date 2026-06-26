from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


CONTEXT_FILE_PRIORITY = [
    "CONTEXT.md",
    "CONTEXT.txt",
    "README.md",
    "README.txt",
    "project.md",
    ".context.md",
    ".cursorrules",
    ".windsurfrules",
]

SOUL_FILE_NAME = "SOUL.md"

MAX_FILE_CHARS = 15000
MAX_FOLDER_ENTRIES = 50
MAX_FOLDER_DEPTH = 3

DANGEROUS_CONTEXT_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions?",
    r"forget\s+(all\s+)?(previous|prior|above)\s+instructions?",
    r"disregard\s+(all\s+)?(previous|prior|above)\s+instructions?",
    r"you\s+(are|must|should)\s+(now\s+)?(act|behave|pretend)\s+as",
    r"system\s*prompt\s*:?\s*$",
    r"<\|im_start\|>",
    r"<\|im_end\|>",
]


@dataclass
class TokenAllocation:
    system_prompt: int = 2400
    memory: int = 1200
    history: int = 2000
    dynamic_context: int = 1200
    tool_results: int = 1200
    reserve: int = 800


_ALLOCATION_RATIOS = {
    "system_prompt": 0.30,
    "memory": 0.15,
    "history": 0.25,
    "dynamic_context": 0.15,
    "tool_results": 0.15,
    "reserve": 0.10,
}


class TokenBudgetAllocator:
    def __init__(self, total_budget: int = 8000) -> None:
        self._total = total_budget

    def allocate(self) -> TokenAllocation:
        return TokenAllocation(
            system_prompt=int(self._total * _ALLOCATION_RATIOS["system_prompt"]),
            memory=int(self._total * _ALLOCATION_RATIOS["memory"]),
            history=int(self._total * _ALLOCATION_RATIOS["history"]),
            dynamic_context=int(self._total * _ALLOCATION_RATIOS["dynamic_context"]),
            tool_results=int(self._total * _ALLOCATION_RATIOS["tool_results"]),
            reserve=int(self._total * _ALLOCATION_RATIOS["reserve"]),
        )

    @staticmethod
    def estimate_tokens(text: str) -> int:
        return max(1, len(text) // 4)

    def truncate_to_budget(self, text: str, budget: int) -> str:
        estimated = self.estimate_tokens(text)
        if estimated <= budget:
            return text
        max_chars = budget * 4
        return text[:max_chars] + "..."

    @property
    def total_budget(self) -> int:
        return self._total


@dataclass
class ContextEntry:
    id: str
    type: str
    content: str
    priority: int = 5
    token_estimate: int = 0
    source: str = ""


class ContextManager:
    """上下文管理器——可组合管道，构建LLM对话上下文。

    整合系统提示、人格语气、动态上下文、记忆注入、历史消息和@引用解析。
    支持Token预算分配和上下文文件注册表。

    Usage:
        mgr = ContextManager(total_budget=8000)
        mgr.set_reference_resolver(resolver)
        mgr.set_file_registry(registry)
        messages = mgr.build_context(user_input="你好", system_prompt="你是助手")
    """

    def __init__(self, total_budget: int = 8000) -> None:
        self._allocator = TokenBudgetAllocator(total_budget)
        self._entries: list[ContextEntry] = []
        self._reference_resolver: ContextReferenceResolver | None = None
        self._file_registry: ContextFileRegistry | None = None

    def set_reference_resolver(self, resolver: ContextReferenceResolver) -> None:
        """设置引用解析器，用于解析@file/@folder/@url引用。

        Args:
            resolver: ContextReferenceResolver实例。
        """
        self._reference_resolver = resolver

    def set_file_registry(self, registry: ContextFileRegistry) -> None:
        """设置上下文文件注册表，用于加载项目上下文文件。

        Args:
            registry: ContextFileRegistry实例。
        """
        self._file_registry = registry

    def build_context(
        self,
        user_input: str,
        system_prompt: str = "",
        memories: list[str] | None = None,
        history: list[dict[str, str]] | None = None,
        dynamic_context: str = "",
        persona_summary: str = "",
        scene: str = "daily",
    ) -> list[dict[str, str]]:
        self._entries = []
        allocation = self._allocator.allocate()
        messages: list[dict[str, str]] = []

        if system_prompt:
            truncated = self._allocator.truncate_to_budget(system_prompt, allocation.system_prompt)
            messages.append({"role": "system", "content": truncated})
            self._entries.append(ContextEntry(
                id="constitutional", type="system", content=truncated,
                priority=10, source="ConstitutionalBuilder",
            ))

        if persona_summary:
            tone = self._get_tone_instruction(scene)
            persona_content = f"{persona_summary}\n\n{tone}"
            truncated = self._allocator.truncate_to_budget(persona_content, allocation.dynamic_context)
            messages.append({"role": "system", "content": truncated})
            self._entries.append(ContextEntry(
                id="persona_tone", type="dynamic", content=truncated,
                priority=9, source="PersonaCore",
            ))

        if dynamic_context:
            truncated = self._allocator.truncate_to_budget(dynamic_context, allocation.dynamic_context)
            messages.append({"role": "system", "content": truncated})
            self._entries.append(ContextEntry(
                id="dynamic", type="dynamic", content=truncated,
                priority=9, source="DynamicContext",
            ))

        if memories:
            memory_text = "\n".join(memories)
            truncated = self._allocator.truncate_to_budget(memory_text, allocation.memory)
            messages.append({"role": "system", "content": f"【相关记忆】\n{truncated}"})
            self._entries.append(ContextEntry(
                id="memories", type="memory", content=truncated,
                priority=7, source="MemoryInjector",
            ))

        if history:
            for msg in history[-10:]:
                messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})

        final_user_input = user_input

        if self._reference_resolver:
            try:
                resolved = self._reference_resolver.resolve(user_input)
                if resolved.has_references:
                    if resolved.resolved_content:
                        final_user_input = f"{resolved.cleaned_input}\n\n[引用内容]\n{resolved.resolved_content}"
                    else:
                        final_user_input = resolved.cleaned_input
            except Exception:
                pass

        messages.append({"role": "user", "content": final_user_input})
        return messages

    def get_entries(self) -> list[ContextEntry]:
        return list(self._entries)

    def get_allocation(self) -> TokenAllocation:
        return self._allocator.allocate()

    @staticmethod
    def infer_scene(input_text: str) -> str:
        text = input_text.lower()
        if re.search(r"代码|编程|开发|调试|bug|函数|接口|api|重构|部署", text):
            return "development"
        if re.search(r"工作|项目|排期|会议|汇报|方案|需求|上线", text):
            return "work"
        if re.search(r"难过|烦|累|焦虑|压力|不开心|心情|崩溃", text):
            return "comfort"
        if re.search(r"你好|早上好|晚安|嗨|hello|hi", text):
            return "greeting"
        if re.search(r"简报|总结|日报|周报|进度", text):
            return "briefing"
        return "daily"

    @staticmethod
    def _get_tone_instruction(scene: str) -> str:
        tones = {
            "development": "技术场景：简洁、精确、代码优先",
            "work": "工作场景：专业、高效、结果导向",
            "comfort": "关怀场景：温暖、共情、支持性",
            "greeting": "问候场景：友好、轻松、自然",
            "briefing": "简报场景：结构化、重点突出、数据驱动",
            "daily": "日常场景：自然、友好、有帮助",
        }
        return tones.get(scene, tones["daily"])


@dataclass
class ContextFileEntry:
    """上下文文件条目。

    Attributes:
        file_name: 文件名。
        content: 文件内容。
        loaded_at: 加载时间戳。
        source: 来源（project/soul）。
        char_count: 字符数。
        truncated: 是否被截断。
    """

    file_name: str
    content: str
    loaded_at: float = 0.0
    source: str = "project"
    char_count: int = 0
    truncated: bool = False


class ContextFileRegistry:
    """上下文文件注册表——发现、加载、安全扫描和截断项目上下文文件。

    统一管理上下文文件的发现和加载，消除重复硬编码。
    支持优先级文件发现（先匹配先生效）和 SOUL.md 独立插槽。

    Usage:
        registry = ContextFileRegistry(project_root="/path/to/project")
        entries = registry.load_all()
        for entry in entries:
            print(f"{entry.file_name}: {entry.char_count} chars")
    """

    def __init__(self, project_root: str | None = None, cache_ttl_ms: int = 300_000) -> None:
        self._cache: list[ContextFileEntry] = []
        self._cache_timestamp: float = 0.0
        self._cache_ttl_ms = cache_ttl_ms
        self._project_root = Path(project_root) if project_root else Path.cwd()

    def load_all(self) -> list[ContextFileEntry]:
        """加载所有上下文文件（项目上下文 + SOUL）。

        Returns:
            list[ContextFileEntry]: 上下文文件条目列表。
        """
        import time

        now = time.time()
        if (now - self._cache_timestamp) * 1000 < self._cache_ttl_ms and self._cache:
            return self._cache

        entries: list[ContextFileEntry] = []

        project_entry = self._load_project_context()
        if project_entry:
            entries.append(project_entry)

        soul_entry = self._load_soul_context()
        if soul_entry:
            entries.append(soul_entry)

        self._cache = entries
        self._cache_timestamp = now
        return entries

    def _load_project_context(self) -> ContextFileEntry | None:
        for name in CONTEXT_FILE_PRIORITY:
            file_path = self._project_root / name
            if file_path.exists():
                content = self._read_and_truncate(file_path)
                if self._scan_dangerous(content):
                    continue
                return ContextFileEntry(
                    file_name=name,
                    content=content,
                    loaded_at=__import__("time").time(),
                    source="project",
                    char_count=len(content),
                    truncated=len(content) >= MAX_FILE_CHARS,
                )
        return None

    def _load_soul_context(self) -> ContextFileEntry | None:
        file_path = self._project_root / SOUL_FILE_NAME
        if not file_path.exists():
            return None
        content = self._read_and_truncate(file_path)
        return ContextFileEntry(
            file_name=SOUL_FILE_NAME,
            content=content,
            loaded_at=__import__("time").time(),
            source="soul",
            char_count=len(content),
            truncated=len(content) >= MAX_FILE_CHARS,
        )

    def _read_and_truncate(self, file_path: Path) -> str:
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
            if len(content) > MAX_FILE_CHARS:
                head = int(MAX_FILE_CHARS * 0.7)
                mid = int(MAX_FILE_CHARS * 0.2)
                tail = int(MAX_FILE_CHARS * 0.1)
                content = (
                    content[:head]
                    + f"\n\n[... {len(content) - head - tail} chars truncated ...]\n\n"
                    + content[-tail:]
                )
            return content
        except (OSError, UnicodeDecodeError):
            return ""

    @staticmethod
    def _scan_dangerous(content: str) -> bool:
        for pattern in DANGEROUS_CONTEXT_PATTERNS:
            if re.search(pattern, content, re.IGNORECASE):
                return True
        return False

    def invalidate_cache(self) -> None:
        """清除缓存，强制下次load_all重新读取磁盘。"""
        self._cache = []
        self._cache_timestamp = 0.0


@dataclass
class ResolvedReference:
    """解析出的引用。

    Attributes:
        ref_type: 引用类型（file/folder/url/git_diff）。
        target: 引用目标。
        content: 引用内容。
        error: 错误信息（如果有）。
        char_count: 字符数。
    """

    ref_type: str
    target: str
    content: str = ""
    error: str | None = None
    char_count: int = 0


@dataclass
class ResolveResult:
    """引用解析结果。

    Attributes:
        has_references: 是否有引用。
        references: 引用列表。
        resolved_content: 展开后的引用内容。
        cleaned_input: 清理@标记后的输入。
    """

    has_references: bool = False
    references: list[ResolvedReference] = field(default_factory=list)
    resolved_content: str = ""
    cleaned_input: str = ""


REFERENCE_PATTERN = re.compile(r"@(https?://[^\s]+)|@([\w./\-]+(?:\.[\w]+)?)")


class ContextReferenceResolver:
    """上下文引用解析器——解析消息中的@引用并内联展开。

    支持 @file、@folder、@url、@git_diff 四种引用类型。
    将引用内容内联展开到用户消息中，供 LLM 理解上下文。

    Usage:
        resolver = ContextReferenceResolver(project_root="/path/to/project")
        result = resolver.resolve("请分析 @README.md 的内容")
        if result.has_references:
            print(result.resolved_content)
    """

    def __init__(self, project_root: str) -> None:
        self._project_root = Path(project_root)

    def resolve(self, input_text: str) -> ResolveResult:
        """解析输入中的所有@引用。

        Args:
            input_text: 用户输入文本。

        Returns:
            ResolveResult: 解析结果，包含引用列表和展开内容。
        """
        matches: list[tuple[str, str, int]] = []
        for m in REFERENCE_PATTERN.finditer(input_text):
            target = m.group(1) or m.group(2)
            if target:
                matches.append((m.group(0), target, m.start()))

        if not matches:
            return ResolveResult(cleaned_input=input_text)

        references: list[ResolvedReference] = []
        content_parts: list[str] = []
        cleaned_input = input_text

        for full_match, target, _ in matches:
            ref = self._resolve_reference(target)
            references.append(ref)

            if ref.content and not ref.error:
                content_parts.append(
                    f"--- @{target} ---\n{ref.content}\n--- end @{target} ---"
                )
            cleaned_input = cleaned_input.replace(full_match, target, 1)

        return ResolveResult(
            has_references=True,
            references=references,
            resolved_content="\n\n".join(content_parts),
            cleaned_input=cleaned_input,
        )

    def _resolve_reference(self, target: str) -> ResolvedReference:
        if target.startswith("http://") or target.startswith("https://"):
            return self._resolve_url(target)

        full_path = self._project_root / target
        full_path_resolved = full_path.resolve()

        if not full_path_resolved.exists():
            return ResolvedReference(
                ref_type="file",
                target=target,
                error=f"文件不存在: {target}",
            )

        if full_path_resolved.is_dir():
            return self._resolve_folder(target, full_path_resolved)

        return self._resolve_file(target, full_path_resolved)

    def _resolve_file(self, target: str, full_path: Path) -> ResolvedReference:
        try:
            content = full_path.read_text(encoding="utf-8", errors="replace")
            truncated = len(content) > MAX_FILE_CHARS
            final_content = (
                content[:MAX_FILE_CHARS]
                + f"\n\n[...truncated: {len(content)} chars total, showing first {MAX_FILE_CHARS}]"
                if truncated
                else content
            )
            return ResolvedReference(
                ref_type="file",
                target=target,
                content=final_content,
                char_count=len(final_content),
            )
        except (OSError, UnicodeDecodeError) as e:
            return ResolvedReference(
                ref_type="file",
                target=target,
                error=f"读取失败: {e}",
            )

    def _resolve_folder(self, target: str, full_path: Path) -> ResolvedReference:
        try:
            tree = self._list_directory(full_path, MAX_FOLDER_DEPTH)
            content = f"目录结构 ({target}):\n{tree}"
            return ResolvedReference(
                ref_type="folder",
                target=target,
                content=content,
                char_count=len(content),
            )
        except OSError as e:
            return ResolvedReference(
                ref_type="folder",
                target=target,
                error=f"读取失败: {e}",
            )

    def _resolve_url(self, target: str) -> ResolvedReference:
        return ResolvedReference(
            ref_type="url",
            target=target,
            content=f"[URL引用] {target}",
            char_count=len(target) + 10,
        )

    def _list_directory(self, dir_path: Path, max_depth: int, prefix: str = "") -> str:
        lines: list[str] = []
        try:
            entries = sorted(dir_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
            visible = [
                e
                for e in entries
                if not e.name.startswith(".")
                and e.name != "node_modules"
                and e.name != "__pycache__"
            ]

            for entry in visible[:MAX_FOLDER_ENTRIES]:
                icon = "📁" if entry.is_dir() else "📄"
                lines.append(f"{prefix}{icon} {entry.name}")

                if entry.is_dir() and max_depth > 1:
                    sub_tree = self._list_directory(entry, max_depth - 1, prefix + "  ")
                    lines.append(sub_tree)
        except (OSError, PermissionError):
            lines.append(f"{prefix}[读取失败]")
        return "\n".join(lines)

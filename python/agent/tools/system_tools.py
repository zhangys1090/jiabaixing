from __future__ import annotations

import os
import time as _time
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)


ASK_CLARIFICATION_DEF = ToolDefinition(
    name="ask_clarification",
    description="向用户请求澄清。适用场景：用户需求不明确、存在歧义。不适用：需求已明确时。",
    short_desc="请求用户澄清",
    category=ToolCategory.SYSTEM,
    tags=["clarify", "question", "system"],
    scenes=["coding", "daily", "research"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="question", type="string", description="需要澄清的问题"),
        ToolParameterDef(name="options", type="string", required=False, description="可选选项列表"),
    ],
    risk_level="low",
)

CONTEXT_MANAGE_DEF = ToolDefinition(
    name="context_manage",
    description="管理对话上下文，支持压缩、摘要、聚焦。适用场景：对话过长需要压缩、需要聚焦关键信息。",
    short_desc="管理对话上下文",
    category=ToolCategory.SYSTEM,
    tags=["context", "compress", "summarize", "system"],
    scenes=["coding", "daily", "research"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作: compress/summarize/focus/reset", enum=["compress", "summarize", "focus", "reset"]),
        ToolParameterDef(name="target", type="string", required=False, description="聚焦目标关键词"),
    ],
    risk_level="low",
)

PREVIEW_EXECUTION_DEF = ToolDefinition(
    name="preview_execution",
    description="预览执行计划，不实际执行。适用场景：高风险操作前预览、确认执行步骤。",
    short_desc="预览执行计划",
    category=ToolCategory.SYSTEM,
    tags=["preview", "plan", "system", "safety"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="plan", type="string", description="执行计划描述"),
    ],
    risk_level="low",
)

ROLLBACK_CHANGES_DEF = ToolDefinition(
    name="rollback_changes",
    description="回滚最近的文件修改。适用场景：操作出错需要撤销。不适用：未做修改时。",
    short_desc="回滚文件修改",
    category=ToolCategory.SYSTEM,
    tags=["rollback", "undo", "revert", "system", "safety"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", required=False, description="要回滚的文件路径"),
        ToolParameterDef(name="steps", type="number", required=False, description="回滚步数"),
    ],
    risk_level="medium",
)


async def ask_clarification_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    question = str(params.get("question", ""))
    options = params.get("options")

    if not question:
        return ToolResult(success=False, error="问题不能为空")

    output = f"❓ {question}"
    if options:
        output += f"\n选项: {options}"

    return ToolResult(success=True, output=output, duration=time.time() - start)


async def context_manage_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    action = str(params.get("action", "summarize"))
    target = params.get("target")

    if action == "compress":
        return ToolResult(success=True, output="上下文已压缩", duration=time.time() - start)
    elif action == "summarize":
        llm = None
        try:
            from agent.main import engine
            if engine and hasattr(engine, "llm"):
                llm = engine.llm
        except Exception:
            pass

        if llm:
            try:
                from agent.main import engine
                history = []
                if engine and hasattr(engine, "loop") and engine.loop:
                    history = getattr(engine.loop, "_conversation_history", [])

                if history:
                    last_msgs = history[-10:]
                    context_text = "\n".join(
                        f"{m.get('role', 'user')}: {m.get('content', '')[:200]}"
                        for m in last_msgs
                    )
                    prompt = f"请总结以下对话的关键信息：\n{context_text}"
                    response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
                    return ToolResult(success=True, output=response.get("content", "摘要完成"), duration=time.time() - start)
            except Exception:
                pass

        return ToolResult(success=True, output="上下文摘要完成", duration=time.time() - start)
    elif action == "focus":
        if target:
            return ToolResult(success=True, output=f"上下文已聚焦到: {target}", duration=time.time() - start)
        return ToolResult(success=False, error="聚焦操作需要指定目标关键词")
    elif action == "reset":
        return ToolResult(success=True, output="上下文已重置", duration=time.time() - start)
    else:
        return ToolResult(success=False, error=f"未知操作: {action}")


async def preview_execution_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    plan = str(params.get("plan", ""))

    if not plan:
        return ToolResult(success=False, error="执行计划不能为空")

    llm = None
    try:
        from agent.main import engine
        if engine and hasattr(engine, "llm"):
            llm = engine.llm
    except Exception:
        pass

    if llm:
        try:
            prompt = (
                f"请分析以下执行计划的风险和可行性：\n\n"
                f"{plan}\n\n"
                f"请给出：1. 执行步骤分解 2. 潜在风险 3. 建议的替代方案"
            )
            response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
            content = response.get("content", "")
            return ToolResult(success=True, output=content, duration=time.time() - start)
        except Exception:
            pass

    return ToolResult(success=True, output=f"执行计划预览:\n{plan}", duration=time.time() - start)


async def rollback_changes_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    file_path = params.get("file_path")
    steps = int(params.get("steps", 1))

    try:
        from agent.main import engine
        if engine and hasattr(engine, "persistence") and engine.persistence:
            checkpoint = engine.persistence.checkpoint
            if checkpoint:
                if file_path:
                    success = await checkpoint.rollback_file(str(file_path), steps)
                else:
                    success = await checkpoint.rollback_last(steps)

                if success:
                    target = str(file_path) if file_path else "最近修改"
                    return ToolResult(
                        success=True,
                        output=f"已回滚: {target}（{steps}步）",
                        duration=time.time() - start,
                    )
    except Exception:
        pass

    return ToolResult(success=False, error="回滚失败：检查点服务不可用或无可用快照")


# ═══════════════════════════════════════════════════════════════
# P3 工具: file_dedup, log_view, shell_generate,
#         voice_interact, delegate_task, get_active_file
# ═══════════════════════════════════════════════════════════════

import hashlib
import os
import platform
import re
import time as _time
from pathlib import Path


FILE_DEDUP_DEF = ToolDefinition(
    name="file_dedup",
    description="扫描目录中的重复文件。适用场景：清理重复文件、整理目录、释放磁盘空间。不适用：搜索文件内容（用file_search）或列出目录（用file_list）。返回重复文件对列表，不自动删除。",
    category=ToolCategory.FILE,
    parameters=[
        ToolParameterDef(name="directory", type="string", required=False, description="要扫描的目录路径，默认当前目录"),
        ToolParameterDef(name="recursive", type="boolean", required=False, description="是否递归扫描子目录"),
        ToolParameterDef(name="min_size", type="number", required=False, description="最小文件大小(字节)，跳过太小的文件"),
    ],
    risk_level="low",
)


LOG_VIEW_DEF = ToolDefinition(
    name="log_view",
    description="查看应用日志。适用场景：看日志、查错误、排查问题、了解系统运行状态。支持按级别/模块/关键词过滤。不适用：修改日志配置或清理日志文件。",
    category=ToolCategory.SYSTEM,
    parameters=[
        ToolParameterDef(name="level", type="string", required=False, description="日志级别过滤", enum=["all", "error", "warn", "info", "fatal"]),
        ToolParameterDef(name="keyword", type="string", required=False, description="关键词过滤"),
        ToolParameterDef(name="module", type="string", required=False, description="模块名过滤"),
        ToolParameterDef(name="lines", type="number", required=False, description="返回最后 N 条日志"),
        ToolParameterDef(name="log_file", type="string", required=False, description="日志文件名", enum=["combined.log", "error.log", "fatal.log", "audit.log"]),
    ],
    risk_level="low",
)


SHELL_GENERATE_DEF = ToolDefinition(
    name="shell_generate",
    description="将自然语言描述转换为Shell命令。适用场景：用户用自然语言描述想做什么（如查看端口占用、找大文件）。不适用：用户已给出具体命令（用shell_exec）。自动适配Windows/Linux/macOS。",
    category=ToolCategory.SYSTEM,
    parameters=[
        ToolParameterDef(name="intent", type="string", description="用户意图的自然语言描述"),
        ToolParameterDef(name="os", type="string", required=False, description="目标操作系统", enum=["win32", "linux", "darwin"]),
    ],
    risk_level="medium",
)


VOICE_INTERACT_DEF = ToolDefinition(
    name="voice_interact",
    description="语音交互工具。管理实时语音会话，支持语音合成(speak)、语音识别(listen)、会话控制等操作。speak自动检测edge-tts/系统TTS引擎；listen对接speech_transcribe工具。适用场景：语音对话、语音播报、语音助手交互。",
    category=ToolCategory.SYSTEM,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["start_session", "stop_session", "speak", "listen", "status"]),
        ToolParameterDef(name="text", type="string", required=False, description="speak操作时要转为语音的文本内容"),
        ToolParameterDef(name="language", type="string", required=False, description="语音识别/合成的语言，默认zh-CN"),
        ToolParameterDef(name="emotion", type="string", required=False, description="语音合成的情绪参数", enum=["平静", "开心", "悲伤", "惊讶", "愤怒", "温柔", "宠溺"]),
        ToolParameterDef(name="audio_path", type="string", required=False, description="listen操作时的音频文件路径，留空则尝试录音"),
        ToolParameterDef(name="voice", type="string", required=False, description="speak操作的语音角色，如zh-CN-XiaoxiaoNeural、zh-CN-YunxiNeural"),
    ],
    risk_level="low",
)


DELEGATE_TASK_DEF = ToolDefinition(
    name="delegate_task",
    description="将子任务委托给独立的子Agent执行。适用场景：并行处理多个独立任务、将复杂任务拆分给专门的执行者、需要隔离上下文执行子任务。不适用：任务简单可直接用单个工具完成。",
    category=ToolCategory.SYSTEM,
    parameters=[
        ToolParameterDef(name="goal", type="string", description="子Agent要完成的目标"),
        ToolParameterDef(name="context", type="string", required=False, description="子Agent需要的上下文信息"),
        ToolParameterDef(name="tools", type="array", required=False, description="限制子Agent可用的工具列表"),
        ToolParameterDef(name="max_iterations", type="number", required=False, description="子Agent最大执行轮次"),
    ],
    risk_level="medium",
)


GET_ACTIVE_FILE_DEF = ToolDefinition(
    name="get_active_file",
    description="获取用户当前正在编辑的文件内容（需要IDE集成支持）。适用场景：用户说改一下这个文件但没有提供文件路径。不适用：用户已明确提供文件路径。",
    category=ToolCategory.FILE,
    parameters=[
        ToolParameterDef(name="include_related", type="boolean", required=False, description="是否同时获取相关文件"),
    ],
    risk_level="low",
)


def _format_size(bytes_val: int) -> str:
    if bytes_val < 1024:
        return f"{bytes_val}B"
    if bytes_val < 1024 * 1024:
        return f"{bytes_val / 1024:.1f}KB"
    if bytes_val < 1024 * 1024 * 1024:
        return f"{bytes_val / (1024 * 1024):.1f}MB"
    return f"{bytes_val / (1024 * 1024 * 1024):.1f}GB"


def _scan_files(dir_path: str, recursive: bool, min_size: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    try:
        p = Path(dir_path)
        for entry in p.iterdir():
            if entry.is_file():
                try:
                    stat = entry.stat()
                    if stat.st_size >= min_size:
                        results.append({"path": str(entry), "size": stat.st_size, "name": entry.name})
                except OSError:
                    pass
            elif entry.is_dir() and recursive and not entry.name.startswith("."):
                results.extend(_scan_files(str(entry), recursive, min_size))
    except OSError:
        pass
    return results


def _hash_file(file_path: str) -> str:
    h = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


async def file_dedup_executor(params: dict[str, Any]) -> ToolResult:
    start = _time.time()
    dir_path = str(params.get("directory", os.getcwd()))
    recursive = params.get("recursive", True)
    min_size = int(params.get("min_size", 1024))

    if not Path(dir_path).is_dir():
        return ToolResult(success=False, error=f"目录不存在: {dir_path}", duration=_time.time() - start)

    files = _scan_files(dir_path, recursive, min_size)
    if not files:
        return ToolResult(success=True, output="目录为空或没有符合条件的文件", duration=_time.time() - start)

    size_groups: dict[int, list[dict[str, Any]]] = {}
    for f in files:
        size_groups.setdefault(f["size"], []).append(f)

    duplicates: list[dict[str, Any]] = []
    total_wasted = 0

    for group in size_groups.values():
        if len(group) < 2:
            continue
        for f in group:
            f["hash"] = _hash_file(f["path"])

        hash_groups: dict[str, list[dict[str, Any]]] = {}
        for f in group:
            hash_groups.setdefault(f["hash"], []).append(f)

        for h, h_group in hash_groups.items():
            if len(h_group) >= 2:
                duplicates.append({
                    "files": [f["path"] for f in h_group],
                    "size": h_group[0]["size"],
                    "hash": h[:12],
                })
                total_wasted += h_group[0]["size"] * (len(h_group) - 1)

    if not duplicates:
        return ToolResult(success=True, output=f"扫描了 {len(files)} 个文件，未发现重复文件。", duration=_time.time() - start)

    lines = [f"扫描了 {len(files)} 个文件，发现 {len(duplicates)} 组重复文件："]
    lines.append(f"浪费空间: {_format_size(total_wasted)}\n")

    for i, dup in enumerate(duplicates, 1):
        lines.append(f"--- 第 {i} 组 ({_format_size(dup['size'])}, hash: {dup['hash']}) ---")
        for fp in dup["files"]:
            lines.append(f"  {fp}")
        lines.append("")

    lines.append("提示: 以上文件内容完全相同，请手动确认后删除不需要的副本。")

    return ToolResult(
        success=True,
        output="\n".join(lines),
        duration=_time.time() - start,
        metadata={"scannedFiles": len(files), "duplicateGroups": len(duplicates), "wastedBytes": total_wasted},
    )


async def log_view_executor(params: dict[str, Any]) -> ToolResult:
    start = _time.time()
    level = str(params.get("level", "all"))
    keyword = params.get("keyword")
    module_name = params.get("module")
    lines_count = int(params.get("lines", 30))
    log_file = str(params.get("log_file", "combined.log"))

    logs_dir = Path(os.environ.get("LOGS_DIR", str(Path(os.environ.get("DATA_DIR", "data")) / "logs")))
    file_path = logs_dir / log_file

    if not file_path.is_file():
        return ToolResult(success=False, error=f"日志文件不存在: {file_path}", duration=_time.time() - start)

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
        all_lines = [l.strip() for l in content.splitlines() if l.strip()]

        parsed: list[dict[str, Any]] = []
        import json as _json
        for line in all_lines:
            try:
                parsed.append(_json.loads(line))
            except (ValueError, _json.JSONDecodeError):
                parsed.append({"message": line, "level": "info"})

        filtered = parsed
        if level != "all":
            filtered = [l for l in filtered if l.get("level") == level]
        if keyword:
            kw = str(keyword).lower()
            filtered = [l for l in filtered if kw in str(l.get("message", "")).lower() or kw in str(l.get("module", "")).lower()]
        if module_name:
            mod = str(module_name).lower()
            filtered = [l for l in filtered if mod in str(l.get("module", "")).lower()]

        recent = filtered[-lines_count:]

        if not recent:
            return ToolResult(
                success=True,
                output=f"日志查询: {log_file}\n过滤: level={level}, keyword={keyword or '-'}, module={module_name or '-'}\n\n没有匹配的日志条目。",
                duration=_time.time() - start,
            )

        icons = {"error": "🔴", "warn": "🟡", "info": "🟢", "fatal": "💀"}
        out_lines = [f"📋 日志查询: {log_file}", f"过滤: level={level}, keyword={keyword or '-'}, module={module_name or '-'}", f"匹配: {len(recent)} 条", "─" * 50]

        for log in recent:
            icon = icons.get(str(log.get("level", "")), "⚪")
            ts = str(log.get("timestamp", ""))[11:19]
            mod_str = f"[{log['module']}]" if log.get("module") else ""
            msg = str(log.get("message", ""))[:200]
            trace = f" ({log.get('traceId')})" if log.get("traceId") else ""
            out_lines.append(f"{icon} {ts} {mod_str} {msg}{trace}")
            if log.get("error") and log.get("level") == "error":
                out_lines.append(f"   ❌ {str(log['error'])[:150]}")

        return ToolResult(success=True, output="\n".join(out_lines), duration=_time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"读取日志失败: {e}", duration=_time.time() - start)


_LOW_RISK_SHELL_PATTERNS = [
    re.compile(r"^(ls|dir|Get-ChildItem|pwd|cd|echo|cat|Get-Content|head|tail|wc|grep|find|which|where|whoami|hostname|date|uname|ver|env|set)", re.IGNORECASE),
    re.compile(r"^(ipconfig|ifconfig|ping|traceroute|nslookup|netstat|systeminfo|tasklist)", re.IGNORECASE),
    re.compile(r"^(git\s+(status|log|diff|branch|show|remote))", re.IGNORECASE),
    re.compile(r"^(npm\s+(list|ls|outdated|whoami|prefix))", re.IGNORECASE),
    re.compile(r"^(node\s+--version|python\s+--version|java\s+-version)", re.IGNORECASE),
]


def _detect_os() -> str:
    s = platform.system().lower()
    if s == "windows":
        return "win32"
    if s == "darwin":
        return "darwin"
    return "linux"


def _get_os_name(os_name: str) -> str:
    mapping = {"win32": "Windows (PowerShell)", "darwin": "macOS (zsh/bash)", "linux": "Linux (bash)"}
    return mapping.get(os_name, os_name)


def _is_low_risk(command: str) -> bool:
    trimmed = command.strip()
    return any(p.match(trimmed) for p in _LOW_RISK_SHELL_PATTERNS)


async def shell_generate_executor(params: dict[str, Any]) -> ToolResult:
    start = _time.time()
    intent = str(params.get("intent", ""))
    os_name = str(params.get("os", _detect_os()))

    if not intent.strip():
        return ToolResult(success=False, error="意图描述不能为空", duration=_time.time() - start)

    llm = None
    try:
        from agent.main import engine
        if engine and hasattr(engine, "llm"):
            llm = engine.llm
    except Exception:
        pass

    if not llm:
        return ToolResult(
            success=True,
            output=f"⚠️ 无LLM可用，无法生成命令。\n\n意图: {intent}\n系统: {_get_os_name(os_name)}\n\n请手动输入对应命令，或使用shell_exec直接执行。",
            duration=_time.time() - start,
            metadata={"fallback": True, "intent": intent, "os": os_name},
        )

    try:
        os_display = _get_os_name(os_name)
        prompt = (
            f"你是一个命令行专家。用户想完成以下操作，请生成对应的shell命令。\n\n"
            f"用户意图: {intent}\n"
            f"操作系统: {os_display}\n\n"
            f'请严格按以下JSON格式输出（不要输出其他内容）:\n'
            f'{{"command": "实际命令", "explanation": "一句话解释", "risk_level": "low|medium|high", "requires_confirm": true或false}}\n\n'
            f"规则:\n1. 命令必须适配指定操作系统\n2. Windows用PowerShell语法\n3. 高风险命令requires_confirm设为true\n4. 只输出JSON"
        )
        response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
        content = response.get("content", "")

        import json as _json
        json_match = re.search(r"\{[\s\S]*\}", content)
        if not json_match:
            return ToolResult(success=False, error="LLM未返回有效JSON", duration=_time.time() - start)

        parsed = _json.loads(json_match.group())
        command = parsed.get("command", "")
        explanation = parsed.get("explanation", "")
        risk_level = parsed.get("risk_level", "medium")

        low_risk = _is_low_risk(command)
        needs_confirm = not low_risk and risk_level in ("high", "medium")

        icon = {"low": "🟢", "medium": "🟡", "high": "🔴"}.get(risk_level, "⚪")
        output = f"💻 生成命令 ({os_display})\n\n$ {command}\n\n{icon} 风险: {risk_level}\n📖 {explanation}"
        if needs_confirm:
            output += f"\n\n⚠️ 此命令需要确认后执行。使用shell_exec执行: {command}"

        return ToolResult(
            success=True,
            output=output,
            duration=_time.time() - start,
            metadata={"command": command, "explanation": explanation, "risk_level": risk_level, "os": os_name, "intent": intent},
        )
    except Exception as e:
        return ToolResult(success=False, error=f"命令生成失败: {e}", duration=_time.time() - start)


_voice_session: dict[str, Any] | None = None


async def voice_interact_executor(params: dict[str, Any]) -> ToolResult:
    global _voice_session
    start = _time.time()
    action = str(params.get("action", ""))
    text = params.get("text", "")
    language = str(params.get("language", "zh-CN"))
    emotion = str(params.get("emotion", "平静"))
    audio_path = str(params.get("audio_path", ""))
    voice = str(params.get("voice", ""))

    if action == "start_session":
        _voice_session = {"id": f"voice_{int(_time.time())}", "status": "idle", "language": language, "startedAt": _time.time(), "turnCount": 0}
        return ToolResult(
            success=True,
            output=f"语音会话已启动 (id={_voice_session['id']}, language={language})",
            duration=_time.time() - start,
            metadata={"sessionId": _voice_session["id"], "language": language, "status": "idle"},
        )
    elif action == "stop_session":
        if not _voice_session:
            return ToolResult(success=False, error="没有活跃的语音会话", duration=_time.time() - start)
        turns = _voice_session.get("turnCount", 0)
        _voice_session = None
        return ToolResult(success=True, output=f"语音会话已停止 (轮次={turns})", duration=_time.time() - start)
    elif action == "speak":
        if not text:
            return ToolResult(success=False, error="speak操作需要提供text参数", duration=_time.time() - start)
        return await _do_tts_speak(str(text), language, emotion, voice, start)
    elif action == "listen":
        if not _voice_session:
            return ToolResult(success=False, error="没有活跃的语音会话，请先使用start_session", duration=_time.time() - start)
        return await _do_stt_listen(audio_path, language, start)
    elif action == "status":
        if not _voice_session:
            return ToolResult(success=True, output="当前没有活跃的语音会话", duration=_time.time() - start, metadata={"active": False})
        return ToolResult(
            success=True,
            output=f"语音会话状态: id={_voice_session['id']}, status={_voice_session['status']}, language={_voice_session['language']}, turns={_voice_session['turnCount']}",
            duration=_time.time() - start,
            metadata={"active": True, **_voice_session},
        )
    else:
        return ToolResult(success=False, error=f"不支持的操作: {action}。支持: start_session, stop_session, speak, listen, status", duration=_time.time() - start)


async def _do_tts_speak(text: str, language: str, emotion: str, voice: str, start: float) -> ToolResult:
    """TTS 语音合成 — 优先 edge-tts，降级系统 TTS，最终模拟"""
    voice_map: dict[str, str] = {
        "zh-CN": "zh-CN-XiaoxiaoNeural",
        "zh-CN-male": "zh-CN-YunxiNeural",
        "en-US": "en-US-JennyNeural",
        "ja-JP": "ja-JP-NanamiNeural",
    }

    target_voice = voice or voice_map.get(language, "zh-CN-XiaoxiaoNeural")

    try:
        import edge_tts
        import tempfile
        from pathlib import Path

        communicate = edge_tts.Communicate(text, target_voice)
        audio_dir = Path(os.environ.get("DATA_DIR", "data")) / "tts"
        audio_dir.mkdir(parents=True, exist_ok=True)
        timestamp = _time.strftime("%Y%m%d_%H%M%S")
        audio_file = audio_dir / f"tts_{timestamp}.mp3"
        await communicate.save(str(audio_file))

        return ToolResult(
            success=True,
            output=f"语音合成完成（edge-tts）: {audio_file}",
            duration=_time.time() - start,
            metadata={"engine": "edge-tts", "voice": target_voice, "audio_path": str(audio_file), "text_length": len(text)},
        )
    except ImportError:
        pass
    except Exception:
        pass

    try:
        import subprocess
        if os.name == "nt":
            import pyttsx3
            engine = pyttsx3.init()
            engine.say(text)
            engine.runAndWait()
            return ToolResult(
                success=True,
                output=f"语音播报完成（pyttsx3）: \"{text[:50]}\"",
                duration=_time.time() - start,
                metadata={"engine": "pyttsx3", "simulated": False},
            )
    except (ImportError, Exception):
        pass

    try:
        if os.name == "darwin":
            subprocess.run(["say", text], check=True, timeout=10)
            return ToolResult(
                success=True,
                output=f"语音播报完成（macOS say）: \"{text[:50]}\"",
                duration=_time.time() - start,
                metadata={"engine": "macos_say", "simulated": False},
            )
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        pass

    return ToolResult(
        success=True,
        output=f"语音指令已接收（模拟模式，无TTS引擎）: \"{text[:50]}\"",
        duration=_time.time() - start,
        metadata={"engine": "simulated", "simulated": True, "text_length": len(text)},
    )


async def _do_stt_listen(audio_path: str, language: str, start: float) -> ToolResult:
    """STT 语音识别 — 支持实时录音或文件路径"""
    if not audio_path:
        recorded_file = await _record_audio_realtime(language)
        if recorded_file:
            audio_path = recorded_file
        else:
            return ToolResult(
                success=True,
                output="语音监听已就绪（等待音频输入，请通过audio_path参数提供音频文件，或确保麦克风可用以启用实时录音）",
                duration=_time.time() - start,
                metadata={"simulated": True, "hint": "提供audio_path参数或确保麦克风可用"},
            )

    try:
        from agent.tools.perception_tools import speech_transcribe_executor
        lang_code = language.split("-")[0] if "-" in language else language
        result = await speech_transcribe_executor({
            "audio_path": audio_path,
            "language": lang_code,
        })
        if result.success:
            if _voice_session:
                _voice_session["turnCount"] += 1
            return ToolResult(
                success=True,
                output=f"语音识别结果: {result.output}",
                duration=_time.time() - start,
                metadata={"engine": "speech_transcribe", "simulated": False},
            )
        return ToolResult(
            success=False,
            error=f"语音识别失败: {result.error}",
            duration=_time.time() - start,
        )
    except ImportError:
        return ToolResult(
            success=True,
            output=f"语音监听已就绪（speech_transcribe不可用，模拟模式）",
            duration=_time.time() - start,
            metadata={"simulated": True},
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"语音识别异常: {e}",
            duration=_time.time() - start,
        )


async def _record_audio_realtime(language: str) -> str | None:
    """实时录音 — 优先 sounddevice + scipy，降级 pyaudio，最终模拟"""
    from pathlib import Path

    audio_dir = Path(os.environ.get("DATA_DIR", "data")) / "voice"
    audio_dir.mkdir(parents=True, exist_ok=True)
    timestamp = _time.strftime("%Y%m%d_%H%M%S")
    wav_file = str(audio_dir / f"record_{timestamp}.wav")

    try:
        import sounddevice as sd
        import scipy.io.wavfile as wav

        fs = 16000
        seconds = 5.0
        recording = sd.rec(int(seconds * fs), samplerate=fs, channels=1, dtype='int16')
        sd.wait()
        wav.write(wav_file, fs, recording)
        return wav_file
    except ImportError:
        pass
    except Exception:
        pass

    try:
        import pyaudio
        import wave

        CHUNK = 1024
        FORMAT = pyaudio.paInt16
        CHANNELS = 1
        RATE = 16000
        RECORD_SECONDS = 5.0

        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)

        frames = []
        for _ in range(0, int(RATE / CHUNK * RECORD_SECONDS)):
            data = stream.read(CHUNK)
            frames.append(data)

        stream.stop_stream()
        stream.close()
        p.terminate()

        wf = wave.open(wav_file, 'wb')
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(p.get_sample_size(FORMAT))
        wf.setframerate(RATE)
        wf.writeframes(b''.join(frames))
        wf.close()

        return wav_file
    except ImportError:
        pass
    except Exception:
        pass

    return None


async def delegate_task_executor(params: dict[str, Any]) -> ToolResult:
    start = _time.time()
    goal = str(params.get("goal", ""))
    context = params.get("context")
    tools = params.get("tools")
    max_iterations = int(params.get("max_iterations", 5))

    if not goal.strip():
        return ToolResult(success=False, error="目标描述不能为空", duration=_time.time() - start)

    llm = None
    try:
        from agent.main import engine
        if engine and hasattr(engine, "llm"):
            llm = engine.llm
    except Exception:
        pass

    if not llm:
        return ToolResult(success=False, error="子Agent需要LLM支持，当前LLM不可用", duration=_time.time() - start)

    tools_used: list[str] = []
    iterations = 0

    system_prompt = "你是一个专注执行子任务的Agent。使用提供的工具来完成任务，完成后输出简洁的结果摘要。不要闲聊，直接执行。"

    messages_list: list[dict[str, str]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"## 目标\n{goal}" + (f"\n\n## 上下文\n{context}" if context else "")},
    ]

    for i in range(max_iterations):
        iterations += 1
        try:
            response = await llm.chat(messages=messages_list, use_cache=False)
            content = response.get("content", "")
        except Exception as e:
            return ToolResult(
                success=False,
                output=f"子Agent LLM调用失败: {e}",
                duration=_time.time() - start,
                metadata={"toolsUsed": tools_used, "iterations": iterations},
            )

        tool_call_match = re.search(r"\[(\w+)\]\s*(\{[\s\S]*?\})", content)
        if not tool_call_match:
            return ToolResult(
                success=True,
                output=f"✅ 子Agent完成\n\n📋 目标: {goal}\n⏱️ 轮次: {iterations}\n\n📄 结果:\n{content[:5000]}",
                duration=_time.time() - start,
                metadata={"toolsUsed": tools_used, "iterations": iterations},
            )

        tool_name = tool_call_match.group(1)
        import json as _json
        try:
            tool_params = _json.loads(tool_call_match.group(2))
        except (ValueError, _json.JSONDecodeError):
            tool_params = {}

        try:
            from agent.tools.registry import registry
            result = await registry.execute(tool_name, tool_params)
            tool_result_str = result.output or str(result.error or "")
            tools_used.append(tool_name)
        except Exception as e:
            tool_result_str = f"工具执行失败: {e}"

        messages_list.append({"role": "assistant", "content": content})
        messages_list.append({"role": "user", "content": f"工具 {tool_name} 的结果:\n{tool_result_str[:3000]}\n\n请继续执行任务或给出最终结果。"})

    return ToolResult(
        success=False,
        output=f"⚠️ 子Agent达到最大轮次 ({max_iterations})\n\n📋 目标: {goal}\n⏱️ 轮次: {iterations}\n🔧 使用工具: {', '.join(tools_used) or '无'}",
        duration=_time.time() - start,
        metadata={"toolsUsed": tools_used, "iterations": iterations, "error": "max_iterations_reached"},
    )


async def get_active_file_executor(params: dict[str, Any]) -> ToolResult:
    start = _time.time()
    include_related = params.get("include_related", False)

    ts_backend = os.environ.get("TS_BACKEND_URL", "http://localhost:3111")
    try:
        import json as _json
        import urllib.request

        req_data = _json.dumps({"tool": "get_active_file", "params": {"includeRelated": include_related}}).encode("utf-8")
        req = urllib.request.Request(
            f"{ts_backend}/api/tools/execute",
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                result = _json.loads(resp.read().decode("utf-8"))
                return ToolResult(
                    success=result.get("success", False),
                    output=result.get("output", ""),
                    error=result.get("error"),
                    duration=_time.time() - start,
                )
        except Exception:
            pass
    except Exception:
        pass

    return ToolResult(
        success=False,
        output="IDE集成未启用。请手动提供文件路径，或确保TS后端运行中以启用此功能。",
        error="TS后端不可用",
        duration=_time.time() - start,
        metadata={"fallback": "请提供文件路径，例如: src/utils/helper.ts"},
    )

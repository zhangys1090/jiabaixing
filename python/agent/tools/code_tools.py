from __future__ import annotations

import ast
import difflib
import re
import subprocess
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

_log = StructuredLogger("tools.code")

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)


CODE_GENERATE_DEF = ToolDefinition(
    name="code_generate",
    description="根据需求描述生成代码。适用场景：用户需要新建函数、类、模块、脚本等代码。不适用：修改已有代码（用 file_edit）、分析代码（用 code_analyze）。",
    short_desc="生成代码",
    category=ToolCategory.CODE,
    tags=["code", "generate", "create", "write"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="requirements", type="string", description="代码需求描述"),
        ToolParameterDef(name="language", type="string", description="目标编程语言"),
        ToolParameterDef(name="framework", type="string", required=False, description="目标框架"),
        ToolParameterDef(name="complexity", type="string", required=False, description="复杂度: simple/medium/complex", enum=["simple", "medium", "complex"]),
    ],
    risk_level="medium",
)

CODE_ANALYZE_DEF = ToolDefinition(
    name="code_analyze",
    description="分析代码的结构、质量、潜在问题。适用场景：代码审查、查找bug、性能分析。不适用：生成代码（用 code_generate）、修改代码（用 file_edit）。",
    short_desc="分析代码质量",
    category=ToolCategory.CODE,
    tags=["code", "analyze", "review", "quality", "debug"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要分析的文件路径"),
        ToolParameterDef(name="analysis_type", type="string", required=False, description="分析类型: structure/quality/security/performance", enum=["structure", "quality", "security", "performance"]),
    ],
    risk_level="low",
)

CODE_FIX_DEF = ToolDefinition(
    name="code_fix",
    description="自动修复代码中的问题。适用场景：修复语法错误、修复lint警告、修复已知bug。不适用：重构代码（用 code_generate + file_edit）。",
    short_desc="修复代码问题",
    category=ToolCategory.CODE,
    tags=["code", "fix", "debug", "repair"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要修复的文件路径"),
        ToolParameterDef(name="error_description", type="string", required=False, description="错误描述"),
        ToolParameterDef(name="error_output", type="string", required=False, description="错误输出信息"),
    ],
    risk_level="medium",
)

SHELL_EXEC_DEF = ToolDefinition(
    name="shell_exec",
    description="Shell命令执行工具。在系统终端中执行命令并返回输出。适用场景：运行脚本、管理系统、安装依赖。不适用：需要交互式输入的命令。",
    short_desc="执行Shell命令",
    category=ToolCategory.SYSTEM,
    tags=["shell", "exec", "command", "terminal", "system"],
    scenes=["coding", "development"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="command", type="string", description="要执行的命令"),
        ToolParameterDef(name="timeout", type="number", required=False, description="超时时间（毫秒）"),
        ToolParameterDef(name="cwd", type="string", required=False, description="工作目录"),
    ],
    risk_level="high",
    permissions=["system_admin"],
)

_FORBIDDEN_COMMANDS = [
    "format", "del /s /q C:", "rm -rf /", "rm -rf /*",
    "shutdown", "restart", "reg delete", "reg add HKLM",
    "net user", "net localgroup", "cipher /w", "diskpart",
    "bcdedit", "taskkill /f /im svchost",
    "rm -r /", "rm -r /*", "chmod -r 000", "chmod -R 000",
    "dd if=", "mkfs", "fdisk", "parted",
    ":(){ :|:& };:", "fork bomb",
    "wget", "curl -o /", "curl > /",
    "cat /etc/shadow", "cat /etc/passwd",
    "chmod 777 /", "chown -R root /",
    "sysctl -w", "iptables -F", "route -n flush",
]

_FORBIDDEN_PATTERNS = [
    r"rm\s+-[rRf]", r"chmod\s+-[rR]\s+0", r"dd\s+if=",
    r"mkfs\b", r"fdisk\b", r"parted\b",
    r">\s*/dev/sd", r"shred\s+", r"wipefs\s+",
    r"format\s+[A-Za-z]:", r"del\s+/[sfq]",
    r"shutdown\b", r"reboot\b", r"halt\b",
    r"reg\s+(add|delete)\s+", r"net\s+(user|localgroup)\s+",
    r"cipher\s+/w", r"diskpart\b", r"bcdedit\b",
    r"taskkill\s+/f", r"sysctl\s+-w", r"iptables\s+-F",
    r"chmod\s+777\s+/", r"chown\s+-R\s+root\s+/",
    r":\(\)\s*\{:\|:&\};:", r"fork\s+bomb",
    r"wget\b.*-O\s+/", r"curl\b.*-o\s+/",
    r"cat\s+/etc/(shadow|passwd)", r">\s*/etc/",
    r"systemctl\s+(stop|disable|mask)\s+",
    r"service\s+\w+\s+stop",
    r"pip\s+install\s+--user", r"npm\s+install\s+-g",
    r"python\s+-c\s+.*__import__", r"perl\s+-e",
    r"bash\s+-c\s+.*rm", r"sh\s+-c\s+.*rm",
    r"nohup\b", r"screen\b", r"tmux\b",
    r"crontab\b", r"at\b",
    r"mount\b", r"umount\b",
    r"chroot\b", r"su\b", r"sudo\b",
    r"kill\s+-9\s+1\b", r"killall\b",
]

_ALLOWED_COMMAND_PREFIXES = [
    "ls", "dir", "pwd", "cd", "echo", "cat", "head", "tail",
    "grep", "find", "wc", "sort", "uniq", "diff", "cmp",
    "python", "python3", "node", "ruby", "perl",
    "git", "npm", "pip", "yarn", "pnpm",
    "mkdir", "cp", "mv", "touch", "chmod", "chown",
    "tar", "zip", "unzip", "gzip", "gunzip",
    "curl", "wget",
    "which", "where", "type", "env", "printenv",
    "date", "cal", "whoami", "hostname", "uname",
    "df", "du", "free", "top", "ps",
    "ping", "traceroute", "nslookup", "dig",
    "docker", "kubectl",
    "pytest", "jest", "mocha", "eslint", "ruff",
    "make", "cmake", "cargo", "go",
]


def _get_llm():
    from agent.main import engine
    if engine and hasattr(engine, "llm") and engine.llm:
        return engine.llm
    return None


async def code_generate_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    requirements = str(params.get("requirements", ""))
    language = str(params.get("language", "python"))
    framework = params.get("framework")
    complexity = str(params.get("complexity", "medium"))

    if not requirements:
        return ToolResult(success=False, error="需求描述不能为空")

    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法生成代码", duration=time.time() - start)

    prompt = (
        f"请根据以下需求生成{language}代码。\n"
        f"需求: {requirements}\n"
    )
    if framework:
        prompt += f"框架: {framework}\n"
    prompt += f"复杂度: {complexity}\n"
    prompt += "请只输出代码，不要解释。用```代码块包裹。"

    try:
        response = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
        )
        content = response.get("content", "")
        return ToolResult(
            success=True,
            output=f"代码生成完成:\n\n{content}",
            duration=time.time() - start,
            metadata={"language": language, "complexity": complexity},
        )
    except Exception as e:
        return ToolResult(success=False, error=f"代码生成失败: {e}")


async def code_analyze_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    file_path = str(params.get("file_path", ""))
    analysis_type = str(params.get("analysis_type", "quality"))

    if not file_path:
        return ToolResult(success=False, error="文件路径不能为空")

    from pathlib import Path
    p = Path(file_path).expanduser().resolve()
    if not p.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        code = p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    llm = _get_llm()
    if not llm:
        lines = code.splitlines()
        output = (
            f"文件: {p.name}\n"
            f"行数: {len(lines)}\n"
            f"大小: {len(code)} 字符\n"
            f"分析类型: {analysis_type}\n"
            f"(LLM不可用，仅提供基础统计)"
        )
        return ToolResult(success=True, output=output, duration=time.time() - start)

    prompt = (
        f"请分析以下代码的{analysis_type}方面：\n\n"
        f"```{p.suffix.lstrip('.')}\n{code[:3000]}\n```\n\n"
        f"分析类型: {analysis_type}\n"
        f"请给出：1. 总体评价 2. 发现的问题 3. 改进建议"
    )

    try:
        response = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
        )
        content = response.get("content", "")
        return ToolResult(success=True, output=content, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"代码分析失败: {e}")


async def code_fix_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    file_path = str(params.get("file_path", ""))
    error_description = str(params.get("error_description", ""))
    error_output = str(params.get("error_output", ""))

    if not file_path:
        return ToolResult(success=False, error="文件路径不能为空")

    from pathlib import Path
    p = Path(file_path).expanduser().resolve()
    if not p.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        code = p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法自动修复代码", duration=time.time() - start)

    prompt = (
        f"请修复以下代码中的问题：\n\n"
        f"```{p.suffix.lstrip('.')}\n{code[:3000]}\n```\n\n"
    )
    if error_description:
        prompt += f"错误描述: {error_description}\n"
    if error_output:
        prompt += f"错误输出: {error_output[:500]}\n"
    prompt += "请输出修复后的完整代码，用```代码块包裹。"

    try:
        response = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
        )
        content = response.get("content", "")
        return ToolResult(
            success=True,
            output=f"代码修复建议:\n\n{content}",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"代码修复失败: {e}")


async def shell_exec_executor(params: dict[str, Any]) -> ToolResult:
    import re
    import time
    start = time.time()
    command = str(params.get("command", ""))
    timeout_ms = int(params.get("timeout", 30000))
    cwd = params.get("cwd")

    if not command:
        return ToolResult(success=False, error="命令不能为空")

    cmd_lower = command.lower().strip()
    for forbidden in _FORBIDDEN_COMMANDS:
        if forbidden.lower() in cmd_lower:
            return ToolResult(success=False, error=f"禁止执行的命令: {forbidden}")

    for pattern in _FORBIDDEN_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return ToolResult(
                success=False,
                error=f"命令匹配禁止模式: {pattern}",
                metadata={"security_violation": True},
            )

    # T-02: 命令白名单检查——提取首个命令词，必须匹配允许列表
    first_token = command.strip().split()[0] if command.strip() else ""
    first_token_name = Path(first_token).name if first_token else ""
    if first_token_name and _ALLOWED_COMMAND_PREFIXES:
        if first_token_name not in _ALLOWED_COMMAND_PREFIXES:
            return ToolResult(
                success=False,
                error=f"命令 '{first_token_name}' 不在允许列表中，被安全策略拒绝",
                metadata={"security_violation": True, "allowed_commands": _ALLOWED_COMMAND_PREFIXES[:20]},
            )

    # T-02: 通过 SandboxExecutor 做安全预检
    #
    # 审计修复（W3 顺带发现的 D6 同类缺陷）：此处原先存在两个叠加缺陷——
    #   1) 从 `agent.sandbox.types` 导入 SecurityLevel，而该模块根本不存在
    #      （SecurityLevel 实际定义在 agent/sandbox/executor.py:14），
    #      因此每次调用都必然抛 ModuleNotFoundError；
    #   2) 异常被 `except Exception: pass` 静默吞掉，直接落到下方 subprocess.run。
    # 二者叠加的净效果是：沙箱预检这层防护从未真正执行过一次，且完全不可观测。
    # 现修正导入，并改为 fail-closed —— 安全守卫无法给出裁决时必须拦截，而非放行。
    try:
        from agent.sandbox.executor import SandboxExecutor, SandboxConfig, SecurityLevel

        sandbox = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.HIGH))
        pre_check = sandbox._pre_check_code(command, "shell")
    except Exception as exc:
        _log.error(
            "沙箱安全预检不可用，按 fail-closed 拦截命令",
            command=command[:200],
            error=f"{type(exc).__name__}: {exc}",
        )
        return ToolResult(
            success=False,
            error=f"沙箱安全预检不可用，已按安全策略拒绝执行: {type(exc).__name__}: {exc}",
            metadata={"security_violation": True, "guard_unavailable": True},
        )

    if not pre_check.allowed:
        return ToolResult(
            success=False,
            error=f"沙箱安全检查拒绝: {pre_check.reason}",
            metadata={"security_violation": True},
        )

    timeout_sec = timeout_ms / 1000 if timeout_ms > 0 else 60
    timeout_sec = min(timeout_sec, 60)

    # T-02: 使用 shell=False + shlex.split 避免shell注入
    import shlex
    try:
        cmd_parts = shlex.split(command, posix=True)
    except ValueError:
        cmd_parts = [command]

    try:
        result = subprocess.run(
            cmd_parts,
            shell=False,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            cwd=cwd,
        )

        output_parts: list[str] = []
        if result.stdout:
            output_parts.append(result.stdout[:10000])
        if result.stderr:
            output_parts.append(f"[stderr]\n{result.stderr[:5000]}")

        output = "\n".join(output_parts) if output_parts else "(无输出)"

        if result.returncode != 0:
            output = f"退出码: {result.returncode}\n{output}"

        return ToolResult(
            success=result.returncode == 0,
            output=output,
            duration=time.time() - start,
            metadata={"exit_code": result.returncode},
        )
    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error=f"命令超时（{timeout_sec}秒）", duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"执行失败: {e}", duration=time.time() - start)


CODE_REVIEW_DEF = ToolDefinition(
    name="code_review",
    description='审查代码文件，从语法、逻辑、安全、性能四个维度分析问题。适用场景：代码审查、找bug、安全检查、代码质量分析。不适用：修改代码（用code_fix）或生成新代码（用code_generate）。返回结构化审查报告。',
    short_desc="审查代码质量",
    category=ToolCategory.CODE,
    tags=["code", "review", "security", "quality", "audit"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要审查的文件路径"),
        ToolParameterDef(name="focus", type="string", required=False, description="审查重点", enum=["all", "security", "performance", "quality"]),
        ToolParameterDef(name="git_repo", type="string", required=False,
                         description="审计 P1-2：传入 git 仓库路径后，自动对 `git diff` 涉及的所有改动文件逐一审查（file_path 可留空）"),
    ],
    risk_level="low",
)

CSV_ANALYZE_DEF = ToolDefinition(
    name="csv_analyze",
    description='分析CSV文件，生成统计摘要和关键洞察。适用场景：分析数据、查看CSV内容、生成数据报告。不适用：读取普通文本文件（用file_read）。返回行数、列数、每列统计、数据质量提示。',
    short_desc="分析CSV数据",
    category=ToolCategory.CODE,
    tags=["csv", "data", "analyze", "statistics"],
    scenes=["coding", "research", "daily"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="CSV文件路径"),
        ToolParameterDef(name="max_rows", type="number", required=False, description="最大读取行数"),
        ToolParameterDef(name="delimiter", type="string", required=False, description="分隔符，默认自动检测"),
    ],
    risk_level="low",
)


def _run_rule_checks(content: str, lines: list[str], ext: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    if ext in (".ts", ".js", ".tsx", ".jsx"):
        for i, line in enumerate(lines):
            if "console.log" in line and not line.strip().startswith("//"):
                findings.append({
                    "severity": "low",
                    "category": "quality",
                    "line": i + 1,
                    "message": "生产代码中包含 console.log",
                    "suggestion": "使用 Logger 替代或移除",
                })
        for i, line in enumerate(lines):
            if ": any" in line and not line.strip().startswith("//"):
                findings.append({
                    "severity": "low",
                    "category": "quality",
                    "line": i + 1,
                    "message": "使用了 any 类型",
                    "suggestion": "考虑使用更具体的类型定义",
                })
        for i, line in enumerate(lines):
            if re.search(r"catch\s*\(\s*\w*\s*\)\s*\{\s*\}", line):
                findings.append({
                    "severity": "medium",
                    "category": "quality",
                    "line": i + 1,
                    "message": "空的 catch 块，错误被静默吞没",
                    "suggestion": "至少记录错误日志",
                })

    if ext == ".py":
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("except:") and len(stripped) <= len("except:"):
                findings.append({
                    "severity": "medium",
                    "category": "quality",
                    "line": i + 1,
                    "message": "裸 except: 可能捕获过多异常",
                    "suggestion": "使用 except Exception: 或更具体的异常类型",
                })
            if "print(" in stripped and not stripped.startswith("#"):
                findings.append({
                    "severity": "low",
                    "category": "quality",
                    "line": i + 1,
                    "message": "生产代码中包含 print()",
                    "suggestion": "使用 logging 替代",
                })

    if len(lines) > 500:
        findings.append({
            "severity": "low",
            "category": "quality",
            "message": f"文件过长 ({len(lines)} 行)",
            "suggestion": "考虑拆分为更小的模块",
        })

    return findings[:20]


def _run_security_checks(content: str, lines: list[str]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    secret_patterns = [
        (r"(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['\"][^'\"]{8,}['\"]", "硬编码密钥"),
        (r"(?:sk-|api_)[a-zA-Z0-9]{20,}", "API密钥"),
    ]
    for pattern, name in secret_patterns:
        for i, line in enumerate(lines):
            if re.search(pattern, line, re.IGNORECASE) and not line.strip().startswith("//"):
                findings.append({
                    "severity": "critical",
                    "category": "security",
                    "line": i + 1,
                    "message": f"检测到{name}",
                    "suggestion": "使用环境变量替代硬编码密钥",
                })

    for i, line in enumerate(lines):
        if re.search(r"query\(.*\$\{", line, re.IGNORECASE) and not line.strip().startswith("//"):
            findings.append({
                "severity": "high",
                "category": "security",
                "line": i + 1,
                "message": "可能存在 SQL 注入风险（模板字符串拼接）",
                "suggestion": "使用参数化查询",
            })

    for i, line in enumerate(lines):
        if re.search(r"\beval\s*\(", line) and not line.strip().startswith("//"):
            findings.append({
                "severity": "high",
                "category": "security",
                "line": i + 1,
                "message": "使用了 eval()，存在代码注入风险",
                "suggestion": "避免使用 eval，考虑替代方案",
            })

    for i, line in enumerate(lines):
        if "exec(" in line and not line.strip().startswith("#") and not line.strip().startswith("//"):
            findings.append({
                "severity": "high",
                "category": "security",
                "line": i + 1,
                "message": "使用了 exec()，存在代码注入风险",
                "suggestion": "避免使用 exec，考虑更安全的替代方案",
            })

    return findings[:20]


async def _run_llm_review(content: str, file_path: str, focus: str) -> list[dict[str, Any]]:
    llm = _get_llm()
    if not llm:
        return []

    prompt = (
        f"审查以下代码文件，找出问题。\n\n"
        f"文件: {file_path}\n"
        f"审查重点: {focus}\n\n"
        f"代码:\n```\n{content[:6000]}\n```\n\n"
        f'请用 JSON 数组格式输出发现的问题:\n'
        f'[{{"severity": "critical|high|medium|low|info", "category": "security|performance|quality|style", "line": 行号, "message": "问题描述", "suggestion": "修复建议"}}]\n\n'
        f"只输出 JSON，不要其他内容。最多输出 5 个最重要的问题。"
    )

    try:
        response = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
            system_prompt="你是一个资深代码审查专家。只输出 JSON 数组。",
        )
        text = response.get("content", "")
        json_match = re.search(r"\[[\s\S]*\]", text)
        if json_match:
            import json
            return json.loads(json_match.group(0))
    except Exception as _exc:
        log_ignored(_log, "code_tools._run_llm_review", _exc)
    return []


def _format_review_report(
    file_path: str,
    total_lines: int,
    findings: list[dict[str, Any]],
    focus: str,
) -> str:
    lines_out: list[str] = []
    lines_out.append(f"📋 代码审查报告: {file_path}")
    lines_out.append(f"总行数: {total_lines} | 审查重点: {focus}")
    lines_out.append(f"发现问题: {len(findings)} 个")
    lines_out.append("")

    if not findings:
        lines_out.append("✅ 未发现问题，代码质量良好。")
        return "\n".join(lines_out)

    severity_counts: dict[str, int] = {}
    for f in findings:
        sev = f.get("severity", "info")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    icons = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢", "info": "ℹ️"}
    labels = {"critical": "严重", "high": "高危", "medium": "中等", "low": "低危", "info": "信息"}
    for sev in ("critical", "high", "medium", "low"):
        if sev in severity_counts:
            lines_out.append(f"{icons[sev]} {labels[sev]}: {severity_counts[sev]}")
    lines_out.append("")

    for finding in findings:
        severity = finding.get("severity", "info")
        icon = icons.get(severity, "ℹ️")
        category = finding.get("category", "")
        line_ref = f" (行 {finding['line']})" if finding.get("line") else ""
        lines_out.append(f"{icon} [{category}]{line_ref} {finding.get('message', '')}")
        lines_out.append(f"   建议: {finding.get('suggestion', '')}")
        lines_out.append("")

    return "\n".join(lines_out)


async def code_review_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    focus = str(params.get("focus", "all"))
    git_repo = str(params.get("git_repo", "") or "")

    # 审计 P1-2：传入 git_repo 时，审查 git diff 涉及的所有改动文件
    if git_repo:
        changed = _code_review_changed_files(git_repo)
        if not changed:
            return ToolResult(
                success=True,
                output=f"git_repo={git_repo} 的 diff 无改动文件，无需审查。",
                duration=time.time() - start,
                metadata={"changed_files": []},
            )
        raw_path = str(params.get("file_path", "") or "")
        repo_root = Path(git_repo).expanduser().resolve()
        targets = [repo_root / f for f in changed][:20]
        if raw_path:
            targets = [Path(raw_path).expanduser().resolve()]

        all_outputs: list[str] = []
        total_findings = total_critical = total_high = 0
        reviewed = 0
        for tf in targets:
            if not tf.exists() or tf.is_dir():
                continue
            try:
                content = tf.read_text(encoding="utf-8", errors="replace")
            except Exception as e:
                log_ignored(_log, "code_tools._review_targets.read", e)
                continue
            out, findings, crit, high = await _review_single_file(tf, content, focus)
            total_findings += len(findings)
            total_critical += crit
            total_high += high
            all_outputs.append(out)
            reviewed += 1

        combined = "\n\n".join(all_outputs)
        return ToolResult(
            success=True,
            output=f"已审查 {reviewed} 个改动文件（git_repo={git_repo}）:\n\n{combined}",
            duration=time.time() - start,
            metadata={
                "changed_files": [str(t) for t in targets],
                "reviewed": reviewed,
                "total_findings": total_findings,
                "critical_count": total_critical,
                "high_count": total_high,
            },
        )

    raw_path = str(params.get("file_path", ""))
    if not raw_path:
        return ToolResult(success=False, error="文件路径不能为空（或提供 git_repo 审查改动）")

    file_path = Path(raw_path).expanduser().resolve()
    if not file_path.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    out, findings, critical_count, high_count = await _review_single_file(file_path, content, focus)
    return ToolResult(
        success=True,
        output=out,
        duration=time.time() - start,
        metadata={
            "file_path": str(file_path),
            "total_lines": len(content.splitlines()),
            "findings_count": len(findings),
            "critical_count": critical_count,
            "high_count": high_count,
        },
    )


async def _review_single_file(
    file_path: Path, content: str, focus: str
) -> tuple[str, list[dict[str, Any]], int, int]:
    """对单个文件执行规则 + 安全 + LLM 三层审查（供单文件与 git diff 批量复用）。"""
    lines = content.splitlines()
    ext = file_path.suffix.lower()

    rule_findings = _run_rule_checks(content, lines, ext)
    security_findings = _run_security_checks(content, lines)

    llm_findings: list[dict[str, Any]] = []
    if len(content) < 10000:
        try:
            llm_findings = await _run_llm_review(content, str(file_path), focus)
        except Exception as exc:
            _log.warning("LLM 审查失败，跳过", file=str(file_path), error=str(exc))
            llm_findings = []

    all_findings = rule_findings + security_findings + llm_findings

    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    all_findings.sort(key=lambda f: severity_order.get(f.get("severity", "info"), 4))

    output = _format_review_report(str(file_path), len(lines), all_findings, focus)

    critical_count = sum(1 for f in all_findings if f.get("severity") == "critical")
    high_count = sum(1 for f in all_findings if f.get("severity") == "high")

    return output, all_findings, critical_count, high_count


def _code_review_changed_files(repo: str) -> list[str]:
    """返回 git diff（工作区 + 已暂存）涉及的文件相对路径列表。"""
    import subprocess

    base = Path(repo).expanduser().resolve()
    out: list[str] = []
    for args in (["diff", "--name-only"], ["diff", "--staged", "--name-only"]):
        try:
            proc = subprocess.run(
                ["git", *args], cwd=str(base),
                capture_output=True, text=True, check=False, timeout=30,
            )
        except Exception as e:
            log_ignored(_log, "code_tools._git_collect_changes", e)
            continue
        if proc.returncode == 0:
            for ln in proc.stdout.splitlines():
                ln = ln.strip()
                if ln and ln not in out:
                    out.append(ln)
    return out


def _parse_csv_line(line: str, delimiter: str) -> list[str]:
    result: list[str] = []
    current = ""
    in_quotes = False
    for char in line:
        if char == '"':
            in_quotes = not in_quotes
        elif char == delimiter and not in_quotes:
            result.append(current.strip())
            current = ""
        else:
            current += char
    result.append(current.strip())
    return result


def _detect_delimiter(content: str) -> str:
    first_line = content.split("\n", 1)[0]
    for delim in ["\t", ",", ";", "|"]:
        if delim in first_line:
            return delim
    return ","


async def csv_analyze_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    raw_path = str(params.get("file_path", ""))
    max_rows = int(params.get("max_rows", 10000))
    delimiter = str(params.get("delimiter", ""))

    if not raw_path:
        return ToolResult(success=False, error="文件路径不能为空")

    file_path = Path(raw_path).expanduser().resolve()
    if not file_path.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    raw_lines = [l for l in content.split("\n") if l.strip()]
    if len(raw_lines) < 2:
        return ToolResult(success=False, error="CSV文件至少需要表头+1行数据")

    if not delimiter:
        delimiter = _detect_delimiter(content)

    headers = _parse_csv_line(raw_lines[0], delimiter)
    rows: list[list[str]] = []
    for i in range(1, min(len(raw_lines), max_rows + 1)):
        rows.append(_parse_csv_line(raw_lines[i], delimiter))

    column_stats: list[dict[str, Any]] = []
    for col_idx in range(len(headers)):
        values = [r[col_idx] if col_idx < len(r) else "" for r in rows]
        non_empty = [v for v in values if v]
        null_count = len(values) - len(non_empty)
        unique_values = set(non_empty)

        numeric_values: list[float] = []
        for v in non_empty:
            try:
                numeric_values.append(float(v))
            except ValueError as _exc:
                log_ignored(_log, "code_tools.csv_analyze_executor", _exc)
        is_numeric = len(numeric_values) > len(non_empty) * 0.8

        stats: dict[str, Any] = {
            "name": headers[col_idx],
            "type": "number" if is_numeric else "string",
            "non_null_count": len(non_empty),
            "null_count": null_count,
            "unique_count": len(unique_values),
        }

        if is_numeric and numeric_values:
            stats["min"] = min(numeric_values)
            stats["max"] = max(numeric_values)
            stats["mean"] = sum(numeric_values) / len(numeric_values)

        value_counts: dict[str, int] = {}
        for v in non_empty:
            value_counts[v] = value_counts.get(v, 0) + 1
        top_values = sorted(value_counts.items(), key=lambda x: x[1], reverse=True)[:5]
        stats["top_values"] = [{"value": v[:50], "count": c} for v, c in top_values]

        column_stats.append(stats)

    lines_out: list[str] = []
    lines_out.append(f"📊 CSV 分析报告: {file_path}")
    truncated = len(raw_lines) - 1 > max_rows
    lines_out.append(f"总行数: {len(rows)}{' (截取前' + str(max_rows) + '行)' if truncated else ''}")
    lines_out.append(f"列数: {len(headers)}")
    lines_out.append("")

    for col in column_stats:
        type_icon = "🔢" if col["type"] == "number" else "📝"
        lines_out.append(f"{type_icon} {col['name']} ({col['type']})")
        lines_out.append(f"  非空: {col['non_null_count']}, 空值: {col['null_count']}, 唯一值: {col['unique_count']}")
        if col["type"] == "number" and "min" in col:
            lines_out.append(f"  范围: {col['min']:.2f} ~ {col['max']:.2f}, 均值: {col['mean']:.2f}")
        if col.get("top_values"):
            top_str = ", ".join(f"{tv['value']}({tv['count']})" for tv in col["top_values"])
            lines_out.append(f"  高频值: {top_str}")
        lines_out.append("")

    issues: list[str] = []
    for col in column_stats:
        if col["null_count"] > len(rows) * 0.3:
            pct = col["null_count"] / len(rows) * 100
            issues.append(f"⚠️ {col['name']} 缺失率 {pct:.0f}%")
        if col["type"] == "number" and col.get("min") is not None and col.get("max") is not None:
            if col["max"] - col["min"] == 0:
                issues.append(f"⚠️ {col['name']} 所有值相同（常量列）")

    if issues:
        lines_out.append("数据质量提示:")
        for issue in issues:
            lines_out.append(f"  {issue}")

    return ToolResult(
        success=True,
        output="\n".join(lines_out),
        duration=time.time() - start,
        metadata={
            "rows": len(rows),
            "columns": len(headers),
            "headers": headers,
            "column_stats": [
                {"name": c["name"], "type": c["type"], "null_count": c["null_count"], "unique_count": c["unique_count"]}
                for c in column_stats
            ],
        },
    )


# ==================== AST 感知代码生成与编辑工具 ====================


def _parse_ast_safely(code: str) -> ast.Module | None:
    """安全解析Python代码为AST，失败返回None。

    Args:
        code: Python源代码字符串。

    Returns:
        ast.Module | None: 解析成功返回AST模块节点，失败返回None。
    """
    try:
        return ast.parse(code)
    except SyntaxError:
        return None


def _extract_ast_summary(tree: ast.Module) -> dict[str, Any]:
    """从AST中提取结构摘要（导入、类、函数、顶层赋值）。

    Args:
        tree: 已解析的AST模块节点。

    Returns:
        dict: 包含 imports/classes/functions/assignments 的结构摘要。
    """
    imports: list[str] = []
    classes: list[dict[str, Any]] = []
    functions: list[dict[str, Any]] = []
    assignments: list[str] = []

    for node in ast.iter_child_nodes(tree):
        # 导入
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            names = ", ".join(a.name for a in node.names if a.name)
            imports.append(f"from {module} import {names}")
        # 类定义
        elif isinstance(node, ast.ClassDef):
            methods = [
                {
                    "name": n.name,
                    "line": n.lineno,
                    "end_line": getattr(n, "end_lineno", n.lineno),
                    "args": [a.arg for a in n.args.args if a.arg != "self"],
                }
                for n in node.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            classes.append({
                "name": node.name,
                "line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "bases": [ast.dump(b) for b in node.bases],
                "methods": methods,
            })
        # 函数定义
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append({
                "name": node.name,
                "line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "args": [a.arg for a in node.args.args],
                "decorators": [ast.dump(d) for d in node.decorator_list],
            })
        # 顶层赋值
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments.append(target.id)

    return {
        "imports": imports,
        "classes": classes,
        "functions": functions,
        "assignments": assignments,
    }


def _read_file_lines(path: Path) -> list[str] | None:
    """读取文件所有行，失败返回None。

    Args:
        path: 文件路径。

    Returns:
        list[str] | None: 行列表或None。
    """
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
    except Exception:
        return None


def _make_unified_diff(
    old_lines: list[str], new_lines: list[str], filepath: str = "a"
) -> str:
    """生成unified diff字符串。

    Args:
        old_lines: 原始行列表。
        new_lines: 新行列表。
        filepath: diff中显示的文件路径标识。

    Returns:
        str: unified diff文本。
    """
    diff = difflib.unified_diff(
        old_lines, new_lines, fromfile=f"a/{filepath}", tofile=f"b/{filepath}"
    )
    return "".join(diff)


CODE_GENERATE_AST_DEF = ToolDefinition(
    name="code_generate_ast",
    description="AST感知的代码生成工具。读取目标文件AST结构，参考现有类/函数/导入，在指定位置插入新代码。适用场景：向已有文件添加函数/类/方法，确保风格一致和导入正确。不适用：从零创建文件（用code_generate）、修改已有函数（用code_edit_ast）。",
    short_desc="AST感知代码生成",
    category=ToolCategory.CODE,
    tags=["code", "generate", "ast", "insert"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="requirements", type="string", description="代码需求描述"),
        ToolParameterDef(name="target_file", type="string", description="目标文件路径"),
        ToolParameterDef(name="language", type="string", required=False, description="目标编程语言，默认python"),
        ToolParameterDef(name="context_files", type="string", required=False, description="相关文件列表，逗号分隔，用于获取类型定义和接口"),
        ToolParameterDef(name="insert_position", type="string", required=False, description="插入位置: end|after_class:X|before_function:Y", enum=["end", "after_class", "before_function"]),
    ],
    risk_level="medium",
)


async def code_generate_ast_executor(params: dict[str, Any]) -> ToolResult:
    """AST感知的代码生成执行器。

    读取目标文件AST结构，结合上下文文件信息，
    生成代码并插入到指定位置。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含生成代码和插入结果的工具执行结果。
    """
    import time
    start = time.time()

    requirements = str(params.get("requirements", ""))
    target_file = str(params.get("target_file", ""))
    language = str(params.get("language", "python"))
    context_files_str = str(params.get("context_files", ""))
    insert_position = str(params.get("insert_position", "end"))

    if not requirements:
        return ToolResult(success=False, error="需求描述不能为空")
    if not target_file:
        return ToolResult(success=False, error="目标文件路径不能为空")

    target_path = Path(target_file).expanduser().resolve()

    # 读取目标文件AST结构
    ast_summary: dict[str, Any] = {}
    existing_code = ""
    if target_path.exists():
        try:
            existing_code = target_path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            return ToolResult(success=False, error=f"读取目标文件失败: {e}")

        if language == "python":
            tree = _parse_ast_safely(existing_code)
            if tree:
                ast_summary = _extract_ast_summary(tree)
            else:
                return ToolResult(success=False, error="目标文件Python语法有误，无法解析AST")

    # 读取上下文文件AST
    context_summaries: list[dict[str, Any]] = []
    if context_files_str:
        for cf in context_files_str.split(","):
            cf = cf.strip()
            if not cf:
                continue
            cf_path = Path(cf).expanduser().resolve()
            if cf_path.exists():
                try:
                    cf_code = cf_path.read_text(encoding="utf-8", errors="replace")
                    cf_tree = _parse_ast_safely(cf_code)
                    if cf_tree:
                        context_summaries.append({
                            "file": str(cf_path),
                            **_extract_ast_summary(cf_tree),
                        })
                except Exception as _exc:
                    log_ignored(_log, "code_tools.code_generate_ast_executor", _exc)

    # 构建LLM提示词
    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法生成代码", duration=time.time() - start)

    prompt_parts = [
        f"请根据需求生成{language}代码，需插入到已有文件中。",
        f"需求: {requirements}",
    ]

    if ast_summary:
        prompt_parts.append(f"\n目标文件现有结构:\n{ast_summary}")
        prompt_parts.append("请确保: 1.不重复已有导入 2.风格与现有代码一致 3.仅输出要插入的代码")

    if context_summaries:
        prompt_parts.append(f"\n上下文文件结构:\n{context_summaries}")

    prompt_parts.append("\n请只输出要插入的代码，不要解释。用```代码块包裹。")

    try:
        response = await llm.chat(
            messages=[{"role": "user", "content": "\n".join(prompt_parts)}],
            use_cache=False,
        )
        generated = response.get("content", "")
    except Exception as e:
        return ToolResult(success=False, error=f"LLM代码生成失败: {e}")

    # 从markdown代码块中提取代码
    code_match = re.search(r"```[\w]*\n([\s\S]*?)```", generated)
    new_code = code_match.group(1).rstrip("\n") if code_match else generated.strip()

    # 计算插入位置
    lines = existing_code.splitlines(keepends=True) if existing_code else []
    insert_line = len(lines)  # 默认文件末尾

    if insert_position.startswith("after_class:") and ast_summary:
        class_name = insert_position.split(":", 1)[1].strip()
        for cls in ast_summary.get("classes", []):
            if cls["name"] == class_name:
                insert_line = cls["end_line"]
                break

    elif insert_position.startswith("before_function:") and ast_summary:
        func_name = insert_position.split(":", 1)[1].strip()
        for func in ast_summary.get("functions", []):
            if func["name"] == func_name:
                insert_line = func["line"] - 1
                break

    # 执行插入
    new_lines = lines[:insert_line] + [new_code + "\n"] + lines[insert_line:]
    result_code = "".join(new_lines)

    # Python语法验证
    if language == "python":
        test_tree = _parse_ast_safely(result_code)
        if not test_tree:
            return ToolResult(
                success=False,
                error="插入后代码语法有误，已放弃写入。请调整需求后重试。",
                duration=time.time() - start,
                metadata={"generated_code": new_code},
            )

    # 写入文件
    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(result_code, encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"写入文件失败: {e}", duration=time.time() - start)

    # 生成diff
    diff_text = _make_unified_diff(lines, new_lines, target_path.name)

    return ToolResult(
        success=True,
        output=f"代码已插入到 {target_file} 第{insert_line + 1}行\n\n{diff_text}",
        duration=time.time() - start,
        metadata={
            "target_file": str(target_path),
            "insert_line": insert_line + 1,
            "language": language,
            "ast_summary": ast_summary,
        },
    )


CODE_EDIT_AST_DEF = ToolDefinition(
    name="code_edit_ast",
    description="AST感知的精确代码编辑工具。解析目标文件AST，精确定位函数/类/方法/导入等符号，进行替换、添加、修改操作。适用场景：修改函数实现、为类添加方法、修改类定义、添加导入、替换表达式。不适用：生成新代码（用code_generate_ast）、全局重命名（用refactor_rename）。",
    short_desc="AST感知代码编辑",
    category=ToolCategory.CODE,
    tags=["code", "edit", "ast", "refactor"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要编辑的文件路径"),
        ToolParameterDef(name="edit_type", type="string", description="编辑类型", enum=["replace_function", "add_method", "modify_class", "add_import", "replace_expression"]),
        ToolParameterDef(name="target_symbol", type="string", description="目标符号名（函数名/类名/方法名，格式: Class.method 或 function）"),
        ToolParameterDef(name="new_code", type="string", description="新代码内容"),
        ToolParameterDef(name="preview_only", type="boolean", required=False, description="仅预览变更不写入，默认false"),
    ],
    risk_level="medium",
)


def _find_symbol_lines(
    tree: ast.Module, lines: list[str], target_symbol: str, edit_type: str
) -> dict[str, int] | None:
    """在AST中查找目标符号的行范围。

    Args:
        tree: 已解析的AST模块。
        lines: 源代码行列表。
        target_symbol: 目标符号名（支持 Class.method 格式）。
        edit_type: 编辑类型。

    Returns:
        dict | None: 包含 start_line/end_line 的字典，未找到返回None。
    """
    parts = target_symbol.split(".", 1)

    # 类方法查找
    if len(parts) == 2:
        class_name, method_name = parts
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if item.name == method_name:
                            return {
                                "start_line": item.lineno,
                                "end_line": getattr(item, "end_lineno", item.lineno),
                            }
        return None

    # 顶层符号查找
    symbol_name = parts[0]
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == symbol_name:
                return {
                    "start_line": node.lineno,
                    "end_line": getattr(node, "end_lineno", node.lineno),
                }
        elif isinstance(node, ast.ClassDef):
            if node.name == symbol_name:
                if edit_type == "add_method":
                    # 在类末尾添加方法
                    return {
                        "start_line": getattr(node, "end_lineno", node.lineno),
                        "end_line": getattr(node, "end_lineno", node.lineno),
                        "is_class_end": True,
                    }
                return {
                    "start_line": node.lineno,
                    "end_line": getattr(node, "end_lineno", node.lineno),
                }
        elif isinstance(node, ast.ImportFrom) and edit_type == "add_import":
            return {
                "start_line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "is_import": True,
            }
        elif isinstance(node, ast.Import) and edit_type == "add_import":
            return {
                "start_line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "is_import": True,
            }

    return None


async def code_edit_ast_executor(params: dict[str, Any]) -> ToolResult:
    """AST感知的精确代码编辑执行器。

    解析目标文件AST，精确定位目标符号，执行编辑操作，
    支持 preview_only 模式和语法验证。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含编辑结果和diff的工具执行结果。
    """
    import time
    start = time.time()

    file_path = str(params.get("file_path", ""))
    edit_type = str(params.get("edit_type", ""))
    target_symbol = str(params.get("target_symbol", ""))
    new_code = str(params.get("new_code", ""))
    preview_only = bool(params.get("preview_only", False))

    if not file_path:
        return ToolResult(success=False, error="文件路径不能为空")
    if not edit_type:
        return ToolResult(success=False, error="编辑类型不能为空")
    if not target_symbol:
        return ToolResult(success=False, error="目标符号不能为空")

    p = Path(file_path).expanduser().resolve()
    if not p.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        code = p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取文件失败: {e}")

    lines = code.splitlines(keepends=True)
    tree = _parse_ast_safely(code)
    if not tree:
        return ToolResult(success=False, error="文件Python语法有误，无法解析AST")

    # 定位目标符号
    symbol_info = _find_symbol_lines(tree, lines, target_symbol, edit_type)
    if not symbol_info:
        return ToolResult(success=False, error=f"未找到目标符号: {target_symbol}")

    old_lines = lines[:]
    sl = symbol_info["start_line"]
    el = symbol_info["end_line"]

    # 根据编辑类型执行操作
    if edit_type == "add_method" and symbol_info.get("is_class_end"):
        # 在类末尾（end_line前一行）插入新方法
        indent = "    "
        method_code = "\n".join(indent + l for l in new_code.splitlines()) + "\n"
        new_lines = lines[:el] + [method_code] + lines[el:]

    elif edit_type == "add_import":
        # 在最后一个导入后添加新导入
        last_import_line = 0
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                end = getattr(node, "end_lineno", node.lineno)
                if end > last_import_line:
                    last_import_line = end
        if last_import_line > 0:
            new_lines = lines[:last_import_line] + [new_code + "\n"] + lines[last_import_line:]
        else:
            # 文件顶部添加
            new_lines = [new_code + "\n", "\n"] + lines

    elif edit_type == "replace_function":
        # 替换函数（保留原始缩进风格）
        new_lines = lines[:sl - 1] + [new_code + "\n"] + lines[el:]

    elif edit_type == "modify_class":
        # 替换整个类定义
        new_lines = lines[:sl - 1] + [new_code + "\n"] + lines[el:]

    elif edit_type == "replace_expression":
        # 替换指定行范围的代码
        new_lines = lines[:sl - 1] + [new_code + "\n"] + lines[el:]

    else:
        return ToolResult(success=False, error=f"不支持的编辑类型: {edit_type}")

    result_code = "".join(new_lines)

    # 语法验证
    test_tree = _parse_ast_safely(result_code)
    if not test_tree:
        return ToolResult(
            success=False,
            error="编辑后代码语法有误，已放弃写入。请调整new_code后重试。",
            duration=time.time() - start,
            metadata={"diff": _make_unified_diff(old_lines, new_lines, p.name)},
        )

    # 生成diff
    diff_text = _make_unified_diff(old_lines, new_lines, p.name)

    if preview_only:
        return ToolResult(
            success=True,
            output=f"预览变更（未写入）:\n\n{diff_text}",
            duration=time.time() - start,
            metadata={"preview": True, "file_path": str(p)},
        )

    # 写入文件
    try:
        p.write_text(result_code, encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"写入文件失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=True,
        output=f"代码编辑完成:\n\n{diff_text}",
        duration=time.time() - start,
        metadata={
            "file_path": str(p),
            "edit_type": edit_type,
            "target_symbol": target_symbol,
        },
    )

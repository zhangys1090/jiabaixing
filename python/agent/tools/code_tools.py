from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

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
    try:
        from agent.sandbox.executor import SandboxExecutor, SandboxConfig
        from agent.sandbox.types import SecurityLevel
        sandbox = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.HIGH))
        pre_check = sandbox._pre_check_code(command, "shell")
        if not pre_check.allowed:
            return ToolResult(
                success=False,
                error=f"沙箱安全检查拒绝: {pre_check.reason}",
                metadata={"security_violation": True},
            )
    except Exception:
        pass

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
    except Exception:
        pass
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
    raw_path = str(params.get("file_path", ""))
    focus = str(params.get("focus", "all"))

    if not raw_path:
        return ToolResult(success=False, error="文件路径不能为空")

    file_path = Path(raw_path).expanduser().resolve()
    if not file_path.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    lines = content.splitlines()
    ext = file_path.suffix.lower()

    rule_findings = _run_rule_checks(content, lines, ext)
    security_findings = _run_security_checks(content, lines)

    llm_findings: list[dict[str, Any]] = []
    if len(content) < 10000:
        llm_findings = await _run_llm_review(content, str(file_path), focus)

    all_findings = rule_findings + security_findings + llm_findings

    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    all_findings.sort(key=lambda f: severity_order.get(f.get("severity", "info"), 4))

    output = _format_review_report(str(file_path), len(lines), all_findings, focus)

    critical_count = sum(1 for f in all_findings if f.get("severity") == "critical")
    high_count = sum(1 for f in all_findings if f.get("severity") == "high")

    return ToolResult(
        success=True,
        output=output,
        duration=time.time() - start,
        metadata={
            "file_path": str(file_path),
            "total_lines": len(lines),
            "findings_count": len(all_findings),
            "critical_count": critical_count,
            "high_count": high_count,
        },
    )


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
            except ValueError:
                pass
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

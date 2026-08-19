"""P0-6 / P0-7 验证。

P0-6: API 鉴权默认 fail-fast
  - 非开发环境(ENV=production)且未配置 API_KEYS → 导入即崩溃(RuntimeError)，杜绝裸奔
  - 开发环境(ENV=development) → 正常导入、鉴权关闭

P0-7: LSP 非 Python 语言返回 success=False + 明确 unsupported
  - 对 .ts 等本后端不支持的语言，补全/诊断/悬停/定义/引用/符号查找均不再谎报成功
"""

import asyncio
import os
import subprocess
import sys
import tempfile

PYTHON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANAGED_PY = sys.executable

# 这些键由被测 agent 读取用于鉴权/环境判定。为避免被其他测试污染的父进程
# os.environ 影响（顺序依赖：全量运行时前面的测试会写入 ENV/API_KEYS 等），
# 子进程环境只保留安全系统变量 + 本测试显式覆盖的值。
_AGENT_ENV_KEYS = (
    "ENV", "AGENT_ENV", "API_KEYS", "AUTH_FAILFAST",
    "OPENAI_API_KEY", "OPENAI_API_BASE", "ANTHROPIC_API_KEY",
    "AGENT_API_KEY", "API_KEY",
)


def _clean_env(overrides: dict) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in _AGENT_ENV_KEYS}
    env.update(overrides)
    return env


def _import_agent_main(env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [MANAGED_PY, "-c", "import agent.main"],
        cwd=PYTHON_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_p0_6_dev_import_ok():
    env = _clean_env({"ENV": "development", "API_KEYS": ""})
    r = _import_agent_main(env)
    assert r.returncode == 0, f"dev 下导入应成功: {r.stderr[-500:]}"


def test_p0_6_prod_without_keys_failfast():
    env = _clean_env({"ENV": "production", "API_KEYS": "", "AUTH_FAILFAST": "true"})
    r = _import_agent_main(env)
    assert r.returncode != 0, "生产无 key 必须启动崩溃(fail-fast)"
    assert "fail-fast" in r.stderr, f"应抛出 fail-fast RuntimeError: {r.stderr[-500:]}"


def test_p0_6_prod_without_keys_failfast_disabled_reject_all():
    # AUTH_FAILFAST=false 降级为 reject-all（不崩溃，但日志报错），用于测试/特例
    env = _clean_env({"ENV": "production", "API_KEYS": "", "AUTH_FAILFAST": "false"})
    r = _import_agent_main(env)
    assert r.returncode == 0, f"降级模式应可导入: {r.stderr[-500:]}"


def test_p0_6_prod_with_keys_ok():
    env = _clean_env({"ENV": "production", "API_KEYS": "k1:admin", "AUTH_FAILFAST": "true"})
    r = _import_agent_main(env)
    assert r.returncode == 0, f"生产配了 key 应正常导入: {r.stderr[-500:]}"


def _make_temp_file(suffix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    return path


def test_p0_7_non_python_returns_failure():
    from agent.tools.lsp_tools import (
        lsp_completion_executor,
        lsp_definition_executor,
        lsp_diagnostics_executor,
        lsp_hover_executor,
        lsp_references_executor,
        lsp_symbols_executor,
    )

    ts_path = _make_temp_file(".ts")
    try:
        executors = [
            ("completion", lsp_completion_executor, {"uri": ts_path, "line": 0, "character": 0}),
            ("diagnostics", lsp_diagnostics_executor, {"uri": ts_path, "severity": "error"}),
            ("hover", lsp_hover_executor, {"uri": ts_path, "line": 0, "character": 0}),
            ("definition", lsp_definition_executor, {"uri": ts_path, "line": 0, "character": 0}),
            ("references", lsp_references_executor, {"uri": ts_path, "line": 0, "character": 0}),
            ("symbols", lsp_symbols_executor, {"uri": ts_path}),
        ]
        for name, fn, params in executors:
            result = asyncio.run(fn(params))
            assert result.success is False, f"{name} 对 {ts_path} 不应谎报成功"
            assert "unsupported" in (result.error or ""), f"{name} 应明确 unsupported，实际 error={result.error!r}"
    finally:
        os.remove(ts_path)


def test_p0_7_python_still_succeeds():
    from agent.tools.lsp_tools import lsp_symbols_executor

    py_path = _make_temp_file(".py")
    try:
        result = asyncio.run(lsp_symbols_executor({"uri": py_path}))
        # Python 真实分支返回 success=True（符号查找走 Python 分支）
        assert result.success is True, f"Python 应走真实分支: {result.error!r}"
    finally:
        os.remove(py_path)

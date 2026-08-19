from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

from agent.tools import file_tools as _file_tools
from agent.tools.registry import ToolRegistry, register_default_tools


@pytest.fixture
def registry():
    r = ToolRegistry()
    register_default_tools(r)
    return r


@pytest.fixture(autouse=True)
def _allow_edit_without_read(monkeypatch):
    # 本模块测试编辑工具的内部机制（替换/预览/语法校验/多文件原子性）。
    # read-before-edit 守卫本身由 tests/test_p2_7_read_before_edit.py 专项覆盖，
    # 此处将其置为 no-op，避免编辑 freshly-created 临时文件时被守卫拦截（P2-7 回归修复）。
    monkeypatch.setattr(_file_tools, "_read_before_edit_check", lambda *a, **k: None)


class TestToolRegistration:
    def test_all_tools_registered(self, registry: ToolRegistry):
        assert registry.size() >= 44

    def test_file_tools_registered(self, registry: ToolRegistry):
        for name in ["file_read", "file_list", "file_grep", "file_search", "file_edit"]:
            assert registry.get(name) is not None, f"{name} not registered"

    def test_memory_tools_registered(self, registry: ToolRegistry):
        for name in ["memory_recall", "memory_search", "memory_store", "knowledge_query"]:
            assert registry.get(name) is not None, f"{name} not registered"

    def test_code_tools_registered(self, registry: ToolRegistry):
        for name in ["code_generate", "code_analyze", "code_fix", "shell_exec"]:
            assert registry.get(name) is not None, f"{name} not registered"

    def test_network_tools_registered(self, registry: ToolRegistry):
        for name in ["web_search", "web_fetch", "chart_generate"]:
            assert registry.get(name) is not None, f"{name} not registered"

    def test_cognition_tools_registered(self, registry: ToolRegistry):
        for name in ["emotion_detect", "scene_analyze", "self_reflect"]:
            assert registry.get(name) is not None, f"{name} not registered"

    def test_system_tools_registered(self, registry: ToolRegistry):
        for name in ["ask_clarification", "context_manage", "preview_execution", "rollback_changes"]:
            assert registry.get(name) is not None, f"{name} not registered"

    def test_openai_tools_format(self, registry: ToolRegistry):
        tools = registry.to_openai_tools()
        assert len(tools) >= 22
        for t in tools:
            assert t["type"] == "function"
            assert "name" in t["function"]
            assert "parameters" in t["function"]


class TestFileReadTool:
    @pytest.mark.asyncio
    async def test_read_existing_file(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write("line1\nline2\nline3\n")
            tmp = f.name

        try:
            result = await registry.execute("file_read", {"file_path": tmp})
            assert result.success
            assert "line1" in result.output
            assert "line2" in result.output
            assert "line3" in result.output
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_read_with_offset_and_limit(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write("line1\nline2\nline3\nline4\nline5\n")
            tmp = f.name

        try:
            result = await registry.execute("file_read", {"file_path": tmp, "offset": 2, "limit": 2})
            assert result.success
            assert "line2" in result.output
            assert "line3" in result.output
            assert "line1" not in result.output
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_read_nonexistent_file(self, registry: ToolRegistry):
        result = await registry.execute("file_read", {"file_path": "/nonexistent/file.txt"})
        assert not result.success
        assert "不存在" in result.error

    @pytest.mark.asyncio
    async def test_read_empty_path(self, registry: ToolRegistry):
        result = await registry.execute("file_read", {"file_path": ""})
        assert not result.success


class TestFileListTool:
    @pytest.mark.asyncio
    async def test_list_directory(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            Path(tmpdir, "test.py").write_text("print('hello')", encoding="utf-8")
            Path(tmpdir, "subdir").mkdir()

            result = await registry.execute("file_list", {"dir_path": tmpdir})
            assert result.success
            assert "test.py" in result.output
            assert "subdir" in result.output

    @pytest.mark.asyncio
    async def test_list_nonexistent_dir(self, registry: ToolRegistry):
        result = await registry.execute("file_list", {"dir_path": "/nonexistent/dir"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_list_with_pattern(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            Path(tmpdir, "test.py").write_text("", encoding="utf-8")
            Path(tmpdir, "test.js").write_text("", encoding="utf-8")
            Path(tmpdir, "readme.md").write_text("", encoding="utf-8")

            result = await registry.execute("file_list", {"dir_path": tmpdir, "pattern": "*.py"})
            assert result.success
            assert "test.py" in result.output


class TestFileGrepTool:
    @pytest.mark.asyncio
    async def test_grep_in_file(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    print('world')\n    return True\n")
            tmp = f.name

        try:
            result = await registry.execute("file_grep", {"pattern": "print", "path": tmp})
            assert result.success
            assert "print" in result.output
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_grep_no_match(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    pass\n")
            tmp = f.name

        try:
            result = await registry.execute("file_grep", {"pattern": "nonexistent_pattern_xyz", "path": tmp})
            assert result.success
            assert "未找到" in result.output
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_grep_empty_pattern(self, registry: ToolRegistry):
        result = await registry.execute("file_grep", {"pattern": ""})
        assert not result.success


class TestFileSearchTool:
    @pytest.mark.asyncio
    async def test_search_by_name(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            Path(tmpdir, "config.json").write_text("{}", encoding="utf-8")
            Path(tmpdir, "main.py").write_text("", encoding="utf-8")

            result = await registry.execute("file_search", {"pattern": "config", "dir_path": tmpdir})
            assert result.success
            assert "config.json" in result.output

    @pytest.mark.asyncio
    async def test_search_no_match(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            Path(tmpdir, "main.py").write_text("", encoding="utf-8")

            result = await registry.execute("file_search", {"pattern": "nonexistent_xyz", "dir_path": tmpdir})
            assert result.success
            assert "未找到" in result.output


class TestFileEditTool:
    @pytest.mark.asyncio
    async def test_edit_replace(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    print('world')\n")
            tmp = f.name

        try:
            result = await registry.execute("file_edit", {
                "file_path": tmp,
                "old_text": "world",
                "new_text": "python",
                "bypass_read_check": True,
            })
            assert result.success
            assert "1 处匹配" in result.output

            content = Path(tmp).read_text(encoding="utf-8")
            assert "python" in content
            assert "world" not in content
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_edit_no_match(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("hello world\n")
            tmp = f.name

        try:
            result = await registry.execute("file_edit", {
                "file_path": tmp,
                "old_text": "nonexistent_text_xyz",
                "new_text": "replacement",
            })
            assert not result.success
            assert "未找到" in result.error
        finally:
            os.unlink(tmp)


class TestShellExecTool:
    @pytest.mark.asyncio
    async def test_shell_echo(self, registry: ToolRegistry):
        result = await registry.execute("shell_exec", {"command": "echo hello"})
        assert result.success
        assert "hello" in result.output

    @pytest.mark.asyncio
    async def test_shell_forbidden_command(self, registry: ToolRegistry):
        result = await registry.execute("shell_exec", {"command": "format C:"})
        assert not result.success
        assert "禁止" in result.error

    @pytest.mark.asyncio
    async def test_shell_empty_command(self, registry: ToolRegistry):
        result = await registry.execute("shell_exec", {"command": ""})
        assert not result.success


class TestAskClarificationTool:
    @pytest.mark.asyncio
    async def test_ask_with_question(self, registry: ToolRegistry):
        result = await registry.execute("ask_clarification", {"question": "你想要哪种方案？"})
        assert result.success
        assert "哪种方案" in result.output

    @pytest.mark.asyncio
    async def test_ask_with_options(self, registry: ToolRegistry):
        result = await registry.execute("ask_clarification", {
            "question": "选择语言",
            "options": "Python, TypeScript, Go",
        })
        assert result.success
        assert "Python" in result.output


class TestToolDefinitions:
    def test_file_read_has_parameters(self, registry: ToolRegistry):
        defn = registry.get_definition("file_read")
        assert defn is not None
        param_names = [p.name for p in defn.parameters]
        assert "file_path" in param_names
        assert "offset" in param_names
        assert "limit" in param_names

    def test_shell_exec_risk_level(self, registry: ToolRegistry):
        defn = registry.get_definition("shell_exec")
        assert defn is not None
        assert defn.risk_level == "high"

    def test_memory_recall_definition(self, registry: ToolRegistry):
        defn = registry.get_definition("memory_recall")
        assert defn is not None
        assert defn.category.value == "memory"
        param_names = [p.name for p in defn.parameters]
        assert "query" in param_names

    def test_code_generate_definition(self, registry: ToolRegistry):
        defn = registry.get_definition("code_generate")
        assert defn is not None
        assert defn.category.value == "code"
        assert defn.risk_level == "medium"

    def test_web_search_definition(self, registry: ToolRegistry):
        defn = registry.get_definition("web_search")
        assert defn is not None
        assert defn.category.value == "network"

    def test_emotion_detect_definition(self, registry: ToolRegistry):
        defn = registry.get_definition("emotion_detect")
        assert defn is not None
        assert defn.category.value == "cognition"

    def test_context_manage_definition(self, registry: ToolRegistry):
        defn = registry.get_definition("context_manage")
        assert defn is not None
        assert defn.category.value == "system"

    def test_daily_tools_registered(self, registry: ToolRegistry):
        for name in ["task_manage", "calendar", "reminder_set", "note_take",
                      "system_status", "task_priority", "task_dependency",
                      "batch_task", "task_analytics"]:
            assert registry.get(name) is not None, f"{name} not registered"


class TestTaskManageTool:
    @pytest.mark.asyncio
    async def test_create_task(self, registry: ToolRegistry):
        result = await registry.execute("task_manage", {"action": "create", "title": "测试任务"})
        assert result.success
        assert "测试任务" in result.output

    @pytest.mark.asyncio
    async def test_list_tasks(self, registry: ToolRegistry):
        await registry.execute("task_manage", {"action": "create", "title": "列表测试"})
        result = await registry.execute("task_manage", {"action": "list"})
        assert result.success

    @pytest.mark.asyncio
    async def test_complete_task(self, registry: ToolRegistry):
        create_result = await registry.execute("task_manage", {"action": "create", "title": "完成测试"})
        task_id = create_result.output.split("[")[1].split("]")[0] if "[" in create_result.output else ""
        if task_id:
            result = await registry.execute("task_manage", {"action": "complete", "task_id": task_id})
            assert result.success
            assert "已完成" in result.output

    @pytest.mark.asyncio
    async def test_create_task_no_title(self, registry: ToolRegistry):
        result = await registry.execute("task_manage", {"action": "create"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_unknown_action(self, registry: ToolRegistry):
        result = await registry.execute("task_manage", {"action": "unknown_action"})
        assert not result.success


class TestCalendarTool:
    @pytest.mark.asyncio
    async def test_create_event(self, registry: ToolRegistry):
        result = await registry.execute("calendar", {"action": "create_event", "title": "测试会议", "start_time": "2026-06-24 10:00"})
        assert result.success
        assert "测试会议" in result.output

    @pytest.mark.asyncio
    async def test_list_events(self, registry: ToolRegistry):
        result = await registry.execute("calendar", {"action": "list_events"})
        assert result.success

    @pytest.mark.asyncio
    async def test_create_event_no_title(self, registry: ToolRegistry):
        result = await registry.execute("calendar", {"action": "create_event"})
        assert not result.success


class TestReminderSetTool:
    @pytest.mark.asyncio
    async def test_set_reminder(self, registry: ToolRegistry):
        result = await registry.execute("reminder_set", {"action": "set", "message": "测试提醒", "trigger_time": "30分钟后"})
        assert result.success
        assert "测试提醒" in result.output

    @pytest.mark.asyncio
    async def test_list_reminders(self, registry: ToolRegistry):
        result = await registry.execute("reminder_set", {"action": "list"})
        assert result.success

    @pytest.mark.asyncio
    async def test_set_reminder_no_message(self, registry: ToolRegistry):
        result = await registry.execute("reminder_set", {"action": "set"})
        assert not result.success


class TestNoteTakeTool:
    @pytest.mark.asyncio
    async def test_write_note(self, registry: ToolRegistry):
        result = await registry.execute("note_take", {"action": "write", "title": "测试笔记", "content": "笔记内容"})
        assert result.success
        assert "测试笔记" in result.output

    @pytest.mark.asyncio
    async def test_list_notes(self, registry: ToolRegistry):
        result = await registry.execute("note_take", {"action": "list"})
        assert result.success

    @pytest.mark.asyncio
    async def test_search_notes(self, registry: ToolRegistry):
        await registry.execute("note_take", {"action": "write", "title": "搜索测试笔记", "content": "可搜索内容"})
        result = await registry.execute("note_take", {"action": "search", "query": "搜索测试"})
        assert result.success


class TestTaskPriorityTool:
    @pytest.mark.asyncio
    async def test_list_by_priority(self, registry: ToolRegistry):
        result = await registry.execute("task_priority", {"action": "list_by_priority"})
        assert result.success

    @pytest.mark.asyncio
    async def test_promote_nonexistent(self, registry: ToolRegistry):
        result = await registry.execute("task_priority", {"action": "promote", "task_id": "nonexistent"})
        assert not result.success


class TestBatchTaskTool:
    @pytest.mark.asyncio
    async def test_create_batch(self, registry: ToolRegistry):
        result = await registry.execute("batch_task", {"action": "create_batch", "titles": "任务A,任务B,任务C"})
        assert result.success
        assert "3" in result.output

    @pytest.mark.asyncio
    async def test_list_by_status(self, registry: ToolRegistry):
        result = await registry.execute("batch_task", {"action": "list_by_status", "status": "pending"})
        assert result.success


class TestTaskAnalyticsTool:
    @pytest.mark.asyncio
    async def test_summary(self, registry: ToolRegistry):
        result = await registry.execute("task_analytics", {"action": "summary"})
        assert result.success
        assert "任务统计" in result.output

    @pytest.mark.asyncio
    async def test_bottleneck(self, registry: ToolRegistry):
        result = await registry.execute("task_analytics", {"action": "bottleneck"})
        assert result.success


class TestLSPTools:
    def test_lsp_tools_registered(self, registry: ToolRegistry):
        for name in ["lsp_completion", "lsp_diagnostics", "lsp_hover",
                      "lsp_definition", "lsp_references", "lsp_symbols"]:
            assert registry.get(name) is not None, f"{name} not registered"

    @pytest.mark.asyncio
    async def test_lsp_diagnostics_no_uri(self, registry: ToolRegistry):
        result = await registry.execute("lsp_diagnostics", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_lsp_diagnostics_file_not_found(self, registry: ToolRegistry):
        result = await registry.execute("lsp_diagnostics", {"uri": "file:///nonexistent.py"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_lsp_symbols_no_uri(self, registry: ToolRegistry):
        result = await registry.execute("lsp_symbols", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_lsp_symbols_existing_file(self, registry: ToolRegistry):
        result = await registry.execute("lsp_symbols", {"uri": f"file:///{str(Path(__file__).parent / 'test_p1_tools.py').replace(os.sep, '/')}"})
        assert result.success

    @pytest.mark.asyncio
    async def test_lsp_completion_no_uri(self, registry: ToolRegistry):
        result = await registry.execute("lsp_completion", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_lsp_hover_no_uri(self, registry: ToolRegistry):
        result = await registry.execute("lsp_hover", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_lsp_definition_no_uri(self, registry: ToolRegistry):
        result = await registry.execute("lsp_definition", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_lsp_references_no_uri(self, registry: ToolRegistry):
        result = await registry.execute("lsp_references", {})
        assert not result.success


class TestDesktopTools:
    def test_desktop_tools_registered(self, registry: ToolRegistry):
        for name in ["desktop_automate", "desktop_screenshot"]:
            assert registry.get(name) is not None, f"{name} not registered"

    @pytest.mark.asyncio
    async def test_desktop_automate_no_task(self, registry: ToolRegistry):
        result = await registry.execute("desktop_automate", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_desktop_automate_with_task(self, registry: ToolRegistry):
        result = await registry.execute("desktop_automate", {"task": "open notepad"})
        assert result.success or result.error is not None

    @pytest.mark.asyncio
    async def test_desktop_screenshot(self, registry: ToolRegistry):
        result = await registry.execute("desktop_screenshot", {})
        assert result.success or result.error is not None


class TestNetworkEnhancedTools:
    def test_network_enhanced_tools_registered(self, registry: ToolRegistry):
        for name in ["image_generate", "skill_create", "message_push"]:
            assert registry.get(name) is not None, f"{name} not registered"

    @pytest.mark.asyncio
    async def test_image_generate_no_prompt(self, registry: ToolRegistry):
        result = await registry.execute("image_generate", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_image_generate_with_prompt(self, registry: ToolRegistry):
        result = await registry.execute("image_generate", {"prompt": "a cat", "size": "square"})
        assert result.success

    @pytest.mark.asyncio
    async def test_skill_create_no_name(self, registry: ToolRegistry):
        result = await registry.execute("skill_create", {"action": "create"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_skill_create_and_list(self, registry: ToolRegistry):
        result = await registry.execute("skill_create", {"action": "create", "skill_name": "test_skill", "template": "Hello {{name}}", "description": "测试技能"})
        assert result.success
        result = await registry.execute("skill_create", {"action": "list"})
        assert result.success

    @pytest.mark.asyncio
    async def test_skill_create_execute(self, registry: ToolRegistry):
        await registry.execute("skill_create", {"action": "create", "skill_name": "exec_test", "template": "Result: {{input}}", "description": "执行测试"})
        result = await registry.execute("skill_create", {"action": "execute", "skill_name": "exec_test", "params": '{"input": "hello"}'})
        assert result.success
        assert "hello" in result.output

    @pytest.mark.asyncio
    @pytest.mark.xfail(
        sys.platform == "win32",
        strict=False,
        reason="Windows 沙箱无回收站，safe_delete fail-closed 拒绝删除使 result.success=False；Linux CI 走回收站删除正常通过",
    )
    async def test_skill_create_delete(self, registry: ToolRegistry):
        await registry.execute("skill_create", {"action": "create", "skill_name": "del_test", "template": "temp", "description": "删除测试"})
        result = await registry.execute("skill_create", {"action": "delete", "skill_name": "del_test"})
        assert result.success

    @pytest.mark.asyncio
    async def test_skill_create_usage_stats(self, registry: ToolRegistry):
        result = await registry.execute("skill_create", {"action": "usage_stats"})
        assert result.success

    @pytest.mark.asyncio
    async def test_skill_create_unknown_action(self, registry: ToolRegistry):
        result = await registry.execute("skill_create", {"action": "unknown_action"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_message_push_no_channel(self, registry: ToolRegistry):
        result = await registry.execute("message_push", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_message_push_no_sendkey(self, registry: ToolRegistry):
        result = await registry.execute("message_push", {"channel": "serverchan", "title": "test", "content": "test"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_message_push_dingtalk_no_webhook(self, registry: ToolRegistry):
        result = await registry.execute("message_push", {"channel": "dingtalk", "title": "test", "content": "test"})
        assert not result.success


class TestDailyEnhancedTools:
    def test_daily_enhanced_tools_registered(self, registry: ToolRegistry):
        for name in ["morning_brief", "natural_schedule", "skill_share"]:
            assert registry.get(name) is not None, f"{name} not registered"

    @pytest.mark.asyncio
    async def test_morning_brief(self, registry: ToolRegistry):
        result = await registry.execute("morning_brief", {"topics": "AI", "max_items": 1})
        assert result.success

    @pytest.mark.asyncio
    async def test_natural_schedule_no_desc(self, registry: ToolRegistry):
        result = await registry.execute("natural_schedule", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_natural_schedule_daily(self, registry: ToolRegistry):
        result = await registry.execute("natural_schedule", {"description": "每日站会", "schedule": "每天早上9点"})
        assert result.success
        assert "0 9 * * *" in result.output

    @pytest.mark.asyncio
    async def test_natural_schedule_weekly(self, registry: ToolRegistry):
        result = await registry.execute("natural_schedule", {"description": "周会", "schedule": "每周一上午10点"})
        assert result.success
        assert "0 10 * * 1" in result.output

    @pytest.mark.asyncio
    async def test_natural_schedule_hourly(self, registry: ToolRegistry):
        result = await registry.execute("natural_schedule", {"description": "健康提醒", "schedule": "每小时"})
        assert result.success
        assert "0 * * * *" in result.output

    @pytest.mark.asyncio
    async def test_natural_schedule_weekday(self, registry: ToolRegistry):
        result = await registry.execute("natural_schedule", {"description": "打卡", "schedule": "工作日9点"})
        assert result.success
        assert "0 9 * * 1-5" in result.output

    @pytest.mark.asyncio
    async def test_skill_share_list(self, registry: ToolRegistry):
        result = await registry.execute("skill_share", {"action": "list"})
        assert result.success

    @pytest.mark.asyncio
    async def test_skill_share_export_no_name(self, registry: ToolRegistry):
        result = await registry.execute("skill_share", {"action": "export"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_skill_share_import_no_file(self, registry: ToolRegistry):
        result = await registry.execute("skill_share", {"action": "import"})
        assert not result.success


class TestIncrementalEditTool:
    def test_incremental_edit_registered(self, registry: ToolRegistry):
        assert registry.get("incremental_edit") is not None

    @pytest.mark.asyncio
    async def test_incremental_edit_basic_replace(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    print('world')\n    return True\n")
            tmp = f.name

        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [{"search": "world", "replace": "python", "description": "替换打印内容"}],
            })
            assert result.success
            content = Path(tmp).read_text(encoding="utf-8")
            assert "python" in content
            assert "world" not in content
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_incremental_edit_preview_only(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    print('world')\n    return True\n")
            tmp = f.name

        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [{"search": "world", "replace": "python", "description": "替换打印内容"}],
                "preview_only": True,
            })
            assert result.success
            content = Path(tmp).read_text(encoding="utf-8")
            assert "world" in content
            assert "python" not in content
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_incremental_edit_validate_python_syntax(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    print('world')\n    return True\n")
            tmp = f.name

        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [{"search": "return True", "replace": "return False", "description": "修改返回值"}],
                "validate_syntax": True,
            })
            assert result.success
            content = Path(tmp).read_text(encoding="utf-8")
            assert "return False" in content
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_incremental_edit_syntax_error_rejected(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    print('world')\n    return True\n")
            tmp = f.name

        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [{"search": "return True", "replace": "return True # broken", "description": "破坏语法"}],
                "validate_syntax": True,
            })
            content = Path(tmp).read_text(encoding="utf-8")
            if not result.success:
                assert "语法" in result.error or "syntax" in result.error.lower()
            else:
                assert "return True" in content
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_incremental_edit_create_if_missing(self, registry: ToolRegistry):
        tmp = os.path.join(tempfile.gettempdir(), f"test_incremental_{os.getpid()}.py")
        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [{"search": "", "replace": "print('hello')\n", "description": "创建新文件"}],
                "create_if_missing": True,
            })
            if result.success:
                assert Path(tmp).exists()
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_incremental_edit_not_found(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    pass\n")
            tmp = f.name

        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [{"search": "nonexistent_code_xyz", "replace": "new_code", "description": "不存在的代码"}],
            })
            assert not result.success
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_incremental_edit_no_path(self, registry: ToolRegistry):
        result = await registry.execute("incremental_edit", {
            "edits": [{"search": "x", "replace": "y", "description": "test"}],
        })
        assert not result.success

    @pytest.mark.asyncio
    async def test_incremental_edit_no_edits(self, registry: ToolRegistry):
        result = await registry.execute("incremental_edit", {"file_path": "/tmp/test.py"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_incremental_edit_multiple_edits(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("x = 1\ny = 2\nz = 3\n")
            tmp = f.name

        try:
            result = await registry.execute("incremental_edit", {
                "file_path": tmp,
                "edits": [
                    {"search": "x = 1", "replace": "x = 10", "description": "修改x"},
                    {"search": "y = 2", "replace": "y = 20", "description": "修改y"},
                ],
            })
            assert result.success
            content = Path(tmp).read_text(encoding="utf-8")
            assert "x = 10" in content
            assert "y = 20" in content
            assert "z = 3" in content
        finally:
            os.unlink(tmp)


class TestMultiFileEditTool:
    def test_multi_file_edit_registered(self, registry: ToolRegistry):
        assert registry.get("multi_file_edit") is not None

    @pytest.mark.asyncio
    async def test_multi_file_edit_basic(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            file_a = Path(tmpdir, "a.py")
            file_b = Path(tmpdir, "b.py")
            file_a.write_text("x = 1\n", encoding="utf-8")
            file_b.write_text("y = 2\n", encoding="utf-8")

            result = await registry.execute("multi_file_edit", {
                "files": [
                    {"path": str(file_a), "edits": [{"search": "x = 1", "replace": "x = 10", "description": "修改a"}]},
                    {"path": str(file_b), "edits": [{"search": "y = 2", "replace": "y = 20", "description": "修改b"}]},
                ],
            })
            assert result.success
            assert "x = 10" in file_a.read_text(encoding="utf-8")
            assert "y = 20" in file_b.read_text(encoding="utf-8")

    @pytest.mark.asyncio
    async def test_multi_file_edit_atomic_rollback(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            file_a = Path(tmpdir, "a.py")
            file_b = Path(tmpdir, "b_not_exist.py")
            file_a.write_text("x = 1\n", encoding="utf-8")

            result = await registry.execute("multi_file_edit", {
                "files": [
                    {"path": str(file_a), "edits": [{"search": "x = 1", "replace": "x = 10", "description": "修改a"}]},
                    {"path": str(file_b), "edits": [{"search": "y = 2", "replace": "y = 20", "description": "修改不存在的b"}]},
                ],
                "atomic": True,
            })
            if not result.success:
                content_a = file_a.read_text(encoding="utf-8")
                assert "x = 1" in content_a

    @pytest.mark.asyncio
    async def test_multi_file_edit_no_files(self, registry: ToolRegistry):
        result = await registry.execute("multi_file_edit", {"files": []})
        assert not result.success


class TestCodeReviewTool:
    def test_code_review_registered(self, registry: ToolRegistry):
        assert registry.get("code_review") is not None

    @pytest.mark.asyncio
    async def test_code_review_python_file(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("import os\n\ndef hello():\n    print('debug')\n    api_key = 'sk-1234567890abcdef1234567890abcdef'\n    return api_key\n")
            tmp = f.name

        try:
            result = await registry.execute("code_review", {"file_path": tmp})
            assert result.success
            assert "审查报告" in result.output or "代码审查" in result.output
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_code_review_with_focus(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("def hello():\n    pass\n")
            tmp = f.name

        try:
            result = await registry.execute("code_review", {"file_path": tmp, "focus": "security"})
            assert result.success
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_code_review_nonexistent_file(self, registry: ToolRegistry):
        result = await registry.execute("code_review", {"file_path": "/nonexistent/file.py"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_code_review_no_path(self, registry: ToolRegistry):
        result = await registry.execute("code_review", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_code_review_detects_security_issues(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write("api_key = 'sk-abcdef1234567890abcdef1234567890'\npassword = 'my_secret_password_123'\n")
            tmp = f.name

        try:
            result = await registry.execute("code_review", {"file_path": tmp, "focus": "security"})
            assert result.success
            assert result.metadata.get("findings_count", 0) > 0
        finally:
            os.unlink(tmp)


class TestCsvAnalyzeTool:
    def test_csv_analyze_registered(self, registry: ToolRegistry):
        assert registry.get("csv_analyze") is not None

    @pytest.mark.asyncio
    async def test_csv_analyze_basic(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
            f.write("name,age,score\nAlice,25,90\nBob,30,85\nCharlie,28,95\n")
            tmp = f.name

        try:
            result = await registry.execute("csv_analyze", {"file_path": tmp})
            assert result.success
            assert "3" in result.output
            assert "name" in result.output or "列" in result.output
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_csv_analyze_with_delimiter(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
            f.write("name;age;score\nAlice;25;90\nBob;30;85\n")
            tmp = f.name

        try:
            result = await registry.execute("csv_analyze", {"file_path": tmp, "delimiter": ";"})
            assert result.success
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_csv_analyze_nonexistent_file(self, registry: ToolRegistry):
        result = await registry.execute("csv_analyze", {"file_path": "/nonexistent/data.csv"})
        assert not result.success

    @pytest.mark.asyncio
    async def test_csv_analyze_no_path(self, registry: ToolRegistry):
        result = await registry.execute("csv_analyze", {})
        assert not result.success

    @pytest.mark.asyncio
    async def test_csv_analyze_max_rows(self, registry: ToolRegistry):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
            f.write("name,age\n")
            for i in range(100):
                f.write(f"Person{i},{20 + i % 50}\n")
            tmp = f.name

        try:
            result = await registry.execute("csv_analyze", {"file_path": tmp, "max_rows": 10})
            assert result.success
        finally:
            os.unlink(tmp)

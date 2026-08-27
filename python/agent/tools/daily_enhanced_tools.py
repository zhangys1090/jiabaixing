from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
from agent.core.logger import StructuredLogger, log_ignored
import logging
logger = logging.getLogger(__name__)
log = StructuredLogger("daily_enhanced_tools")


MORNING_BRIEF_DEF = ToolDefinition(
    name="morning_brief",
    description='生成每日简报：自动搜索今日新闻、科技动态、天气等，汇总为结构化简报。适用场景：用户要求晨报、每日简报、今日新闻摘要。不适用：用户要搜索特定话题（用web_search）。',
    category=ToolCategory.DAILY,
    parameters=[
        ToolParameterDef(name="topics", type="string", required=False, description="关注的主题，逗号分隔。默认: AI,科技,互联网"),
        ToolParameterDef(name="max_items", type="number", required=False, description="每个主题的新闻条数"),
    ],
    risk_level="low",
)


NATURAL_SCHEDULE_DEF = ToolDefinition(
    name="natural_schedule",
    description='用自然语言创建定时任务。适用场景：用户说每天早上9点、每周一、每小时、工作日提醒我。不适用：用户要设置一次性提醒（用reminder_set）。支持: 每天/每周/每小时/工作日/周末/自定义时间。',
    category=ToolCategory.DAILY,
    parameters=[
        ToolParameterDef(name="description", type="string", description="要定时执行的任务描述"),
        ToolParameterDef(name="schedule", type="string", description="自然语言时间描述，如每天早上9点、每周一上午10点、每小时"),
        ToolParameterDef(name="enabled", type="boolean", required=False, description="是否立即启用"),
    ],
    risk_level="low",
)


SKILL_SHARE_DEF = ToolDefinition(
    name="skill_share",
    description='Skill 分享工具：导出/导入/运行可分享的技能包。适用场景：用户要分享技能、导入别人的技能、运行一个技能包。不适用：用户要创建新技能（用skill_create）。',
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["export", "import", "run", "list"]),
        ToolParameterDef(name="skill_name", type="string", required=False, description="技能名称（export/run 时必填）"),
        ToolParameterDef(name="skill_file", type="string", required=False, description="技能文件路径（import 时必填）"),
        ToolParameterDef(name="prompt", type="string", required=False, description="运行技能时的用户输入（run 时可选）"),
    ],
    risk_level="low",
)


_SCHEDULE_DIR = Path(os.environ.get("DATA_DIR", "data")) / "schedules"
_SHARE_DIR = Path(os.environ.get("DATA_DIR", "data")) / "skill_shares"


class _ScheduleStore:
    _instance: _ScheduleStore | None = None

    def __init__(self, data_dir: str | Path | None = None) -> None:
        if data_dir is None:
            from agent.config import DATA_DIR
            data_dir = DATA_DIR
        self._dir = Path(data_dir) / "schedules"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._tasks: dict[str, dict[str, Any]] = {}
        self._load()

    @classmethod
    def get_instance(cls) -> _ScheduleStore:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _load(self) -> None:
        for f in self._dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                tid = data.get("id", f.stem)
                self._tasks[tid] = data
            except Exception as _exc:
                logger.warning("daily_enhanced_tools 异常处理", error=str(_exc))
                log_ignored(None, "daily_enhanced_tools._ScheduleStore._load", _exc)

    def _save(self, tid: str) -> None:
        task = self._tasks.get(tid)
        if not task:
            return
        path = self._dir / f"{tid}.json"
        path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")

    def create(self, description: str, schedule: str, enabled: bool = True) -> dict[str, Any]:
        tid = f"{int(time.time()):x}{hash(schedule) % 0xfff:03x}"
        cron = _parse_natural_schedule(schedule)
        task = {
            "id": tid,
            "description": description,
            "schedule": schedule,
            "cron": cron,
            "enabled": enabled,
            "created_at": time.time(),
            "last_run": None,
            "next_run": None,
        }
        self._tasks[tid] = task
        self._save(tid)
        return task

    def list_all(self) -> list[dict[str, Any]]:
        return list(self._tasks.values())

    def delete(self, tid: str) -> bool:
        if tid not in self._tasks:
            return False
        del self._tasks[tid]
        path = self._dir / f"{tid}.json"
        if path.exists():
            path.unlink()
        return True


def _parse_natural_schedule(schedule: str) -> str:
    s = schedule.strip()
    if re.search(r"每小时|every\s+hour", s):
        return "0 * * * *"
    if re.search(r"每天|every\s+day|每日", s):
        m = re.search(r"(\d+)\s*[点时:：]", s)
        hour = int(m.group(1)) if m else 9
        mm = re.search(r"[点时:：](\d+)", s)
        minute = int(mm.group(1)) if mm else 0
        return f"{minute} {hour} * * *"
    if re.search(r"每周|every\s+week", s):
        weekday_map = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0}
        m = re.search(r"周([一二三四五六日天])", s)
        weekday = weekday_map.get(m.group(1), 1) if m else 1
        hour_m = re.search(r"(\d+)\s*[点时:：]", s)
        hour = int(hour_m.group(1)) if hour_m else 9
        return f"0 {hour} * * {weekday}"
    if re.search(r"工作日|weekday", s):
        m = re.search(r"(\d+)\s*[点时:：]", s)
        hour = int(m.group(1)) if m else 9
        return f"0 {hour} * * 1-5"
    if re.search(r"周末|weekend", s):
        m = re.search(r"(\d+)\s*[点时:：]", s)
        hour = int(m.group(1)) if m else 10
        return f"0 {hour} * * 0,6"
    if re.search(r"每月|every\s+month", s):
        m = re.search(r"(\d+)\s*[号日]", s)
        day = int(m.group(1)) if m else 1
        hour_m = re.search(r"(\d+)\s*[点时:：]", s)
        hour = int(hour_m.group(1)) if hour_m else 9
        return f"0 {hour} {day} * *"
    return f"# 未解析: {s}"


def _get_schedule_store() -> _ScheduleStore:
    return _ScheduleStore.get_instance()


async def morning_brief_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    topics_str = str(params.get("topics", "AI,科技,互联网"))
    max_items = int(params.get("max_items", 3))

    topics = [t.strip() for t in topics_str.split(",") if t.strip()]
    if not topics:
        topics = ["AI", "科技", "互联网"]

    try:
        from agent.tools.network_tools import web_search_executor

        sections: list[str] = []
        for topic in topics:
            search_result = await web_search_executor({"query": f"{topic} 最新新闻 {time.strftime('%Y-%m-%d')}", "max_results": max_items})
            if search_result.success:
                sections.append(f"### {topic}\n{search_result.output}")
            else:
                sections.append(f"### {topic}\n⚠️ 搜索失败: {search_result.error}")

        brief = f"📰 每日简报 — {time.strftime('%Y年%m月%d日')}\n\n" + "\n\n".join(sections)
        return ToolResult(success=True, output=brief, duration=time.time() - start)
    except Exception as e:
        logger.warning("daily_enhanced_tools 异常处理", error=str(e))
        return ToolResult(
            success=True,
            output=f"📰 每日简报 — {time.strftime('%Y年%m月%d日')}\n\n关注主题: {', '.join(topics)}\n⚠️ 简报生成需要网络搜索支持: {e}",
            duration=time.time() - start,
        )


async def natural_schedule_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    description = str(params.get("description", ""))
    schedule = str(params.get("schedule", ""))
    enabled = bool(params.get("enabled", True))

    if not description or not schedule:
        return ToolResult(success=False, error="任务描述和时间描述不能为空", duration=time.time() - start)

    store = _get_schedule_store()
    task = store.create(description, schedule, enabled)

    return ToolResult(
        success=True,
        output=f"⏰ 定时任务已创建\n📋 任务: {description}\n🕐 时间: {schedule}\n📊 Cron: {task['cron']}\n{'✅ 已启用' if enabled else '⏸️ 未启用'}\n🆔 ID: {task['id']}",
        duration=time.time() - start,
    )


async def skill_share_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))

    _SHARE_DIR.mkdir(parents=True, exist_ok=True)

    if action == "export":
        name = str(params.get("skill_name", ""))
        if not name:
            return ToolResult(success=False, error="技能名称不能为空", duration=time.time() - start)
        try:
            from agent.tools.network_enhanced_tools import _get_skill_store
            store = _get_skill_store()
            skill = store.get(name)
            if not skill:
                return ToolResult(success=False, error=f"技能 '{name}' 不存在", duration=time.time() - start)
            export_data = {
                "name": skill["name"],
                "description": skill.get("description", ""),
                "template": skill.get("template", ""),
                "version": "1.0",
                "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            export_path = _SHARE_DIR / f"{name}_export.json"
            export_path.write_text(json.dumps(export_data, ensure_ascii=False, indent=2), encoding="utf-8")
            return ToolResult(success=True, output=f"📤 技能已导出: {name}\n路径: {export_path}", duration=time.time() - start)
        except Exception as e:
            logger.warning("daily_enhanced_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"导出失败: {e}", duration=time.time() - start)

    elif action == "import":
        skill_file = str(params.get("skill_file", ""))
        if not skill_file:
            return ToolResult(success=False, error="技能文件路径不能为空", duration=time.time() - start)
        try:
            path = Path(skill_file)
            if not path.is_file():
                return ToolResult(success=False, error=f"文件不存在: {skill_file}", duration=time.time() - start)
            data = json.loads(path.read_text(encoding="utf-8"))
            from agent.tools.network_enhanced_tools import _get_skill_store
            store = _get_skill_store()
            skill = store.create(data["name"], data.get("description", ""), data.get("template", ""))
            return ToolResult(success=True, output=f"📥 技能已导入: {skill['name']}\n描述: {skill.get('description', '无')}", duration=time.time() - start)
        except Exception as e:
            logger.warning("daily_enhanced_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"导入失败: {e}", duration=time.time() - start)

    elif action == "run":
        name = str(params.get("skill_name", ""))
        prompt = str(params.get("prompt", ""))
        if not name:
            return ToolResult(success=False, error="技能名称不能为空", duration=time.time() - start)
        try:
            from agent.tools.network_enhanced_tools import _get_skill_store
            store = _get_skill_store()
            skill = store.get(name)
            if not skill:
                return ToolResult(success=False, error=f"技能 '{name}' 不存在", duration=time.time() - start)
            store.record_usage(name)
            template = skill.get("template", "")
            if prompt:
                template = template.replace("{{prompt}}", prompt).replace("{{input}}", prompt)
            return ToolResult(success=True, output=f"▶️ 运行技能: {name}\n结果:\n{template}", duration=time.time() - start)
        except Exception as e:
            logger.warning("daily_enhanced_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"运行失败: {e}", duration=time.time() - start)

    elif action == "list":
        shares = list(_SHARE_DIR.glob("*_export.json"))
        if not shares:
            return ToolResult(success=True, output="📋 暂无分享的技能包", duration=time.time() - start)
        items = [f"  • {f.stem.replace('_export', '')}" for f in shares]
        return ToolResult(success=True, output=f"📋 已分享技能包 ({len(shares)} 个):\n" + "\n".join(items), duration=time.time() - start)

    else:
        return ToolResult(success=False, error=f"未知操作: {action}", duration=time.time() - start)

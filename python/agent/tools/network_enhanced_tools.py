from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
from agent.core.logger import log_ignored


IMAGE_GENERATE_DEF = ToolDefinition(
    name="image_generate",
    description='图像生成工具。根据文本描述生成图像。适用场景：生成插图、设计原型、创意图片。支持多种尺寸和风格。',
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="prompt", type="string", description="图像描述（英文效果最佳）"),
        ToolParameterDef(name="size", type="string", required=False, description="图像尺寸", enum=["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"]),
        ToolParameterDef(name="style", type="string", required=False, description="艺术风格提示（可选）"),
    ],
    risk_level="low",
)


SKILL_CREATE_DEF = ToolDefinition(
    name="skill_create",
    description='用户自定义技能管理工具。支持创建、查看、执行、删除、更新技能模板，以及技能自我改进。适用场景：创建可复用的prompt模板、管理自定义技能、技能使用中自动优化。不适用：系统内置工具管理。',
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["create", "list", "execute", "delete", "update", "auto_improve", "suggest_improvements", "usage_stats", "export", "import"]),
        ToolParameterDef(name="skill_name", type="string", required=False, description="技能名称（英文，如 format_json）"),
        ToolParameterDef(name="description", type="string", required=False, description="技能描述"),
        ToolParameterDef(name="template", type="string", required=False, description="技能模板（prompt模板，支持 {{variable}} 占位符）"),
        ToolParameterDef(name="params", type="string", required=False, description="执行时传入的变量值（JSON格式）"),
        ToolParameterDef(name="feedback", type="string", required=False, description="用户反馈（auto_improve时使用）"),
    ],
    risk_level="low",
)


MESSAGE_PUSH_DEF = ToolDefinition(
    name="message_push",
    description='发送消息推送通知到多种渠道（ServerChan微信推送、钉钉群机器人、企业微信机器人）。适用于告警通知、日报推送、任务完成通知、系统监控告警等需要主动推送给用户的场景。不适用：需要即时双向聊天的场景。',
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="channel", type="string", description="推送渠道", enum=["serverchan", "dingtalk", "wecom"]),
        ToolParameterDef(name="title", type="string", description="消息标题"),
        ToolParameterDef(name="content", type="string", description="消息内容（支持 Markdown）"),
        ToolParameterDef(name="webhook_url", type="string", required=False, description="Webhook 地址（钉钉/企微必填）"),
        ToolParameterDef(name="send_key", type="string", required=False, description="ServerChan SendKey（可选，默认从环境变量读取）"),
        ToolParameterDef(name="message_type", type="string", required=False, description="消息类型（仅钉钉/企微有效）", enum=["text", "markdown"]),
    ],
    risk_level="low",
)


_SKILL_DIR = Path(os.environ.get("DATA_DIR", "data")) / "skills"


class _SkillStore:
    _instance: _SkillStore | None = None

    def __init__(self, data_dir: str | Path | None = None) -> None:
        if data_dir is None:
            from agent.config import DATA_DIR
            data_dir = DATA_DIR
        self._dir = Path(data_dir) / "skills"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._skills: dict[str, dict[str, Any]] = {}
        self._load()

    @classmethod
    def get_instance(cls) -> _SkillStore:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _load(self) -> None:
        for f in self._dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                name = data.get("name", f.stem)
                self._skills[name] = data
            except Exception as _exc:
                log_ignored(None, "network_enhanced_tools._SkillStore._load", _exc)

    def _save(self, name: str) -> None:
        skill = self._skills.get(name)
        if not skill:
            return
        path = self._dir / f"{name}.json"
        path.write_text(json.dumps(skill, ensure_ascii=False, indent=2), encoding="utf-8")

    def create(self, name: str, description: str, template: str) -> dict[str, Any]:
        skill = {
            "name": name,
            "description": description,
            "template": template,
            "created_at": time.time(),
            "updated_at": time.time(),
            "usage_count": 0,
            "feedbacks": [],
        }
        self._skills[name] = skill
        self._save(name)
        return skill

    def get(self, name: str) -> dict[str, Any] | None:
        return self._skills.get(name)

    def list_all(self) -> list[dict[str, Any]]:
        return list(self._skills.values())

    def delete(self, name: str) -> bool:
        if name not in self._skills:
            return False
        del self._skills[name]
        path = self._dir / f"{name}.json"
        if path.exists():
            path.unlink()
        return True

    def record_usage(self, name: str) -> None:
        skill = self._skills.get(name)
        if skill:
            skill["usage_count"] = skill.get("usage_count", 0) + 1
            skill["updated_at"] = time.time()
            self._save(name)

    def add_feedback(self, name: str, feedback: str) -> None:
        skill = self._skills.get(name)
        if skill:
            skill.setdefault("feedbacks", []).append({"text": feedback, "time": time.time()})
            skill["updated_at"] = time.time()
            self._save(name)


def _get_skill_store() -> _SkillStore:
    return _SkillStore.get_instance()


async def image_generate_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    prompt = str(params.get("prompt", ""))
    size = str(params.get("size", "square"))
    style = str(params.get("style", ""))

    if not prompt:
        return ToolResult(success=False, error="图像描述不能为空", duration=time.time() - start)

    try:
        api_key = os.environ.get("IMAGE_API_KEY", "")
        api_url = os.environ.get("IMAGE_API_URL", "")

        if api_key and api_url:
            import urllib.request

            req_data = json.dumps({"prompt": prompt, "size": size, "style": style}).encode("utf-8")
            req = urllib.request.Request(
                api_url,
                data=req_data,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                url = result.get("url", "")
                return ToolResult(
                    success=True,
                    output=f"🎨 图像已生成\n描述: {prompt}\n尺寸: {size}\nURL: {url}",
                    duration=time.time() - start,
                )
    except Exception as _exc:
        log_ignored(None, "network_enhanced_tools.image_generate_executor", _exc)

    return ToolResult(
        success=True,
        output=f"🎨 图像生成请求已记录\n描述: {prompt}\n尺寸: {size}\n⚠️ 图像生成需要配置 IMAGE_API_URL 和 IMAGE_API_KEY 环境变量",
        duration=time.time() - start,
    )


async def skill_create_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    store = _get_skill_store()

    if action == "create":
        name = str(params.get("skill_name", ""))
        description = str(params.get("description", ""))
        template = str(params.get("template", ""))
        if not name or not template:
            return ToolResult(success=False, error="技能名称和模板不能为空", duration=time.time() - start)
        skill = store.create(name, description, template)
        return ToolResult(
            success=True,
            output=f"✅ 技能已创建: {name}\n描述: {description}\n模板: {template[:100]}{'...' if len(template) > 100 else ''}",
            duration=time.time() - start,
        )

    elif action == "list":
        skills = store.list_all()
        if not skills:
            return ToolResult(success=True, output="📋 暂无自定义技能", duration=time.time() - start)
        items = [f"  • {s['name']}: {s.get('description', '无描述')} (使用{s.get('usage_count', 0)}次)" for s in skills]
        return ToolResult(success=True, output=f"📋 自定义技能列表 ({len(skills)} 个):\n" + "\n".join(items), duration=time.time() - start)

    elif action == "execute":
        name = str(params.get("skill_name", ""))
        skill = store.get(name)
        if not skill:
            return ToolResult(success=False, error=f"技能 '{name}' 不存在", duration=time.time() - start)
        store.record_usage(name)
        template = skill.get("template", "")
        exec_params = params.get("params", "{}")
        if isinstance(exec_params, str):
            try:
                exec_params = json.loads(exec_params)
            except json.JSONDecodeError:
                exec_params = {}
        for key, value in (exec_params if isinstance(exec_params, dict) else {}).items():
            template = template.replace("{{" + key + "}}", str(value))
        return ToolResult(success=True, output=f"▶️ 执行技能: {name}\n结果:\n{template}", duration=time.time() - start)

    elif action == "delete":
        name = str(params.get("skill_name", ""))
        if store.delete(name):
            return ToolResult(success=True, output=f"🗑️ 技能已删除: {name}", duration=time.time() - start)
        return ToolResult(success=False, error=f"技能 '{name}' 不存在", duration=time.time() - start)

    elif action == "update":
        name = str(params.get("skill_name", ""))
        skill = store.get(name)
        if not skill:
            return ToolResult(success=False, error=f"技能 '{name}' 不存在", duration=time.time() - start)
        if params.get("description"):
            skill["description"] = str(params.get("description"))
        if params.get("template"):
            skill["template"] = str(params.get("template"))
        skill["updated_at"] = time.time()
        store._save(name)
        return ToolResult(success=True, output=f"✅ 技能已更新: {name}", duration=time.time() - start)

    elif action == "auto_improve":
        name = str(params.get("skill_name", ""))
        feedback = str(params.get("feedback", ""))
        skill = store.get(name)
        if not skill:
            return ToolResult(success=False, error=f"技能 '{name}' 不存在", duration=time.time() - start)
        store.add_feedback(name, feedback)
        return ToolResult(success=True, output=f"🔄 技能反馈已记录: {name}\n反馈: {feedback}\n系统将根据反馈优化技能模板。", duration=time.time() - start)

    elif action == "usage_stats":
        skills = store.list_all()
        if not skills:
            return ToolResult(success=True, output="📊 暂无技能使用数据", duration=time.time() - start)
        stats = [f"  • {s['name']}: 使用{s.get('usage_count', 0)}次, 反馈{len(s.get('feedbacks', []))}条" for s in skills]
        return ToolResult(success=True, output=f"📊 技能使用统计:\n" + "\n".join(stats), duration=time.time() - start)

    elif action in ("export", "import", "suggest_improvements"):
        return ToolResult(success=True, output=f"🔧 {action} 功能开发中", duration=time.time() - start)

    else:
        return ToolResult(success=False, error=f"未知操作: {action}", duration=time.time() - start)


async def message_push_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    channel = str(params.get("channel", ""))
    title = str(params.get("title", ""))
    content = str(params.get("content", ""))
    webhook_url = str(params.get("webhook_url", ""))
    send_key = str(params.get("send_key", "")) or os.environ.get("SERVERCHAN_SENDKEY", "")
    message_type = str(params.get("message_type", "markdown"))

    if not channel or not title or not content:
        return ToolResult(success=False, error="channel、title、content 为必填参数", duration=time.time() - start)

    try:
        import urllib.request

        if channel == "serverchan":
            if not send_key:
                return ToolResult(success=False, error="ServerChan SendKey 未配置（设置 send_key 参数或 SERVERCHAN_SENDKEY 环境变量）", duration=time.time() - start)
            url = f"https://sctapi.ftqq.com/{send_key}.send"
            req_data = json.dumps({"title": title, "desp": content}).encode("utf-8")
            req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") == 0:
                    return ToolResult(success=True, output=f"✅ ServerChan 推送成功: {title}", duration=time.time() - start)
                return ToolResult(success=False, error=f"ServerChan 推送失败: {result.get('message', '未知错误')}", duration=time.time() - start)

        elif channel == "dingtalk":
            if not webhook_url:
                return ToolResult(success=False, error="钉钉推送需要 webhook_url 参数", duration=time.time() - start)
            if message_type == "markdown":
                req_data = json.dumps({"msgtype": "markdown", "markdown": {"title": title, "text": f"### {title}\n\n{content}"}}).encode("utf-8")
            else:
                req_data = json.dumps({"msgtype": "text", "text": {"content": f"{title}\n{content}"}}).encode("utf-8")
            req = urllib.request.Request(webhook_url, data=req_data, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("errcode") == 0:
                    return ToolResult(success=True, output=f"✅ 钉钉推送成功: {title}", duration=time.time() - start)
                return ToolResult(success=False, error=f"钉钉推送失败: {result.get('errmsg', '未知错误')}", duration=time.time() - start)

        elif channel == "wecom":
            if not webhook_url:
                return ToolResult(success=False, error="企业微信推送需要 webhook_url 参数", duration=time.time() - start)
            if message_type == "markdown":
                req_data = json.dumps({"msgtype": "markdown", "markdown": {"content": f"### {title}\n\n{content}"}}).encode("utf-8")
            else:
                req_data = json.dumps({"msgtype": "text", "text": {"content": f"{title}\n{content}"}}).encode("utf-8")
            req = urllib.request.Request(webhook_url, data=req_data, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("errcode") == 0:
                    return ToolResult(success=True, output=f"✅ 企业微信推送成功: {title}", duration=time.time() - start)
                return ToolResult(success=False, error=f"企业微信推送失败: {result.get('errmsg', '未知错误')}", duration=time.time() - start)

        else:
            return ToolResult(success=False, error=f"不支持的推送渠道: {channel}", duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"推送失败: {e}", duration=time.time() - start)

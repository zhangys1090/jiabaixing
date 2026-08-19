"""WorkflowEngine 工具注册 — 将工作流操作注册为 Agent 可调用的工具。

注册以下工具：
- workflow_create: 创建工作流定义
- workflow_start: 启动工作流实例
- workflow_list: 列出工作流定义
- workflow_status: 查询工作流实例状态
- workflow_pause: 暂停工作流
- workflow_resume: 恢复工作流
- workflow_cancel: 取消工作流
- workflow_rollback: 回滚工作流到还原点

Usage:
    from agent.workflow.tools import register_workflow_tools
    register_workflow_tools(registry, engine)
"""

from __future__ import annotations

import json
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
    ToolRegistry,
)
from agent.workflow.types import (
    WorkflowStep,
    TriggerConfig,
    StepType,
)

log = StructuredLogger("workflow_tools")


def register_workflow_tools(registry: ToolRegistry, engine: Any) -> None:
    """注册工作流工具到工具注册表。"""

    async def _workflow_create(params: dict[str, Any]) -> ToolResult:
        name = params.get("name", "")
        if not name:
            return ToolResult(success=False, output="", error="工作流名称不能为空")

        steps_data = params.get("steps", [])
        steps = []
        for sd in steps_data:
            steps.append(WorkflowStep(
                id=sd.get("id", ""),
                name=sd.get("name", ""),
                type=sd.get("type", StepType.LLM),
                prompt=sd.get("prompt", ""),
                tool_name=sd.get("tool_name", ""),
                depends_on=sd.get("depends_on", []),
                condition=sd.get("condition"),
                timeout_seconds=sd.get("timeout_seconds", 300.0),
                retry_count=sd.get("retry_count", 0),
                on_failure=sd.get("on_failure", "fail"),
                variables_input=sd.get("variables_input", {}),
                variables_output=sd.get("variables_output", {}),
            ))

        trigger_data = params.get("trigger")
        trigger = None
        if trigger_data:
            trigger = TriggerConfig(
                type=trigger_data.get("type", "manual"),
                cron_expression=trigger_data.get("cron_expression"),
                watch_paths=trigger_data.get("watch_paths"),
                webhook_path=trigger_data.get("webhook_path"),
                message_pattern=trigger_data.get("message_pattern"),
                enabled=trigger_data.get("enabled", True),
            )

        def_id = engine.create_definition(
            name=name,
            steps=steps,
            variables=params.get("variables", {}),
            trigger=trigger,
            description=params.get("description", ""),
            tags=params.get("tags", []),
        )
        return ToolResult(success=True, output=f"工作流已创建: {def_id}", data={"definition_id": def_id})

    async def _workflow_start(params: dict[str, Any]) -> ToolResult:
        definition_id = params.get("definition_id", "")
        if not definition_id:
            return ToolResult(success=False, output="", error="definition_id 不能为空")

        instance = engine.start(
            definition_id=definition_id,
            variables=params.get("variables", {}),
        )
        if not instance:
            return ToolResult(success=False, output="", error="工作流定义不存在")

        return ToolResult(
            success=True,
            output=f"工作流实例已创建: {instance.id}",
            data={"instance_id": instance.id, "status": instance.status},
        )

    async def _workflow_list(params: dict[str, Any]) -> ToolResult:
        definitions = engine.list_definitions(limit=params.get("limit", 20))
        items = []
        for d in definitions:
            items.append({
                "id": d.id,
                "name": d.name,
                "description": d.description,
                "steps_count": len(d.steps),
                "trigger_type": d.trigger.type if d.trigger else "manual",
                "version": d.version,
            })
        return ToolResult(success=True, output=json.dumps(items, ensure_ascii=False, indent=2), data={"definitions": items})

    async def _workflow_status(params: dict[str, Any]) -> ToolResult:
        instance_id = params.get("instance_id", "")
        if not instance_id:
            return ToolResult(success=False, output="", error="instance_id 不能为空")

        instance = engine.get_instance(instance_id)
        if not instance:
            return ToolResult(success=False, output="", error="工作流实例不存在")

        progress = engine.get_progress(instance_id)
        return ToolResult(
            success=True,
            output=json.dumps({
                "id": instance.id,
                "definition_id": instance.definition_id,
                "status": instance.status,
                "progress": progress,
                "error": instance.error,
            }, ensure_ascii=False, indent=2),
            data={"instance": {"id": instance.id, "status": instance.status}, "progress": progress},
        )

    async def _workflow_pause(params: dict[str, Any]) -> ToolResult:
        instance_id = params.get("instance_id", "")
        ok = engine.pause(instance_id)
        return ToolResult(success=ok, output=f"工作流已暂停: {instance_id}" if ok else "", error="" if ok else "暂停失败")

    async def _workflow_resume(params: dict[str, Any]) -> ToolResult:
        instance_id = params.get("instance_id", "")
        ok = await engine.resume(instance_id)
        return ToolResult(success=ok, output=f"工作流已恢复: {instance_id}" if ok else "", error="" if ok else "恢复失败")

    async def _workflow_cancel(params: dict[str, Any]) -> ToolResult:
        instance_id = params.get("instance_id", "")
        ok = engine.cancel(instance_id)
        return ToolResult(success=ok, output=f"工作流已取消: {instance_id}" if ok else "", error="" if ok else "取消失败")

    async def _workflow_rollback(params: dict[str, Any]) -> ToolResult:
        instance_id = params.get("instance_id", "")
        instance = engine.get_instance(instance_id)
        if not instance:
            return ToolResult(success=False, output="", error="工作流实例不存在")
        if not instance.checkpoint_id:
            return ToolResult(success=False, output="", error="工作流实例没有关联的还原点")

        if engine._safety_net:
            result = engine._safety_net.restore_checkpoint(instance.checkpoint_id)
            return ToolResult(
                success=result.get("success", False),
                output=f"工作流已回滚: {instance_id}",
                data=result,
            )
        return ToolResult(success=False, output="", error="SafetyNet 未配置")

    registry.register(ToolDefinition(
        name="workflow_create",
        description="创建工作流定义。工作流是一组按依赖关系编排的步骤（DAG），支持定时/事件触发。",
        short_desc="创建工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation", "productivity"],
        capability_level=2,
        parameters=[
            ToolParameterDef(name="name", type="string", required=True, description="工作流名称"),
            ToolParameterDef(name="description", type="string", required=False, description="工作流描述"),
            ToolParameterDef(
                name="steps",
                type="array",
                required=True,
                description="步骤列表，每个步骤包含 id/name/type/prompt/depends_on",
                items={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "步骤唯一标识"},
                        "name": {"type": "string", "description": "步骤名称"},
                        "type": {"type": "string", "description": "步骤类型", "enum": ["llm", "tool", "condition", "parallel", "subworkflow"]},
                        "prompt": {"type": "string", "description": "LLM 步骤的提示词"},
                        "tool_name": {"type": "string", "description": "工具步骤的工具名"},
                        "depends_on": {"type": "array", "items": {"type": "string"}, "description": "依赖的步骤 ID 列表"},
                        "condition": {"type": "string", "description": "条件步骤的表达式"},
                        "timeout_seconds": {"type": "number", "description": "超时时间（秒）"},
                        "retry_count": {"type": "integer", "description": "重试次数"},
                        "on_failure": {"type": "string", "description": "失败策略", "enum": ["fail", "skip", "retry"]},
                    },
                    "required": ["id", "name", "type"],
                },
            ),
            ToolParameterDef(name="variables", type="object", required=False, description="工作流变量"),
            ToolParameterDef(
                name="trigger",
                type="object",
                required=False,
                description="触发配置（type/cron_expression/watch_paths/webhook_path）",
                properties={
                    "type": {"type": "string", "description": "触发类型", "enum": ["manual", "cron", "watch", "webhook", "message"]},
                    "cron_expression": {"type": "string", "description": "Cron 表达式（type=cron 时必填）"},
                    "watch_paths": {"type": "array", "items": {"type": "string"}, "description": "监控路径列表（type=watch 时必填）"},
                    "webhook_path": {"type": "string", "description": "Webhook 路径（type=webhook 时必填）"},
                    "message_pattern": {"type": "string", "description": "消息匹配模式（type=message 时必填）"},
                    "enabled": {"type": "boolean", "description": "是否启用触发器"},
                },
            ),
            ToolParameterDef(
                name="tags",
                type="array",
                required=False,
                description="标签列表",
                items={"type": "string"},
            ),
        ],
        risk_level="medium",
    ), _workflow_create)

    registry.register(ToolDefinition(
        name="workflow_start",
        description="启动工作流实例。根据工作流定义创建实例并开始执行。",
        short_desc="启动工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation", "productivity"],
        capability_level=1,
        parameters=[
            ToolParameterDef(name="definition_id", type="string", required=True, description="工作流定义 ID"),
            ToolParameterDef(
                name="variables",
                type="object",
                required=False,
                description="运行时变量（覆盖定义变量）",
                properties={
                    "key": {"type": "string", "description": "变量名"},
                    "value": {"type": "string", "description": "变量值"},
                },
            ),
        ],
        risk_level="low",
    ), _workflow_start)

    registry.register(ToolDefinition(
        name="workflow_list",
        description="列出所有工作流定义。",
        short_desc="列出工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation", "productivity"],
        capability_level=0,
        parameters=[
            ToolParameterDef(name="limit", type="integer", required=False, description="返回条数上限"),
        ],
        risk_level="low",
    ), _workflow_list)

    registry.register(ToolDefinition(
        name="workflow_status",
        description="查询工作流实例的执行状态和进度。",
        short_desc="查询工作流状态",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation", "productivity"],
        capability_level=0,
        parameters=[
            ToolParameterDef(name="instance_id", type="string", required=True, description="工作流实例 ID"),
        ],
        risk_level="low",
    ), _workflow_status)

    registry.register(ToolDefinition(
        name="workflow_pause",
        description="暂停正在执行的工作流。",
        short_desc="暂停工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation"],
        capability_level=1,
        parameters=[
            ToolParameterDef(name="instance_id", type="string", required=True, description="工作流实例 ID"),
        ],
        risk_level="low",
    ), _workflow_pause)

    registry.register(ToolDefinition(
        name="workflow_resume",
        description="恢复暂停的工作流。",
        short_desc="恢复工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation"],
        capability_level=1,
        parameters=[
            ToolParameterDef(name="instance_id", type="string", required=True, description="工作流实例 ID"),
        ],
        risk_level="low",
    ), _workflow_resume)

    registry.register(ToolDefinition(
        name="workflow_cancel",
        description="取消工作流执行。",
        short_desc="取消工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation"],
        scenes=["automation"],
        capability_level=1,
        parameters=[
            ToolParameterDef(name="instance_id", type="string", required=True, description="工作流实例 ID"),
        ],
        risk_level="medium",
    ), _workflow_cancel)

    registry.register(ToolDefinition(
        name="workflow_rollback",
        description="回滚工作流到执行前的还原点。需要 SafetyNet 支持。",
        short_desc="回滚工作流",
        category=ToolCategory.AUTOMATION,
        tags=["workflow", "automation", "safety"],
        scenes=["automation", "safety"],
        capability_level=2,
        parameters=[
            ToolParameterDef(name="instance_id", type="string", required=True, description="工作流实例 ID"),
        ],
        risk_level="high",
    ), _workflow_rollback)

    log.info("工作流工具已注册", count=8)

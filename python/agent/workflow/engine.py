"""WorkflowEngine — 工作流引擎主入口。

整合所有工作流组件，提供统一的工作流管理 API：
- 创建/删除/查询工作流定义
- 启动/暂停/恢复/取消工作流实例
- 步骤执行和状态管理
- 事件触发和通知
- 崩溃恢复

与 SafetyNet 的集成：
- 工作流启动时自动创建还原点
- 工作流失败时可选自动回滚

Usage:
    from agent.workflow import WorkflowEngine

    engine = WorkflowEngine()
    def_id = engine.create_definition(
        name="每日代码总结",
        steps=[...],
        trigger=TriggerConfig(type="cron", cron_expression="0 9 * * *"),
    )
    instance = engine.start(def_id)
    await engine.run(instance.id)
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger
from agent.workflow.types import (
    WorkflowDefinition,
    WorkflowStep,
    WorkflowInstance,
    StepState,
    StepStatus,
    WorkflowStatus,
    TriggerConfig,
    StepType,
    new_definition,
    new_instance,
)
from agent.workflow.checkpoint_store import WorkflowStore
from agent.workflow.instance import WorkflowStateMachine
from agent.workflow.step_executor import StepExecutor
from agent.workflow.event_bridge import EventBridge
from agent.workflow.notification import NotificationManager
from agent.workflow.distributed_lock import LockProvider, LockHandle, create_lock_provider

log = StructuredLogger("workflow_engine")


class WorkflowEngine:
    """工作流引擎 — 统一入口。

    整合 WorkflowStore、WorkflowStateMachine、StepExecutor、
    EventBridge、NotificationManager 五大组件。

    支持：
    - 后台事件轮询：自动检查 cron/file/webhook 触发器
    - 崩溃恢复：启动时自动恢复 RUNNING 状态的实例
    - 暂停/恢复：执行中检查暂停信号，恢复后从断点继续

    Usage:
        engine = WorkflowEngine()
        def_id = engine.create_definition(name="我的工作流", steps=[...])
        instance = engine.start(def_id)
        await engine.run(instance.id)
    """

    def __init__(
        self,
        store: WorkflowStore | None = None,
        executor: StepExecutor | None = None,
        event_bridge: EventBridge | None = None,
        notification: NotificationManager | None = None,
        safety_net: Any | None = None,
        poll_interval: float = 30.0,
        lock_provider: LockProvider | None = None,
    ) -> None:
        self._store = store or WorkflowStore()
        self._executor = executor or StepExecutor()
        self._event_bridge = event_bridge or EventBridge()
        self._notification = notification or NotificationManager()
        self._safety_net = safety_net
        self._poll_interval = poll_interval
        self._lock = lock_provider or create_lock_provider()
        self._running_instances: dict[str, asyncio.Task] = {}
        self._pause_signals: set[str] = set()
        self._cancel_signals: set[str] = set()
        self._poll_task: asyncio.Task | None = None
        self._started = False
        self._active_locks: dict[str, LockHandle] = {}

    def create_definition(
        self,
        name: str,
        steps: list[WorkflowStep] | None = None,
        variables: dict[str, Any] | None = None,
        trigger: TriggerConfig | None = None,
        description: str = "",
        tags: list[str] | None = None,
    ) -> str:
        """创建工作流定义。

        Returns:
            str: 工作流定义 ID。
        """
        definition = new_definition(
            name=name,
            steps=steps or [],
            trigger=trigger,
            description=description,
            tags=tags,
        )
        if variables:
            definition.variables = variables
        self._store.save_definition(definition)

        if trigger and trigger.enabled:
            self._event_bridge.register_trigger(definition.id, trigger)

        log.info("创建工作流定义", id=definition.id, name=name, steps=len(steps or []))
        return definition.id

    def update_definition(
        self,
        definition_id: str,
        **kwargs: Any,
    ) -> bool:
        definition = self._store.load_definition(definition_id)
        if not definition:
            return False
        for key, value in kwargs.items():
            if hasattr(definition, key):
                setattr(definition, key, value)
        definition.updated_at = time.time()
        definition.version += 1
        self._store.save_definition(definition)

        if "trigger" in kwargs and kwargs["trigger"]:
            self._event_bridge.unregister_trigger(definition_id)
            self._event_bridge.register_trigger(definition_id, kwargs["trigger"])

        return True

    def delete_definition(self, definition_id: str) -> bool:
        definition = self._store.load_definition(definition_id)
        if not definition:
            return False
        self._store.delete_definition(definition_id)
        self._event_bridge.unregister_trigger(definition_id)
        log.info("删除工作流定义", id=definition_id)
        return True

    def get_definition(self, definition_id: str) -> WorkflowDefinition | None:
        return self._store.load_definition(definition_id)

    def list_definitions(self, limit: int = 50) -> list[WorkflowDefinition]:
        return self._store.list_definitions(limit)

    def list_versions(self, definition_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """P2: 列出工作流定义的版本历史。

        Returns:
            版本列表，每项包含 version 和 created_at。
        """
        return self._store.list_versions(definition_id, limit)

    def get_version(self, definition_id: str, version: int) -> WorkflowDefinition | None:
        """P2: 获取工作流定义的指定版本。"""
        return self._store.load_version(definition_id, version)

    def rollback_version(self, definition_id: str, version: int) -> bool:
        """P2: 回滚工作流定义到指定版本。

        将指定版本的内容恢复为当前版本，版本号自动递增。
        """
        restored = self._store.load_version(definition_id, version)
        if not restored:
            log.warning("版本回滚失败：版本不存在", definition_id=definition_id, version=version)
            return False
        current = self._store.load_definition(definition_id)
        if not current:
            return False
        restored.version = current.version + 1
        restored.updated_at = time.time()
        self._store.save_definition(restored)
        log.info("版本回滚成功", definition_id=definition_id, from_version=version, to_version=restored.version)
        return True

    async def start(
        self,
        definition_id: str,
        variables: dict[str, Any] | None = None,
        parent_instance_id: str = "",
    ) -> WorkflowInstance | None:
        """启动工作流实例。

        Args:
            definition_id: 工作流定义 ID。
            variables: 运行时变量（覆盖定义变量）。
            parent_instance_id: 父实例 ID（子工作流场景）。

        Returns:
            WorkflowInstance | None: 工作流实例。
        """
        definition = self._store.load_definition(definition_id)
        if not definition:
            log.warning("工作流定义不存在", id=definition_id)
            return None

        lock_resource = f"workflow:start:{definition_id}"
        lock_handle = await self._lock.acquire(lock_resource, ttl=300.0)
        if lock_handle is None:
            log.warning("工作流启动被分布式锁阻止", definition_id=definition_id)
            return None

        instance = new_instance(definition_id, parent_instance_id=parent_instance_id)
        instance.variables = {**definition.variables, **(variables or {})}

        if self._safety_net:
            try:
                cp = self._safety_net.create_checkpoint(
                    label=f"workflow-{instance.id}",
                    trigger="pre-workflow",
                )
                instance.checkpoint_id = cp.id
            except Exception as e:
                log.warning("SafetyNet 还原点创建失败", error=str(e))

        self._store.save_instance(instance)
        self._active_locks[instance.id] = lock_handle
        log.info("启动工作流实例", id=instance.id, definition=definition_id)
        return instance

    async def run(self, instance_id: str) -> WorkflowInstance | None:
        """运行工作流实例至完成。

        按步骤依赖关系依次执行，支持：
        - DAG 调度
        - 条件跳过
        - 重试
        - 失败策略
        - 暂停/取消信号检查

        Args:
            instance_id: 工作流实例 ID。

        Returns:
            WorkflowInstance | None: 更新后的实例。
        """
        instance = self._store.load_instance(instance_id)
        if not instance:
            return None

        definition = self._store.load_definition(instance.definition_id)
        if not definition:
            return None

        sm = WorkflowStateMachine(instance, definition)

        if instance.status == WorkflowStatus.PAUSED:
            if not sm.transition(WorkflowStatus.RUNNING):
                return instance
            self._store.update_instance_status(instance_id, WorkflowStatus.RUNNING)
            await self._notification.notify("workflow-resumed", {
                "instance_id": instance_id,
                "definition_id": instance.definition_id,
            })
        elif instance.status == WorkflowStatus.PENDING:
            if not sm.transition(WorkflowStatus.RUNNING):
                return instance
            self._store.update_instance_status(instance_id, WorkflowStatus.RUNNING)
            await self._notification.notify("workflow-started", {
                "instance_id": instance_id,
                "definition_id": instance.definition_id,
                "name": definition.name,
            })
        elif instance.status != WorkflowStatus.RUNNING:
            log.warning("工作流不在可运行状态", id=instance_id, status=instance.status)
            return instance

        max_iterations = len(definition.steps) * 3
        iteration = 0

        while iteration < max_iterations:
            if instance_id in self._cancel_signals:
                self._cancel_signals.discard(instance_id)
                sm.transition(WorkflowStatus.CANCELLED)
                self._store.update_instance_status(instance_id, WorkflowStatus.CANCELLED)
                await self._notification.notify("workflow-cancelled", {
                    "instance_id": instance_id,
                })
                break

            if instance_id in self._pause_signals:
                self._pause_signals.discard(instance_id)
                sm.transition(WorkflowStatus.PAUSED)
                self._store.update_instance_status(instance_id, WorkflowStatus.PAUSED)
                await self._notification.notify("workflow-paused", {
                    "instance_id": instance_id,
                })
                break

            iteration += 1
            ready_steps = sm.get_ready_steps()

            if not ready_steps:
                if sm.is_all_done():
                    break
                if sm.has_failed_steps():
                    sm.transition(WorkflowStatus.FAILED)
                    self._store.update_instance_status(
                        instance_id, WorkflowStatus.FAILED,
                        error=f"步骤失败: {sm.get_failed_steps()}",
                    )
                    await self._notification.notify("workflow-failed", {
                        "instance_id": instance_id,
                        "failed_steps": sm.get_failed_steps(),
                    })
                    if self._safety_net and instance.checkpoint_id:
                        try:
                            self._safety_net.restore_checkpoint(instance.checkpoint_id)
                            log.info("工作流失败后自动回滚", instance=instance_id)
                        except Exception as e:
                            log.warning("工作流失败后回滚失败", error=str(e))
                    break
                break

            for step in ready_steps:
                if instance_id in self._pause_signals or instance_id in self._cancel_signals:
                    break

                lock_handle = self._active_locks.get(instance_id)
                if lock_handle and lock_handle.is_expired:
                    log.warning("工作流锁已过期，尝试续期", instance_id=instance_id)
                    try:
                        await self._lock.extend(lock_handle, ttl=300.0)
                    except Exception as _exc:
                        log.warning("工作流锁续期失败", instance_id=instance_id, error=str(_exc))

                sm.start_step(step.id)
                self._store.update_step_state(instance_id, step.id, StepStatus.RUNNING)
                await self._notification.notify("step-started", {
                    "instance_id": instance_id,
                    "step_id": step.id,
                    "step_name": step.name,
                })

                result = await self._executor.execute(step, instance.variables)

                if result.get("success", True):
                    sm.complete_step(step.id, result)
                    self._store.update_step_state(
                        instance_id, step.id, StepStatus.DONE,
                        result=result, duration_ms=result.get("duration_ms", 0),
                    )
                    await self._notification.notify("step-done", {
                        "instance_id": instance_id,
                        "step_id": step.id,
                        "step_name": step.name,
                    })
                else:
                    step_obj = next((s for s in definition.steps if s.id == step.id), None)
                    ss = instance.step_states.get(step.id)
                    retry_available = step_obj and ss and ss.attempts < step_obj.retry_count + 1

                    if retry_available and step_obj.on_failure == "retry":
                        log.info("步骤重试", step=step.id, attempt=ss.attempts)
                        ss.status = StepStatus.PENDING
                        self._store.update_step_state(instance_id, step.id, StepStatus.PENDING)
                    elif step_obj and step_obj.on_failure == "skip":
                        sm.fail_step(step.id, result.get("error", ""))
                        ss_skip = instance.step_states.get(step.id)
                        if ss_skip:
                            ss_skip.status = StepStatus.SKIPPED
                        self._store.update_step_state(instance_id, step.id, StepStatus.SKIPPED, error=result.get("error", ""))
                    else:
                        sm.fail_step(step.id, result.get("error", ""))
                        self._store.update_step_state(
                            instance_id, step.id, StepStatus.FAILED,
                            error=result.get("error", ""),
                        )
                        await self._notification.notify("step-failed", {
                            "instance_id": instance_id,
                            "step_id": step.id,
                            "step_name": step.name,
                            "error": result.get("error", ""),
                        })

                self._store.save_instance(instance)

        if sm.is_all_done() and instance.status == WorkflowStatus.RUNNING:
            sm.transition(WorkflowStatus.DONE)
            self._store.update_instance_status(instance_id, WorkflowStatus.DONE)
            progress = sm.get_progress()
            await self._notification.notify("workflow-done", {
                "instance_id": instance_id,
                "definition_id": instance.definition_id,
                "progress": progress,
            })

        self._running_instances.pop(instance_id, None)

        lock_handle = self._active_locks.pop(instance_id, None)
        if lock_handle:
            try:
                await self._lock.release(lock_handle)
            except Exception as _exc:
                log.warning("分布式锁释放失败", instance_id=instance_id, error=str(_exc))

        return instance

    def pause(self, instance_id: str) -> bool:
        """暂停工作流实例。

        设置暂停信号，run() 循环会在下一个迭代检查点暂停。
        """
        instance = self._store.load_instance(instance_id)
        if not instance:
            return False
        if instance.status not in (WorkflowStatus.RUNNING,):
            return False
        self._pause_signals.add(instance_id)
        log.info("暂停工作流信号已发送", id=instance_id)
        return True

    async def resume(self, instance_id: str) -> bool:
        """恢复暂停的工作流实例。

        更新状态并重新启动 run() 循环从断点继续。
        """
        instance = self._store.load_instance(instance_id)
        if not instance:
            return False
        if instance.status != WorkflowStatus.PAUSED:
            return False
        task = asyncio.create_task(self.run(instance_id))
        self._running_instances[instance_id] = task
        log.info("恢复工作流", id=instance_id)
        return True

    def cancel(self, instance_id: str) -> bool:
        """取消工作流实例。

        设置取消信号，run() 循环会在下一个迭代检查点取消。
        """
        instance = self._store.load_instance(instance_id)
        if not instance:
            return False
        if instance.status not in (WorkflowStatus.RUNNING, WorkflowStatus.PAUSED):
            return False
        self._cancel_signals.add(instance_id)
        if instance.status == WorkflowStatus.PAUSED:
            self._store.update_instance_status(instance_id, WorkflowStatus.CANCELLED)
        log.info("取消工作流信号已发送", id=instance_id)
        return True

    def get_instance(self, instance_id: str) -> WorkflowInstance | None:
        return self._store.load_instance(instance_id)

    def list_instances(
        self,
        definition_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[WorkflowInstance]:
        return self._store.list_instances(definition_id, status, limit)

    def get_progress(self, instance_id: str) -> dict[str, Any] | None:
        instance = self._store.load_instance(instance_id)
        if not instance:
            return None
        definition = self._store.load_definition(instance.definition_id)
        if not definition:
            return None
        sm = WorkflowStateMachine(instance, definition)
        return sm.get_progress()

    async def check_triggers(self) -> list[str]:
        """检查所有触发器，启动匹配的工作流实例。"""
        events = self._event_bridge.check()
        started = []
        for event in events:
            instance = self.start(
                event.definition_id,
                variables=event.payload,
            )
            if instance:
                started.append(instance.id)
                task = asyncio.create_task(self.run(instance.id))
                self._running_instances[instance.id] = task
        return started

    async def start_event_loop(self) -> None:
        """启动后台事件轮询循环。

        定期检查 cron/file 触发器，并处理 webhook/message 触发。
        同时恢复上次崩溃时 RUNNING 状态的实例。
        """
        if self._started:
            return
        self._started = True
        await self._event_bridge.start()
        await self._recover_crashed_instances()
        self._poll_task = asyncio.create_task(self._poll_loop())
        log.info("工作流事件循环启动", poll_interval=self._poll_interval)

    async def stop_event_loop(self) -> None:
        """停止后台事件轮询循环。"""
        self._started = False
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError as _exc:
                log_ignored(log, "workflow.engine._run_event_loop", _exc)
            self._poll_task = None
        await self._event_bridge.stop()
        log.info("工作流事件循环停止")

    async def _poll_loop(self) -> None:
        """后台轮询循环 — 定期检查触发器。"""
        while self._started:
            try:
                await self.check_triggers()
            except Exception as e:
                log.error("触发器检查异常", error=str(e))
            try:
                await asyncio.sleep(self._poll_interval)
            except asyncio.CancelledError:
                break

    async def _recover_crashed_instances(self) -> None:
        """崩溃恢复 — 将 RUNNING 状态的实例恢复为 PAUSED。

        进程重启后，之前 RUNNING 的实例无法继续执行，
        将其标记为 PAUSED 等待手动恢复。
        """
        running = self._store.list_instances(status=WorkflowStatus.RUNNING)
        if not running:
            return
        for instance in running:
            log.info("崩溃恢复：将 RUNNING 实例标记为 PAUSED", id=instance.id)
            self._store.update_instance_status(instance.id, WorkflowStatus.PAUSED)
            await self._notification.notify("workflow-crash-recovered", {
                "instance_id": instance.id,
                "definition_id": instance.definition_id,
                "previous_status": "running",
                "current_status": "paused",
            })
        log.info("崩溃恢复完成", recovered=len(running))

    def handle_webhook(self, path: str, payload: dict[str, Any] | None = None) -> str | None:
        """处理 webhook 请求，返回匹配的工作流定义 ID。"""
        event = self._event_bridge.trigger_webhook(path, payload)
        if event:
            return event.definition_id
        return None

    def handle_message(self, message: str) -> str | None:
        """处理消息触发，返回匹配的工作流定义 ID。"""
        event = self._event_bridge.trigger_message(message)
        if event:
            return event.definition_id
        return None

    def configure_executor(
        self,
        llm_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
        tool_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
        subflow_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
        human_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self._executor = StepExecutor(
            llm_runner=llm_runner,
            tool_runner=tool_runner,
            subflow_runner=subflow_runner,
            human_runner=human_runner,
        )

    @property
    def store(self) -> WorkflowStore:
        return self._store

    @property
    def event_bridge(self) -> EventBridge:
        return self._event_bridge

    @property
    def notification(self) -> NotificationManager:
        return self._notification

    @property
    def is_running(self) -> bool:
        return self._started

    @property
    def active_instances(self) -> list[str]:
        return list(self._running_instances.keys())

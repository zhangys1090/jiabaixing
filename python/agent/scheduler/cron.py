from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Awaitable

from agent.config import DATA_DIR
from agent.core.logger import StructuredLogger
from agent.infrastructure.message_queue import (
    Message,
    MessagePriority,
    create_message_queue,
)
from agent.infrastructure.distributed_lock import create_lock
from agent.infrastructure.sharding import LeaderElection, get_shard_count

log = StructuredLogger("cron")


@dataclass
class CronJob:
    """定时任务定义。

    Attributes:
        id: 任务唯一标识。
        name: 任务名称。
        schedule: 调度规则（every:30m / hourly / daily / cron表达式）。
        command: 执行命令。
        args: 命令参数。
        timeout: 超时时间（毫秒）。
        max_retries: 最大重试次数。
        enabled: 是否启用。
        last_run: 上次执行时间戳。
        next_run: 下次执行时间戳。
        status: 当前状态（idle/running/error）。
    """

    id: str
    name: str
    schedule: str
    command: str
    args: list[str] = field(default_factory=list)
    timeout: int = 60_000
    max_retries: int = 0
    enabled: bool = True
    last_run: float | None = None
    next_run: float | None = None
    status: str = "idle"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "schedule": self.schedule,
            "command": self.command,
            "args": self.args,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "enabled": self.enabled,
            "last_run": self.last_run,
            "next_run": self.next_run,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CronJob:
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            schedule=data.get("schedule", ""),
            command=data.get("command", ""),
            args=data.get("args", []),
            timeout=data.get("timeout", 60_000),
            max_retries=data.get("max_retries", 0),
            enabled=data.get("enabled", True),
            last_run=data.get("last_run"),
            next_run=data.get("next_run"),
            status=data.get("status", "idle"),
        )


@dataclass
class CronJobResult:
    """定时任务执行结果。

    Attributes:
        job_id: 任务ID。
        job_name: 任务名称。
        start_time: 开始时间戳。
        end_time: 结束时间戳。
        exit_code: 退出码。
        stdout: 标准输出。
        stderr: 标准错误。
        success: 是否成功。
    """

    job_id: str
    job_name: str
    start_time: float
    end_time: float
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    success: bool = False


class CronJobScheduler:
    """定时任务调度器——管理定时任务的注册、调度和执行。

    支持every:N{s|m|h|d}格式的间隔调度规则，内置危险命令检测。
    单例模式，自动持久化任务配置。

    Usage:
        scheduler = CronJobScheduler.get_instance()
        job = CronJob(id="1", name="backup", schedule="every:1h", command="echo backup")
        scheduler.add_job(job)
        await scheduler.start()
    """

_DANGEROUS_PATTERNS = [
    r"rm\s+-rf\s+/",
    r"del\s+/[sS]",
    r"format\s+[cC]:",
    r">\s*/dev/sd",
    r"shutdown",
    r"reboot",
    r"mkfs",
    r"dd\s+if=",
]


def _scan_injection(command: str) -> tuple[bool, str]:
    for pattern in _DANGEROUS_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return True, f"危险命令匹配: {pattern}"
    return False, ""


def _parse_cron_field(field: str, min_val: int, max_val: int) -> set[int]:
    """解析单个 cron 字段为匹配的整数集合。支持 `*`, `a-b`, `a/b`, `a,b` 组合。"""
    result: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            base, step_str = part.split("/", 1)
            step = int(step_str)
        else:
            base = part
        if base == "*":
            lo, hi = min_val, max_val
        elif "-" in base:
            lo_s, hi_s = base.split("-", 1)
            lo, hi = int(lo_s), int(hi_s)
        else:
            lo = hi = int(base)
        for v in range(lo, hi + 1, step):
            if min_val <= v <= max_val:
                result.add(v)
    return result


def _next_cron_run(expr: str) -> int | None:
    """解析标准 5 段 cron 表达式（MIN HOUR DOM MONTH DOW），返回距下次触发秒数。

    搜索范围上限 60 天，避免极端表达式无限循环。cron DOW 以 0=周日 计，
    兼容 7=周日 写法。失败时返回 None（由调用方回退为固定间隔）。
    """
    try:
        parts = expr.split()
        if len(parts) != 5:
            return None
        minutes = _parse_cron_field(parts[0], 0, 59)
        hours = _parse_cron_field(parts[1], 0, 23)
        dom = _parse_cron_field(parts[2], 1, 31)
        months = _parse_cron_field(parts[3], 1, 12)
        dow = _parse_cron_field(parts[4], 0, 6)
        if 7 in dow:
            dow.discard(7)
            dow.add(0)
    except (ValueError, IndexError):
        return None
    now = time.time()
    t = ((int(now) // 60) + 1) * 60  # 对齐到下一整分钟
    for _ in range(60 * 24 * 60):
        dt = time.localtime(t)
        if dt.tm_mon not in months or dt.tm_mday not in dom:
            t += 60
            continue
        cron_dow = (dt.tm_wday + 1) % 7  # tm_wday: 0=周一 → 转换 cron 0=周日
        if cron_dow not in dow or dt.tm_hour not in hours or dt.tm_min not in minutes:
            t += 60
            continue
        return int(t - now)
    return None


def _parse_interval(schedule: str) -> int | None:
    """解析调度规则为「距下次执行的秒数」间隔。

    支持: every:N{s|m|h|d}（原有）, hourly/daily/weekly/monthly（新增）,
    cron:<5段表达式>（新增）。无法识别的规则返回 None，由调用方告警而非静默永不执行。
    """
    schedule = (schedule or "").strip().lower()
    if not schedule:
        return None
    if schedule == "hourly":
        return 3600
    if schedule == "daily":
        return 86400
    if schedule == "weekly":
        return 86400 * 7
    if schedule == "monthly":
        return 86400 * 30
    m = re.match(r"every:(\d+)(s|m|h|d)", schedule)
    if m:
        val = int(m.group(1))
        unit = m.group(2)
        multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400}
        return val * multipliers.get(unit, 60)
    if schedule.startswith("cron:"):
        return _next_cron_run(schedule[len("cron:"):].strip())
    return None


class CronJobScheduler:
    _instance: CronJobScheduler | None = None

    def __init__(self, data_dir: Path | None = None) -> None:
        self._jobs: list[CronJob] = []
        self._data_dir = data_dir or DATA_DIR / "cron"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._running = False
        self._task: asyncio.Task | None = None
        self._tick_interval = 60.0
        self._handlers: dict[str, Callable[..., Awaitable[Any]]] = {}
        self._mq: Any = None
        # 水平扩展（审计残留）：仅 leader 副本运行调度循环并写入 jobs.json，
        # 其余副本作为热备 + MQ 消费者执行派发任务；写锁防止同进程并发写损坏。
        self._leader: LeaderElection | None = None
        self._jobs_io_lock = threading.Lock()
        self._load()

    @classmethod
    def get_instance(cls) -> CronJobScheduler:
        if cls._instance is None:
            cls._instance = CronJobScheduler()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        if cls._instance:
            cls._instance.stop()
        cls._instance = None

    def register(self, job: CronJob) -> None:
        interval = _parse_interval(job.schedule)
        if interval is None:
            # 不支持的调度规则：明确告警，避免 next_run=None 导致任务静默永不执行（审计 S-01）
            import logging
            logging.getLogger(__name__).warning(
                "不支持的调度规则，任务将不会自动执行", schedule=job.schedule
            )
        else:
            job.next_run = time.time() + interval
        self._jobs.append(job)
        self._save()

    def unregister(self, job_id: str) -> None:
        self._jobs = [j for j in self._jobs if j.id != job_id]
        self._save()

    def get_jobs(self) -> list[CronJob]:
        return list(self._jobs)

    def get_job(self, job_id: str) -> CronJob | None:
        for j in self._jobs:
            if j.id == job_id:
                return j
        return None

    def register_handler(self, command: str, handler: Callable[..., Awaitable[Any]]) -> None:
        self._handlers[command] = handler

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        # 所有副本都订阅 cron.dispatch，以便消费并执行派发来的任务
        await self._init_mq()
        # 领导者选举：仅 leader 副本跑调度循环（单副本下恒为 leader）
        self._leader = LeaderElection("cron")
        await self._leader.start()
        if self._leader.is_leader:
            self._task = asyncio.create_task(self._tick_loop())
        else:
            log.info("非 leader 副本，仅作为任务执行者待命", shard_count=get_shard_count())

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None
        # 仅在运行中的事件循环内调度异步清理，避免无循环场景（如同步 teardown）崩溃
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._leader = None
            self._mq = None
            return
        if self._leader is not None:
            loop.create_task(self._leader.stop())
            self._leader = None
        if self._mq is not None:
            loop.create_task(self._mq.stop())
            self._mq = None

    async def _tick_loop(self) -> None:
        # 仅 leader 执行；若领导权在运行中转移，立即停止以避免双副本调度
        while self._running and (self._leader is not None and self._leader.is_leader):
            try:
                await self._tick()
            except Exception:
                pass
            await asyncio.sleep(self._tick_interval)

    async def _tick(self) -> None:
        now = time.time()
        for job in self._jobs:
            if not job.enabled or job.status == "running":
                continue
            if job.next_run and job.next_run <= now:
                # P0：调度锁防 2 副本重复触发；经 MQ 解耦执行
                asyncio.create_task(self._safe_dispatch(job))

    async def _safe_dispatch(self, job: CronJob) -> None:
        """加调度锁后派发：仅持有者触发，另一副本抢不到即跳过。"""
        lock = create_lock(
            f"cron:sched:{job.id}",
            ttl_ms=job.timeout or 60_000,
            max_retries=0,
            retry_interval_ms=100,
        )
        if await lock.acquire():
            try:
                await self.dispatch(job)
            finally:
                await lock.release()

    async def _init_mq(self) -> None:
        """惰性初始化调度用消息队列（P0-2：执行主干）。"""
        if self._mq is None:
            self._mq = create_message_queue()
            await self._mq.start()
            await self._mq.subscribe("cron.dispatch", self._on_dispatch)

    async def dispatch(self, job: CronJob) -> None:
        """派发任务：经 MQ 解耦到消费者（可跨副本）。

        无 MQ 时退化为本地直接执行，保持单实例行为兼容。
        """
        if self._mq is None:
            await self._init_mq()
        await self._mq.publish(
            "cron.dispatch",
            job.id,
            priority=MessagePriority.HIGH,
            max_retries=job.max_retries or 3,
        )

    async def _on_dispatch(self, msg: Message) -> None:
        """MQ 消费者：真正执行任务；执行锁防并发重入（含跨副本）。"""
        job = self.get_job(msg.payload)
        if not job:
            return
        async with create_lock(
            f"cron:exec:{job.id}",
            ttl_ms=job.timeout or 60_000,
        ):
            await self._run_job(job)

    async def _run_job(self, job: CronJob) -> CronJobResult:
        blocked, reason = _scan_injection(job.command)
        # 命令注入扫描须覆盖 args（审计 S-03：原仅扫描 command，args 可注入任意命令）
        if not blocked and job.args:
            blocked, reason = _scan_injection(" ".join(job.args))
        if blocked:
            return CronJobResult(
                job_id=job.id,
                job_name=job.name,
                start_time=time.time(),
                end_time=time.time(),
                exit_code=-1,
                stderr=f"Injection blocked: {reason}",
            )

        job.status = "running"
        self._save()
        start = time.time()

        try:
            handler = self._handlers.get(job.command)
            if handler:
                result = await handler(*job.args)
                stdout = str(result) if result else ""
                exit_code = 0
            else:
                proc = await asyncio.create_subprocess_shell(
                    job.command + " " + " ".join(job.args),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        proc.communicate(), timeout=job.timeout / 1000
                    )
                    stdout = stdout_bytes.decode(errors="replace")
                    stderr = stderr_bytes.decode(errors="replace")
                    exit_code = proc.returncode or 0
                except asyncio.TimeoutError:
                    proc.kill()
                    stdout = ""
                    stderr = "Timeout"
                    exit_code = -1

            end = time.time()
            success = exit_code == 0

            job.last_run = start
            interval = _parse_interval(job.schedule) or 3600
            job.next_run = end + (interval if success else 300)
            job.status = "idle" if success else "failed"
            self._save()

            return CronJobResult(
                job_id=job.id,
                job_name=job.name,
                start_time=start,
                end_time=end,
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                success=success,
            )
        except Exception as e:
            job.status = "failed"
            self._save()
            return CronJobResult(
                job_id=job.id,
                job_name=job.name,
                start_time=start,
                end_time=time.time(),
                exit_code=1,
                stderr=str(e),
            )

    def _load(self) -> None:
        jobs_file = self._data_dir / "jobs.json"
        if jobs_file.exists():
            try:
                data = json.loads(jobs_file.read_text(encoding="utf-8"))
                self._jobs = [CronJob.from_dict(d) for d in data]
                # 崩溃恢复（审计 S-02）：运行中崩溃的任务持久化为 "running"，
                # 重启后会被 _tick 永久跳过；重置为 idle 以便重新调度。
                now = time.time()
                for job in self._jobs:
                    if job.status == "running":
                        job.status = "idle"
                        if job.next_run is None and job.enabled:
                            interval = _parse_interval(job.schedule)
                            if interval:
                                job.next_run = now + interval
                self._save()
            except (json.JSONDecodeError, OSError):
                pass

    def _save(self) -> None:
        jobs_file = self._data_dir / "jobs.json"
        data = [j.to_dict() for j in self._jobs]
        # 写锁：leader 副本独占写入；同进程并发写（如 _run_job 与 register）不互相撕裂。
        with self._jobs_io_lock:
            # Windows 兼容写：直接覆写，避免 tmp.replace 跨文件系统权限问题
            jobs_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@dataclass
class BlueprintParam:
    """蓝图参数定义。

    Attributes:
        name: 参数名称。
        type: 参数类型。
        required: 是否必填。
        default: 默认值。
        description: 参数描述。
    """

    name: str
    type: str = "string"
    required: bool = True
    default: str = ""
    description: str = ""


@dataclass
class BlueprintEntry:
    """蓝图条目——可复用的定时任务模板。

    Attributes:
        id: 蓝图唯一标识。
        name: 蓝图名称。
        description: 蓝图描述。
        category: 分类。
        schedule: 默认调度规则。
        command: 执行命令模板（支持 {{param}} 占位符）。
        args: 默认参数列表。
        params: 可配置参数定义。
        tags: 标签列表。
        author: 作者。
        version: 版本号。
    """

    id: str
    name: str
    description: str = ""
    category: str = "general"
    schedule: str = "every:1h"
    command: str = ""
    args: list[str] = field(default_factory=list)
    params: list[BlueprintParam] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    author: str = "system"
    version: str = "1.0.0"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "schedule": self.schedule,
            "command": self.command,
            "args": self.args,
            "params": [
                {"name": p.name, "type": p.type, "required": p.required, "default": p.default, "description": p.description}
                for p in self.params
            ],
            "tags": self.tags,
            "author": self.author,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BlueprintEntry:
        params_data = data.get("params", [])
        params = [
            BlueprintParam(
                name=p.get("name", ""),
                type=p.get("type", "string"),
                required=p.get("required", True),
                default=p.get("default", ""),
                description=p.get("description", ""),
            )
            for p in params_data
        ]
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            description=data.get("description", ""),
            category=data.get("category", "general"),
            schedule=data.get("schedule", "every:1h"),
            command=data.get("command", ""),
            args=data.get("args", []),
            params=params,
            tags=data.get("tags", []),
            author=data.get("author", "system"),
            version=data.get("version", "1.0.0"),
        )


class BlueprintCatalog:
    """蓝图目录——管理可复用的定时任务模板。

    支持蓝图的注册、搜索、实例化为 CronJob。
    蓝图存储在 DATA_DIR/cron/blueprints/ 下。

    Usage:
        catalog = BlueprintCatalog.get_instance()
        catalog.register(BlueprintEntry(id="backup", name="自动备份", ...))
        job = catalog.instantiate("backup", {"path": "/data"})
    """

    _instance: BlueprintCatalog | None = None

    def __init__(self) -> None:
        self._blueprint_dir = DATA_DIR / "cron" / "blueprints"
        self._blueprint_dir.mkdir(parents=True, exist_ok=True)
        self._entries: dict[str, BlueprintEntry] = {}
        self._load()

    @classmethod
    def get_instance(cls) -> BlueprintCatalog:
        if cls._instance is None:
            cls._instance = BlueprintCatalog()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def _load(self) -> None:
        index_file = self._blueprint_dir / "index.json"
        if index_file.exists():
            try:
                data = json.loads(index_file.read_text(encoding="utf-8"))
                for item in data:
                    entry = BlueprintEntry.from_dict(item)
                    self._entries[entry.id] = entry
            except (json.JSONDecodeError, OSError):
                pass

    def _save(self) -> None:
        index_file = self._blueprint_dir / "index.json"
        data = [e.to_dict() for e in self._entries.values()]
        index_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def register(self, entry: BlueprintEntry) -> None:
        self._entries[entry.id] = entry
        self._save()

    def unregister(self, blueprint_id: str) -> bool:
        if blueprint_id not in self._entries:
            return False
        del self._entries[blueprint_id]
        self._save()
        return True

    def get(self, blueprint_id: str) -> BlueprintEntry | None:
        return self._entries.get(blueprint_id)

    def list_entries(self, category: str | None = None) -> list[BlueprintEntry]:
        entries = list(self._entries.values())
        if category:
            entries = [e for e in entries if e.category == category]
        return entries

    def search(self, query: str) -> list[BlueprintEntry]:
        query_lower = query.lower()
        results: list[tuple[BlueprintEntry, float]] = []
        for entry in self._entries.values():
            score = 0.0
            if query_lower in entry.name.lower():
                score += 2.0
            if query_lower in entry.description.lower():
                score += 1.0
            if any(query_lower in t.lower() for t in entry.tags):
                score += 0.5
            if query_lower in entry.category.lower():
                score += 0.3
            if score > 0:
                results.append((entry, score))
        results.sort(key=lambda x: -x[1])
        return [r[0] for r in results]

    def instantiate(
        self,
        blueprint_id: str,
        param_values: dict[str, str] | None = None,
        schedule_override: str | None = None,
    ) -> CronJob | None:
        entry = self._entries.get(blueprint_id)
        if not entry:
            return None

        command = entry.command
        if param_values:
            for key, value in param_values.items():
                command = command.replace(f"{{{{{key}}}}}", value)

        for param in entry.params:
            if param.name not in (param_values or {}):
                placeholder = f"{{{{{param.name}}}}}"
                if placeholder in command:
                    command = command.replace(placeholder, param.default)

        return CronJob(
            id=f"bp_{blueprint_id}_{int(time.time())}",
            name=entry.name,
            schedule=schedule_override or entry.schedule,
            command=command,
            args=list(entry.args),
        )

    def register_builtin_blueprints(self) -> None:
        builtins = [
            BlueprintEntry(
                id="system_backup",
                name="系统自动备份",
                description="定期备份指定目录到备份存储",
                category="system",
                schedule="every:1d",
                command="tar -czf {{output}}/{{name}}.tar.gz {{source}}",
                params=[
                    BlueprintParam(name="source", description="源目录路径", default="/data"),
                    BlueprintParam(name="output", description="备份输出目录", default="/backup"),
                    BlueprintParam(name="name", description="备份文件名前缀", default="backup"),
                ],
                tags=["backup", "system", "maintenance"],
                author="system",
            ),
            BlueprintEntry(
                id="log_cleanup",
                name="日志清理",
                description="定期清理过期日志文件",
                category="maintenance",
                schedule="every:1d",
                command="find {{log_dir}} -name '*.log' -mtime +{{days}} -delete",
                params=[
                    BlueprintParam(name="log_dir", description="日志目录", default="/var/log"),
                    BlueprintParam(name="days", type="number", description="保留天数", default="7"),
                ],
                tags=["log", "cleanup", "maintenance"],
                author="system",
            ),
            BlueprintEntry(
                id="health_check",
                name="健康检查",
                description="定期检查服务健康状态",
                category="monitoring",
                schedule="every:5m",
                command="curl -sf {{url}}/health || echo 'HEALTH_CHECK_FAILED'",
                params=[
                    BlueprintParam(name="url", description="服务URL", default="http://localhost:3112"),
                ],
                tags=["health", "monitoring", "alert"],
                author="system",
            ),
            BlueprintEntry(
                id="db_vacuum",
                name="数据库优化",
                description="定期执行数据库VACUUM优化",
                category="maintenance",
                schedule="every:1d",
                command="sqlite3 {{db_path}} 'VACUUM;'",
                params=[
                    BlueprintParam(name="db_path", description="数据库文件路径", default="data/agent.db"),
                ],
                tags=["database", "maintenance", "optimization"],
                author="system",
            ),
            BlueprintEntry(
                id="report_generate",
                name="定期报告生成",
                description="定期生成系统运行报告",
                category="reporting",
                schedule="every:1d",
                command="python -m agent.tools.daily_enhanced_tools report --type {{report_type}} --output {{output_dir}}",
                params=[
                    BlueprintParam(name="report_type", description="报告类型", default="daily"),
                    BlueprintParam(name="output_dir", description="输出目录", default="data/reports"),
                ],
                tags=["report", "analytics", "daily"],
                author="system",
            ),
        ]
        for bp in builtins:
            if bp.id not in self._entries:
                self._entries[bp.id] = bp
        self._save()

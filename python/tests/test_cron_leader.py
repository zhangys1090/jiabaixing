"""cron 领导者选举 + jobs.json 写保护测试（审计残留项）。

验证：单实例下 start() 后成为 leader 并跑调度；多实例竞争仅一个为 leader
（防双副本调度）；调度链路（锁 + MQ + handler）在降级模式下可端到端执行；
jobs.json 写入在写锁下不死锁。
不依赖 Redis。
"""

import asyncio
import os
from pathlib import Path

import pytest

from agent.scheduler.cron import CronJob, CronJobScheduler


@pytest.fixture
def tmp_scheduler(tmp_path):
    os.environ.setdefault("REDIS_ENABLED", "false")
    sched = CronJobScheduler(data_dir=Path(tmp_path))
    yield sched
    try:
        sched.stop()
    except Exception:
        pass
    CronJobScheduler.reset_instance()


@pytest.mark.asyncio
async def test_single_instance_becomes_leader_and_ticks(tmp_scheduler) -> None:
    """单实例 start() 后应为 leader（调度循环已启动）。"""
    await tmp_scheduler.start()
    assert tmp_scheduler._leader is not None
    assert tmp_scheduler._leader.is_leader is True
    assert tmp_scheduler._task is not None  # tick 循环已创建


@pytest.mark.asyncio
async def test_only_one_leader_among_instances(tmp_path) -> None:
    """两个同 data_dir 的调度器竞争，恰有一个为 leader（防双副本调度）。"""
    os.environ.setdefault("REDIS_ENABLED", "false")
    s1 = CronJobScheduler(data_dir=Path(tmp_path))
    s2 = CronJobScheduler(data_dir=Path(tmp_path))
    await s1.start()
    await s2.start()
    try:
        leaders = [s._leader.is_leader for s in (s1, s2)]
        assert sum(leaders) == 1
    finally:
        s1.stop()
        s2.stop()
        CronJobScheduler.reset_instance()


@pytest.mark.asyncio
async def test_dispatch_chain_executes_handler(tmp_scheduler) -> None:
    """调度链路：到期的 job 经调度锁 + MQ 派发后真实执行 handler。"""
    executed = []

    async def handler(*args):
        executed.append(args)
        return "done"

    job = CronJob(
        id="j1",
        name="t",
        schedule="every:1h",
        command="noop",
        next_run=0.0,  # 立即到期
    )
    tmp_scheduler.register(job)
    tmp_scheduler.register_handler("noop", handler)

    # 直接驱动调度链路（调度锁 + MQ 派发 + handler 异步执行）
    await tmp_scheduler._safe_dispatch(job)
    # 等待 MQ worker 异步执行 handler
    await asyncio.sleep(0.3)

    assert executed, "job handler 应被调度链路执行"
    assert tmp_scheduler.get_job("j1").status in ("idle", "failed")


@pytest.mark.asyncio
async def test_run_job_writes_jobs_json_under_lock(tmp_scheduler) -> None:
    """_run_job 经写锁持久化 jobs.json，不出现死锁/异常。"""
    job = CronJob(
        id="j2",
        name="t2",
        schedule="every:1h",
        command="echo ok",
    )
    tmp_scheduler.register(job)
    result = await tmp_scheduler._run_job(job)
    assert result.success is True
    # jobs.json 应已写出
    assert (tmp_scheduler._data_dir / "jobs.json").exists()


@pytest.mark.asyncio
async def test_handler_error_recorded_no_deadlock(tmp_scheduler) -> None:
    """handler 抛错时 _run_job 不崩溃、状态回流，写锁正常释放。"""
    job = CronJob(id="j3", name="t3", schedule="every:1h", command="badcmd")
    tmp_scheduler.register(job)
    result = await tmp_scheduler._run_job(job)
    assert result.success is False
    assert tmp_scheduler.get_job("j3").status == "failed"


@pytest.mark.asyncio
async def test_safe_dispatch_marks_running_before_execution(tmp_scheduler) -> None:
    """审计 L-01 回归：派发时同步置 running，使 _tick 守卫立即生效，

    避免慢任务在下次 tick 被重复派发。无此修复时，_safe_dispatch 返回后
    job.status 仍为 idle（_run_job 尚未设置），断言会失败。
    此处桩掉 dispatch 的实际执行，仅验证「派发即置 running」这一前置行为。
    """
    job = CronJob(id="jL01", name="slow", schedule="every:1h", command="slow", next_run=0.0)
    tmp_scheduler.register(job)
    dispatched = []

    async def noop_dispatch(j):
        dispatched.append(j)

    tmp_scheduler.dispatch = noop_dispatch  # 阻断真实执行，隔离守卫前置行为
    await tmp_scheduler._safe_dispatch(job)
    # 派发发起点立即置 running，_tick 的 status=="running" 守卫随即生效
    assert tmp_scheduler.get_job("jL01").status == "running"
    assert dispatched, "应确实发起了派发"

"""长任务 Goal 复用（跨请求 Goal 身份延续）单测。

覆盖：
- 同 session 后续请求复用 ACTIVE Goal（goalId 不变、planVersion 延续、描述追加）
- TS 网关委派 goalId 在本进程落库（避免 getGoal/replan 断链）
- Goal 完结/放弃后解绑 session（下次请求新建 Goal）
- 不同 session 互不干扰
"""
import pytest

from agent.core.goal_authority import GoalAuthority
from agent.core.authority_types import GoalStatus


@pytest.fixture(autouse=True)
def _reset():
    GoalAuthority.resetInstance()
    yield
    GoalAuthority.resetInstance()


def test_same_session_reuses_active_goal():
    auth = GoalAuthority.getInstance()
    g1 = auth.getOrCreateGoal(
        description="修复登录 bug",
        originalInput="帮我把登录 bug 修好",
        session_id="session-A",
    )
    g2 = auth.getOrCreateGoal(
        description="继续修复登录 bug（报错是 500）",
        originalInput="还在报错，继续修",
        session_id="session-A",
    )
    assert g1.goalId == g2.goalId, "同 session 应复用同一 Goal 身份"
    assert g2.planVersion == 1, "复用不改变 planVersion"
    assert "续:" in g2.description, "新输入应追加到描述（长任务语义）"
    assert g2.originalInput == "帮我把登录 bug 修好", "originalInput 保留首轮输入"


def test_delegated_goal_id_registered_and_reused():
    auth = GoalAuthority.getInstance()
    # TS 网关委派身份在本进程不存在 → 以该 ID 落库
    g1 = auth.getOrCreateGoal(
        description="统计目录文件",
        originalInput="统计 tools 目录",
        session_id="session-B",
        explicit_goal_id="G_ts_delegated_123",
    )
    assert g1.goalId == "G_ts_delegated_123"
    # 同 ID 再次委派 → 复用同一 Goal
    g2 = auth.getOrCreateGoal(
        description="继续统计",
        originalInput="继续",
        session_id="session-B",
        explicit_goal_id="G_ts_delegated_123",
    )
    assert g2.goalId == g1.goalId
    assert auth.getGoal("G_ts_delegated_123") is not None, "委派 goal 必须落库"


def test_completed_goal_unbinds_session():
    auth = GoalAuthority.getInstance()
    g1 = auth.getOrCreateGoal(
        description="任务一", originalInput="做任务一", session_id="session-C"
    )
    auth.markCompleted(g1.goalId, reason="完成")
    # 同 session 新请求 → 新 Goal（旧 Goal 已完结，不复用）
    g2 = auth.getOrCreateGoal(
        description="任务二", originalInput="做任务二", session_id="session-C"
    )
    assert g2.goalId != g1.goalId, "completed 后应解绑并新建 Goal"
    assert g1.status == GoalStatus.COMPLETED
    assert g2.status == GoalStatus.ACTIVE


def test_abandoned_goal_unbinds_session():
    auth = GoalAuthority.getInstance()
    g1 = auth.getOrCreateGoal(
        description="任务X", originalInput="做任务X", session_id="session-D"
    )
    auth.markAbandoned(g1.goalId, reason="放弃")
    g2 = auth.getOrCreateGoal(
        description="任务Y", originalInput="做任务Y", session_id="session-D"
    )
    assert g2.goalId != g1.goalId


def test_sessions_are_independent():
    auth = GoalAuthority.getInstance()
    a1 = auth.getOrCreateGoal(description="A", originalInput="a", session_id="s-A")
    b1 = auth.getOrCreateGoal(description="B", originalInput="b", session_id="s-B")
    assert a1.goalId != b1.goalId


def test_plan_version_survives_reuse():
    """replan 的跨轮价值：复用 Goal 上 replan() 后 planVersion 递增，后续请求仍见新版本。"""
    auth = GoalAuthority.getInstance()
    g1 = auth.getOrCreateGoal(
        description="部署服务", originalInput="部署一下", session_id="session-E"
    )
    # 第一轮 replan（模拟失败恢复）
    auth.replan(g1.goalId, reason="连续失败，换策略", expectedVersion=1)
    assert g1.planVersion == 2
    # 第二轮请求复用同一 Goal → 看到 planVersion=2（而非重置为 1）
    g2 = auth.getOrCreateGoal(
        description="重新部署", originalInput="换个方式部署", session_id="session-E"
    )
    assert g2.goalId == g1.goalId
    assert g2.planVersion == 2, "跨请求复用必须延续 planVersion"


def test_no_session_creates_fresh_goal():
    auth = GoalAuthority.getInstance()
    g1 = auth.getOrCreateGoal(description="A", originalInput="a")
    g2 = auth.getOrCreateGoal(description="B", originalInput="b")
    assert g1.goalId != g2.goalId, "无 session 绑定时不复用"

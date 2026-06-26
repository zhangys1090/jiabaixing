import pytest
import tempfile
import os

from agent.skills.registry import Skill, SkillDefinition, SkillParameter, SkillRegistry, SkillResult
from agent.persistence.session_store import SessionStore
from agent.scheduler.cron import CronJob, CronJobScheduler, _parse_interval, _scan_injection


def test_skill_definition_defaults():
    defn = SkillDefinition(name="test_skill")
    assert defn.category == "general"
    assert defn.version == "1.0.0"
    assert defn.source == "builtin"


def test_skill_registry_register():
    SkillRegistry.reset_instance()
    registry = SkillRegistry()
    skill = Skill(definition=SkillDefinition(name="test", description="测试技能", category="test"))
    registry.register(skill)
    assert registry.get_skill("test") is not None


def test_skill_registry_duplicate():
    SkillRegistry.reset_instance()
    registry = SkillRegistry()
    skill1 = Skill(definition=SkillDefinition(name="dup", description="1"))
    skill2 = Skill(definition=SkillDefinition(name="dup", description="2"))
    registry.register(skill1)
    registry.register(skill2)
    assert len(registry.get_all_skills()) == 1


def test_skill_registry_unregister():
    SkillRegistry.reset_instance()
    registry = SkillRegistry()
    registry.register(Skill(definition=SkillDefinition(name="rm_test")))
    assert registry.unregister("rm_test") is True
    assert registry.get_skill("rm_test") is None


def test_skill_registry_by_category():
    SkillRegistry.reset_instance()
    registry = SkillRegistry()
    registry.register(Skill(definition=SkillDefinition(name="a", category="cat1")))
    registry.register(Skill(definition=SkillDefinition(name="b", category="cat2")))
    registry.register(Skill(definition=SkillDefinition(name="c", category="cat1")))

    cat1 = registry.get_skills_by_category("cat1")
    assert len(cat1) == 2


def test_skill_registry_search():
    SkillRegistry.reset_instance()
    registry = SkillRegistry()
    registry.register(Skill(definition=SkillDefinition(
        name="code_analysis", description="代码分析", tags=["code", "analysis"]
    )))
    registry.register(Skill(definition=SkillDefinition(
        name="memory_recall", description="记忆回忆", tags=["memory"]
    )))

    results = registry.search_skills("code")
    assert len(results) == 1
    assert results[0].definition.name == "code_analysis"


def test_skill_registry_builtin():
    SkillRegistry.reset_instance()
    registry = SkillRegistry()
    registry.register_builtin_skills()
    assert len(registry.get_all_skills()) >= 5
    assert "communication" in registry.get_categories()


@pytest.mark.anyio
async def test_skill_execute():
    async def my_fn(params, ctx):
        return SkillResult(success=True, output=f"hello {params.get('name', '')}")

    skill = Skill(
        definition=SkillDefinition(name="greet"),
        execute_fn=my_fn,
    )
    result = await skill.execute({"name": "world"})
    assert result.success
    assert result.output == "hello world"


@pytest.mark.anyio
async def test_skill_execute_default():
    skill = Skill(definition=SkillDefinition(name="default"))
    result = await skill.execute({})
    assert result.success
    assert "default" in result.output


def test_session_store_create():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions")
        store = SessionStore(db_path=db_path)
        session = store.create_session(title="测试会话")
        assert session.session_id is not None
        assert session.title == "测试会话"
        store.close()


def test_session_store_add_message():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions")
        store = SessionStore(db_path=db_path)
        session = store.create_session()
        ok = store.add_message(session.session_id, "user", "你好")
        assert ok is True

        msgs = store.get_messages(session.session_id)
        assert len(msgs) == 1
        assert msgs[0].content == "你好"
        store.close()


def test_session_store_list():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions")
        store = SessionStore(db_path=db_path)
        store.create_session(title="会话1")
        store.create_session(title="会话2")

        sessions = store.list_sessions()
        assert len(sessions) == 2
        store.close()


def test_session_store_delete():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions")
        store = SessionStore(db_path=db_path)
        session = store.create_session()
        ok = store.delete_session(session.session_id)
        assert ok is True
        assert store.get_session(session.session_id) is None
        store.close()


def test_session_store_stats():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions")
        store = SessionStore(db_path=db_path)
        session = store.create_session()
        store.add_message(session.session_id, "user", "hi")
        store.add_message(session.session_id, "assistant", "hello")

        stats = store.get_stats()
        assert stats["total_sessions"] == 1
        assert stats["total_messages"] == 2
        store.close()


def test_session_store_persistence():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions")
        store1 = SessionStore(db_path=db_path)
        session = store1.create_session(title="持久化测试")
        store1.add_message(session.session_id, "user", "测试消息")
        store1.close()

        store2 = SessionStore(db_path=db_path)
        loaded = store2.get_session(session.session_id)
        assert loaded is not None
        assert loaded.title == "持久化测试"
        assert len(loaded.messages) == 1
        store2.close()


def test_cron_parse_interval():
    assert _parse_interval("every:5m") == 300
    assert _parse_interval("every:1h") == 3600
    assert _parse_interval("every:30s") == 30
    assert _parse_interval("every:1d") == 86400
    assert _parse_interval("invalid") is None


def test_cron_injection_scan():
    blocked, reason = _scan_injection("rm -rf /")
    assert blocked is True

    blocked, reason = _scan_injection("echo hello")
    assert blocked is False


def test_cron_register():
    CronJobScheduler.reset_instance()
    with tempfile.TemporaryDirectory() as tmpdir:
        scheduler = CronJobScheduler(data_dir=__import__("pathlib").Path(tmpdir))
        job = CronJob(
            id="test_1",
            name="Test Job",
            schedule="every:5m",
            command="echo hello",
        )
        scheduler.register(job)
        assert len(scheduler.get_jobs()) == 1
        assert scheduler.get_job("test_1") is not None


def test_cron_unregister():
    CronJobScheduler.reset_instance()
    with tempfile.TemporaryDirectory() as tmpdir:
        scheduler = CronJobScheduler(data_dir=__import__("pathlib").Path(tmpdir))
        job = CronJob(
            id="test_2",
            name="Remove Me",
            schedule="every:1h",
            command="echo bye",
        )
        scheduler.register(job)
        scheduler.unregister("test_2")
        assert scheduler.get_job("test_2") is None


def test_cron_toggle():
    CronJobScheduler.reset_instance()
    with tempfile.TemporaryDirectory() as tmpdir:
        scheduler = CronJobScheduler(data_dir=__import__("pathlib").Path(tmpdir))
        job = CronJob(
            id="test_3",
            name="Toggle",
            schedule="every:5m",
            command="echo test",
            enabled=True,
        )
        scheduler.register(job)
        job.enabled = not job.enabled
        assert job.enabled is False


def test_cron_persistence():
    CronJobScheduler.reset_instance()
    with tempfile.TemporaryDirectory() as tmpdir:
        path = __import__("pathlib").Path(tmpdir)
        s1 = CronJobScheduler(data_dir=path)
        s1.register(CronJob(id="p1", name="Persist", schedule="every:5m", command="echo hi"))

        s2 = CronJobScheduler(data_dir=path)
        loaded = s2.get_job("p1")
        assert loaded is not None
        assert loaded.name == "Persist"


def test_cron_job_to_dict():
    job = CronJob(id="d1", name="Dict", schedule="every:1h", command="echo test")
    d = job.to_dict()
    assert d["id"] == "d1"
    assert d["name"] == "Dict"

    restored = CronJob.from_dict(d)
    assert restored.id == "d1"
    assert restored.name == "Dict"

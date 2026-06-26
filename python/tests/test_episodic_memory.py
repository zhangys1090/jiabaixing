from __future__ import annotations

import time

import pytest

from agent.memory.episodic_memory import (
    EmotionType,
    EpisodicMemory,
    EpisodicMemoryStore,
    EpisodeCluster,
    RetrievalResult,
    SceneType,
)


def _store(
    content: str = "test episode",
    scene: SceneType = SceneType.OTHER,
    emotion: EmotionType = EmotionType.NEUTRAL,
    importance: float = 5.0,
) -> EpisodicMemory:
    store = EpisodicMemoryStore(db_path=":memory:")
    return store.store(content, scene=scene, emotion=emotion, importance=importance)


# ─── Store ───


def test_store_episode():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("用户正在编写代码", scene=SceneType.DEVELOPMENT, emotion=EmotionType.FOCUSED)
    assert ep.id.startswith("ep_")
    assert ep.content == "用户正在编写代码"
    assert ep.scene == SceneType.DEVELOPMENT
    assert ep.emotion == EmotionType.FOCUSED


def test_store_with_string_scene_emotion():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("test", scene="development", emotion="happy")
    assert ep.scene == SceneType.DEVELOPMENT
    assert ep.emotion == EmotionType.HAPPY


def test_store_importance_clamped():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("test", importance=15.0)
    assert ep.importance == 10.0

    ep2 = store.store("test2", importance=-1.0)
    assert ep2.importance == 1.0


def test_store_emotion_intensity_clamped():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("test", emotion_intensity=2.0)
    assert ep.emotion_intensity == 1.0

    ep2 = store.store("test2", emotion_intensity=-0.5)
    assert ep2.emotion_intensity == 0.0


def test_store_with_tags():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("tagged episode", tags=["python", "coding"])
    assert "python" in ep.tags
    assert "coding" in ep.tags


# ─── Retrieve ───


def test_retrieve_all():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("episode 1")
    store.store("episode 2")
    result = store.retrieve()
    assert len(result.memories) == 2
    assert result.total_found == 2


def test_retrieve_by_scene():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("coding episode", scene=SceneType.DEVELOPMENT)
    store.store("daily episode", scene=SceneType.DAILY)

    result = store.retrieve(scene=SceneType.DEVELOPMENT)
    assert len(result.memories) == 1
    assert result.memories[0].scene == SceneType.DEVELOPMENT


def test_retrieve_by_emotion():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("happy episode", emotion=EmotionType.HAPPY)
    store.store("sad episode", emotion=EmotionType.SAD)

    result = store.retrieve(emotion=EmotionType.HAPPY)
    assert len(result.memories) == 1
    assert result.memories[0].emotion == EmotionType.HAPPY


def test_retrieve_by_query():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("Python coding session", importance=8.0)
    store.store("Java debugging session", importance=6.0)

    result = store.retrieve(query="Python")
    assert len(result.memories) >= 1
    assert any("Python" in m.content for m in result.memories)


def test_retrieve_by_importance():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("low importance", importance=3.0)
    store.store("high importance", importance=9.0)

    result = store.retrieve(min_importance=7.0)
    assert len(result.memories) == 1
    assert result.memories[0].importance >= 7.0


def test_retrieve_by_time_range():
    store = EpisodicMemoryStore(db_path=":memory:")
    now = time.time()
    ep1 = store.store("old episode")
    ep1.timestamp = now - 7200
    ep2 = store.store("recent episode")

    result = store.retrieve(since=now - 3600)
    assert len(result.memories) == 1
    assert result.memories[0].content == "recent episode"


def test_retrieve_limit():
    store = EpisodicMemoryStore(db_path=":memory:")
    for i in range(30):
        store.store(f"episode {i}")
    result = store.retrieve(limit=5)
    assert len(result.memories) == 5


def test_retrieve_updates_access_count():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("access test")
    result = store.retrieve()
    assert result.memories[0].access_count == 1

    store.retrieve()
    result2 = store.retrieve()
    assert result2.memories[0].access_count >= 2


# ─── Get by ID ───


def test_get_by_id():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("find me")
    found = store.get_by_id(ep.id)
    assert found is not None
    assert found.content == "find me"


def test_get_by_id_not_found():
    store = EpisodicMemoryStore(db_path=":memory:")
    assert store.get_by_id("nonexistent") is None


# ─── Update ───


def test_update_importance():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("test", importance=5.0)
    success = store.update_importance(ep.id, 3.0)
    assert success is True
    found = store.get_by_id(ep.id)
    assert found.importance == 8.0


def test_update_importance_not_found():
    store = EpisodicMemoryStore(db_path=":memory:")
    assert store.update_importance("nonexistent", 1.0) is False


def test_add_tag():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("tag test")
    success = store.add_tag(ep.id, "new_tag")
    assert success is True
    found = store.get_by_id(ep.id)
    assert "new_tag" in found.tags


def test_add_tag_duplicate():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("tag test", tags=["existing"])
    result = store.add_tag(ep.id, "existing")
    assert result is False


def test_add_tag_not_found():
    store = EpisodicMemoryStore(db_path=":memory:")
    assert store.add_tag("nonexistent", "tag") is False


# ─── Delete ───


def test_delete():
    store = EpisodicMemoryStore(db_path=":memory:")
    ep = store.store("delete me")
    success = store.delete(ep.id)
    assert success is True
    assert store.get_by_id(ep.id) is None


def test_delete_not_found():
    store = EpisodicMemoryStore(db_path=":memory:")
    assert store.delete("nonexistent") is False


# ─── Clustering ───


def test_cluster_by_scene():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("code1", scene=SceneType.DEVELOPMENT)
    store.store("code2", scene=SceneType.DEVELOPMENT)
    store.store("daily1", scene=SceneType.DAILY)

    clusters = store.cluster_by_scene()
    assert SceneType.DEVELOPMENT in clusters
    assert len(clusters[SceneType.DEVELOPMENT].memories) == 2
    assert SceneType.DAILY in clusters


def test_cluster_by_emotion():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("happy1", emotion=EmotionType.HAPPY)
    store.store("happy2", emotion=EmotionType.HAPPY)
    store.store("sad1", emotion=EmotionType.SAD)

    clusters = store.cluster_by_emotion()
    assert EmotionType.HAPPY in clusters
    assert len(clusters[EmotionType.HAPPY].memories) == 2


# ─── Recent / Important ───


def test_get_recent():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("old")
    store.store("newer")
    store.store("newest")

    recent = store.get_recent(limit=2)
    assert len(recent) == 2
    assert recent[0].content == "newest"


def test_get_important():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("low", importance=3.0)
    store.store("high", importance=9.0)
    store.store("medium", importance=5.0)

    important = store.get_important(limit=5)
    assert len(important) == 1
    assert important[0].importance >= 7.0


# ─── Stats ───


def test_get_stats():
    store = EpisodicMemoryStore(db_path=":memory:")
    store.store("code", scene=SceneType.DEVELOPMENT, emotion=EmotionType.FOCUSED, importance=8.0)
    store.store("daily", scene=SceneType.DAILY, emotion=EmotionType.HAPPY, importance=5.0)

    stats = store.get_stats()
    assert stats["total_episodes"] == 2
    assert stats["scenes"]["development"] == 1
    assert stats["emotions"]["focused"] == 1
    assert stats["important_count"] == 1


# ─── Cleanup ───


def test_cleanup_old():
    store = EpisodicMemoryStore(db_path=":memory:")
    for i in range(550):
        store.store(f"episode {i}")

    assert len(store._episodes) <= 500


# ─── Enums ───


def test_emotion_types():
    assert EmotionType.HAPPY == "happy"
    assert EmotionType.SAD == "sad"
    assert EmotionType.FOCUSED == "focused"


def test_scene_types():
    assert SceneType.DEVELOPMENT == "development"
    assert SceneType.DAILY == "daily"
    assert SceneType.LEARNING == "learning"

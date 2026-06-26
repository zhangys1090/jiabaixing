from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import StructuredLogger

log = StructuredLogger("episodic_memory")

_MAX_EPISODES = 500
_DEFAULT_DECAY_HOURS = 24.0
_IMPORTANCE_THRESHOLD = 7.0


class EmotionType(str, Enum):
    HAPPY = "happy"
    SAD = "sad"
    ANGRY = "angry"
    FEARFUL = "fearful"
    SURPRISED = "surprised"
    DISGUSTED = "disgusted"
    NEUTRAL = "neutral"
    FOCUSED = "focused"
    CALM = "calm"


class SceneType(str, Enum):
    DEVELOPMENT = "development"
    DAILY = "daily"
    LEARNING = "learning"
    WORK = "work"
    SOCIAL = "social"
    ENTERTAINMENT = "entertainment"
    OTHER = "other"


@dataclass
class EpisodicMemory:
    id: str = ""
    content: str = ""
    scene: SceneType = SceneType.OTHER
    emotion: EmotionType = EmotionType.NEUTRAL
    emotion_intensity: float = 0.5
    timestamp: float = 0.0
    importance: float = 5.0
    access_count: int = 0
    last_accessed: float = 0.0
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    decay_score: float = 1.0


@dataclass
class EpisodeCluster:
    scene: SceneType
    emotion: EmotionType | None = None
    memories: list[EpisodicMemory] = field(default_factory=list)
    start_time: float = 0.0
    end_time: float = 0.0
    summary: str = ""


@dataclass
class RetrievalResult:
    memories: list[EpisodicMemory]
    query: str = ""
    total_found: int = 0
    retrieval_time_ms: float = 0.0


class EpisodicMemoryStore:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self._episodes: list[EpisodicMemory] = []
        self._db_path = Path(db_path) if db_path else DATA_DIR / "episodic_memory.db"
        self._in_memory = str(self._db_path) == ":memory:"
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        if not self._in_memory:
            self._load_from_db()

    def store(
        self,
        content: str,
        scene: SceneType | str = SceneType.OTHER,
        emotion: EmotionType | str = EmotionType.NEUTRAL,
        emotion_intensity: float = 0.5,
        importance: float = 5.0,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> EpisodicMemory:
        if isinstance(scene, str):
            scene = SceneType(scene.lower())
        if isinstance(emotion, str):
            emotion = EmotionType(emotion.lower())

        now = time.time()
        episode = EpisodicMemory(
            id=f"ep_{uuid.uuid4().hex[:12]}",
            content=content,
            scene=scene,
            emotion=emotion,
            emotion_intensity=max(0.0, min(1.0, emotion_intensity)),
            timestamp=now,
            importance=max(1.0, min(10.0, importance)),
            access_count=0,
            last_accessed=now,
            tags=tags or [],
            metadata=metadata or {},
            decay_score=1.0,
        )

        self._episodes.append(episode)

        if len(self._episodes) > _MAX_EPISODES:
            self._cleanup_old()

        log.debug("Episode stored", id=episode.id, scene=scene.value)
        self._persist_episode(episode)
        return episode

    def retrieve(
        self,
        query: str = "",
        scene: SceneType | str | None = None,
        emotion: EmotionType | str | None = None,
        limit: int = 20,
        min_importance: float = 0.0,
        since: float = 0.0,
        until: float = 0.0,
    ) -> RetrievalResult:
        start = time.time()

        if isinstance(scene, str):
            scene = SceneType(scene.lower())
        if isinstance(emotion, str):
            emotion = EmotionType(emotion.lower())

        candidates = self._episodes

        if scene is not None:
            candidates = [e for e in candidates if e.scene == scene]

        if emotion is not None:
            candidates = [e for e in candidates if e.emotion == emotion]

        if min_importance > 0:
            candidates = [e for e in candidates if e.importance >= min_importance]

        if since > 0:
            candidates = [e for e in candidates if e.timestamp >= since]

        if until > 0:
            candidates = [e for e in candidates if e.timestamp <= until]

        if query:
            query_lower = query.lower()
            for ep in candidates:
                score = self._calculate_relevance(ep, query_lower)
                ep.decay_score = score
            candidates.sort(key=lambda e: e.decay_score, reverse=True)
        else:
            for ep in candidates:
                ep.decay_score = self._calculate_decay_score(ep)
            candidates.sort(key=lambda e: (e.decay_score, -e.importance), reverse=True)

        result_memories = candidates[:limit]

        for mem in result_memories:
            mem.access_count += 1
            mem.last_accessed = time.time()

        elapsed = (time.time() - start) * 1000
        return RetrievalResult(
            memories=result_memories,
            query=query,
            total_found=len(candidates),
            retrieval_time_ms=elapsed,
        )

    def get_by_id(self, memory_id: str) -> EpisodicMemory | None:
        return next((e for e in self._episodes if e.id == memory_id), None)

    def update_importance(self, memory_id: str, delta: float) -> bool:
        ep = self.get_by_id(memory_id)
        if not ep:
            return False
        ep.importance = max(1.0, min(10.0, ep.importance + delta))
        self._update_episode_db(ep)
        log.debug("Importance updated", id=memory_id, new_importance=ep.importance)
        return True

    def add_tag(self, memory_id: str, tag: str) -> bool:
        ep = self.get_by_id(memory_id)
        if not ep or tag in ep.tags:
            return False
        ep.tags.append(tag)
        self._update_episode_db(ep)
        return True

    def delete(self, memory_id: str) -> bool:
        original_len = len(self._episodes)
        self._episodes = [e for e in self._episodes if e.id != memory_id]
        if len(self._episodes) < original_len:
            self._delete_episode_db(memory_id)
            return True
        return False

    def cluster_by_scene(self) -> dict[SceneType, EpisodeCluster]:
        clusters: dict[SceneType, list[EpisodicMemory]] = {}
        for ep in self._episodes:
            clusters.setdefault(ep.scene, []).append(ep)

        result: dict[SceneType, EpisodeCluster] = {}
        for scene, episodes in clusters.items():
            timestamps = [e.timestamp for e in episodes]
            result[scene] = EpisodeCluster(
                scene=scene,
                memories=sorted(episodes, key=lambda e: e.timestamp),
                start_time=min(timestamps) if timestamps else 0.0,
                end_time=max(timestamps) if timestamps else 0.0,
                summary=f"{len(episodes)} episodes in {scene.value}",
            )
        return result

    def cluster_by_emotion(self) -> dict[EmotionType, EpisodeCluster]:
        clusters: dict[EmotionType, list[EpisodicMemory]] = {}
        for ep in self._episodes:
            clusters.setdefault(ep.emotion, []).append(ep)

        result: dict[EmotionType, EpisodeCluster] = {}
        for emotion, episodes in clusters.items():
            result[emotion] = EpisodeCluster(
                scene=SceneType.OTHER,
                emotion=emotion,
                memories=sorted(episodes, key=lambda e: e.timestamp),
                start_time=min(e.timestamp for e in episodes) if episodes else 0.0,
                end_time=max(e.timestamp for e in episodes) if episodes else 0.0,
                summary=f"{len(episodes)} episodes with {emotion.value}",
            )
        return result

    def get_recent(self, limit: int = 10) -> list[EpisodicMemory]:
        sorted_episodes = sorted(self._episodes, key=lambda e: e.timestamp, reverse=True)
        return sorted_episodes[:limit]

    def get_important(self, limit: int = 10) -> list[EpisodicMemory]:
        filtered = [e for e in self._episodes if e.importance >= _IMPORTANCE_THRESHOLD]
        return sorted(filtered, key=lambda e: (-e.importance, -e.timestamp))[:limit]

    def get_stats(self) -> dict[str, Any]:
        scenes: dict[str, int] = {}
        emotions: dict[str, int] = {}

        for ep in self._episodes:
            scenes[ep.scene.value] = scenes.get(ep.scene.value, 0) + 1
            emotions[ep.emotion.value] = emotions.get(ep.emotion.value, 0) + 1

        total_access = sum(e.access_count for e in self._episodes)
        avg_importance = sum(e.importance for e in self._episodes) / len(self._episodes) if self._episodes else 0.0

        return {
            "total_episodes": len(self._episodes),
            "scenes": scenes,
            "emotions": emotions,
            "avg_importance": round(avg_importance, 2),
            "total_access_count": total_access,
            "important_count": sum(1 for e in self._episodes if e.importance >= _IMPORTANCE_THRESHOLD),
        }

    def _cleanup_old(self) -> None:
        for ep in self._episodes:
            ep.decay_score = self._calculate_decay_score(ep)
        self._episodes.sort(key=lambda e: e.decay_score)
        to_remove = len(self._episodes) - _MAX_EPISODES
        if to_remove > 0:
            removed = self._episodes[:to_remove]
            self._episodes = self._episodes[to_remove:]
            log.info("Old episodes cleaned", count=len(removed))

    @staticmethod
    def _calculate_relevance(episode: EpisodicMemory, query_lower: str) -> float:
        content_lower = episode.content.lower()

        exact_match = 1.0 if query_lower in content_lower else 0.0

        words = set(query_lower.split())
        content_words = set(content_lower.split())
        word_overlap = len(words & content_words) / max(len(words), 1)

        tag_match = any(query_lower in tag.lower() for tag in episode.tags)

        relevance = (
            exact_match * 0.5 +
            word_overlap * 0.3 +
            (0.2 if tag_match else 0.0)
        ) * (episode.importance / 10.0)

        decay = EpisodicMemoryStore._calculate_decay_score(episode)
        return relevance * decay

    @staticmethod
    def _calculate_decay_score(episode: EpisodicMemory) -> float:
        hours_since = (time.time() - episode.timestamp) / 3600.0
        time_decay = 1.0 / (1.0 + hours_since / _DEFAULT_DECAY_HOURS)

        access_boost = 1.0 + (episode.access_count * 0.05)

        importance_factor = episode.importance / 10.0

        return time_decay * access_boost * importance_factor

    def _init_db(self) -> None:
        if self._in_memory:
            return
        try:
            conn = sqlite3.connect(str(self._db_path))
            conn.execute("""
                CREATE TABLE IF NOT EXISTS episodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    scene TEXT NOT NULL DEFAULT 'other',
                    emotion TEXT NOT NULL DEFAULT 'neutral',
                    emotion_intensity REAL NOT NULL DEFAULT 0.5,
                    timestamp REAL NOT NULL DEFAULT 0,
                    importance REAL NOT NULL DEFAULT 5.0,
                    access_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed REAL NOT NULL DEFAULT 0,
                    tags TEXT NOT NULL DEFAULT '[]',
                    metadata TEXT NOT NULL DEFAULT '{}'
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_episodes_scene ON episodes(scene)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_episodes_importance ON episodes(importance)")
            conn.commit()
            conn.close()
        except Exception as e:
            log.warning("Failed to init episodic DB", error=str(e))

    def _load_from_db(self) -> None:
        try:
            conn = sqlite3.connect(str(self._db_path))
            conn.row_factory = sqlite3.Row
            cur = conn.execute(
                "SELECT id, content, scene, emotion, emotion_intensity, "
                "timestamp, importance, access_count, last_accessed, tags, metadata "
                "FROM episodes ORDER BY timestamp DESC LIMIT ?",
                (_MAX_EPISODES,),
            )
            for row in cur:
                try:
                    ep = EpisodicMemory(
                        id=row[0],
                        content=row[1],
                        scene=SceneType(row[2]),
                        emotion=EmotionType(row[3]),
                        emotion_intensity=row[4],
                        timestamp=row[5],
                        importance=row[6],
                        access_count=row[7],
                        last_accessed=row[8],
                        tags=json.loads(row[9]),
                        metadata=json.loads(row[10]),
                    )
                    self._episodes.append(ep)
                except Exception:
                    continue
            conn.close()
            log.info("Loaded episodes from DB", count=len(self._episodes))
        except Exception as e:
            log.warning("Failed to load episodes from DB", error=str(e))

    def _persist_episode(self, episode: EpisodicMemory) -> None:
        if self._in_memory:
            return
        try:
            conn = sqlite3.connect(str(self._db_path))
            conn.execute(
                "INSERT OR REPLACE INTO episodes "
                "(id, content, scene, emotion, emotion_intensity, timestamp, "
                "importance, access_count, last_accessed, tags, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    episode.id,
                    episode.content,
                    episode.scene.value,
                    episode.emotion.value,
                    episode.emotion_intensity,
                    episode.timestamp,
                    episode.importance,
                    episode.access_count,
                    episode.last_accessed,
                    json.dumps(episode.tags, ensure_ascii=False),
                    json.dumps(episode.metadata, ensure_ascii=False),
                ),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            log.warning("Failed to persist episode", id=episode.id, error=str(e))

    def _update_episode_db(self, episode: EpisodicMemory) -> None:
        if self._in_memory:
            return
        try:
            conn = sqlite3.connect(str(self._db_path))
            conn.execute(
                "UPDATE episodes SET importance=?, access_count=?, last_accessed=?, "
                "tags=?, metadata=? WHERE id=?",
                (
                    episode.importance,
                    episode.access_count,
                    episode.last_accessed,
                    json.dumps(episode.tags, ensure_ascii=False),
                    json.dumps(episode.metadata, ensure_ascii=False),
                    episode.id,
                ),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            log.warning("Failed to update episode in DB", id=episode.id, error=str(e))

    def _delete_episode_db(self, memory_id: str) -> None:
        try:
            conn = sqlite3.connect(str(self._db_path))
            conn.execute("DELETE FROM episodes WHERE id=?", (memory_id,))
            conn.commit()
            conn.close()
        except Exception as e:
            log.warning("Failed to delete episode from DB", id=memory_id, error=str(e))

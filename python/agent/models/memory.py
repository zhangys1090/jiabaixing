from pydantic import BaseModel, Field
from typing import Any
from datetime import datetime


class MemoryItem(BaseModel):
    id: str = ""
    content: str
    memory_type: str = "short_term"
    scene: str = ""
    emotion: str = "neutral"
    timestamp: float = 0.0
    relevance_score: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)


class MemorySearchRequest(BaseModel):
    query: str
    limit: int = 10
    memory_type: str | None = None
    min_relevance: float = 0.0


class MemorySearchResponse(BaseModel):
    results: list[MemoryItem] = Field(default_factory=list)
    total: int = 0
    query: str = ""


class MemoryStoreRequest(BaseModel):
    content: str
    memory_type: str = "short_term"
    scene: str = ""
    emotion: str = "neutral"
    metadata: dict[str, Any] = Field(default_factory=dict)


class MemoryStoreResponse(BaseModel):
    id: str
    success: bool = True


class MemoryStatsResponse(BaseModel):
    total_entries: int = 0
    short_term_count: int = 0
    long_term_count: int = 0
    instant_count: int = 0
    oldest_entry: datetime | None = None
    newest_entry: datetime | None = None

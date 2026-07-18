from agent.infrastructure.backup import BackupManager, BackupManifest
from agent.infrastructure.doctor import DiagnosticLevel, DiagnosticResult, Doctor
from agent.infrastructure.message_queue import (
    InMemoryMessageQueue,
    Message,
    MessagePriority,
    MessageStatus,
    QueueStats,
    RedisStreamsQueue,
    create_message_queue,
)
from agent.infrastructure.otel_setup import setup_otel, get_tracer, get_meter, is_otel_enabled
from agent.infrastructure.lazy_deps import (
    LazyDependency,
    DEFAULT_LAZY_DEPS,
    create_default_lazy_deps,
)
from agent.infrastructure.disk_cleanup import (
    DiskCleaner,
    CleanupRule,
    CleanupResult,
)
from agent.infrastructure.distributed_lock import (
    DistributedLock,
    RedisLock,
    LocalLock,
    LockManager,
    create_lock,
    get_lock_manager,
)
from agent.infrastructure.sharding import (
    LeaderElection,
    consistent_shard,
    get_shard_count,
    get_replica_index,
    this_replica_owns,
)

__all__ = [
    # doctor
    "Doctor",
    "DiagnosticLevel",
    "DiagnosticResult",
    # backup
    "BackupManager",
    "BackupManifest",
    # otel
    "setup_otel",
    "get_tracer",
    "get_meter",
    "is_otel_enabled",
    # message queue
    "RedisStreamsQueue",
    "InMemoryMessageQueue",
    "create_message_queue",
    "Message",
    "MessagePriority",
    "MessageStatus",
    "QueueStats",
    # lazy deps
    "LazyDependency",
    "DEFAULT_LAZY_DEPS",
    "create_default_lazy_deps",
    # disk cleanup
    "DiskCleaner",
    "CleanupRule",
    "CleanupResult",
    # distributed lock
    "DistributedLock",
    "RedisLock",
    "LocalLock",
    "LockManager",
    "create_lock",
    "get_lock_manager",
    # sharding / horizontal scaling
    "LeaderElection",
    "consistent_shard",
    "get_shard_count",
    "get_replica_index",
    "this_replica_owns",
]

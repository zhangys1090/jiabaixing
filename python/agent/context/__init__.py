"""上下文管理模块

提供统一的上下文编排器和相关组件。
"""

from agent.context.models import (
    BuildContext,
    BuildStatistics,
    BuildStatus,
    CacheMetrics,
    CacheStrategy,
    ComponentDependency,
    ComponentMetrics,
    ComponentPriority,
    ComponentResult,
    ComponentStatus,
    ContextBuildRequest,
    ContextBuildResult,
    ErrorInfo,
)
from agent.context.base import (
    ComponentRegistry,
    ContextComponent,
    DependencyResolver,
)
from agent.context.cache import ContextCache, LRUCache
from agent.context.unified_orchestrator import (
    UnifiedContextOrchestrator,
    get_orchestrator,
)
from agent.context.coding_context import CodingContext, CodingContextDetector
from agent.context.subdirectory_hints import DirectoryHints, SubdirectoryHints

__all__ = [
    # 数据模型
    "BuildContext",
    "BuildStatistics",
    "BuildStatus",
    "CacheMetrics",
    "CacheStrategy",
    "ComponentDependency",
    "ComponentMetrics",
    "ComponentPriority",
    "ComponentResult",
    "ComponentStatus",
    "ContextBuildRequest",
    "ContextBuildResult",
    "ErrorInfo",
    # 基础组件
    "ComponentRegistry",
    "ContextComponent",
    "DependencyResolver",
    # 缓存
    "ContextCache",
    "LRUCache",
    # 编排器
    "UnifiedContextOrchestrator",
    "get_orchestrator",
    # 编码上下文
    "CodingContext",
    "CodingContextDetector",
    # 子目录提示
    "DirectoryHints",
    "SubdirectoryHints",
]

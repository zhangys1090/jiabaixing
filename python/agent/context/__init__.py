"""上下文管理模块

提供统一的上下文编排器和相关组件。

P1.2 上下文构建器合并：新增 UnifiedContextBuilder、UnifiedContextPipeline、
LLMContextBuilder，对标 TS 侧同名组件。
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
from agent.context.unified_context_pipeline import (
    EmotionInfo,
    SceneInfo,
    TimeContext,
    UnifiedContext,
    UnifiedContextPipeline,
    UserProfile,
)
from agent.context.llm_context_builder import (
    FilteredMemory,
    LLMContextBuilder,
    LLMContextBuilderConfig,
    LLMContextResult,
)
from agent.context.unified_context_builder import (
    ContextBuildOptions,
    ContextBuildResult as BuilderResult,
    ContextStats,
    UnifiedContextBuilder,
)

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
    # P1.2 统一上下文构建器
    "UnifiedContextBuilder",
    "ContextBuildOptions",
    "BuilderResult",
    "ContextStats",
    # P1.2 统一上下文管道
    "UnifiedContextPipeline",
    "UnifiedContext",
    "SceneInfo",
    "EmotionInfo",
    "TimeContext",
    "UserProfile",
    # P1.2 智能记忆筛选
    "LLMContextBuilder",
    "LLMContextBuilderConfig",
    "LLMContextResult",
    "FilteredMemory",
]

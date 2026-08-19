from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ============================================================================
# 枚举定义
# ============================================================================


class BuildStatus(str, Enum):
    """构建状态枚举"""

    SUCCESS = "success"
    """完全成功"""

    PARTIAL = "partial"
    """部分成功（有组件降级）"""

    FAILED = "failed"
    """完全失败"""


class ComponentStatus(str, Enum):
    """组件执行状态枚举"""

    PENDING = "pending"
    """待执行"""

    RUNNING = "running"
    """执行中"""

    SUCCESS = "success"
    """成功"""

    SKIPPED = "skipped"
    """跳过（条件不满足）"""

    FAILED = "failed"
    """失败"""

    DEGRADED = "degraded"
    """降级运行"""

    DISABLED = "disabled"
    """已禁用"""


class CacheStrategy(str, Enum):
    """缓存策略枚举"""

    NO_CACHE = "no_cache"
    """不缓存"""

    LRU = "lru"
    """LRU缓存"""

    TTL = "ttl"
    """TTL缓存"""

    HYBRID = "hybrid"
    """混合缓存（LRU + TTL）"""


class DegradationLevel(str, Enum):
    """降级级别枚举"""

    FULL = "full"
    """完整执行（无降级）"""

    SIMPLIFIED = "simplified"
    """简化模式"""

    SKIP = "skip"
    """跳过组件"""

    USE_CACHE = "use_cache"
    """使用缓存结果"""


class ComponentPriority:
    """组件优先级常量

    数字越小，优先级越高，越早执行
    """

    # 系统层（最先执行）
    SYSTEM_PROMPT = 10
    PERSONA = 20
    TONE = 30

    # 记忆层
    MEMORY_RETRIEVAL = 100
    EPISODIC_MEMORY = 110
    MEMORY_CURATION = 120

    # 上下文层
    FILE_CONTEXT = 200
    REFERENCE_RESOLVER = 210
    DYNAMIC_CONTEXT = 220

    # 历史层
    HISTORY_MANAGER = 300

    # 组装层
    CONTEXT_ASSEMBLER = 400

    # 优化层（最后执行）
    TOKEN_BUDGET = 500
    CONTEXT_COMPRESSOR = 510
    ATTENTION_FOCUS = 520
    WINDOW_MANAGER = 530


# ============================================================================
# 核心数据类
# ============================================================================


@dataclass
class ErrorInfo:
    """错误信息"""

    error_type: str
    """错误类型"""

    message: str
    """错误消息"""

    component: str = ""
    """发生错误的组件名称"""

    timestamp: float = field(default_factory=time.time)
    """错误发生时间戳"""

    traceback: str | None = None
    """错误堆栈（可选）"""

    recoverable: bool = True
    """是否可恢复"""

    def to_dict(self) -> dict[str, Any]:
        """转换为字典"""
        return {
            "error_type": self.error_type,
            "message": self.message,
            "component": self.component,
            "timestamp": self.timestamp,
            "recoverable": self.recoverable,
        }


@dataclass
class ComponentDependency:
    """组件依赖关系"""

    component_name: str
    """依赖的组件名称"""

    required: bool = True
    """是否为强依赖（强依赖失败则本组件也失败）"""

    version: str = "*"
    """依赖的版本要求"""


@dataclass
class ComponentResult:
    """组件执行结果"""

    component_name: str
    """组件名称"""

    status: ComponentStatus = ComponentStatus.PENDING
    """执行状态"""

    execution_time_ms: float = 0.0
    """执行耗时（毫秒）"""

    output: dict[str, Any] = field(default_factory=dict)
    """输出数据"""

    error: ErrorInfo | None = None
    """错误信息（如有）"""

    degraded: bool = False
    """是否降级运行"""

    degradation_reason: str | None = None
    """降级原因"""

    from_cache: bool = False
    """是否来自缓存"""

    def is_success(self) -> bool:
        """是否成功（包括降级成功）"""
        return self.status in (ComponentStatus.SUCCESS, ComponentStatus.DEGRADED)

    def to_dict(self) -> dict[str, Any]:
        """转换为字典"""
        return {
            "component_name": self.component_name,
            "status": self.status.value,
            "execution_time_ms": self.execution_time_ms,
            "degraded": self.degraded,
            "from_cache": self.from_cache,
            "has_error": self.error is not None,
        }


@dataclass
class ComponentMetrics:
    """组件性能指标"""

    component_name: str
    """组件名称"""

    total_executions: int = 0
    """总执行次数"""

    successful_executions: int = 0
    """成功执行次数"""

    failed_executions: int = 0
    """失败执行次数"""

    degraded_executions: int = 0
    """降级执行次数"""

    total_time_ms: float = 0.0
    """总执行时间（毫秒）"""

    avg_time_ms: float = 0.0
    """平均执行时间（毫秒）"""

    min_time_ms: float = 0.0
    """最小执行时间（毫秒）"""

    max_time_ms: float = 0.0
    """最大执行时间（毫秒）"""

    cache_hits: int = 0
    """缓存命中次数"""

    def record_execution(self, result: ComponentResult) -> None:
        """记录一次执行结果"""
        self.total_executions += 1

        if result.status == ComponentStatus.SUCCESS:
            self.successful_executions += 1
        elif result.status == ComponentStatus.FAILED:
            self.failed_executions += 1
        elif result.status == ComponentStatus.DEGRADED:
            self.degraded_executions += 1

        if result.from_cache:
            self.cache_hits += 1

        self.total_time_ms += result.execution_time_ms
        if self.total_executions == 1:
            self.min_time_ms = result.execution_time_ms
            self.max_time_ms = result.execution_time_ms
        else:
            self.min_time_ms = min(self.min_time_ms, result.execution_time_ms)
            self.max_time_ms = max(self.max_time_ms, result.execution_time_ms)

        self.avg_time_ms = self.total_time_ms / self.total_executions

    @property
    def success_rate(self) -> float:
        """成功率"""
        if self.total_executions == 0:
            return 0.0
        return self.successful_executions / self.total_executions

    @property
    def cache_hit_rate(self) -> float:
        """缓存命中率"""
        if self.total_executions == 0:
            return 0.0
        return self.cache_hits / self.total_executions


@dataclass
class CacheMetrics:
    """缓存指标"""

    total_requests: int = 0
    """总请求次数"""

    cache_hits: int = 0
    """缓存命中次数"""

    cache_misses: int = 0
    """缓存未命中次数"""

    total_saved_time_ms: float = 0.0
    """总共节省的时间（毫秒）"""

    cache_size: int = 0
    """当前缓存条目数"""

    max_cache_size: int = 0
    """最大缓存条目数"""

    evictions: int = 0
    """缓存淘汰次数"""

    @property
    def hit_rate(self) -> float:
        """缓存命中率"""
        if self.total_requests == 0:
            return 0.0
        return self.cache_hits / self.total_requests

    def record_hit(self, saved_time_ms: float = 0.0) -> None:
        """记录一次缓存命中"""
        self.total_requests += 1
        self.cache_hits += 1
        self.total_saved_time_ms += saved_time_ms

    def record_miss(self) -> None:
        """记录一次缓存未命中"""
        self.total_requests += 1
        self.cache_misses += 1

    def record_eviction(self) -> None:
        """记录一次缓存淘汰"""
        self.evictions += 1


@dataclass
class BuildStatistics:
    """构建统计信息"""

    total_builds: int = 0
    """总构建次数"""

    successful_builds: int = 0
    """成功构建次数"""

    partial_builds: int = 0
    """部分成功构建次数"""

    failed_builds: int = 0
    """失败构建次数"""

    total_time_ms: float = 0.0
    """总构建时间（毫秒）"""

    avg_time_ms: float = 0.0
    """平均构建时间（毫秒）"""

    min_time_ms: float = 0.0
    """最小构建时间（毫秒）"""

    max_time_ms: float = 0.0
    """最大构建时间（毫秒）"""

    avg_total_tokens: float = 0.0
    """平均Token数"""

    cache_metrics: CacheMetrics = field(default_factory=CacheMetrics)
    """缓存指标"""

    component_metrics: dict[str, ComponentMetrics] = field(default_factory=dict)
    """各组件指标"""

    def record_build(self, result: "ContextBuildResult") -> None:
        """记录一次构建结果"""
        self.total_builds += 1

        if result.status == BuildStatus.SUCCESS:
            self.successful_builds += 1
        elif result.status == BuildStatus.PARTIAL:
            self.partial_builds += 1
        elif result.status == BuildStatus.FAILED:
            self.failed_builds += 1

        self.total_time_ms += result.build_time_ms
        if self.total_builds == 1:
            self.min_time_ms = result.build_time_ms
            self.max_time_ms = result.build_time_ms
        else:
            self.min_time_ms = min(self.min_time_ms, result.build_time_ms)
            self.max_time_ms = max(self.max_time_ms, result.build_time_ms)

        self.avg_time_ms = self.total_time_ms / self.total_builds

        # 更新组件指标
        for comp_name, comp_result in result.component_results.items():
            if comp_name not in self.component_metrics:
                self.component_metrics[comp_name] = ComponentMetrics(
                    component_name=comp_name
                )
            self.component_metrics[comp_name].record_execution(comp_result)

    def get_component_stats(self, component_name: str) -> ComponentMetrics | None:
        """获取指定组件的统计信息"""
        return self.component_metrics.get(component_name)

    @property
    def success_rate(self) -> float:
        """总体成功率（包括部分成功）"""
        if self.total_builds == 0:
            return 0.0
        return (self.successful_builds + self.partial_builds) / self.total_builds


# ============================================================================
# 请求和响应数据类
# ============================================================================


@dataclass
class ContextBuildRequest:
    """上下文构建请求"""

    # 基础信息
    user_input: str
    """用户输入"""

    session_id: str = "default"
    """会话ID"""

    scene: str = "daily"
    """场景类型"""

    # 系统Prompt相关
    system_prompt: str = ""
    """基础系统Prompt"""

    persona_summary: str = ""
    """人格摘要（可选，自动获取）"""

    tone_instruction: str = ""
    """语气指令（可选，自动获取）"""

    # 记忆相关
    use_memory: bool = True
    """是否使用记忆"""

    memory_limit: int = 5
    """记忆条数限制"""

    memory_types: list[str] | None = None
    """记忆类型过滤"""

    # 历史消息相关
    history: list[dict[str, str]] | None = None
    """历史消息"""

    history_limit: int = 20
    """历史消息条数限制"""

    # 上下文文件相关
    use_file_context: bool = True
    """是否使用文件上下文"""

    context_files: list[str] | None = None
    """指定上下文文件"""

    # @引用相关
    resolve_references: bool = True
    """是否解析@引用"""

    # 优化相关
    use_compression: bool = True
    """是否启用压缩"""

    use_attention_focus: bool = True
    """是否启用注意力聚焦"""

    max_tokens: int = 8000
    """最大Token数"""

    # 缓存相关
    use_cache: bool = True
    """是否使用缓存"""

    cache_ttl: int = 300
    """缓存TTL（秒）"""

    # 其他
    metadata: dict[str, Any] = field(default_factory=dict)
    """元数据"""

    def get_cache_key(self) -> str:
        """生成缓存键

        基于请求的核心内容生成哈希值
        """
        key_parts = [
            self.user_input,
            self.scene,
            self.system_prompt,
            str(self.use_memory),
            str(self.memory_limit),
            str(self.use_file_context),
            str(self.use_compression),
            str(self.max_tokens),
        ]

        if self.history:
            # 只取最后几条历史消息参与哈希
            recent_history = self.history[-3:] if len(self.history) > 3 else self.history
            key_parts.append(str(recent_history))

        key_string = "|".join(key_parts)
        return hashlib.md5(key_string.encode("utf-8")).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        """转换为字典（用于日志等）"""
        return {
            "session_id": self.session_id,
            "scene": self.scene,
            "user_input_length": len(self.user_input),
            "history_length": len(self.history) if self.history else 0,
            "use_memory": self.use_memory,
            "use_file_context": self.use_file_context,
            "use_compression": self.use_compression,
            "max_tokens": self.max_tokens,
        }


@dataclass
class ContextBuildResult:
    """上下文构建结果"""

    # 核心输出
    messages: list[dict[str, str]] = field(default_factory=list)
    """最终的消息列表"""

    system_prompt: str = ""
    """系统Prompt（单独提取）"""

    history: list[dict[str, str]] = field(default_factory=list)
    """历史消息（单独提取）"""

    # Token统计
    total_tokens: int = 0
    """总Token数"""

    system_tokens: int = 0
    """系统Prompt Token数"""

    history_tokens: int = 0
    """历史消息 Token数"""

    memory_tokens: int = 0
    """记忆 Token数"""

    context_tokens: int = 0
    """上下文 Token数"""

    # 组件执行结果
    component_results: dict[str, ComponentResult] = field(default_factory=dict)
    """各组件执行结果"""

    # 构建统计
    build_time_ms: float = 0.0
    """总构建耗时（毫秒）"""

    from_cache: bool = False
    """是否来自缓存"""

    # 状态
    status: BuildStatus = BuildStatus.SUCCESS
    """构建状态"""

    errors: list[ErrorInfo] = field(default_factory=list)
    """错误列表"""

    warnings: list[str] = field(default_factory=list)
    """警告列表"""

    # 请求引用
    request: ContextBuildRequest | None = None
    """原始请求引用"""

    def is_success(self) -> bool:
        """是否成功（包括部分成功）"""
        return self.status in (BuildStatus.SUCCESS, BuildStatus.PARTIAL)

    def get_successful_components(self) -> list[str]:
        """获取成功执行的组件列表"""
        return [
            name
            for name, result in self.component_results.items()
            if result.is_success()
        ]

    def get_failed_components(self) -> list[str]:
        """获取失败的组件列表"""
        return [
            name
            for name, result in self.component_results.items()
            if result.status == ComponentStatus.FAILED
        ]

    def get_degraded_components(self) -> list[str]:
        """获取降级的组件列表"""
        return [
            name
            for name, result in self.component_results.items()
            if result.degraded
        ]

    def to_dict(self) -> dict[str, Any]:
        """转换为字典（用于日志等）"""
        return {
            "status": self.status.value,
            "build_time_ms": self.build_time_ms,
            "total_tokens": self.total_tokens,
            "message_count": len(self.messages),
            "from_cache": self.from_cache,
            "successful_components": len(self.get_successful_components()),
            "failed_components": len(self.get_failed_components()),
            "degraded_components": len(self.get_degraded_components()),
        }


# ============================================================================
# 构建上下文（组件间数据传递）
# ============================================================================


@dataclass
class BuildContext:
    """构建上下文（组件间数据传递）"""

    request: ContextBuildRequest
    """原始构建请求"""

    # 各组件输出的数据
    component_outputs: dict[str, dict[str, Any]] = field(default_factory=dict)

    # 累积的消息列表
    messages: list[dict[str, str]] = field(default_factory=list)

    # Token使用情况
    tokens_used: int = 0
    token_budget: int = 0

    # 构建状态
    current_component: str = ""
    component_results: dict[str, ComponentResult] = field(default_factory=dict)

    # 错误收集
    errors: list[ErrorInfo] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def get_output(self, component_name: str) -> dict[str, Any] | None:
        """获取指定组件的输出

        Args:
            component_name: 组件名称

        Returns:
            组件输出数据，如果组件未执行则返回None
        """
        return self.component_outputs.get(component_name)

    def set_output(self, component_name: str, output: dict[str, Any]) -> None:
        """设置组件输出

        Args:
            component_name: 组件名称
            output: 输出数据
        """
        self.component_outputs[component_name] = output

    def add_message(self, role: str, content: str) -> None:
        """添加消息到消息列表

        Args:
            role: 消息角色（system/user/assistant）
            content: 消息内容
        """
        self.messages.append({"role": role, "content": content})

    def add_error(self, error: ErrorInfo) -> None:
        """添加错误信息

        Args:
            error: 错误信息
        """
        self.errors.append(error)

    def add_warning(self, warning: str) -> None:
        """添加警告信息

        Args:
            warning: 警告信息
        """
        self.warnings.append(warning)

    def has_component_output(self, component_name: str) -> bool:
        """检查组件是否有输出

        Args:
            component_name: 组件名称

        Returns:
            是否有输出
        """
        return component_name in self.component_outputs

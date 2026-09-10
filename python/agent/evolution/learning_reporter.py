"""
学习状态报告生成器

【功能】
生成人类可读的学习状态报告，让用户看到系统的学习效果和进步

【设计原则】
- 数据驱动：基于真实的进化指标数据
- 可视化：使用 ASCII 图表和进度条展示趋势
- 激励性：突出进步和成就，增强用户信心
- 简洁明了：重点信息突出，不堆砌数据

【使用场景】
- CLI status 命令增强
- 仪表盘展示
- 学习进度通知

@module learning_reporter
@version 0.1.0
@status Beta - 功能基本完成，测试中
@since 2026-06-24
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("learning_reporter")


# ========== 常量定义 ==========

# 报告分隔线长度
REPORT_SEPARATOR_LENGTH = 40

# 最大显示成就数
MAX_ACHIEVEMENTS_COUNT = 5

# 百次交互成就阈值
ACHIEVEMENT_INTERACTIONS_100 = 100

# 千次交互成就阈值
ACHIEVEMENT_INTERACTIONS_1000 = 1000

# 优化新手成就阈值
ACHIEVEMENT_OPTIMIZATIONS_10 = 10

# 优化大师成就阈值
ACHIEVEMENT_OPTIMIZATIONS_100 = 100

# 高质量成就阈值（质量评分）
ACHIEVEMENT_HIGH_QUALITY_THRESHOLD = 0.8

# Sparkline 块字符集
SPARKLINE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

# 默认数值
DEFAULT_NUMBER = 0

# 默认字符串
DEFAULT_STRING = "-"


@dataclass
class UnifiedEvolutionMetrics:
    """统一进化指标数据"""
    # 概览
    total_interactions: int = 0
    total_optimizations: int = 0
    average_quality_score: float = 0.0
    engines_active: list[str] = field(default_factory=list)

    # 质量
    current_quality: float = 0.0
    quality_trend: str = "stable"
    failure_rate: float = 0.0
    recent_scores: list[float] = field(default_factory=list)

    # 性能
    average_response_time: float = 0.0
    p95_response_time: float = 0.0
    throughput: float = 0.0

    # 优化周期
    cycles_today: int = 0
    total_cycles: int = 0
    optimization_success_rate: float = 0.0

    # 进化指标（V1）
    v1_total_feedback: int = 0
    v1_successful_optimizations: int = 0
    v1_failed_optimizations: int = 0
    v1_weekly_success_rate: float = 0.0

    # 代码进化指标（V2）
    v2_total_evolutions: int = 0
    v2_success_rate: float = 0.0
    v2_average_duration: float = 0.0
    v2_rollback_rate: float = 0.0
    v2_quality_improvement: float = 0.0

    # 记忆统计
    short_term_memory_count: int = 0
    long_term_memory_count: int = 0
    memory_growth_rate: float = 0.0

    # 工具统计
    tool_success_rate: float = 0.0
    average_tool_duration: float = 0.0
    top_tools: list[dict[str, Any]] = field(default_factory=list)

    # 技能统计
    skills_mastered: int = 0
    evolution_generations: int = 0


class LearningStatusReporter:
    """学习状态报告生成器"""

    @staticmethod
    def generate_report(metrics: UnifiedEvolutionMetrics | None) -> str:
        """
        生成完整的学习状态报告

        【健壮性设计】
        - 传入 None 返回空报告
        - 缺失字段使用默认值，不抛出错误
        - 异常数值（NaN、Infinity）安全处理
        - 确保任何输入都不会导致崩溃
        """
        # 空值保护
        if not metrics:
            return "\n  ⚠️ 暂无学习数据\n"

        lines: list[str] = []

        # 安全数值获取函数
        def safe_num(val: float | int | None, def_val: float = 0.0) -> float:
            if val is None:
                return def_val
            if not isinstance(val, (int, float)):
                return def_val
            if val != val:  # NaN check
                return def_val
            if val == float("inf") or val == float("-inf"):
                return def_val
            return float(val)

        # 安全字符串获取函数
        def safe_str(val: str | None, def_val: str = "-") -> str:
            return val or def_val

        # 安全数组获取函数
        def safe_arr(val: list[Any] | None, def_val: list[Any] | None = None) -> list[Any]:
            if def_val is None:
                def_val = []
            return val if isinstance(val, list) else def_val

        lines.append("")
        lines.append("  📊 学习状态报告")
        lines.append("  " + "─" * 40)

        # 概览部分
        lines.append("")
        lines.append("  📈 总体概览")
        lines.append(f"    总交互次数: {safe_num(metrics.total_interactions):.0f}")
        lines.append(f"    总优化次数: {safe_num(metrics.total_optimizations):.0f}")
        lines.append(f"    平均质量评分: {safe_num(metrics.average_quality_score) * 100:.1f}%")
        engines = safe_arr(metrics.engines_active)
        lines.append(
            f"    活跃引擎: {', '.join(engines) if engines else '-'}"
        )

        # 质量趋势
        lines.append("")
        lines.append("  🎯 质量趋势")
        lines.append(f"    当前状态: {safe_num(metrics.current_quality):.2f}")
        lines.append(
            f"    趋势方向: {LearningStatusReporter._get_trend_icon(metrics.quality_trend)} "
            f"{LearningStatusReporter._get_trend_text(metrics.quality_trend)}"
        )
        lines.append(f"    失败率: {safe_num(metrics.failure_rate) * 100:.1f}%")

        # 质量趋势图（ASCII）
        recent_scores = safe_arr(metrics.recent_scores)
        if recent_scores:
            lines.append("")
            lines.append("    近期质量趋势:")
            lines.append("    " + LearningStatusReporter._generate_sparkline(recent_scores))

        # 性能指标
        lines.append("")
        lines.append("  ⚡ 性能表现")
        lines.append(f"    平均响应时间: {safe_num(metrics.average_response_time):.0f}ms")
        lines.append(f"    P95 响应时间: {safe_num(metrics.p95_response_time):.0f}ms")
        lines.append(f"    吞吐量: {safe_num(metrics.throughput):.1f} 次/小时")

        # 优化周期
        lines.append("")
        lines.append("  🔄 优化周期")
        lines.append(f"    今日优化: {safe_num(metrics.cycles_today):.0f} 次")
        lines.append(f"    总优化周期: {safe_num(metrics.total_cycles):.0f} 次")
        lines.append(f"    优化成功率: {safe_num(metrics.optimization_success_rate) * 100:.1f}%")

        # 进化指标（V1）
        if metrics.v1_total_feedback > 0:
            lines.append("")
            lines.append("  🧠 反馈学习（V1）")
            lines.append(f"    总反馈数: {safe_num(metrics.v1_total_feedback):.0f}")
            lines.append(f"    成功优化: {safe_num(metrics.v1_successful_optimizations):.0f}")
            lines.append(f"    失败优化: {safe_num(metrics.v1_failed_optimizations):.0f}")
            if metrics.v1_weekly_success_rate > 0:
                lines.append(
                    f"    本周成功率: {safe_num(metrics.v1_weekly_success_rate) * 100:.1f}%"
                )

        # 代码进化指标（V2）
        if metrics.v2_total_evolutions > 0:
            lines.append("")
            lines.append("  🚀 代码进化（V2）")
            lines.append(f"    总进化数: {safe_num(metrics.v2_total_evolutions):.0f}")
            lines.append(f"    成功率: {safe_num(metrics.v2_success_rate) * 100:.1f}%")
            lines.append(f"    平均耗时: {safe_num(metrics.v2_average_duration):.0f}ms")
            lines.append(f"    回滚率: {safe_num(metrics.v2_rollback_rate) * 100:.1f}%")
            lines.append(f"    质量提升: {safe_num(metrics.v2_quality_improvement):.2f}")

        # 记忆统计
        lines.append("")
        lines.append("  🧩 记忆系统")
        lines.append(f"    短期记忆: {safe_num(metrics.short_term_memory_count):.0f} 条")
        lines.append(f"    长期记忆: {safe_num(metrics.long_term_memory_count):.0f} 条")
        lines.append(f"    记忆增长率: {safe_num(metrics.memory_growth_rate) * 100:.1f}%")

        # 工具统计
        lines.append("")
        lines.append("  🔧 工具使用")
        lines.append(f"    工具成功率: {safe_num(metrics.tool_success_rate) * 100:.1f}%")
        lines.append(f"    平均工具耗时: {safe_num(metrics.average_tool_duration):.0f}ms")
        if metrics.top_tools:
            lines.append("    Top 工具:")
            for i, tool in enumerate(metrics.top_tools[:5]):
                tool_name = tool.get("tool_name", "unknown")
                calls = tool.get("calls", 0)
                success_rate = tool.get("success_rate", 0)
                lines.append(
                    f"      {i + 1}. {tool_name} ({calls}次, "
                    f"{success_rate * 100:.0f}%成功)"
                )

        # 技能统计
        lines.append("")
        lines.append("  🎓 技能掌握")
        lines.append(f"    已掌握技能: {safe_num(metrics.skills_mastered):.0f} 个")
        lines.append(f"    进化代数: {safe_num(metrics.evolution_generations):.0f} 代")

        # 成就和里程碑
        lines.append("")
        lines.append("  🏆 学习成就")
        achievements = LearningStatusReporter._get_achievements(metrics)
        for achievement in achievements:
            lines.append(f"    {achievement}")

        lines.append("")
        lines.append("  " + "─" * 40)
        lines.append("  💡 系统在持续学习和进步中...")
        lines.append("")

        return "\n".join(lines)

    @staticmethod
    def generate_summary(metrics: UnifiedEvolutionMetrics | None) -> str:
        """生成简洁的状态摘要"""
        if not metrics:
            return "学习状态: 暂无数据"

        quality_percent = metrics.average_quality_score * 100
        trend = LearningStatusReporter._get_trend_icon(metrics.quality_trend)
        optimizations = metrics.total_optimizations
        engines_count = len(metrics.engines_active) if metrics.engines_active else 0

        return (
            f"学习状态: 质量 {quality_percent:.0f}% {trend} | "
            f"已优化 {optimizations:.0f} 次 | 活跃引擎 {engines_count} 个"
        )

    @staticmethod
    def _get_trend_icon(trend: str) -> str:
        """获取趋势图标"""
        trend_map = {
            "improving": "📈",
            "declining": "📉",
            "stable": "➡️",
        }
        return trend_map.get(trend, "➡️")

    @staticmethod
    def _get_trend_text(trend: str) -> str:
        """获取趋势文本"""
        trend_map = {
            "improving": "持续提升",
            "declining": "有所下降",
            "stable": "保持稳定",
        }
        return trend_map.get(trend, "未知")

    @staticmethod
    def _generate_sparkline(values: list[float]) -> str:
        """生成 ASCII 迷你图（Sparkline）"""
        if not values:
            return ""

        blocks = SPARKLINE_BLOCKS
        min_val = min(values)
        max_val = max(values)
        value_range = max_val - min_val or 1

        sparkline = ""
        for value in values:
            normalized = (value - min_val) / value_range
            index = min(int(normalized * (len(blocks) - 1)), len(blocks) - 1)
            sparkline += blocks[index]

        # 添加数值标签
        sparkline += f"  {min_val * 100:.0f}% → {max_val * 100:.0f}%"

        return sparkline

    @staticmethod
    def _get_achievements(metrics: UnifiedEvolutionMetrics | None) -> list[str]:
        """获取学习成就列表"""
        achievements: list[str] = []

        if not metrics:
            achievements.append("🌱 学习中：系统正在积累经验...")
            achievements.append("   💡 多与系统互动，帮助它学习成长")
            return achievements

        total_interactions = metrics.total_interactions
        total_optimizations = metrics.total_optimizations
        current_quality = metrics.current_quality
        quality_trend = metrics.quality_trend

        # 基于交互次数的成就
        if total_interactions >= 100:
            achievements.append("🌟 百次交互：已完成 100 次交互")
        if total_interactions >= 1000:
            achievements.append("💎 千次交互：已完成 1000 次交互")

        # 基于优化次数的成就
        if total_optimizations >= 10:
            achievements.append("🔧 优化新手：完成 10 次优化")
        if total_optimizations >= 100:
            achievements.append("⚙️ 优化大师：完成 100 次优化")

        # 基于质量的成就
        if current_quality >= 0.8:
            achievements.append("✨ 高质量：质量评分达到 80% 以上")
        if quality_trend == "improving":
            achievements.append("📈 持续进步：质量呈上升趋势")

        # 基于代码进化的成就
        if metrics.v2_total_evolutions >= 1:
            achievements.append("🧬 首次进化：完成第一次代码自我进化")

        # 基于技能的成就
        if metrics.skills_mastered >= 5:
            achievements.append("🎓 技能达人：掌握 5 个以上技能")

        # 如果没有成就，给个鼓励
        if not achievements:
            achievements.append("🌱 学习中：系统正在积累经验...")
            achievements.append("   💡 多与系统互动，帮助它学习成长")

        return achievements[:MAX_ACHIEVEMENTS_COUNT]

    @staticmethod
    def log_report(metrics: UnifiedEvolutionMetrics) -> None:
        """打印学习状态报告到日志"""
        report = LearningStatusReporter.generate_report(metrics)
        log.info(report)

    @staticmethod
    def build_metrics_from_sources(
        evolution_metrics: Any = None,
        memory_stats: dict[str, Any] | None = None,
        loop_stats: Any = None,
        feedback_stats: Any = None,
    ) -> UnifiedEvolutionMetrics:
        """
        从多个数据源构建统一的进化指标

        参数:
            evolution_metrics: 进化引擎的指标数据
            memory_stats: 记忆系统的统计数据
            loop_stats: 循环观察者的统计数据
            feedback_stats: 隐式反馈的统计数据
        """
        metrics = UnifiedEvolutionMetrics()

        # 从进化引擎获取数据
        if evolution_metrics:
            metrics.total_interactions = getattr(evolution_metrics, "total_interactions", 0)
            metrics.total_optimizations = getattr(evolution_metrics, "total_evolutions", 0)
            metrics.average_quality_score = getattr(evolution_metrics, "average_quality", 0.0)
            metrics.current_quality = getattr(evolution_metrics, "average_quality", 0.0)
            metrics.quality_trend = getattr(evolution_metrics, "quality_trend", "stable")
            metrics.recent_scores = getattr(evolution_metrics, "recent_quality_scores", [])
            metrics.engines_active = ["v1_evolution"]

            # V1 反馈数据
            metrics.v1_total_feedback = getattr(evolution_metrics, "total_interactions", 0)
            metrics.v1_successful_optimizations = getattr(
                evolution_metrics, "successful_evolutions", 0
            )
            metrics.v1_failed_optimizations = (
                getattr(evolution_metrics, "total_evolutions", 0)
                - getattr(evolution_metrics, "successful_evolutions", 0)
            )

        # 从记忆系统获取数据
        if memory_stats:
            metrics.short_term_memory_count = memory_stats.get("short_term_count", 0)
            metrics.long_term_memory_count = memory_stats.get("long_term_count", 0)
            metrics.memory_growth_rate = memory_stats.get("growth_rate", 0.0)

        # 从循环观察者获取数据
        if loop_stats:
            metrics.average_response_time = getattr(loop_stats, "average_duration", 0.0) * 1000
            metrics.tool_success_rate = getattr(loop_stats, "tool_success_rate", 0.0)
            metrics.average_tool_duration = getattr(loop_stats, "average_tool_duration", 0.0) * 1000
            metrics.total_cycles = getattr(loop_stats, "total_loops", 0)
            metrics.cycles_today = getattr(loop_stats, "total_loops", 0)  # 简化处理

        # 从隐式反馈获取数据
        if feedback_stats:
            metrics.v1_total_feedback = getattr(feedback_stats, "total_signals", 0)

        return metrics

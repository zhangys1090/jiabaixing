#!/usr/bin/env python3
"""
Agent 执行效能评估报告
=====================
分析 Hermes Agent 的执行效率、任务成功率、工具表现。

数据来源:
- 轨迹数据库: data/trajectory/trajectory.db
- 工具使用统计: data/curator/usage.json
- Skill 使用统计: data/evolution/skill-usage.json
- 进化指标: data/evolution/evolution-metrics.json

用法:
    python scripts/analyze-agent-efficiency.py [--output report.html]
"""

import json
import os
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
import logging
from typing import Optional

log = logging.getLogger(__name__)


# ======================== 基础数据模型 ========================

@dataclass
class ToolStat:
    """单个工具的统计"""
    tool_name: str
    total_calls: int = 0
    successes: int = 0
    failures: int = 0
    total_duration_ms: float = 0.0
    avg_duration_ms: float = 0.0
    success_rate: float = 0.0
    retry_count: int = 0


@dataclass
class ExecutionSummary:
    """单次执行的概要"""
    exec_id: str
    status: str  # success / failed / timeout
    quality_score: float = 0.0
    total_duration_ms: float = 0.0
    tool_calls: int = 0
    rounds_used: int = 0
    planner_time_ms: float = 0.0
    executor_time_ms: float = 0.0
    evaluator_time_ms: float = 0.0
    input_text: str = ""


@dataclass
class EfficiencyReport:
    """完整效能报告"""
    generated_at: str = ""
    total_executions: int = 0
    overall_success_rate: float = 0.0
    avg_quality_score: float = 0.0
    avg_duration_ms: float = 0.0
    median_duration_ms: float = 0.0
    p95_duration_ms: float = 0.0
    avg_tool_calls_per_exec: float = 0.0
    avg_rounds_per_exec: float = 0.0
    top_tools: list[ToolStat] = field(default_factory=list)
    tool_rankings: list[ToolStat] = field(default_factory=list)
    slowest_tools: list[ToolStat] = field(default_factory=list)
    failed_executions: list[ExecutionSummary] = field(default_factory=list)
    high_quality_executions: list[ExecutionSummary] = field(default_factory=list)
    time_distribution: dict = field(default_factory=dict)
    daily_stats: dict = field(default_factory=dict)


# ======================== 数据获取器 ========================

TRAJECTORY_DB = Path(__file__).resolve().parent.parent.parent / "data" / "trajectory" / "trajectory.db"
CURATOR_USAGE = Path(__file__).resolve().parent.parent.parent / "data" / "curator" / "usage.json"
SKILL_USAGE = Path(__file__).resolve().parent.parent.parent / "data" / "evolution" / "skill-usage.json"
EVOLUTION_METRICS = Path(__file__).resolve().parent.parent.parent / "data" / "evolution" / "evolution-metrics.json"


def query_trajectory_db():
    """从轨迹数据库获取所有数据"""
    if not TRAJECTORY_DB.exists():
        return [], {}

    conn = sqlite3.connect(str(TRAJECTORY_DB))
    conn.row_factory = sqlite3.Row

    result = {}
    try:
        # 1. 基础统计
        stats = conn.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success_count,
                AVG(quality_overall) as avg_quality,
                AVG(total_duration) as avg_duration,
                AVG(loop_rounds) as avg_rounds,
                AVG(total_tool_calls) as avg_tools,
                MIN(total_duration) as min_duration,
                MAX(total_duration) as max_duration
            FROM executions
        """).fetchone()

        result['base_stats'] = dict(stats)

        # 2. 所有执行记录
        rows = conn.execute("""
            SELECT id, status, quality_overall, total_duration, loop_rounds,
                   total_tool_calls, created_at, input
            FROM executions
            ORDER BY created_at DESC
        """).fetchall()

        executions = []
        for r in rows:
            executions.append({
                'exec_id': r['id'],
                'status': r['status'],
                'quality_score': r['quality_overall'] or 0,
                'total_duration_ms': r['total_duration'] or 0,
                'rounds_used': r['loop_rounds'] or 0,
                'tool_calls': r['total_tool_calls'] or 0,
                'created_at': r['created_at'],
                'input': r['input'] or '',
            })
        result['executions'] = executions

        # 3. 工具调用统计
        tool_rows = conn.execute("""
            SELECT tool_name,
                   COUNT(*) as total_calls,
                   SUM(CASE WHEN result_success=1 THEN 1 ELSE 0 END) as successes,
                   SUM(CASE WHEN result_success=0 THEN 1 ELSE 0 END) as failures,
                   AVG(duration) as avg_duration,
                   SUM(duration) as total_duration
            FROM tool_invocations
            GROUP BY tool_name
            ORDER BY total_calls DESC
        """).fetchall()

        tools = []
        for r in tool_rows:
            total = r['total_calls'] or 1
            succ = r['successes'] or 0
            tools.append({
                'tool_name': r['tool_name'],
                'total_calls': total,
                'successes': succ,
                'failures': r['failures'] or 0,
                'avg_duration': r['avg_duration'] or 0,
                'total_duration': r['total_duration'] or 0,
                'success_rate': succ / total if total > 0 else 0,
            })
        result['tools'] = tools

        # 4. 按天统计
        daily_rows = conn.execute("""
            SELECT DATE(datetime(created_at / 1000, 'unixepoch')) as day,
                   COUNT(*) as total,
                   SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success_count,
                   AVG(quality_overall) as avg_quality,
                   AVG(total_duration) as avg_duration
            FROM executions
            GROUP BY day
            ORDER BY day DESC
            LIMIT 30
        """).fetchall()

        result['daily'] = [dict(r) for r in daily_rows]

    finally:
        conn.close()

    return result


def load_json_file(path: Path) -> Optional[dict]:
    """安全加载 JSON 文件"""
    if not path.exists():
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        log.warning("读取JSON文件失败: %s", path, exc_info=e)
        return None


# ======================== 效能分析引擎 ========================

def analyze_efficiency(db_data: dict) -> EfficiencyReport:
    """从轨迹数据生成完整效能报告"""
    report = EfficiencyReport()
    report.generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    executions = db_data.get('executions', [])
    tools_data = db_data.get('tools', [])
    base_stats = db_data.get('base_stats', {})
    daily_data = db_data.get('daily', [])

    report.total_executions = base_stats.get('total', len(executions))
    report.overall_success_rate = (base_stats.get('success_count', 0) or 0) / max(report.total_executions, 1)
    report.avg_quality_score = base_stats.get('avg_quality', 0) or 0
    report.avg_duration_ms = base_stats.get('avg_duration', 0) or 0

    # 时长统计
    durations = sorted([e['total_duration_ms'] for e in executions if e['total_duration_ms'] > 0])
    if durations:
        report.median_duration_ms = durations[len(durations) // 2]
        p95_idx = int(len(durations) * 0.95)
        report.p95_duration_ms = durations[min(p95_idx, len(durations) - 1)]

    # 工具/轮次统计
    total_tool_calls = sum(e['tool_calls'] for e in executions)
    total_rounds = sum(e['rounds_used'] for e in executions)
    n = max(report.total_executions, 1)
    report.avg_tool_calls_per_exec = total_tool_calls / n
    report.avg_rounds_per_exec = total_rounds / n

    # 构建工具统计对象
    tool_stats = []
    for t in tools_data:
        ts = ToolStat(
            tool_name=t['tool_name'],
            total_calls=t['total_calls'],
            successes=t['successes'],
            failures=t['failures'],
            total_duration_ms=t['total_duration'],
            avg_duration_ms=t['avg_duration'],
            success_rate=t['success_rate'],
        )
        tool_stats.append(ts)

    report.top_tools = sorted(tool_stats, key=lambda x: x.total_calls, reverse=True)[:10]
    report.tool_rankings = sorted(tool_stats, key=lambda x: (x.success_rate, x.total_calls), reverse=True)[:10]
    report.slowest_tools = sorted(tool_stats, key=lambda x: x.avg_duration_ms, reverse=True)[:10]

    # 失败执行
    report.failed_executions = [
        ExecutionSummary(
            exec_id=e['exec_id'],
            status=e['status'],
            quality_score=e['quality_score'],
            total_duration_ms=e['total_duration_ms'],
            tool_calls=e['tool_calls'],
            rounds_used=e['rounds_used'],
            input_text=e['input'],
        )
        for e in executions if e['status'] != 'success'
    ][:20]

    # 高质量执行
    report.high_quality_executions = [
        ExecutionSummary(
            exec_id=e['exec_id'],
            status=e['status'],
            quality_score=e['quality_score'],
            total_duration_ms=e['total_duration_ms'],
            tool_calls=e['tool_calls'],
            rounds_used=e['rounds_used'],
            input_text=e['input'],
        )
        for e in executions if e['quality_score'] >= 0.8
    ][:20]

    # 时长分布
    report.time_distribution = {
        '<1s': sum(1 for d in durations if d < 1000),
        '1-5s': sum(1 for d in durations if 1000 <= d < 5000),
        '5-15s': sum(1 for d in durations if 5000 <= d < 15000),
        '15-60s': sum(1 for d in durations if 15000 <= d < 60000),
        '>60s': sum(1 for d in durations if d >= 60000),
    }

    # 按天统计
    for d in daily_data:
        day = d.get('day', '')
        if day:
            report.daily_stats[day] = {
                'total': d.get('total', 0),
                'success_rate': d.get('success_count', 0) / max(d.get('total', 1), 1),
                'avg_quality': d.get('avg_quality', 0) or 0,
                'avg_duration_ms': d.get('avg_duration', 0) or 0,
            }

    # 从 curator usage.json 补充数据
    curator_data = load_json_file(CURATOR_USAGE)
    if curator_data and 'tools' in curator_data:
        for tool_key, tool_info in curator_data['tools'].items():
            if isinstance(tool_info, dict) and 'use_count' in tool_info:
                # 如果数据库中没有该工具，补充进去
                existing_names = {t.tool_name for t in tool_stats}
                if tool_key not in existing_names:
                    report.top_tools.append(ToolStat(
                        tool_name=tool_key,
                        total_calls=tool_info.get('use_count', 0),
                        success_rate=tool_info.get('quality_score', 0),
                    ))

    return report


# ======================== 报告渲染器 ========================

def generate_markdown(report: EfficiencyReport) -> str:
    """生成 Markdown 格式报告"""
    lines = []
    lines.append(f"# Agent 执行效能评估报告")
    lines.append(f"\n> 生成时间: {report.generated_at}")
    lines.append("")

    # 概览
    lines.append("## 一、总体概览")
    lines.append("")
    lines.append(f"| 指标 | 数值 |")
    lines.append(f"|------|------|")
    lines.append(f"| 总执行次数 | {report.total_executions} |")
    lines.append(f"| 任务成功率 | {report.overall_success_rate:.1%} |")
    lines.append(f"| 平均质量评分 | {report.avg_quality_score:.3f} |")
    lines.append(f"| 平均执行耗时 | {report.avg_duration_ms:.0f}ms ({report.avg_duration_ms/1000:.1f}s) |")
    lines.append(f"| 中位数耗时 | {report.median_duration_ms:.0f}ms |")
    lines.append(f"| P95 耗时 | {report.p95_duration_ms:.0f}ms |")
    lines.append(f"| 平均工具调用数 | {report.avg_tool_calls_per_exec:.1f} 次/执行 |")
    lines.append(f"| 平均循环轮次 | {report.avg_rounds_per_exec:.1f} 轮/执行 |")
    lines.append("")

    # 工具表现
    lines.append("## 二、工具调用表现")
    lines.append("")

    lines.append("### 2.1 调用频次 Top 10")
    lines.append("")
    lines.append("| 工具 | 调用次数 | 成功率 | 平均耗时(ms) | 总耗时(ms) |")
    lines.append("|------|---------|--------|-------------|-----------|")
    for t in report.top_tools:
        lines.append(f"| {t.tool_name} | {t.total_calls} | {t.success_rate:.1%} | {t.avg_duration_ms:.0f} | {t.total_duration_ms:.0f} |")
    lines.append("")

    lines.append("### 2.2 成功率排名 Top 10")
    lines.append("")
    lines.append("| 工具 | 调用次数 | 成功率 | 平均耗时(ms) |")
    lines.append("|------|---------|--------|-------------|")
    ranked = [t for t in report.tool_rankings if t.total_calls >= 5]  # 至少5次调用才有统计意义
    for t in ranked[:10]:
        lines.append(f"| {t.tool_name} | {t.total_calls} | {t.success_rate:.1%} | {t.avg_duration_ms:.0f} |")
    lines.append("")

    lines.append("### 2.3 最慢工具 Top 10")
    lines.append("")
    lines.append("| 工具 | 调用次数 | 平均耗时(ms) | 成功率 |")
    lines.append("|------|---------|-------------|--------|")
    for t in report.slowest_tools[:10]:
        lines.append(f"| {t.tool_name} | {t.total_calls} | {t.avg_duration_ms:.0f} | {t.success_rate:.1%} |")
    lines.append("")

    # 执行时长分布
    lines.append("## 三、执行时长分布")
    lines.append("")
    td = report.time_distribution
    lines.append(f"- **< 1秒**: {td.get('<1s', 0)} 次")
    lines.append(f"- **1-5秒**: {td.get('1-5s', 0)} 次")
    lines.append(f"- **5-15秒**: {td.get('5-15s', 0)} 次")
    lines.append(f"- **15-60秒**: {td.get('15-60s', 0)} 次")
    lines.append(f"- **> 60秒**: {td.get('>60s', 0)} 次")
    lines.append("")

    # 最近7天趋势
    if report.daily_stats:
        lines.append("## 四、近期趋势 (近7天)")
        lines.append("")
        lines.append("| 日期 | 执行次数 | 成功率 | 平均质量 | 平均耗时(s) |")
        lines.append("|------|---------|--------|---------|-----------|")
        sorted_days = sorted(report.daily_stats.items(), key=lambda x: x[0], reverse=True)[:7]
        for day, stats in sorted_days:
            lines.append(f"| {day} | {stats['total']} | {stats['success_rate']:.1%} | {stats['avg_quality']:.3f} | {stats['avg_duration_ms']/1000:.1f} |")
        lines.append("")

    # 失败分析
    if report.failed_executions:
        lines.append("## 五、失败执行分析")
        lines.append("")
        lines.append(f"共检测到 {len(report.failed_executions)} 次失败执行，以下为最近20次：")
        lines.append("")
        for i, exec in enumerate(report.failed_executions, 1):
            lines.append(f"### {i}. {exec.exec_id[:12]}...")
            lines.append(f"- **状态**: {exec.status}")
            lines.append(f"- **质量评分**: {exec.quality_score:.3f}")
            lines.append(f"- **耗时**: {exec.total_duration_ms:.0f}ms")
            lines.append(f"- **工具调用**: {exec.tool_calls} 次, 循环轮次: {exec.rounds_used}")
            if exec.input_text:
                lines.append(f"- **输入**: {exec.input_text[:100]}{'...' if len(exec.input_text) > 100 else ''}")
            lines.append("")

    # 高质量执行
    if report.high_quality_executions:
        lines.append("## 六、高质量执行示例")
        lines.append("")
        lines.append(f"质量评分 >= 0.8 的执行共 {len(report.high_quality_executions)} 次，以下为最近20次：")
        lines.append("")
        for i, exec in enumerate(report.high_quality_executions[:20], 1):
            lines.append(f"### {i}. {exec.exec_id[:12]}... (评分: {exec.quality_score:.3f})")
            lines.append(f"- **耗时**: {exec.total_duration_ms:.0f}ms, **工具调用**: {exec.tool_calls}")
            if exec.input_text:
                lines.append(f"- **输入**: {exec.input_text[:100]}{'...' if len(exec.input_text) > 100 else ''}")
            lines.append("")

    # 优化建议
    lines.append("## 七、优化建议")
    lines.append("")
    lines.append(generate_suggestions(report))
    lines.append("")

    return "\n".join(lines)


def generate_suggestions(report: EfficiencyReport) -> str:
    """基于数据分析生成优化建议"""
    suggestions = []

    # 成功率低于80%
    if report.overall_success_rate < 0.8:
        suggestions.append(
            f"**[P0] 任务成功率偏低 ({report.overall_success_rate:.1%})** "
            f"- 当前成功率低于80%警戒线，建议优先排查失败执行的根本原因"
        )

    # 识别低成功率工具
    low_perf_tools = [t for t in report.tool_rankings if t.success_rate < 0.7 and t.total_calls >= 5]
    if low_perf_tools:
        tool_names = ", ".join([f"{t.tool_name}({t.success_rate:.0%})" for t in low_perf_tools[:5]])
        suggestions.append(
            f"**[P1] 存在低成功率工具** - 以下工具成功率低于70%（基于≥5次调用）: {tool_names}"
        )

    # P95 耗时过长
    if report.p95_duration_ms > 30000:  # 30s
        suggestions.append(
            f"**[P1] P95 耗时过高 ({report.p95_duration_ms/1000:.1f}s)** "
            f"- 5%的执行超过30秒，建议优化耗时最长的工具调用"
        )

    # 平均工具调用过多
    if report.avg_tool_calls_per_exec > 10:
        suggestions.append(
            f"**[P2] 平均工具调用数偏高 ({report.avg_tool_calls_per_exec:.1f})** "
            f"- 单次执行调用过多工具，可能存在工具选择效率问题"
        )

    # 平均质量评分
    if report.avg_quality_score < 0.7:
        suggestions.append(
            f"**[P1] 平均质量评分较低 ({report.avg_quality_score:.3f})** "
            f"- 响应质量有待提升，建议检查 evaluator 评分逻辑"
        )

    # 高耗时工具
    slow_heavy = [t for t in report.slowest_tools if t.total_calls >= 10 and t.avg_duration_ms > 5000]
    if slow_heavy:
        tool_names = ", ".join([f"{t.tool_name}({t.avg_duration_ms/1000:.1f}s)" for t in slow_heavy[:3]])
        suggestions.append(
            f"**[P2] 高频工具中存在高耗时** - {tool_names}"
        )

    # 如果一切良好
    if not suggestions:
        suggestions.append("✅ 系统运行良好！所有核心指标均在健康范围内。")

    return "\n".join(f"{i+1}. {s}" for i, s in enumerate(suggestions))


def generate_html(report: EfficiencyReport) -> str:
    """生成 HTML 可视化报告"""
    md_content = generate_markdown(report)

    stats_grid = ''
    stats_cards = [
        ('总执行次数', str(report.total_executions), ''),
        ('任务成功率', f'{report.overall_success_rate:.1%}', 'green' if report.overall_success_rate >= 0.8 else 'red'),
        ('平均质量评分', f'{report.avg_quality_score:.3f}', 'blue'),
        ('平均耗时', f'{report.avg_duration_ms/1000:.1f}s', ''),
        ('中位数耗时', f'{report.median_duration_ms/1000:.1f}s', ''),
        ('P95 耗时', f'{report.p95_duration_ms/1000:.1f}s', 'red' if report.p95_duration_ms > 30000 else 'blue'),
        ('平均工具调用', f'{report.avg_tool_calls_per_exec:.1f}', ''),
        ('平均循环轮次', f'{report.avg_rounds_per_exec:.1f}', ''),
    ]
    for label, value, cls in stats_cards:
        stats_grid += f'<div class="stat-card"><div class="value {cls}">{value}</div><div class="label">{label}</div></div>\n'

    top_tools_rows = ''.join(
        f'<tr><td>{t.tool_name}</td><td>{t.total_calls}</td><td><span class="value {"green" if t.success_rate >= 0.8 else "red"}">{t.success_rate:.1%}</span></td><td>{t.avg_duration_ms:.0f}</td><td>{t.total_duration_ms:.0f}</td></tr>'
        for t in report.top_tools[:10]
    )

    ranked_rows = ''.join(
        f'<tr><td>{t.tool_name}</td><td>{t.total_calls}</td><td><span class="value green">{t.success_rate:.1%}</span></td><td>{t.avg_duration_ms:.0f}</td></tr>'
        for t in report.tool_rankings if t.total_calls >= 5
    )[:10]

    slowest_rows = ''.join(
        f'<tr><td>{t.tool_name}</td><td>{t.total_calls}</td><td>{t.avg_duration_ms:.0f}</td><td><span class="value {"red" if t.success_rate < 0.7 else "green"}">{t.success_rate:.1%}</span></td></tr>'
        for t in report.slowest_tools[:10]
    )

    md5_content = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent 效能评估报告</title>
<style>
:root {{
  --bg: #0a0a0a;
  --bg-raised: #1a1a1a;
  --text: #f0f0f0;
  --text-secondary: #a0a0a0;
  --accent: #c9956b;
  --green: #6daf7b;
  --red: #dc5050;
  --blue: #6b8fc9;
  --border: rgba(255,255,255,0.06);
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.7;
  padding: 2rem;
}}
.container {{ max-width: 960px; margin: 0 auto; }}
header {{
  text-align: center; padding-bottom: 2rem;
  border-bottom: 1px solid var(--border); margin-bottom: 2rem;
}}
header h1 {{
  font-size: 2rem; font-weight: 700;
  background: linear-gradient(135deg, #c9956b, #ddb88a);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  margin-bottom: 0.5rem;
}}
header p {{ color: var(--text-secondary); font-size: 0.9rem; }}
.section {{
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;
}}
.section h2 {{
  font-size: 1.3rem; font-weight: 600; margin-bottom: 1rem; color: var(--accent);
}}
.stats-grid {{
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem;
}}
.stat-card {{
  background: rgba(255,255,255,0.03); border: 1px solid var(--border);
  border-radius: 8px; padding: 1rem; text-align: center;
}}
.stat-card .value {{ font-size: 1.8rem; font-weight: 700; color: var(--accent); }}
.stat-card .label {{ font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem; }}
.stat-card .value.green {{ color: var(--green); }}
.stat-card .value.red {{ color: var(--red); }}
.stat-card .value.blue {{ color: var(--blue); }}
table {{ width: 100%; border-collapse: collapse; margin: 1rem 0; }}
th, td {{ padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }}
th {{ color: var(--accent); font-weight: 600; background: rgba(201, 149, 107, 0.05); }}
tr:hover {{ background: rgba(255,255,255,0.02); }}
.suggestion {{
  padding: 0.75rem 1rem; margin: 0.5rem 0; border-radius: 8px;
  border-left: 3px solid var(--accent); background: rgba(201, 149, 107, 0.05);
}}
.suggestion.P0 {{ border-left-color: var(--red); background: rgba(220,80,80,0.05); }}
.suggestion.P1 {{ border-left-color: #f0a030; background: rgba(240,160,48,0.05); }}
.suggestion.P2 {{ border-left-color: var(--blue); background: rgba(107,143,201,0.05); }}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🤖 Agent 执行效能评估报告</h1>
  <p>生成时间: {report.generated_at}</p>
</header>

<div class="section">
  <h2>📊 总体概览</h2>
  <div class="stats-grid">{stats_grid}</div>
</div>

<div class="section">
  <h2>🔧 工具调用表现</h2>
  <h3 style="color:var(--text-secondary); font-size:1rem; margin:1rem 0 0.5rem;">调用频次 Top 10</h3>
  <table>
    <thead><tr><th>工具</th><th>调用次数</th><th>成功率</th><th>平均耗时(ms)</th><th>总耗时(ms)</th></tr></thead>
    <tbody>{top_tools_rows}</tbody>
  </table>

  <h3 style="color:var(--text-secondary); font-size:1rem; margin:1.5rem 0 0.5rem;">成功率排名 Top 10 (≥5次调用)</h3>
  <table>
    <thead><tr><th>工具</th><th>调用次数</th><th>成功率</th><th>平均耗时(ms)</th></tr></thead>
    <tbody>{ranked_rows}</tbody>
  </table>

  <h3 style="color:var(--text-secondary); font-size:1rem; margin:1.5rem 0 0.5rem;">最慢工具 Top 10</h3>
  <table>
    <thead><tr><th>工具</th><th>调用次数</th><th>平均耗时(ms)</th><th>成功率</th></tr></thead>
    <tbody>{slowest_rows}</tbody>
  </table>
</div>

<div class="section">
  <h2>⏱️ 执行时长分布</h2>
  {generate_duration_chart_html(report.time_distribution, report.total_executions)}
</div>

{generate_daily_trend_html(report.daily_stats)}

<div class="section">
  <h2>💡 优化建议</h2>
  {generate_suggestions_html(report)}
</div>
</div>
</body>
</html>"""

    return md5_content

    return html


def generate_duration_chart_html(time_dist: dict, total: int) -> str:
    """生成时长分布柱状图"""
    categories = ['<1s', '1-5s', '5-15s', '15-60s', '>60s']
    colors = ['#6daf7b', '#6b8fc9', '#c9956b', '#f0a030', '#dc5050']
    bars = ''
    for i, cat in enumerate(categories):
        count = time_dist.get(cat, 0)
        pct = count / max(total, 1) * 100
        bars += f'''<div style="display:flex;align-items:center;gap:1rem;margin:0.5rem 0;">
  <div style="min-width:60px;text-align:right;font-size:0.9rem;color:var(--text-secondary);">{cat}</div>
  <div style="flex:1;height:24px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;">
    <div style="height:100%;width:{pct}%;background:{colors[i]};transition:width 0.5s;"></div>
  </div>
  <div style="min-width:80px;font-size:0.9rem;">{count} 次 ({pct:.1f}%)</div>
</div>'''
    return bars


def generate_daily_trend_html(daily_stats: dict) -> str:
    """生成每日趋势表"""
    if not daily_stats:
        return '<p style="color:var(--text-secondary)">暂无近期数据</p>'

    sorted_days = sorted(daily_stats.items(), key=lambda x: x[0], reverse=True)[:7]
    rows = ''
    for day, stats in sorted_days:
        sr = stats['success_rate']
        rows += f'''<tr>
  <td>{day}</td>
  <td>{stats['total']}</td>
  <td><span class="value {'green' if sr >= 0.8 else 'red'}">{sr:.1%}</span></td>
  <td>{stats['avg_quality']:.3f}</td>
  <td>{stats['avg_duration_ms']/1000:.1f}s</td>
</tr>'''
    return f'''<h3 style="color:var(--text-secondary);font-size:1rem;margin:1rem 0 0.5rem;">近7天趋势</h3>
<table>
<thead><tr><th>日期</th><th>执行次数</th><th>成功率</th><th>平均质量</th><th>平均耗时</th></tr></thead>
<tbody>{rows}</tbody>
</table>'''


def generate_suggestions_html(report: EfficiencyReport) -> str:
    """生成建议卡片"""
    text = generate_suggestions(report)
    cards = ''
    for line in text.split('\n'):
        if not line.strip():
            continue
        if line.startswith('[P0]'):
            severity = 'P0'
        elif line.startswith('[P1]'):
            severity = 'P1'
        elif line.startswith('[P2]'):
            severity = 'P2'
        else:
            severity = ''
        clean_line = line.replace('[P0] ', '').replace('[P1] ', '').replace('[P2] ', '')
        cards += f'<div class="suggestion {severity}">{clean_line}</div>\n'
    return cards


# ======================== 主入口 ========================

def main():
    print("=" * 60)
    print("🤖 Agent 执行效能评估")
    print("=" * 60)

    # 查询轨迹数据库
    print("\n📡 查询轨迹数据库...")
    db_data = query_trajectory_db()

    if not db_data.get('executions'):
        print("⚠️  轨迹数据库为空或不存在。请先运行一些 Agent 执行任务。")
        print(f"   数据库路径: {TRAJECTORY_DB}")
        print(f"   文件存在: {TRAJECTORY_DB.exists()}")
        sys.exit(0)

    # 分析
    print("📊 分析执行效能...")
    report = analyze_efficiency(db_data)

    # 生成报告
    output_dir = Path(__file__).resolve().parent.parent / "data" / "reports"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Markdown 报告
    md_path = output_dir / f"agent-efficiency-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"
    md_content = generate_markdown(report)
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(md_content)
    print(f"\n✅ Markdown 报告: {md_path}")

    # HTML 报告
    html_path = output_dir / f"agent-efficiency-{datetime.now().strftime('%Y%m%d-%H%M%S')}.html"
    html_content = generate_html(report)
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    print(f"✅ HTML 报告: {html_path}")

    # 控制台概览
    print("\n" + "=" * 60)
    print("📋 执行概览")
    print("=" * 60)
    print(f"  总执行次数:     {report.total_executions}")
    print(f"  任务成功率:     {report.overall_success_rate:.1%}")
    print(f"  平均质量评分:   {report.avg_quality_score:.3f}")
    print(f"  平均耗时:       {report.avg_duration_ms/1000:.1f}s")
    print(f"  P95 耗时:       {report.p95_duration_ms/1000:.1f}s")
    print(f"  平均工具调用:   {report.avg_tool_calls_per_exec:.1f} 次")
    print(f"  平均循环轮次:   {report.avg_rounds_per_exec:.1f} 轮")

    print(f"\n  调用频次 Top 5:")
    for t in report.top_tools[:5]:
        status_icon = "✅" if t.success_rate >= 0.8 else "⚠️" if t.success_rate >= 0.5 else "❌"
        print(f"    {status_icon} {t.tool_name}: {t.total_calls}次 ({t.success_rate:.1%}, 平均{t.avg_duration_ms:.0f}ms)")

    print(f"\n  优化建议:")
    for line in generate_suggestions(report).split('\n'):
        if line.strip():
            print(f"    {line}")

    print(f"\n{'=' * 60}")
    print(f"完整报告已保存到: {output_dir}")

    return report


if __name__ == "__main__":
    main()

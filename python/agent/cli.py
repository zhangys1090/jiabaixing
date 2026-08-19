"""
家百星 Agent CLI 工具

提供命令行接口，用于交互对话、查看学习状态、调试和管理。
与 Desktop GUI 和 TS CLI 共享同一 AgentEngine 后端。

使用方法:
    python -m agent.cli chat             # 交互式对话 REPL
    python -m agent.cli chat "你好"      # 单次对话
    python -m agent.cli goal             # 查看 Agent 目标达成追踪
    python -m agent.cli status           # 查看学习状态摘要
    python -m agent.cli status --detailed  # 查看详细学习状态报告
    python -m agent.cli observer         # 查看循环观察者状态
    python -m agent.cli feedback         # 查看隐式反馈统计
"""

from __future__ import annotations

import argparse
import sys


def cmd_chat(args: argparse.Namespace) -> None:
    """交互式对话或单次消息发送。

    通过 AgentEngine.process_input 处理用户输入，
    与 Desktop GUI 和 TS CLI 使用相同的引擎路径。
    """
    import asyncio

    async def _chat() -> None:
        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        await engine.initialize_v2()
        print("\n  🎯 家百星 Agent 对话模式")
        print("  " + "─" * 40)
        print("  输入消息开始对话，/quit 退出\n")

        session_id = f"cli-{id(engine)}"
        turn_count = 0

        # 单次消息模式
        if args.message:
            try:
                result = await engine.process_input(
                    message=args.message,
                    session_id=session_id,
                )
                content = result.get("content", "")
                print(f"  🤖 {content}\n")
            except Exception as e:
                print(f"  ❌ 错误: {e}\n")
            return

        # REPL 交互模式
        while True:
            try:
                user_input = input("  👤 ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n  再见！")
                break

            if not user_input:
                continue
            if user_input.lower() in ("/quit", "/exit", "/q"):
                print("  再见！")
                break
            if user_input.lower() == "/goal":
                _print_goal_stamp(engine, turn_count)
                continue
            if user_input.lower() == "/help":
                _print_help()
                continue

            try:
                result = await engine.process_input(
                    message=user_input,
                    session_id=session_id,
                )
                content = result.get("content", "")
                print(f"  🤖 {content}\n")
                turn_count += 1
            except Exception as e:
                print(f"  ❌ 错误: {e}\n")

    try:
        asyncio.run(_chat())
    except ImportError as e:
        print(f"错误: 无法导入模块 - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


def cmd_goal(args: argparse.Namespace) -> None:
    """查看 Agent 目标达成追踪和能力印记。"""
    try:
        from agent.loop.observer import LoopObserver
        from agent.evolution.implicit_feedback import ImplicitFeedbackCollector

        observer = LoopObserver.get_instance()
        feedback_collector = ImplicitFeedbackCollector.get_instance()
        loop_stats = observer.get_statistics()
        feedback_stats = feedback_collector.get_statistics()

        print("\n  🎯 Agent 目标达成追踪")
        print("  " + "─" * 40)
        print()
        print("  执行统计")
        print(f"    总循环数: {loop_stats.total_loops}")
        print(f"    成功循环: {loop_stats.successful_loops}")
        print(f"    工具调用: {loop_stats.total_tool_calls}")
        print(f"    工具成功率: {loop_stats.tool_success_rate * 100:.1f}%")
        print()
        print("  能力标签")
        print(f"    🔧 工具执行: {'已激活' if loop_stats.total_tool_calls > 0 else '待激活'}")
        print(f"    🧠 反馈收集: {'在线' if feedback_stats.total_signals > 0 else '待启动'}")
        print(f"    🎯 目标达成: {'高效' if loop_stats.total_loops > 10 else '正常' if loop_stats.total_loops > 3 else '起步中'}")
        print()

    except ImportError as e:
        print(f"错误: 无法导入模块 - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


def _print_goal_stamp(engine: object, turn_count: int) -> None:
    """在 REPL 中打印 Agent 印记。"""
    print("\n  🎯 Agent 目标达成追踪")
    print("  " + "─" * 40)
    print(f"    对话轮数: {turn_count}")
    print(f"    🔧 工具执行: {'已激活' if turn_count > 1 else '待激活'}")
    print(f"    🧠 记忆检索: {'在线' if hasattr(engine, 'memory') and engine.memory else '离线'}")
    print(f"    🎯 目标达成: {'高效' if turn_count > 3 else '正常' if turn_count > 1 else '起步中'}")
    print()


def _print_help() -> None:
    """在 REPL 中打印帮助信息。"""
    print("\n  可用命令:")
    print("    /help  - 显示帮助信息")
    print("    /goal  - 目标达成追踪与能力印记")
    print("    /quit  - 退出对话")
    print()


def cmd_status(args: argparse.Namespace) -> None:
    """查看学习状态"""
    try:
        from agent.evolution.learning_reporter import LearningStatusReporter
        from agent.loop.observer import LoopObserver
        from agent.evolution.implicit_feedback import ImplicitFeedbackCollector
        from agent.evolution.engine import EvolutionEngine

        # 初始化各组件（如果还没初始化的话）
        observer = LoopObserver.get_instance()
        feedback_collector = ImplicitFeedbackCollector.get_instance()

        # 尝试加载进化引擎状态
        evolution = EvolutionEngine()
        evolution_metrics = evolution.get_metrics()

        # 获取统计数据
        loop_stats = observer.get_statistics()
        feedback_stats = feedback_collector.get_statistics()

        # 构建统一指标
        metrics = LearningStatusReporter.build_metrics_from_sources(
            evolution_metrics=evolution_metrics,
            loop_stats=loop_stats,
            feedback_stats=feedback_stats,
        )

        # 生成报告
        if args.detailed:
            report = LearningStatusReporter.generate_report(metrics)
        else:
            report = LearningStatusReporter.generate_summary(metrics)

        print(report)

    except ImportError as e:
        print(f"错误: 无法导入模块 - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


def cmd_observer(args: argparse.Namespace) -> None:
    """查看循环观察者状态"""
    try:
        from agent.loop.observer import LoopObserver

        observer = LoopObserver.get_instance()
        stats = observer.get_statistics()

        print("\n  🔍 循环观察者状态")
        print("  " + "─" * 40)
        print(f"  启用状态: {'✅ 已启用' if observer.is_enabled() else '❌ 已禁用'}")
        print()
        print(f"  总循环数: {stats.total_loops}")
        print(f"  成功循环: {stats.successful_loops}")
        print(f"  失败循环: {stats.failed_loops}")
        print(f"  平均耗时: {stats.average_duration * 1000:.0f}ms")
        print()
        print(f"  总工具调用: {stats.total_tool_calls}")
        print(f"  工具成功率: {stats.tool_success_rate * 100:.1f}%")
        print(f"  平均工具耗时: {stats.average_tool_duration * 1000:.0f}ms")
        print()
        print("  各阶段平均耗时:")
        for phase, duration in stats.phase_durations.items():
            if duration > 0:
                print(f"    {phase}: {duration * 1000:.0f}ms")
        print()

    except ImportError as e:
        print(f"错误: 无法导入模块 - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


def cmd_feedback(args: argparse.Namespace) -> None:
    """查看隐式反馈统计"""
    try:
        from agent.evolution.implicit_feedback import ImplicitFeedbackCollector

        collector = ImplicitFeedbackCollector.get_instance()
        stats = collector.get_statistics()

        print("\n  🎯 隐式反馈统计")
        print("  " + "─" * 40)
        print(f"  启用状态: {'✅ 已启用' if collector.is_enabled() else '❌ 已禁用'}")
        print()
        print(f"  总反馈数: {stats.total_signals}")
        print(f"  正向反馈: {stats.positive_count}")
        print(f"  负向反馈: {stats.negative_count}")
        print(f"  中性反馈: {stats.neutral_count}")
        print(f"  正向比例: {collector.get_positive_ratio() * 100:.1f}%")
        print()
        print(f"  会话内反馈: {stats.session_count}")
        print(f"  平均置信度: {stats.average_confidence * 100:.1f}%")
        print()

        if stats.by_source:
            print("  按来源统计:")
            for source, count in sorted(
                stats.by_source.items(), key=lambda x: x[1], reverse=True
            ):
                print(f"    {source}: {count}")
            print()

    except ImportError as e:
        print(f"错误: 无法导入模块 - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


def main() -> None:
    """主入口函数"""
    parser = argparse.ArgumentParser(
        description="家百星 Agent CLI 工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python -m agent.cli chat               交互式对话 REPL
  python -m agent.cli chat "你好"         单次对话
  python -m agent.cli goal               查看 Agent 目标达成追踪
  python -m agent.cli status              查看学习状态摘要
  python -m agent.cli status --detailed   查看详细学习状态报告
  python -m agent.cli observer            查看循环观察者状态
  python -m agent.cli feedback            查看隐式反馈统计
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="可用命令")

    # chat 命令
    chat_parser = subparsers.add_parser("chat", help="交互式对话")
    chat_parser.add_argument(
        "message",
        nargs="?",
        default=None,
        help="单次对话消息（省略则进入 REPL 模式）",
    )
    chat_parser.set_defaults(func=cmd_chat)

    # goal 命令
    goal_parser = subparsers.add_parser("goal", help="查看 Agent 目标达成追踪")
    goal_parser.set_defaults(func=cmd_goal)

    # status 命令
    status_parser = subparsers.add_parser("status", help="查看学习状态")
    status_parser.add_argument(
        "--detailed", "-d",
        action="store_true",
        help="显示详细报告",
    )
    status_parser.set_defaults(func=cmd_status)

    # observer 命令
    observer_parser = subparsers.add_parser("observer", help="查看循环观察者状态")
    observer_parser.set_defaults(func=cmd_observer)

    # feedback 命令
    feedback_parser = subparsers.add_parser("feedback", help="查看隐式反馈统计")
    feedback_parser.set_defaults(func=cmd_feedback)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    if hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()

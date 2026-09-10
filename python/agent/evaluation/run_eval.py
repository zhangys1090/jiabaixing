"""jiabaixing Agent 评测 CLI v2 — Codex-style 命令行评测.

用法:
  python -m agent.evaluation.run_eval              # 运行全部评测
  python -m agent.evaluation.run_eval --categories safety memory  # 指定分类
  python -m agent.evaluation.run_eval --pass-k 3   # pass@3 评测
  python -m agent.evaluation.run_eval --no-regression  # 禁用回归守护
  python -m agent.evaluation.run_eval --url http://localhost:3112  # 指定URL
"""
from __future__ import annotations

import argparse
import asyncio
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="jiabaixing Agent 评测系统 v2")
    parser.add_argument(
        "--url",
        default="http://localhost:3112",
        help="Agent API 地址 (default: http://localhost:3112)",
    )
    parser.add_argument(
        "--categories",
        nargs="*",
        default=[],
        help="限定评测分类 (memory/safety/tool_use/planning/multi_step)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="并发数 (default: 3)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="单请求超时秒数 (default: 60)",
    )
    parser.add_argument(
        "--pass-k",
        type=int,
        default=1,
        help="pass@k 的 k 值 (default: 1, 即单次运行)",
    )
    parser.add_argument(
        "--no-regression",
        action="store_true",
        help="禁用回归守护",
    )
    args = parser.parse_args()

    asyncio.run(_run(args))


async def _run(args: argparse.Namespace) -> None:
    from agent.evaluation.agent_eval_system import AgentEvalSystem

    system = AgentEvalSystem(
        base_url=args.url,
        timeout=args.timeout,
        concurrency=args.concurrency,
        pass_k=args.pass_k,
        enable_regression=not args.no_regression,
    )

    categories = args.categories if args.categories else None
    print("jiabaixing Agent 评测系统 v2 (Codex-style)")
    print(f"目标: {args.url}")
    print(f"分类: {categories or '全部'}")
    print(f"pass@k: k={args.pass_k}")
    print(f"回归守护: {'关闭' if args.no_regression else '开启'}")
    print()

    report = await system.run_full_eval(categories=categories)
    print(report.summary())

    if report.total_cases == 0:
        sys.exit(1)
    if report.pass_rate < 0.5:
        sys.exit(2)
    if any(a.severity == "critical" for a in report.regression_alerts):
        sys.exit(3)


if __name__ == "__main__":
    main()

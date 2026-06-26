from __future__ import annotations

import time

from agent.loop.types import (
    AgentResult,
    LoopContext,
    ReporterOutput,
)


class Reporter:
    def report(self, context: LoopContext) -> ReporterOutput:
        last_assistant = ""
        for msg in reversed(context.messages):
            if msg.get("role") == "assistant" and msg.get("content"):
                last_assistant = msg["content"]
                break

        if not last_assistant and context.step_results:
            successful = [
                r for r in context.step_results.values() if r.success
            ]
            if successful:
                last_assistant = successful[-1].content

        steps_completed = sum(
            1 for r in context.step_results.values() if r.success
        )
        steps_total = len(context.step_results)

        quality = steps_completed / steps_total if steps_total > 0 else 0.0

        elapsed = 0.0
        if context.budget.start_time > 0:
            elapsed = (time.time() - context.budget.start_time) * 1000

        return ReporterOutput(
            response=last_assistant,
            quality_score=quality,
            steps_completed=steps_completed,
            steps_total=steps_total,
            total_duration_ms=elapsed,
        )

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("attention_focus")

_MAX_KEYWORDS = 10
_MIN_KEYWORD_LENGTH = 2
_STOP_WORDS = {
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
    "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "to",
    "of", "in", "for", "on", "with", "at", "by", "from", "as",
}


@dataclass
class MessageItem:
    role: str = ""
    content: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class AttentionWeight:
    index: int = 0
    weight: float = 0.0
    keyword_score: float = 0.0
    position_score: float = 0.0
    role_score: float = 0.0
    density_score: float = 0.0


@dataclass
class FocusResult:
    focused_messages: list[MessageItem] = field(default_factory=list)
    original_count: int = 0
    focused_count: int = 0
    reduction_ratio: float = 0.0
    total_weight: float = 0.0
    tokens_used: int = 0
    token_budget: int = 0


class AttentionFocusEngine:
    def __init__(self, llm: Any | None = None) -> None:
        self._history: list[FocusResult] = []
        self._llm = llm

    def set_llm(self, llm: Any) -> None:
        self._llm = llm

    def extract_keywords(self, task: str) -> list[str]:
        """提取关键词：优先使用 LLM 语义提取，回退到规则提取。"""
        if self._llm:
            try:
                return self._extract_keywords_semantic(task)
            except Exception as _exc:
                log_ignored(log, "attention_focus.AttentionFocusEngine.extract_keywords", _exc)
        return self._extract_keywords_rule(task)

    def _extract_keywords_semantic(self, task: str) -> list[str]:
        """P2-2: 使用 LLM 进行语义关键词提取。"""
        prompt = (
            "从以下用户任务中提取最重要的关键词（最多5个），"
            "这些关键词用于在对话历史中定位相关信息。\n"
            "只返回JSON数组，例如 [\"关键词1\", \"关键词2\"]\n\n"
            f"任务: {task[:300]}"
        )
        import asyncio
        try:
            result = asyncio.get_event_loop().run_until_complete(
                self._llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=True)
            )
            content = result.get("content", "")
            import json, re
            json_match = re.search(r'\[[\s\S]*?\]', content)
            if json_match:
                keywords = json.loads(json_match.group())
                if isinstance(keywords, list) and keywords:
                    return [str(k).strip() for k in keywords if k]
        except Exception as _exc:
            log_ignored(log, "attention_focus.AttentionFocusEngine._extract_keywords_semantic", _exc)
        return self._extract_keywords_rule(task)

    def _extract_keywords_rule(self, task: str) -> list[str]:
        """规则式关键词提取（原 extract_keywords 逻辑）。"""
        task_lower = task.lower()
        words = re.split(r"\s+|[,，。.!！?？;；:：、]", task_lower)

        word_freq: dict[str, int] = {}
        for w in words:
            w = w.strip()
            if len(w) < _MIN_KEYWORD_LENGTH or w in _STOP_WORDS:
                continue
            word_freq[w] = word_freq.get(w, 0) + 1

        path_matches = re.findall(r"[A-Za-z_][\w/\\.-]+", task_lower)
        for p in path_matches:
            if len(p) >= _MIN_KEYWORD_LENGTH:
                word_freq[p] = word_freq.get(p, 0) + 1

        sorted_words = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)
        return [w for w, c in sorted_words[:_MAX_KEYWORDS]]

    def calculate_weights(
        self,
        messages: list[MessageItem],
        current_task: str,
    ) -> list[AttentionWeight]:
        keywords = self.extract_keywords(current_task)
        total = len(messages)
        if not total or not keywords:
            return [AttentionWeight(index=i) for i in range(total)]

        weights: list[AttentionWeight] = []

        for i, msg in enumerate(messages):
            content = (msg.content or "").lower()

            match_count = sum(1 for k in keywords if k.lower() in content)
            keyword_score = (match_count / max(len(keywords), 1)) * 0.6

            position_weight = (i + 1) / total
            position_score = position_weight * 0.1

            role_score = 0.1 if msg.role == "user" else 0.0

            has_path = bool(re.search(r"/[\w/\-\\.]+", content))
            has_error = bool(re.search(r"error|fail|错误|失败|exception", content))
            has_number = bool(re.search(r"\d+", content))

            density_score = 0.0
            if has_path:
                density_score += 0.08
            if has_error:
                density_score += 0.07
            if has_number:
                density_score += 0.05

            total_weight = min(keyword_score + position_score + role_score + density_score, 1.0)

            weights.append(AttentionWeight(
                index=i,
                weight=total_weight,
                keyword_score=keyword_score,
                position_score=position_score,
                role_score=role_score,
                density_score=density_score,
            ))

        return weights

    def focus(
        self,
        messages: list[MessageItem],
        current_task: str,
        token_budget: int,
        tokens_per_char: float = 0.25,
    ) -> FocusResult:
        original_count = len(messages)
        if not messages:
            return FocusResult(original_count=0, token_budget=token_budget)

        weights = self.calculate_weights(messages, current_task)

        indexed = [
            {"msg": m, "weight": w.weight, "original_index": i}
            for i, (m, w) in enumerate(zip(messages, weights))
        ]
        indexed.sort(key=lambda x: x["weight"], reverse=True)

        selected: list[MessageItem] = []
        used_tokens = 0

        for item in indexed:
            content = item["msg"].content or ""
            msg_tokens = int(len(content) * tokens_per_char) + 10

            if used_tokens + msg_tokens > token_budget:
                continue

            selected.append(item["msg"])
            used_tokens += msg_tokens

        selected_set = {id(m) for m in selected}

        focused_messages = [m for m in messages if id(m) in selected_set]
        focused_messages.sort(key=lambda m: next(
            i for i, orig in enumerate(messages) if id(orig) == id(m)
        ))

        total_w = sum(w.weight for w in weights if any(
            id(m) == id(focused) for m in messages for focused in focused_messages if id(m) == id(focused)
        ))
        total_w = sum(w.weight for w, m in zip(weights, messages) if id(m) in selected_set)

        result = FocusResult(
            focused_messages=focused_messages,
            original_count=original_count,
            focused_count=len(focused_messages),
            reduction_ratio=round(1 - len(focused_messages) / max(original_count, 1), 3),
            total_weight=round(total_w, 3),
            tokens_used=used_tokens,
            token_budget=token_budget,
        )

        log.info(
            "Focus completed",
            original=original_count,
            focused=len(focused_messages),
            ratio=result.reduction_ratio,
        )

        self._history.append(result)
        if len(self._history) > 100:
            self._history = self._history[-100:]

        return result

    def get_history(self, limit: int = 50) -> list[FocusResult]:
        return self._history[-limit:]

    def get_stats(self) -> dict[str, Any]:
        if not self._history:
            return {"total_focuses": 0, "avg_reduction": 0.0}

        total = len(self._history)
        avg_reduction = sum(r.reduction_ratio for r in self._history) / total
        avg_ratio = sum(r.focused_count / max(r.original_count, 1) for r in self._history) / total

        return {
            "total_focuses": total,
            "avg_reduction": round(avg_reduction, 3),
            "avg_focus_ratio": round(avg_ratio, 3),
        }

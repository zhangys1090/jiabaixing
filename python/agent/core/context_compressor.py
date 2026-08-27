from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.token_counter import TokenCounter, get_token_counter
log = StructuredLogger("context_compressor")



@dataclass
class CompressionResult:
    """上下文压缩结果。

    Attributes:
        original_tokens: 压缩前 Token 数。
        compressed_tokens: 压缩后 Token 数。
        ratio: 压缩率（compressed / original）。
        strategy: 使用的压缩策略名称。
        removed_messages: 移除的消息数。
        summary: 历史摘要文本。
        attention_keywords: 注意力关键词列表。
    """

    original_tokens: int
    compressed_tokens: int
    ratio: float
    strategy: str
    removed_messages: int = 0
    summary: str = ""
    attention_keywords: list[str] = field(default_factory=list)
    compressed_messages: list[dict[str, Any]] | None = None


class ContextCompressor:
    """上下文压缩器 — 多策略 Token 预算管理。

    当对话上下文超出 Token 预算时，按优先级依次尝试四种压缩策略：
    1. 截断工具输出（_strategy_truncate_tool_output）
    2. 移除旧工具结果（_strategy_remove_old_tool_results）
    3. 摘要早期历史（_strategy_summarize_early_history）
    4. 仅保留最近消息（_strategy_keep_recent_only）

    支持注意力聚焦模式（compress_with_attention），结合记忆检索
    结果和关键词提取，优先保留与当前对话相关的上下文。

    压缩质量回验：
    - 关键实体保留检查：提取原文中的类名/函数名/变量名，验证压缩后是否仍包含
    - 压缩率合理性检查：压缩后文本超过原文80%说明压缩效果差
    - 关键信息标记：支持用 <!-- key:xxx --> 标记不可丢弃的信息
    - 质量不通过时回退到原始文本截断版本

    Usage:
        compressor = ContextCompressor(max_context_tokens=8000)
        result = compressor.compress(messages, target_tokens=5000)
        logger.info("压缩率: {result.ratio:.2f}, 策略: {result.strategy}")
    """

    def __init__(
        self,
        max_context_tokens: int = 8000,
        reserve_ratio: float = 0.3,
        model: str = "gpt-4o",
        use_precise: bool = True,
    ) -> None:
        """初始化上下文压缩器。

        Args:
            max_context_tokens: 最大上下文 Token 数。
            reserve_ratio: 保留比例（为 LLM 生成预留的空间）。
            model: 模型名称（用于 tiktoken 编码器选择）。
            use_precise: 是否使用精确 Token 计数（tiktoken），False 时回退到近似估算。
        """
        self._max_tokens = max_context_tokens
        self._reserve_ratio = reserve_ratio
        self._model = model
        self._use_precise = use_precise
        self._token_counter: TokenCounter | None = None
        if use_precise and TokenCounter.is_available():
            self._token_counter = TokenCounter(model=model)
            log.debug("ContextCompressor using precise token counting", model=model)
        else:
            log.debug("ContextCompressor using approximate token counting")

    def estimate_tokens(self, text: str) -> int:
        """估算文本的 Token 数。

        优先使用 tiktoken 精确计数，不可用时回退到中英文混合近似估算。

        Args:
            text: 输入文本。

        Returns:
            int: 估算的 Token 数（最小为 1）。
        """
        if self._token_counter is not None:
            return self._token_counter.count_tokens(text)
        return self._approximate_tokens(text)

    @staticmethod
    def _approximate_tokens(text: str) -> int:
        """中/日/韩混合近似 Token 估算。

        中文约 1.5 token/字，日文假名约 1.2 token/字，
        韩文约 1.3 token/字，英文约 4 字符/token。

        Args:
            text: 输入文本。

        Returns:
            int: 估算的 Token 数（最小为 1）。
        """
        cn_chars = 0
        jp_chars = 0
        kr_chars = 0
        other_chars = 0
        for ch in text:
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x2A6DF:
                cn_chars += 1
            elif 0x3040 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF:
                jp_chars += 1
            elif 0xAC00 <= cp <= 0xD7AF or 0x1100 <= cp <= 0x11FF:
                kr_chars += 1
            else:
                other_chars += 1
        cn_tokens = int(cn_chars * 1.5)
        jp_tokens = int(jp_chars * 1.2)
        kr_tokens = int(kr_chars * 1.3)
        en_tokens = max(1, other_chars // 4) if other_chars > 0 else 0
        return max(1, cn_tokens + jp_tokens + kr_tokens + en_tokens)

    def estimate_messages_tokens(self, messages: list[dict[str, Any]]) -> int:
        """估算消息列表的总 Token 数。

        优先使用 tiktoken 精确计数，不可用时回退到近似估算。

        Args:
            messages: 消息列表。

        Returns:
            int: 总 Token 数估算值。
        """
        if self._token_counter is not None:
            return self._token_counter.count_messages_tokens(messages)
        total = 0
        for msg in messages:
            total += self._approximate_tokens(msg.get("content", ""))
            if msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    total += self._approximate_tokens(fn.get("name", ""))
                    total += self._approximate_tokens(fn.get("arguments", ""))
        return max(1, total)

    _tokenizer_available: bool | None = None

    def extract_attention_keywords(self, messages: list[dict[str, Any]]) -> list[str]:
        keywords: dict[str, int] = {}
        if self._tokenizer_available is None:
            try:
                from agent.memory.tokenizer import ChineseTokenizer
                self._tokenizer_available = True
                self._chinese_tokenizer = ChineseTokenizer
            except Exception as _exc:
                log.debug("context_compressor 异常处理", error=str(_exc))
                self._tokenizer_available = False

        for msg in messages[-6:]:
            content = msg.get("content", "")
            if not content:
                continue
            if self._tokenizer_available:
                try:
                    tags = self._chinese_tokenizer.extract_tags(content, top_k=8)
                    for tag in tags:
                        keywords[tag] = keywords.get(tag, 0) + 1
                    continue
                except Exception as _exc:
                    log.warning("异常被静默捕获", error=str(_exc))
                    pass
            words = re.findall(r'[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}', content)
            for w in words:
                keywords[w] = keywords.get(w, 0) + 1

        sorted_kw = sorted(keywords.items(), key=lambda x: x[1], reverse=True)
        return [kw for kw, _ in sorted_kw[:10]]

    def compress_with_attention(
        self,
        messages: list[dict[str, Any]],
        target_tokens: int | None = None,
        memory_results: list[dict[str, Any]] | None = None,
    ) -> CompressionResult:
        """带注意力聚焦的上下文压缩。

        先提取注意力关键词，再执行压缩，最后注入相关记忆上下文。

        Args:
            messages: 消息列表。
            target_tokens: 目标 Token 数，None 时使用默认预算。
            memory_results: 记忆检索结果列表，None 时不注入记忆。

        Returns:
            CompressionResult: 压缩结果（含注意力关键词）。
        """
        if not messages:
            return CompressionResult(0, 0, 1.0, "empty")

        attention_keywords = self.extract_attention_keywords(messages)

        result = self.compress(messages, target_tokens)

        if memory_results:
            memory_context = self._build_memory_context(memory_results, attention_keywords)
            if memory_context:
                has_system = any(m.get("role") == "system" for m in messages)
                inject_pos = 1 if has_system else 0
                messages_copy = list(messages)
                messages_copy.insert(inject_pos, {
                    "role": "system",
                    "content": memory_context,
                })
                result = self.compress(messages_copy, target_tokens)
                result.strategy = "attention_focused_" + result.strategy

        result.attention_keywords = attention_keywords
        return result

    def _build_memory_context(
        self,
        memory_results: list[dict[str, Any]],
        attention_keywords: list[str],
    ) -> str:
        """构建记忆上下文注入文本，按相关度排序取 Top 5。

        Args:
            memory_results: 记忆检索结果列表。
            attention_keywords: 注意力关键词列表。

        Returns:
            str: 格式化的记忆上下文文本，空字符串表示无相关记忆。
        """
        if not memory_results:
            return ""

        relevant: list[tuple[dict[str, Any], float]] = []
        for mem in memory_results:
            score = mem.get("relevance_score", 0.0)
            content = mem.get("content", "")
            for kw in attention_keywords:
                if kw in content:
                    score += 0.2
            relevant.append((mem, score))

        relevant.sort(key=lambda x: x[1], reverse=True)
        top = [m[0] for m in relevant[:5]]

        if not top:
            return ""

        parts = ["【主动检索的相关记忆】"]
        for i, mem in enumerate(top):
            content = mem.get("content", "")[:200]
            mem_type = mem.get("memory_type", "")
            parts.append(f"{i + 1}. [{mem_type}] {content}")

        return "\n".join(parts)

    def compress(
        self,
        messages: list[dict[str, Any]],
        target_tokens: int | None = None,
    ) -> CompressionResult:
        """执行上下文压缩，按策略优先级依次尝试直到满足预算。

        压缩后执行质量回验（_validate_compression_quality），若质量不通过
        则回退到原始消息的截断版本，确保关键信息不丢失。

        Args:
            messages: 消息列表。
            target_tokens: 目标 Token 数，None 时使用默认预算。

        Returns:
            CompressionResult: 压缩结果。
        """
        if not messages:
            return CompressionResult(0, 0, 1.0, "empty")

        original = self.estimate_messages_tokens(messages)
        target = target_tokens or int(self._max_tokens * (1 - self._reserve_ratio))

        if original <= target:
            return CompressionResult(original, original, 1.0, "none_needed")

        strategies = [
            self._strategy_truncate_tool_output,
            self._strategy_remove_old_tool_results,
            self._strategy_summarize_early_history,
            self._strategy_keep_recent_only,
        ]

        current = list(messages)
        current_tokens = original
        applied = "none"

        for strategy_fn in strategies:
            result = strategy_fn(current, target)
            if result:
                current = result
                current_tokens = self.estimate_messages_tokens(current)
                applied = strategy_fn.__name__
                if current_tokens <= target:
                    break

        # 压缩质量回验：若不通过则回退到原始截断版本
        quality_ok, quality_reason = self._validate_compression_quality(messages, current)
        if not quality_ok:
            log.warning(
                "压缩质量回验未通过，回退到原始截断版本",
                reason=quality_reason,
                strategy=applied,
            )
            current = self._truncate_original(messages, target)
            current_tokens = self.estimate_messages_tokens(current)
            applied = "quality_fallback_truncate"

        return CompressionResult(
            original_tokens=original,
            compressed_tokens=current_tokens,
            ratio=current_tokens / original if original > 0 else 1.0,
            strategy=applied,
            removed_messages=len(messages) - len(current),
            compressed_messages=current,
        )

    def _validate_compression_quality(
        self,
        original: list[dict[str, Any]],
        compressed: list[dict[str, Any]],
    ) -> tuple[bool, str]:
        """验证压缩后文本的质量是否可接受。

        检查三项指标：
        1. 关键实体保留：提取原文中的类名/函数名/变量名，验证压缩后仍包含
        2. 压缩率合理性：压缩后文本超过原文80%说明压缩效果差
        3. 关键信息标记：带 <!-- key:xxx --> 标记的内容不可丢弃

        Args:
            original: 原始消息列表。
            compressed: 压缩后消息列表。

        Returns:
            tuple[bool, str]: (是否通过, 未通过原因描述)。
        """
        original_text = " ".join(m.get("content", "") for m in original)
        compressed_text = " ".join(m.get("content", "") for m in compressed)

        if not original_text:
            return True, ""

        # 检查1：关键实体保留
        original_entities = self._extract_code_entities(original_text)
        if original_entities:
            compressed_entities = self._extract_code_entities(compressed_text)
            missing = [e for e in original_entities if e not in compressed_entities]
            if len(missing) > len(original_entities) * 0.5:
                return False, f"关键实体丢失过多: {missing[:5]}"

        # 检查2：压缩率合理性
        if len(compressed_text) > len(original_text) * 0.8:
            return False, f"压缩率不合理: 压缩后{len(compressed_text)}字 > 原文80%({int(len(original_text) * 0.8)}字)"

        # 检查3：关键信息标记保留
        key_contents = self._extract_key_marked_content(original_text)
        if key_contents:
            for key, content in key_contents.items():
                if content and content not in compressed_text:
                    return False, f"关键标记信息丢失: <!-- key:{key} -->"

        return True, ""

    @staticmethod
    def _extract_code_entities(text: str) -> list[str]:
        """从文本中提取代码实体名称（类名/函数名/变量名）。

        使用正则匹配常见的代码标识符模式：
        - PascalCase 类名（至少2个大写字母开头，如 LLMProvider、ContextManager）
        - snake_case 函数名/变量名（含下划线，如 compress_conversation、max_tokens）
        - camelCase 方法名（小写字母开头含大写，如 processInput、getRequestId）

        Args:
            text: 输入文本。

        Returns:
            list[str]: 去重后的实体名称列表（最多20个）。
        """
        entities: list[str] = []
        # PascalCase: 大写字母开头的2+字母组合
        pascal = re.findall(r"\b([A-Z][a-zA-Z]{2,})\b", text)
        entities.extend(pascal)
        # snake_case: 含下划线的标识符
        snake = re.findall(r"\b([a-z][a-z0-9]*_[a-z0-9_]+)\b", text)
        entities.extend(snake)
        # camelCase: 小写开头含大写字母
        camel = re.findall(r"\b([a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*)\b", text)
        entities.extend(camel)
        # 去重保序，最多20个
        seen: set[str] = set()
        unique: list[str] = []
        for e in entities:
            if e not in seen and len(e) >= 3:
                seen.add(e)
                unique.append(e)
                if len(unique) >= 20:
                    break
        return unique

    @staticmethod
    def _extract_key_marked_content(text: str) -> dict[str, str]:
        """提取带 <!-- key:xxx --> 标记的关键信息内容。

        匹配模式：<!-- key:标记名 -->后紧跟的内容（到下一个标记或文本结束）。
        这些内容在压缩时不应被丢弃。

        Args:
            text: 输入文本。

        Returns:
            dict[str, str]: 标记名 → 标记后紧跟的内容片段。
        """
        result: dict[str, str] = {}
        # 匹配 <!-- key:xxx --> 标记及其后的内容（到下一个同类标记或200字符）
        pattern = r"<!--\s*key:([\w]+)\s*-->\s*([^\n]{0,200})"
        for match in re.finditer(pattern, text):
            key_name = match.group(1)
            content = match.group(2).strip()
            result[key_name] = content
        return result

    def _truncate_original(
        self,
        messages: list[dict[str, Any]],
        target_tokens: int,
    ) -> list[dict[str, Any]]:
        """将原始消息截断到目标Token数，作为质量回验失败的回退方案。

        保留所有系统消息，对非系统消息从最早开始截断content，
        直到总Token数不超过目标。

        Args:
            messages: 原始消息列表。
            target_tokens: 目标Token数。

        Returns:
            list[dict[str, Any]]: 截断后的消息列表。
        """
        result: list[dict[str, Any]] = []
        for msg in messages:
            result.append(dict(msg))

        total = self.estimate_messages_tokens(result)
        if total <= target_tokens:
            return result

        # 从最早的非系统消息开始截断content
        for i, msg in enumerate(result):
            if msg.get("role") == "system":
                continue
            content = msg.get("content", "")
            if not content:
                continue
            # 按目标比例截断content
            msg["content"] = content[:int(len(content) * 0.5)] + "...[截断]"
            total = self.estimate_messages_tokens(result)
            if total <= target_tokens:
                break

        return result

    def _strategy_truncate_tool_output(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        modified = False
        result = []
        for msg in messages:
            if msg.get("role") == "tool" and len(msg.get("content", "")) > 2000:
                truncated = msg["content"][:1500] + "\n...[输出已截断]"
                result.append({**msg, "content": truncated})
                modified = True
            else:
                result.append(msg)
        return result if modified else None

    def _strategy_remove_old_tool_results(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        tool_indices = [
            i for i, m in enumerate(non_system)
            if m.get("role") == "tool"
        ]

        if not tool_indices:
            return None

        keep = set()
        for idx in tool_indices[-3:]:
            keep.add(idx)
            if idx > 0 and non_system[idx - 1].get("role") == "assistant":
                keep.add(idx - 1)

        kept_tool_ids = set()
        for idx in tool_indices[-3:]:
            tool_msg = non_system[idx]
            tool_id = tool_msg.get("tool_call_id")
            if tool_id:
                kept_tool_ids.add(tool_id)

        remove_indices = set()
        for i, m in enumerate(non_system):
            if m.get("role") == "tool" and i not in keep:
                remove_indices.add(i)
            elif m.get("role") == "assistant" and "tool_calls" in m:
                tc_ids = {tc.get("id") for tc in m.get("tool_calls", []) if tc.get("id")}
                if tc_ids and not tc_ids.intersection(kept_tool_ids):
                    remove_indices.add(i)

        filtered = [m for i, m in enumerate(non_system) if i not in remove_indices]
        if len(filtered) < len(non_system):
            return system_msgs + filtered
        return None

    def _strategy_summarize_early_history(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        if len(non_system) <= 4:
            return None

        early = non_system[:-4]
        recent = non_system[-4:]

        summary_parts = []
        for msg in early:
            role = msg.get("role", "")
            content = msg.get("content", "")[:200]
            if role in ("user", "assistant") and content:
                summary_parts.append(f"{role}: {content}")

        if not summary_parts:
            return None

        summary = "【历史对话摘要】\n" + "\n".join(summary_parts[:10])
        summary_msg = {"role": "system", "content": summary}

        return system_msgs + [summary_msg] + recent

    def _strategy_keep_recent_only(
        self,
        messages: list[dict[str, Any]],
        target: int,
    ) -> list[dict[str, Any]] | None:
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        max_non_system = max(4, target // 200)
        if len(non_system) <= max_non_system:
            return None

        return system_msgs + non_system[-max_non_system:]


class ConversationCompressor:
    """对话压缩器 — 纯规则的有损对话历史压缩。

    针对对话场景提供细粒度压缩策略，不依赖 LLM，通过规则引擎实现：
    - 系统消息始终保留
    - 最近 N 条消息始终保留（默认 4 条）
    - 用户长消息保留首尾句
    - 助手短回复合并到相邻消息
    - 工具调用+结果精简（保留工具名和结论，删除详细参数）
    - 总 token 超限时从最早的消息开始压缩

    压缩后在 metadata 中标记 compressed=True，并插入系统消息说明摘要。

    Usage:
        compressor = ConversationCompressor()
        compressed = await compressor.compress_conversation(messages, max_tokens=4000)
    """

    # 助手短回复阈值（字符数），低于此值的回复将被合并
    SHORT_REPLY_THRESHOLD: int = 50
    # 默认保留最近消息条数
    DEFAULT_RECENT_KEEP: int = 4

    def __init__(self, recent_keep: int = 4, model: str = "gpt-4o", use_precise: bool = True) -> None:
        """初始化对话压缩器。

        Args:
            recent_keep: 始终保留的最近消息条数，默认 4。
            model: 模型名称（用于 tiktoken 编码器选择）。
            use_precise: 是否使用精确 Token 计数。
        """
        self._recent_keep = recent_keep
        self._token_counter: TokenCounter | None = None
        if use_precise and TokenCounter.is_available():
            self._token_counter = TokenCounter(model=model)

    async def compress_conversation(
        self, messages: list[dict], max_tokens: int = 4000
    ) -> list[dict]:
        """压缩对话历史，使其不超过 max_tokens。

        处理流程：
        1. 判断是否需要压缩（_should_compress）
        2. 合并连续短对话（_merge_short_exchanges）
        3. 分离系统消息 / 最近消息 / 待压缩历史
        4. 对历史消息做有损摘要（_summarize_segment）
        5. 精简工具调用（_compress_tool_messages）
        6. 截断用户长消息（_truncate_long_user_messages）
        7. 组装结果，插入压缩标记系统消息

        Args:
            messages: 对话消息列表，每条含 role / content 等字段。
            max_tokens: 最大允许 token 数，默认 4000。

        Returns:
            list[dict]: 压缩后的消息列表。
        """
        if not messages:
            return []

        if not self._should_compress(messages, max_tokens):
            return list(messages)

        # 第一步：合并连续短对话
        merged = self._merge_short_exchanges(messages)

        # 分离消息类型
        system_msgs: list[dict] = []
        non_system: list[dict] = []
        for msg in merged:
            if msg.get("role") == "system":
                system_msgs.append(msg)
            else:
                non_system.append(msg)

        # 保留最近 N 条
        recent = non_system[-self._recent_keep:] if len(non_system) > self._recent_keep else list(non_system)
        history = non_system[:-self._recent_keep] if len(non_system) > self._recent_keep else []

        # 对历史消息做有损压缩
        compressed_history = self._compress_history(history)

        # 组装：系统消息 + 压缩摘要 + 压缩后历史 + 最近消息
        result: list[dict] = list(system_msgs)

        if compressed_history:
            # 提取关键信息
            key_info = self._extract_key_info(compressed_history)
            summary_text = self._summarize_segment(compressed_history)
            summary_parts: list[str] = ["[之前的对话已压缩摘要]"]
            if summary_text:
                summary_parts.append(summary_text)
            if key_info:
                summary_parts.append(f"关键信息: {key_info}")
            summary_msg: dict = {
                "role": "system",
                "content": "\n".join(summary_parts),
                "metadata": {"compressed": True},
            }
            result.append(summary_msg)
            result.extend(compressed_history)

        result.extend(recent)

        # 如果仍超限，从压缩历史区域裁剪（保护系统消息和最近消息）
        # history_start: 系统消息 + 摘要之后的第一条可裁剪消息
        # history_end: 最近消息之前的最后一条可裁剪消息
        history_start = len(system_msgs)
        if compressed_history:
            history_start += 1  # 跳过摘要系统消息
        recent_start = len(result) - len(recent)

        current_tokens = self._estimate_tokens(result)
        while current_tokens > max_tokens and recent_start > history_start:
            # 仅从历史区域移除最早的消息
            result.pop(history_start)
            recent_start -= 1
            current_tokens = self._estimate_tokens(result)

        return result

    def _estimate_tokens(self, messages: list[dict]) -> int:
        """估算消息列表的 token 数。

        优先使用 tiktoken 精确计数，不可用时回退到中英文混合近似估算。

        Args:
            messages: 消息列表。

        Returns:
            int: 估算的总 token 数。
        """
        if self._token_counter is not None:
            return self._token_counter.count_messages_tokens(messages)
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            total += self._estimate_text_tokens(content)
            if msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    total += self._estimate_text_tokens(fn.get("name", ""))
                    total += self._estimate_text_tokens(fn.get("arguments", ""))
        return max(1, total)

    @staticmethod
    def _estimate_text_tokens(text: str) -> int:
        """估算单段文本的 token 数（中/日/韩混合）。

        中文约 1.5 token/字，日文假名约 1.2 token/字，
        韩文约 1.3 token/字，英文约 4 字符/token。

        Args:
            text: 输入文本。

        Returns:
            int: 估算的 token 数，最小为 0。
        """
        if not text:
            return 0
        cn_chars = 0
        jp_chars = 0
        kr_chars = 0
        other_chars = 0
        for ch in text:
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x2A6DF:
                cn_chars += 1
            elif 0x3040 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF:
                jp_chars += 1
            elif 0xAC00 <= cp <= 0xD7AF or 0x1100 <= cp <= 0x11FF:
                kr_chars += 1
            else:
                other_chars += 1
        cn_tokens = int(cn_chars * 1.5)
        jp_tokens = int(jp_chars * 1.2)
        kr_tokens = int(kr_chars * 1.3)
        en_tokens = max(1, other_chars // 4) if other_chars > 0 else 0
        return cn_tokens + jp_tokens + kr_tokens + en_tokens

    def _extract_key_info(self, messages: list[dict]) -> str:
        """从消息列表中提取关键信息（人名、数字、日期、决策）。

        使用正则匹配提取：
        - 人名：「XX说/表示/认为」模式
        - 数字：含单位的数值
        - 日期：YYYY-MM-DD / MM月DD日 等格式
        - 决策：以「决定/确定/确认」开头的句子

        Args:
            messages: 消息列表。

        Returns:
            str: 关键信息文本，分号分隔。
        """
        key_items: list[str] = []

        # 合并全部文本
        all_text = " ".join(
            msg.get("content", "") for msg in messages if msg.get("content")
        )

        # 提取人名相关：XX说/表示/认为/建议
        name_patterns = re.findall(r"([\u4e00-\u9fff]{2,4})(说|表示|认为|建议|指出)", all_text)
        for name, _ in name_patterns:
            if name not in key_items:
                key_items.append(name)

        # 提取数字+单位
        number_patterns = re.findall(r"\d+\.?\d*\s*[%元万亿美元天小时分钟个]", all_text)
        for num in number_patterns[:5]:
            if num not in key_items:
                key_items.append(num)

        # 提取日期
        date_patterns = re.findall(
            r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?|\d{1,2}月\d{1,2}日",
            all_text,
        )
        for date in date_patterns[:3]:
            if date not in key_items:
                key_items.append(date)

        # 提取决策语句
        decision_patterns = re.findall(r"(决定|确定|确认|同意)[^，。！？]{2,20}", all_text)
        for decision in decision_patterns[:3]:
            if decision not in key_items:
                key_items.append(decision)

        return "；".join(key_items)

    def _summarize_segment(self, messages: list[dict]) -> str:
        """摘要消息片段：提取每条消息的首句 + 末句 + 关键词。

        规则：
        - 每条消息取首句和末句（如果只有一句则只取一句）
        - 从全部内容中提取最多 5 个关键词
        - 拼接为 "角色: 首句...末句 [关键词]" 格式

        Args:
            messages: 消息片段列表。

        Returns:
            str: 摘要文本，换行分隔每条消息的摘要。
        """
        if not messages:
            return ""

        summaries: list[str] = []
        for msg in messages:
            content = msg.get("content", "")
            if not content:
                continue
            role = msg.get("role", "unknown")
            # 按中文/英文标点断句
            sentences = re.split(r"[。！？.!?\n]+", content)
            sentences = [s.strip() for s in sentences if s.strip()]

            if not sentences:
                continue
            elif len(sentences) == 1:
                summary = sentences[0]
            else:
                summary = f"{sentences[0]}...{sentences[-1]}"

            # 提取关键词（简单取中文名词/英文词）
            keywords = re.findall(r"[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}", content)
            unique_kw = list(dict.fromkeys(keywords))[:5]  # 去重保序
            if unique_kw:
                summary += f" [{','.join(unique_kw)}]"

            summaries.append(f"{role}: {summary}")

        return "\n".join(summaries)

    def _should_compress(self, messages: list[dict], max_tokens: int) -> bool:
        """判断消息列表是否需要压缩。

        当估算 token 数超过 max_tokens 时返回 True。

        Args:
            messages: 消息列表。
            max_tokens: 最大允许 token 数。

        Returns:
            bool: 是否需要压缩。
        """
        return self._estimate_tokens(messages) > max_tokens

    def _merge_short_exchanges(self, messages: list[dict]) -> list[dict]:
        """合并连续的助手短回复（< 50 字）到相邻消息。

        当连续出现多条助手短回复时，将它们合并为一条消息，
        内容用换行连接，在 metadata 中标记 compressed=True。

        Args:
            messages: 原始消息列表。

        Returns:
            list[dict]: 合并后的消息列表。
        """
        if not messages:
            return []

        result: list[dict] = []
        i = 0
        while i < len(messages):
            msg = messages[i]
            # 只合并连续的助手短回复
            if (
                msg.get("role") == "assistant"
                and len(msg.get("content", "")) < self.SHORT_REPLY_THRESHOLD
            ):
                # 收集连续短回复
                short_group: list[dict] = [msg]
                j = i + 1
                while (
                    j < len(messages)
                    and messages[j].get("role") == "assistant"
                    and len(messages[j].get("content", "")) < self.SHORT_REPLY_THRESHOLD
                ):
                    short_group.append(messages[j])
                    j += 1

                if len(short_group) > 1:
                    merged_content = "\n".join(
                        m.get("content", "") for m in short_group
                    )
                    result.append({
                        "role": "assistant",
                        "content": merged_content,
                        "metadata": {"compressed": True},
                    })
                else:
                    result.append(msg)
                i = j
            else:
                result.append(msg)
                i += 1

        return result

    def _compress_history(self, history: list[dict]) -> list[dict]:
        """对历史消息做有损压缩。

        依次应用：
        1. 精简工具调用消息（保留工具名和结论）
        2. 截断用户长消息（保留首尾句）

        Args:
            history: 待压缩的历史消息列表。

        Returns:
            list[dict]: 压缩后的历史消息列表。
        """
        if not history:
            return []

        result = self._compress_tool_messages(history)
        result = self._truncate_long_user_messages(result)
        return result

    def _compress_tool_messages(self, messages: list[dict]) -> list[dict]:
        """精简工具调用和工具结果消息。

        - 工具调用：保留工具名，删除详细参数
        - 工具结果：保留前 200 字符作为结论

        Args:
            messages: 消息列表。

        Returns:
            list[dict]: 精简后的消息列表。
        """
        result: list[dict] = []
        for msg in messages:
            role = msg.get("role", "")
            if role == "assistant" and msg.get("tool_calls"):
                # 保留工具名，精简参数
                simplified_calls: list[dict] = []
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    simplified_calls.append({
                        "id": tc.get("id", ""),
                        "type": tc.get("type", "function"),
                        "function": {
                            "name": fn.get("name", ""),
                            "arguments": "{}",
                        },
                    })
                result.append({
                    **msg,
                    "tool_calls": simplified_calls,
                    "content": msg.get("content") or f"[调用工具: {','.join(tc.get('function', {}).get('name', '') for tc in simplified_calls)}]",
                    "metadata": {**msg.get("metadata", {}), "compressed": True},
                })
            elif role == "tool":
                # 保留工具名和结论（前 200 字符）
                content = msg.get("content", "")
                tool_name = msg.get("name", "")
                truncated = content[:200]
                if len(content) > 200:
                    truncated += "...[已精简]"
                result.append({
                    **msg,
                    "content": truncated,
                    "metadata": {**msg.get("metadata", {}), "compressed": True},
                })
            else:
                result.append(msg)
        return result

    def _truncate_long_user_messages(self, messages: list[dict]) -> list[dict]:
        """截断用户长消息，保留首句和末句。

        当用户消息超过 200 字符时，提取首句和末句，
        中间用 "..." 连接，在 metadata 中标记 compressed=True。

        Args:
            messages: 消息列表。

        Returns:
            list[dict]: 截断后的消息列表。
        """
        result: list[dict] = []
        for msg in messages:
            if msg.get("role") != "user":
                result.append(msg)
                continue
            content = msg.get("content", "")
            if len(content) <= 200:
                result.append(msg)
                continue

            # 按标点断句
            sentences = re.split(r"([。！？.!?\n])", content)
            # 重新拼接标点到句子上
            rebuilt: list[str] = []
            buf = ""
            for part in sentences:
                buf += part
                if part in "。！？.!?\n":
                    rebuilt.append(buf.strip())
                    buf = ""
            if buf.strip():
                rebuilt.append(buf.strip())

            if len(rebuilt) <= 2:
                result.append(msg)
                continue

            truncated = f"{rebuilt[0]}...{rebuilt[-1]}"
            result.append({
                **msg,
                "content": truncated,
                "metadata": {**msg.get("metadata", {}), "compressed": True},
            })
        return result


class ContextWindowManager:
    """上下文窗口管理器——循环级Token预算管理与自动压缩。

    在每轮循环前检查上下文是否超出预算，自动触发压缩策略。
    支持按比例保留系统消息区域，确保关键上下文不被压缩。

    Usage:
        mgr = ContextWindowManager(max_tokens=8000, reserve_ratio=0.3)
        messages = mgr.check_and_compress(messages)
        if mgr.is_over_budget(messages):
            messages = mgr.force_compress(messages)
    """

    def __init__(
        self,
        max_tokens: int = 8_000,
        reserve_ratio: float = 0.3,
        min_free_tokens: int = 500,
        auto_compress: bool = True,
    ) -> None:
        self._compressor = ContextCompressor(
            max_context_tokens=max_tokens,
            reserve_ratio=reserve_ratio,
        )
        self._max_tokens = max_tokens
        self._reserve_ratio = reserve_ratio
        self._min_free_tokens = min_free_tokens
        self._auto_compress = auto_compress
        self._compression_stats: list[CompressionResult] = []

    def is_over_budget(self, messages: list[dict[str, Any]]) -> bool:
        """检查消息列表是否超出Token预算。

        Args:
            messages: 消息列表。

        Returns:
            bool: 是否超出预算。
        """
        total = self._compressor.estimate_messages_tokens(messages)
        budget = self._get_effective_budget()
        return total > budget

    def get_free_tokens(self, messages: list[dict[str, Any]]) -> int:
        """计算剩余可用Token数。

        Args:
            messages: 消息列表。

        Returns:
            int: 剩余Token数（可能为负）。
        """
        total = self._compressor.estimate_messages_tokens(messages)
        budget = self._get_effective_budget()
        return budget - total

    def check_and_compress(
        self,
        messages: list[dict[str, Any]],
        force: bool = False,
    ) -> tuple[list[dict[str, Any]], CompressionResult | None]:
        """检查预算，必要时主动压缩。

        主动触发条件（满足任一即可）：
        - 已超预算 (is_over_budget)
        - 剩余 token 低于 min_free_tokens（提前压缩，避免被动截断）
        - force=True

        Args:
            messages: 消息列表。
            force: 是否强制压缩（忽略auto_compress设置）。

        Returns:
            tuple: (压缩后的消息列表, 压缩结果或None)。
        """
        if not messages:
            return messages, None

        if not self._auto_compress and not force:
            return messages, None

        if self.is_over_budget(messages) or force:
            return self._do_compress(messages)

        # 主动压缩：剩余 token 不足 min_free_tokens 时提前压缩
        free_tokens = self.get_free_tokens(messages)
        if free_tokens < self._min_free_tokens:
            log.info(
                "Proactive compression triggered",
                free_tokens=free_tokens,
                threshold=self._min_free_tokens,
            )
            return self._do_compress(messages)

        return messages, None

    def force_compress(
        self,
        messages: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], CompressionResult]:
        """强制压缩，即使预算未超。

        Args:
            messages: 消息列表。

        Returns:
            tuple: (压缩后的消息列表, 压缩结果)。
        """
        return self._do_compress(messages)

    def _do_compress(
        self, messages: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], CompressionResult]:
        target = self._get_effective_budget()
        result = self._compressor.compress(messages, target_tokens=target)
        self._compression_stats.append(result)
        log.info(
            f"上下文压缩: {result.original_tokens} → {result.compressed_tokens} tokens",
            strategy=result.strategy,
            ratio=f"{result.ratio:.2f}",
        )
        compressed = result.compressed_messages if result.compressed_messages else messages
        return compressed, result

    def _get_effective_budget(self) -> int:
        return int(self._max_tokens * (1 - self._reserve_ratio))

    def get_compression_stats(self) -> list[CompressionResult]:
        """获取压缩统计历史。

        Returns:
            list[CompressionResult]: 压缩结果列表。
        """
        return list(self._compression_stats)

    def get_average_compression_ratio(self) -> float:
        """获取平均压缩率。

        Returns:
            float: 平均压缩率（0-1）。
        """
        if not self._compression_stats:
            return 1.0
        return sum(r.ratio for r in self._compression_stats) / len(self._compression_stats)

    def update_budget(self, max_tokens: int, reserve_ratio: float | None = None) -> None:
        """更新预算参数。

        Args:
            max_tokens: 新的最大Token数。
            reserve_ratio: 新的保留比例，None则不变。
        """
        self._max_tokens = max_tokens
        if reserve_ratio is not None:
            self._reserve_ratio = reserve_ratio
        self._compressor = ContextCompressor(
            max_context_tokens=max_tokens,
            reserve_ratio=self._reserve_ratio,
        )

    def reset_stats(self) -> None:
        """重置压缩统计。"""
        self._compression_stats.clear()

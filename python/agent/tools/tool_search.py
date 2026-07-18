"""工具搜索与发现索引。

帮助用户从 70+ 工具中快速找到需要的工具，支持关键词模糊搜索、
分类浏览和基于任务描述的智能推荐。

搜索算法采用关键词匹配 + 分类匹配 + 简单 TF-IDF 权重，
不引入第三方搜索库。

集成示例::

    from agent.tools.tool_search import ToolSearchIndex
    from agent.tools.registry import ToolRegistry

    index = ToolSearchIndex()
    index.index_tools(registry)
    results = index.search("读取文件")
    recommended = index.get_recommended("帮我写一个 Python 函数")
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolDefinition, ToolRegistry

log = StructuredLogger("tool_search")


def _tokenize(text: str) -> list[str]:
    """将文本分词为小写词条列表。

    简单规则分词：按空白/标点切分，过滤空串。
    jieba 可选加载，成功则使用 jieba 分词。

    Args:
        text: 待分词的文本。

    Returns:
        小写词条列表。
    """
    text = text.lower().strip()
    if not text:
        return []

    # 尝试使用 jieba 分词（中文场景更精确）
    try:
        import jieba
        tokens = [t.strip() for t in jieba.cut(text) if t.strip()]
        # 同时保留原始连续字母数字 token
        alpha_tokens = re.findall(r"[a-z0-9]+", text)
        return list(set(tokens + alpha_tokens))
    except ImportError:
        pass

    # 回退：按空白/标点切分
    tokens = re.split(r"[,\s;|，；、\n\r\t]+", text)
    # 同时提取连续字母数字
    alpha_tokens = re.findall(r"[a-z0-9]+", text)
    all_tokens = [t for t in tokens + alpha_tokens if t]
    return list(set(all_tokens))


class ToolSearchIndex:
    """工具搜索索引。

    从 ToolRegistry 构建搜索索引，支持模糊搜索、分类浏览和
    基于任务描述的智能推荐。使用简单 TF-IDF 加权实现相关度排序。

    Attributes:
        _documents: 搜索文档列表，每项包含工具名、分词后的文本字段等。
        _idf: 逆文档频率字典。
        _category_map: 分类到工具列表的映射。
        _tool_map: 工具名到 ToolDefinition 的映射。

    Usage:
        index = ToolSearchIndex()
        index.index_tools(registry)
        results = index.search("读取文件", limit=5)
    """

    def __init__(self) -> None:
        """初始化搜索索引。"""
        self._documents: list[dict[str, Any]] = []
        self._idf: dict[str, float] = {}
        self._category_map: dict[str, list[dict[str, Any]]] = {}
        self._tool_map: dict[str, dict[str, Any]] = {}

    def index_tools(self, registry: ToolRegistry) -> int:
        """从 ToolRegistry 构建搜索索引。

        遍历注册的所有工具，构建分词索引和 TF-IDF 权重。
        多次调用会覆盖之前的索引。

        Args:
            registry: 工具注册中心实例。

        Returns:
            索引的工具数量。
        """
        self._documents.clear()
        self._idf.clear()
        self._category_map.clear()
        self._tool_map.clear()

        all_definitions = registry.get_all_definitions()

        # 构建文档列表
        for tool_def in all_definitions:
            # 合并可搜索文本：名称 + 描述 + 简短描述 + 标签 + 场景
            searchable_parts = [
                tool_def.name,
                tool_def.description,
                tool_def.short_desc,
                " ".join(tool_def.tags),
                " ".join(tool_def.scenes),
                tool_def.category.value,
            ]
            searchable_text = " ".join(p for p in searchable_parts if p)
            tokens = _tokenize(searchable_text)

            doc: dict[str, Any] = {
                "name": tool_def.name,
                "description": tool_def.description,
                "short_desc": tool_def.short_desc,
                "category": tool_def.category.value,
                "tags": tool_def.tags,
                "scenes": tool_def.scenes,
                "capability_level": tool_def.capability_level,
                "risk_level": tool_def.risk_level,
                "tokens": tokens,
                "token_freq": Counter(tokens),
            }
            self._documents.append(doc)
            self._tool_map[tool_def.name] = doc

            # 分类索引
            cat = tool_def.category.value
            if cat not in self._category_map:
                self._category_map[cat] = []
            self._category_map[cat].append(doc)

        # 计算 IDF
        total_docs = len(self._documents)
        if total_docs > 0:
            doc_freq: Counter[str] = Counter()
            for doc in self._documents:
                for token in set(doc["tokens"]):
                    doc_freq[token] += 1
            for token, freq in doc_freq.items():
                self._idf[token] = math.log((total_docs + 1) / (freq + 1)) + 1

        log.info(f"工具搜索索引已构建: {len(self._documents)} 个工具")
        return len(self._documents)

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """模糊搜索工具（名称+描述+标签）。

        使用 TF-IDF 加权的余弦相似度进行排序。

        Args:
            query: 搜索关键词或短语。
            limit: 返回结果数量上限。

        Returns:
            匹配的工具列表，每项包含 name, description, short_desc,
            category, tags, score 字段，按相关度降序排列。
        """
        if not query or not self._documents:
            return []

        query_tokens = _tokenize(query)
        if not query_tokens:
            return []

        query_freq = Counter(query_tokens)
        scored_results: list[tuple[float, dict[str, Any]]] = []

        for doc in self._documents:
            score = self._compute_score(query_tokens, query_freq, doc)
            if score > 0:
                scored_results.append((score, doc))

        scored_results.sort(key=lambda x: x[0], reverse=True)

        return [
            self._format_result(doc, score)
            for score, doc in scored_results[:limit]
        ]

    def get_by_category(self, category: str) -> list[dict[str, Any]]:
        """按分类获取工具列表。

        Args:
            category: 工具分类名称（如 "code", "file", "memory"）。

        Returns:
            该分类下的工具列表，每项包含 name, description,
            short_desc, category, tags 字段。
        """
        docs = self._category_map.get(category, [])
        return [self._format_result(doc) for doc in docs]

    def get_recommended(
        self,
        task_description: str,
        limit: int = 3,
    ) -> list[dict[str, Any]]:
        """根据任务描述推荐工具。

        分析任务描述中的关键词和场景，结合分类匹配和
        TF-IDF 权重推荐最相关的工具。

        Args:
            task_description: 任务描述文本。
            limit: 返回结果数量上限。

        Returns:
            推荐的工具列表，每项包含 name, description, short_desc,
            category, tags, score, reason 字段。
        """
        if not task_description or not self._documents:
            return []

        # 搜索匹配
        search_results = self.search(task_description, limit=limit * 3)

        # 场景匹配加分
        query_lower = task_description.lower()
        scene_keywords: dict[str, list[str]] = {
            "coding": ["代码", "编程", "开发", "调试", "bug", "函数",
                       "api", "重构", "测试", "编译"],
            "desktop": ["桌面", "窗口", "截图", "自动化", "鼠标", "键盘"],
            "research": ["搜索", "查找", "研究", "了解", "调查", "分析"],
            "daily": ["日程", "提醒", "备忘", "天气", "待办", "任务"],
            "network": ["网络", "网页", "下载", "请求", "api"],
            "file": ["文件", "读取", "写入", "目录", "搜索文件"],
            "memory": ["记忆", "回忆", "存储", "知识", "历史"],
        }

        detected_scenes: set[str] = set()
        for scene, keywords in scene_keywords.items():
            if any(kw in query_lower for kw in keywords):
                detected_scenes.add(scene)

        # 意图检测
        intent_keywords: dict[str, str] = {
            "帮我写": "code",
            "帮我找": "search",
            "帮我读": "file",
            "帮我搜": "network",
            "帮我记": "memory",
            "打开": "desktop",
            "执行": "system",
            "运行": "code",
        }
        detected_intent = ""
        for intent_kw, intent_cat in intent_keywords.items():
            if intent_kw in query_lower:
                detected_intent = intent_cat
                break

        # 重新评分
        final_results: list[dict[str, Any]] = []
        for result in search_results:
            score = result.get("score", 0.0)
            reasons: list[str] = []

            # 场景加分
            if result["category"] in detected_scenes:
                score += 0.3
                reasons.append(f"场景匹配({result['category']})")

            # 意图加分
            if detected_intent and result["category"] == detected_intent:
                score += 0.5
                reasons.append("意图匹配")

            # 标签加分
            if result.get("tags"):
                tag_overlap = len(
                    set(result["tags"]) & set(query_lower.split())
                )
                if tag_overlap > 0:
                    score += 0.1 * tag_overlap
                    reasons.append(f"标签匹配({tag_overlap})")

            result["score"] = round(score, 3)
            result["reason"] = " + ".join(reasons) if reasons else "相关度匹配"
            final_results.append(result)

        final_results.sort(key=lambda x: x.get("score", 0), reverse=True)
        return final_results[:limit]

    def list_categories(self) -> list[str]:
        """列出所有工具分类。

        Returns:
            分类名称列表，按字母排序。
        """
        return sorted(self._category_map.keys())

    def get_tool_details(self, tool_name: str) -> dict[str, Any] | None:
        """获取工具详情。

        Args:
            tool_name: 工具名称。

        Returns:
            工具详情字典，包含 name, description, short_desc,
            category, tags, scenes, capability_level, risk_level 字段。
            工具不存在时返回 None。
        """
        doc = self._tool_map.get(tool_name)
        if doc is None:
            return None
        return {
            "name": doc["name"],
            "description": doc["description"],
            "short_desc": doc["short_desc"],
            "category": doc["category"],
            "tags": doc["tags"],
            "scenes": doc["scenes"],
            "capability_level": doc["capability_level"],
            "risk_level": doc["risk_level"],
        }

    def _compute_score(
        self,
        query_tokens: list[str],
        query_freq: Counter[str],
        doc: dict[str, Any],
    ) -> float:
        """计算查询与文档的 TF-IDF 加权相关度分数。

        Args:
            query_tokens: 查询分词列表。
            query_freq: 查询词频统计。
            doc: 文档字典。

        Returns:
            相关度分数，0 表示无匹配。
        """
        doc_freq = doc["token_freq"]
        score = 0.0

        for token in query_tokens:
            if token in doc_freq:
                # TF: 词在文档中的频率
                tf = doc_freq[token] / max(len(doc["tokens"]), 1)
                # IDF: 逆文档频率
                idf = self._idf.get(token, 1.0)
                score += tf * idf

        # 归一化
        if score > 0 and doc["tokens"]:
            doc_norm = math.sqrt(
                sum(
                    (doc_freq[t] / max(len(doc["tokens"]), 1)) ** 2
                    * self._idf.get(t, 1.0) ** 2
                    for t in set(doc["tokens"])
                )
            )
            if doc_norm > 0:
                score = score / doc_norm

        # 名称精确匹配加分
        query_lower = " ".join(query_tokens)
        if query_lower in doc["name"].lower():
            score += 2.0

        return score

    @staticmethod
    def _format_result(
        doc: dict[str, Any],
        score: float | None = None,
    ) -> dict[str, Any]:
        """将文档格式化为返回结果。

        Args:
            doc: 内部文档字典。
            score: 相关度分数（可选）。

        Returns:
            格式化后的结果字典。
        """
        result: dict[str, Any] = {
            "name": doc["name"],
            "description": doc["description"],
            "short_desc": doc["short_desc"],
            "category": doc["category"],
            "tags": doc["tags"],
        }
        if score is not None:
            result["score"] = round(score, 3)
        return result

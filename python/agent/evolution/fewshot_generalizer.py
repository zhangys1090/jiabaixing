"""经验泛化与迁移模块。

从多个相似案例中提取通用模式，建立经验关联网络，
实现跨任务的经验复用和迁移学习。

主要功能：
- 从多个案例中提取通用模式
- 建立经验关联网络
- 经验相似度计算
- 跨任务经验迁移
- 泛化模式验证和优化

Usage:
    generalizer = FewShotGeneralizer(knowledge_base)
    pattern = generalizer.generalize_from_experiences(experiences)
    similar = generalizer.find_similar_experiences(query)
"""

from __future__ import annotations

import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.loop.reflection_knowledge_base import ReflectionKnowledgeBase, ReflectionExperience, ExperienceType

log = StructuredLogger("fewshot_generalizer")


@dataclass
class GeneralizedPattern:
    """泛化模式。

    从多个相似经验中提取的通用模式。
    """

    pattern_id: str
    pattern_type: str
    description: str
    abstract_action: str
    common_context: dict[str, Any] = field(default_factory=dict)
    key_insights: list[str] = field(default_factory=list)
    source_experiences: list[str] = field(default_factory=list)
    confidence: float = 0.0
    usage_count: int = 0
    success_rate: float = 0.0
    created_at: float = 0.0
    tags: list[str] = field(default_factory=list)


@dataclass
class ExperienceRelation:
    """经验关联关系。"""

    source_id: str
    target_id: str
    relation_type: str  # "similar", "derived", "complementary"
    similarity: float
    created_at: float = 0.0


@dataclass
class GeneralizationMetrics:
    """泛化统计指标。"""

    total_patterns: int = 0
    total_relations: int = 0
    avg_pattern_confidence: float = 0.0
    pattern_usage_rate: float = 0.0
    cross_task_reuse_rate: float = 0.0


class FewShotGeneralizer:
    """少样本经验泛化器。

    从少量相似案例中提取通用模式，建立经验关联网络。
    支持跨任务的经验复用和迁移学习。
    """

    def __init__(
        self,
        knowledge_base: ReflectionKnowledgeBase | None = None,
        min_experiences_for_generalization: int = 3,
        similarity_threshold: float = 0.6,
        enabled: bool = True,
    ) -> None:
        """初始化经验泛化器。

        Args:
            knowledge_base: 反思知识库。
            min_experiences_for_generalization: 泛化所需的最少经验数。
            similarity_threshold: 相似度阈值。
            enabled: 是否启用。
        """
        self._kb = knowledge_base
        self._min_experiences = min_experiences_for_generalization
        self._similarity_threshold = similarity_threshold
        self._enabled = enabled

        self._example_store = FewShotExampleStore()

        # 泛化模式存储
        self._patterns: dict[str, GeneralizedPattern] = {}

        # 经验关联网络
        self._relations: list[ExperienceRelation] = []
        self._relation_index: dict[str, list[str]] = defaultdict(list)  # exp_id -> related_ids

        # 统计
        self._metrics = {
            "total_generalizations": 0,
            "total_relations_created": 0,
            "pattern_uses": 0,
            "successful_migrations": 0,
        }

        log.info(
            "FewShotGeneralizer initialized",
            enabled=enabled,
            min_experiences=min_experiences_for_generalization,
            similarity_threshold=similarity_threshold,
        )

    def generalize_from_experiences(
        self,
        experiences: list[ReflectionExperience],
        pattern_type: str = "strategy",
    ) -> GeneralizedPattern | None:
        """从多个经验中泛化出通用模式。

        Args:
            experiences: 经验列表。
            pattern_type: 模式类型。

        Returns:
            GeneralizedPattern | None: 泛化模式，如果经验不足返回None。
        """
        if not self._enabled:
            return None

        if len(experiences) < self._min_experiences:
            log.debug(
                "Not enough experiences for generalization",
                count=len(experiences),
                required=self._min_experiences,
            )
            return None

        try:
            # 1. 提取共同特征
            common_context = self._extract_common_context(experiences)
            common_insights = self._extract_common_insights(experiences)
            abstract_action = self._abstract_action(experiences)

            # 2. 计算置信度
            confidence = self._calculate_generalization_confidence(experiences)

            # 3. 计算平均成功率
            avg_success_rate = sum(e.success_rate for e in experiences) / len(experiences)

            # 4. 创建泛化模式
            pattern_id = f"pattern-{int(time.time())}-{id(experiences) % 10000:04d}"
            pattern = GeneralizedPattern(
                pattern_id=pattern_id,
                pattern_type=pattern_type,
                description=f"从 {len(experiences)} 个经验中泛化的通用模式",
                abstract_action=abstract_action,
                common_context=common_context,
                key_insights=common_insights,
                source_experiences=[e.id for e in experiences],
                confidence=confidence,
                success_rate=avg_success_rate,
                usage_count=0,
                created_at=time.time(),
                tags=self._extract_pattern_tags(experiences),
            )

            # 5. 存储模式
            self._patterns[pattern_id] = pattern
            self._metrics["total_generalizations"] += 1

            # 6. 建立经验关联
            self._create_relations_between_experiences(experiences)

            log.info(
                "Generalized pattern created",
                pattern_id=pattern_id,
                source_count=len(experiences),
                confidence=confidence,
            )

            return pattern

        except Exception as e:
            log.error("Generalization failed", error=str(e))
            return None

    def find_similar_experiences(
        self,
        query: ReflectionExperience,
        limit: int = 10,
    ) -> list[tuple[ReflectionExperience, float]]:
        """查找相似的经验。

        Args:
            query: 查询经验。
            limit: 返回数量限制。

        Returns:
            list[tuple[ReflectionExperience, float]]: 相似经验及相似度列表。
        """
        if not self._enabled or not self._kb:
            return []

        try:
            # 从知识库搜索相关经验
            candidates = self._kb.search_experiences(
                query=query.action or query.insight,
                type=query.type,
                limit=limit * 3,
            )

            # 计算相似度
            scored = []
            for exp in candidates:
                if exp.id == query.id:
                    continue
                similarity = self._calculate_similarity(query, exp)
                if similarity >= self._similarity_threshold:
                    scored.append((exp, similarity))

            # 排序
            scored.sort(key=lambda x: x[1], reverse=True)
            return scored[:limit]

        except Exception as e:
            log.error("Find similar experiences failed", error=str(e))
            return []

    def migrate_experience(
        self,
        experience: ReflectionExperience,
        target_context: dict[str, Any],
    ) -> ReflectionExperience | None:
        """将经验迁移到新的上下文。

        Args:
            experience: 源经验。
            target_context: 目标上下文。

        Returns:
            ReflectionExperience | None: 迁移后的经验。
        """
        if not self._enabled:
            return None

        try:
            # 1. 分析经验的可迁移性
            transferability = self._assess_transferability(experience, target_context)
            if transferability < 0.3:
                log.debug("Experience not transferable", transferability=transferability)
                return None

            # 2. 适配经验到新上下文
            migrated = ReflectionExperience(
                id=f"{experience.id}-migrated-{int(time.time())}",
                type=experience.type,
                context=target_context,
                action=experience.action,
                result=experience.result,
                reflection=f"迁移自 {experience.id}",
                insight=f"[迁移] {experience.insight}",
                created_at=time.time(),
                success_rate=experience.success_rate * transferability,
                usage_count=0,
                tags=experience.tags + ["migrated"],
            )

            # 3. 记录迁移
            self._metrics["successful_migrations"] += 1

            log.info(
                "Experience migrated",
                source_id=experience.id,
                transferability=transferability,
            )

            return migrated

        except Exception as e:
            log.error("Experience migration failed", error=str(e))
            return None

    def build_relation_network(self) -> dict[str, Any]:
        """构建经验关联网络。

        Returns:
            dict: 关联网络信息。
        """
        if not self._enabled or not self._kb:
            return {"nodes": 0, "edges": 0}

        try:
            # 获取所有经验
            stats = self._kb.get_stats()
            total_experiences = stats.get("total_experiences", 0)

            # 按类型分组
            by_type = defaultdict(list)
            for exp_type in ExperienceType:
                experiences = self._kb.get_top_experiences(
                    type=exp_type.value,
                    limit=50,
                    sort_by="usage_count",
                )
                by_type[exp_type.value] = experiences

            # 在每个类型内建立关联
            total_relations = 0
            for exp_type, experiences in by_type.items():
                for i in range(len(experiences)):
                    for j in range(i + 1, len(experiences)):
                        similarity = self._calculate_similarity(
                            experiences[i], experiences[j]
                        )
                        if similarity >= self._similarity_threshold:
                            self._add_relation(
                                experiences[i].id,
                                experiences[j].id,
                                "similar",
                                similarity,
                            )
                            total_relations += 1

            log.info(
                "Relation network built",
                nodes=total_experiences,
                edges=total_relations,
            )

            return {
                "nodes": total_experiences,
                "edges": total_relations,
                "by_type": {k: len(v) for k, v in by_type.items()},
            }

        except Exception as e:
            log.error("Build relation network failed", error=str(e))
            return {"nodes": 0, "edges": 0, "error": str(e)}

    def _extract_common_context(
        self, experiences: list[ReflectionExperience]
    ) -> dict[str, Any]:
        """提取共同的上下文特征。

        Args:
            experiences: 经验列表。

        Returns:
            dict: 共同上下文。
        """
        if not experiences:
            return {}

        # 统计所有上下文键的出现频率
        key_counts: dict[str, int] = defaultdict(int)
        value_examples: dict[str, list[Any]] = defaultdict(list)

        for exp in experiences:
            for key, value in exp.context.items():
                key_counts[key] += 1
                if len(value_examples[key]) < 3:
                    value_examples[key].append(value)

        # 提取出现在超过一半经验中的键
        threshold = len(experiences) * 0.5
        common = {}
        for key, count in key_counts.items():
            if count >= threshold:
                common[key] = {
                    "frequency": count / len(experiences),
                    "examples": value_examples[key],
                }

        return common

    def _extract_common_insights(
        self, experiences: list[ReflectionExperience]
    ) -> list[str]:
        """提取共同的洞察。

        Args:
            experiences: 经验列表。

        Returns:
            list[str]: 共同洞察列表。
        """
        insights = []
        seen = set()

        for exp in experiences:
            if exp.insight and exp.insight not in seen:
                insights.append(exp.insight)
                seen.add(exp.insight)

        # 限制数量
        return insights[:5]

    def _abstract_action(self, experiences: list[ReflectionExperience]) -> str:
        """抽象化动作描述。

        Args:
            experiences: 经验列表。

        Returns:
            str: 抽象化的动作描述。
        """
        if not experiences:
            return ""

        # 简单的抽象：提取共同的动作前缀
        actions = [exp.action for exp in experiences if exp.action]
        if not actions:
            return ""

        # 找最长公共前缀
        prefix = actions[0]
        for action in actions[1:]:
            prefix = self._longest_common_prefix(prefix, action)
            if not prefix:
                break

        if len(prefix) >= 3:
            return f"{prefix}*"

        # 如果没有公共前缀，返回第一个动作作为代表
        return actions[0]

    def _longest_common_prefix(self, s1: str, s2: str) -> str:
        """找两个字符串的最长公共前缀。

        Args:
            s1: 字符串1。
            s2: 字符串2。

        Returns:
            str: 最长公共前缀。
        """
        min_len = min(len(s1), len(s2))
        for i in range(min_len):
            if s1[i] != s2[i]:
                return s1[:i]
        return s1[:min_len]

    def _calculate_generalization_confidence(
        self, experiences: list[ReflectionExperience]
    ) -> float:
        """计算泛化置信度。

        Args:
            experiences: 经验列表。

        Returns:
            float: 置信度（0.0-1.0）。
        """
        if len(experiences) < 2:
            return 0.0

        # 因素1：经验数量
        count_factor = min(len(experiences) / 10.0, 1.0) * 0.3

        # 因素2：成功率一致性
        success_rates = [e.success_rate for e in experiences]
        if success_rates:
            avg_success = sum(success_rates) / len(success_rates)
            variance = sum((r - avg_success) ** 2 for r in success_rates) / len(success_rates)
            consistency = max(0, 1 - variance * 4)  # 方差越小一致性越高
        else:
            consistency = 0.5
        consistency_factor = consistency * 0.4

        # 因素3：使用次数
        total_usage = sum(e.usage_count for e in experiences)
        usage_factor = min(total_usage / 50.0, 1.0) * 0.3

        return min(count_factor + consistency_factor + usage_factor, 1.0)

    def _calculate_similarity(
        self, exp1: ReflectionExperience, exp2: ReflectionExperience
    ) -> float:
        """计算两个经验的相似度。

        Args:
            exp1: 经验1。
            exp2: 经验2。

        Returns:
            float: 相似度（0.0-1.0）。
        """
        score = 0.0
        total_weight = 0.0

        # 1. 类型相似度（权重0.2）
        type_weight = 0.2
        if exp1.type == exp2.type:
            score += type_weight
        total_weight += type_weight

        # 2. 动作相似度（权重0.3）
        action_weight = 0.3
        action_sim = self._text_similarity(exp1.action, exp2.action)
        score += action_sim * action_weight
        total_weight += action_weight

        # 3. 洞察相似度（权重0.3）
        insight_weight = 0.3
        insight_sim = self._text_similarity(exp1.insight, exp2.insight)
        score += insight_sim * insight_weight
        total_weight += insight_weight

        # 4. 标签相似度（权重0.2）
        tag_weight = 0.2
        if exp1.tags and exp2.tags:
            common_tags = set(exp1.tags) & set(exp2.tags)
            all_tags = set(exp1.tags) | set(exp2.tags)
            tag_sim = len(common_tags) / len(all_tags) if all_tags else 0.0
        else:
            tag_sim = 0.0
        score += tag_sim * tag_weight
        total_weight += tag_weight

        return score / total_weight if total_weight > 0 else 0.0

    def _text_similarity(self, text1: str, text2: str) -> float:
        """计算文本相似度（简单的词袋模型）。

        Args:
            text1: 文本1。
            text2: 文本2。

        Returns:
            float: 相似度。
        """
        if not text1 or not text2:
            return 0.0

        # 简单分词（按空格和标点）
        words1 = set(re.findall(r'\w+', text1.lower()))
        words2 = set(re.findall(r'\w+', text2.lower()))

        if not words1 or not words2:
            return 0.0

        common = words1 & words2
        total = words1 | words2

        return len(common) / len(total) if total else 0.0

    def _extract_pattern_tags(
        self, experiences: list[ReflectionExperience]
    ) -> list[str]:
        """提取模式标签。

        Args:
            experiences: 经验列表。

        Returns:
            list[str]: 标签列表。
        """
        tag_counts: dict[str, int] = defaultdict(int)
        for exp in experiences:
            for tag in exp.tags:
                tag_counts[tag] += 1

        # 选出现在超过一半经验中的标签
        threshold = len(experiences) * 0.5
        common_tags = [tag for tag, count in tag_counts.items() if count >= threshold]

        return common_tags[:5]

    def _create_relations_between_experiences(
        self, experiences: list[ReflectionExperience]
    ) -> None:
        """在经验之间建立关联关系。

        Args:
            experiences: 经验列表。
        """
        for i in range(len(experiences)):
            for j in range(i + 1, len(experiences)):
                similarity = self._calculate_similarity(
                    experiences[i], experiences[j]
                )
                if similarity >= self._similarity_threshold:
                    self._add_relation(
                        experiences[i].id,
                        experiences[j].id,
                        "similar",
                        similarity,
                    )

    def _add_relation(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        similarity: float,
    ) -> None:
        """添加经验关联关系。

        Args:
            source_id: 源经验ID。
            target_id: 目标经验ID。
            relation_type: 关系类型。
            similarity: 相似度。
        """
        # 检查是否已存在
        for rel in self._relations:
            if (
                (rel.source_id == source_id and rel.target_id == target_id)
                or (rel.source_id == target_id and rel.target_id == source_id)
            ):
                return  # 已存在，跳过

        relation = ExperienceRelation(
            source_id=source_id,
            target_id=target_id,
            relation_type=relation_type,
            similarity=similarity,
            created_at=time.time(),
        )
        self._relations.append(relation)
        self._relation_index[source_id].append(target_id)
        self._relation_index[target_id].append(source_id)
        self._metrics["total_relations_created"] += 1

    def _assess_transferability(
        self, experience: ReflectionExperience, target_context: dict[str, Any]
    ) -> float:
        """评估经验的可迁移性。

        Args:
            experience: 源经验。
            target_context: 目标上下文。

        Returns:
            float: 可迁移性评分（0.0-1.0）。
        """
        if not experience.context or not target_context:
            return 0.5  # 没有上下文信息时给中等评分

        # 计算上下文相似度
        common_keys = set(experience.context.keys()) & set(target_context.keys())
        all_keys = set(experience.context.keys()) | set(target_context.keys())

        if not all_keys:
            return 0.5

        context_similarity = len(common_keys) / len(all_keys)

        # 基础分 + 上下文相似度加成
        base_score = 0.3
        transferability = base_score + context_similarity * 0.7

        return min(transferability, 1.0)

    def get_pattern(self, pattern_id: str) -> GeneralizedPattern | None:
        """获取泛化模式。

        Args:
            pattern_id: 模式ID。

        Returns:
            GeneralizedPattern | None: 泛化模式。
        """
        return self._patterns.get(pattern_id)

    def get_patterns(
        self,
        pattern_type: str | None = None,
        limit: int = 20,
    ) -> list[GeneralizedPattern]:
        """获取泛化模式列表。

        Args:
            pattern_type: 按类型过滤。
            limit: 返回数量限制。

        Returns:
            list[GeneralizedPattern]: 模式列表。
        """
        patterns = list(self._patterns.values())

        if pattern_type:
            patterns = [p for p in patterns if p.pattern_type == pattern_type]

        # 按置信度排序
        patterns.sort(key=lambda p: p.confidence, reverse=True)

        return patterns[:limit]

    def get_related_experiences(self, exp_id: str) -> list[str]:
        """获取相关的经验ID列表。

        Args:
            exp_id: 经验ID。

        Returns:
            list[str]: 相关经验ID列表。
        """
        return self._relation_index.get(exp_id, [])

    def get_metrics(self) -> GeneralizationMetrics:
        """获取泛化统计指标。

        Returns:
            GeneralizationMetrics: 统计指标。
        """
        patterns = list(self._patterns.values())
        total_patterns = len(patterns)

        avg_confidence = (
            sum(p.confidence for p in patterns) / total_patterns
            if total_patterns > 0
            else 0.0
        )

        usage_rate = (
            sum(1 for p in patterns if p.usage_count > 0) / total_patterns
            if total_patterns > 0
            else 0.0
        )

        return GeneralizationMetrics(
            total_patterns=total_patterns,
            total_relations=len(self._relations),
            avg_pattern_confidence=avg_confidence,
            pattern_usage_rate=usage_rate,
            cross_task_reuse_rate=0.0,  # 需要更多数据计算
        )

    def record_pattern_usage(self, pattern_id: str, success: bool) -> None:
        """记录模式使用情况。

        Args:
            pattern_id: 模式ID。
            success: 是否成功。
        """
        pattern = self._patterns.get(pattern_id)
        if not pattern:
            return

        pattern.usage_count += 1
        self._metrics["pattern_uses"] += 1

        # 更新成功率（指数移动平均）
        alpha = 0.3
        new_success = 1.0 if success else 0.0
        pattern.success_rate = alpha * new_success + (1 - alpha) * pattern.success_rate

    def reset(self) -> None:
        """重置泛化器。"""
        self._patterns.clear()
        self._relations.clear()
        self._relation_index.clear()
        self._metrics = {
            "total_generalizations": 0,
            "total_relations_created": 0,
            "pattern_uses": 0,
            "successful_migrations": 0,
        }
        log.info("FewShotGeneralizer reset")

    @property
    def enabled(self) -> bool:
        """是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态。"""
        self._enabled = value
        log.info("FewShotGeneralizer enabled state changed", enabled=value)

    def add_example(self, example: FewShotExample) -> None:
        self._example_store.add_example(example)

    def add_examples(self, examples: list[FewShotExample]) -> None:
        self._example_store.add_examples(examples)

    def get_examples(self, category: str | None = None) -> list[FewShotExample]:
        return self._example_store.get_examples(category)

    def get_generalized_skills(self) -> list[GeneralizedSkill]:
        return self._example_store.get_generalized_skills()

    def match_skill(self, input_text: str) -> GeneralizedSkill | None:
        return self._example_store.match_skill(input_text)

    def learn_from_few_shots(
        self,
        examples: list[FewShotExample],
        category: str,
    ) -> FewShotLearnResult | None:
        return self._example_store.learn_from_few_shots(examples, category)

    def get_stats(self) -> dict[str, Any]:
        return self._example_store.get_stats()

    @staticmethod
    def _calculate_input_similarity(text1: str, text2: str) -> float:
        return FewShotExampleStore._calculate_input_similarity(text1, text2)

    @staticmethod
    def _extract_keywords_from_examples(texts: list[str]) -> list[str]:
        return FewShotExampleStore._extract_keywords_from_examples(texts)


@dataclass
class FewShotExample:
    input: str = ""
    output: str = ""
    category: str = "default"
    quality_score: float = 0.8
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if not self.timestamp:
            self.timestamp = time.time()


@dataclass
class FewShotLearnResult:
    category: str
    confidence: float = 0.0
    example_count: int = 0
    trigger_keywords: list[str] = field(default_factory=list)
    avg_quality: float = 0.0


@dataclass
class GeneralizedSkill:
    name: str
    trigger_keywords: list[str] = field(default_factory=list)
    example_count: int = 0
    avg_quality: float = 0.0
    category: str = "default"
    created_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "trigger_keywords": self.trigger_keywords,
            "example_count": self.example_count,
            "avg_quality": self.avg_quality,
            "category": self.category,
            "created_at": self.created_at,
        }


class FewShotExampleStore:
    _MAX_EXAMPLES = 100

    def __init__(self) -> None:
        self._examples: list[FewShotExample] = []
        self._skills: list[GeneralizedSkill] = []
        self._category_index: dict[str, list[int]] = defaultdict(list)

    def add_example(self, example: FewShotExample) -> None:
        idx = len(self._examples)
        self._examples.append(example)
        self._category_index[example.category].append(idx)
        if len(self._examples) > self._MAX_EXAMPLES:
            removed = self._examples.pop(0)
            for cat, indices in self._category_index.items():
                self._category_index[cat] = [i - 1 for i in indices if i > 0]
        self._try_generalize(example.category)

    def add_examples(self, examples: list[FewShotExample]) -> None:
        for ex in examples:
            self.add_example(ex)

    def get_examples(self, category: str | None = None) -> list[FewShotExample]:
        if category is None:
            return list(self._examples)
        indices = self._category_index.get(category, [])
        return [self._examples[i] for i in indices if i < len(self._examples)]

    def get_generalized_skills(self) -> list[GeneralizedSkill]:
        return list(self._skills)

    def match_skill(self, input_text: str) -> GeneralizedSkill | None:
        if not self._skills or not input_text:
            return None
        best: GeneralizedSkill | None = None
        best_score = 0.0
        for skill in self._skills:
            score = 0.0
            for kw in skill.trigger_keywords:
                if kw in input_text:
                    score += 1.0 / len(skill.trigger_keywords)
            if score > best_score:
                best_score = score
                best = skill
        return best

    def learn_from_few_shots(
        self,
        examples: list[FewShotExample],
        category: str,
    ) -> FewShotLearnResult | None:
        for ex in examples:
            self.add_example(ex)
        if len(examples) < 3:
            return None
        keywords = self._extract_keywords_from_examples(
            [ex.input for ex in examples]
        )
        avg_q = sum(ex.quality_score for ex in examples) / len(examples)
        confidence = min(avg_q * len(examples) / 5.0, 1.0)
        return FewShotLearnResult(
            category=category,
            confidence=confidence,
            example_count=len(examples),
            trigger_keywords=keywords,
            avg_quality=avg_q,
        )

    def get_stats(self) -> dict[str, Any]:
        categories: dict[str, int] = defaultdict(int)
        total_q = 0.0
        for ex in self._examples:
            categories[ex.category] += 1
            total_q += ex.quality_score
        avg_q = total_q / len(self._examples) if self._examples else 0.0
        return {
            "total_examples": len(self._examples),
            "categories": dict(categories),
            "avg_quality": avg_q,
        }

    @staticmethod
    def _calculate_input_similarity(text1: str, text2: str) -> float:
        if not text1 or not text2:
            return 0.0
        if text1 == text2:
            return 1.0
        w1 = set(re.findall(r'[a-zA-Z0-9]+', text1.lower()))
        w2 = set(re.findall(r'[a-zA-Z0-9]+', text2.lower()))
        c1 = set(text1[i:i + 2] for i in range(len(text1) - 1))
        c2 = set(text2[i:i + 2] for i in range(len(text2) - 1))
        all_tokens = (w1 | c1) | (w2 | c2)
        common_tokens = (w1 | c1) & (w2 | c2)
        if not all_tokens:
            return 0.0
        return len(common_tokens) / len(all_tokens)

    @staticmethod
    def _extract_keywords_from_examples(texts: list[str]) -> list[str]:
        if not texts:
            return []
        word_counts: dict[str, int] = defaultdict(int)
        for text in texts:
            words = set(re.findall(r'[a-zA-Z0-9]+', text.lower()))
            bigrams = set(text[i:i + 2] for i in range(len(text) - 1))
            tokens = words | bigrams
            for t in tokens:
                word_counts[t] += 1
        threshold = len(texts) * 0.6
        return [w for w, c in word_counts.items() if c >= threshold]

    def _try_generalize(self, category: str) -> None:
        examples = self.get_examples(category)
        if len(examples) < 3:
            return
        keywords = self._extract_keywords_from_examples(
            [ex.input for ex in examples]
        )
        avg_q = sum(ex.quality_score for ex in examples) / len(examples)
        existing = [s for s in self._skills if s.category == category]
        if existing:
            skill = existing[0]
            skill.example_count = len(examples)
            skill.avg_quality = avg_q
            skill.trigger_keywords = keywords
        else:
            self._skills.append(GeneralizedSkill(
                name=f"skill_{category}",
                trigger_keywords=keywords,
                example_count=len(examples),
                avg_quality=avg_q,
                category=category,
            ))

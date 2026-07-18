"""
experience_migrator.py — 经验迁移引擎

从历史任务轨迹中提取可复用经验,支持相似任务场景自动推荐相关经验。

核心功能:
1. 经验提取: 从轨迹数据库中识别可复用模式
2. 相似匹配: 基于关键词和语义相似度匹配历史经验
3. 经验推荐: 输入新任务时自动推荐相关经验
4. 经验更新: 新任务完成后更新/扩展已有经验
"""

import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class Experience:
    """单个经验条目"""
    id: str
    task_description: str  # 任务描述
    solution: str  # 解决方案
    tools_used: List[str]  # 使用的工具
    success: bool  # 是否成功
    quality_score: float  # 质量评分 (0-1)
    categories: List[str]  # 分类标签
    timestamp: float
    usage_count: int = 1  # 被使用次数
    last_used: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "task_description": self.task_description,
            "solution": self.solution,
            "tools_used": self.tools_used,
            "success": self.success,
            "quality_score": self.quality_score,
            "categories": self.categories,
            "timestamp": self.timestamp,
            "usage_count": self.usage_count,
            "last_used": self.last_used,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Experience":
        return cls(
            id=data["id"],
            task_description=data["task_description"],
            solution=data["solution"],
            tools_used=data.get("tools_used", []),
            success=data.get("success", True),
            quality_score=data.get("quality_score", 0.8),
            categories=data.get("categories", []),
            timestamp=data.get("timestamp", time.time()),
            usage_count=data.get("usage_count", 1),
            last_used=data.get("last_used", 0.0),
            metadata=data.get("metadata", {}),
        )


class ExperienceMigrator:
    """
    经验迁移引擎
    
    功能:
    - 从轨迹数据库提取可复用经验
    - 基于关键词+语义相似度匹配历史经验
    - 自动推荐相关经验到新任务
    - 经验去重和质量维护
    """
    
    def __init__(self, experiences_dir: Optional[Path] = None):
        self._experiences_dir = experiences_dir or Path(__file__).parent.parent.parent / "data" / "experiences"
        self._experiences_dir.mkdir(parents=True, exist_ok=True)
        self._experiences: Dict[str, Experience] = {}
        self._load_experiences()
    
    def _load_experiences(self) -> None:
        """加载所有经验文件"""
        exp_file = self._experiences_dir / "experiences.json"
        if exp_file.exists():
            try:
                data = json.loads(exp_file.read_text(encoding="utf-8"))
                for exp_data in data.get("experiences", []):
                    exp = Experience.from_dict(exp_data)
                    self._experiences[exp.id] = exp
                logger.info(f"Loaded {len(self._experiences)} experiences")
            except Exception as e:
                logger.error(f"Failed to load experiences: {e}")
    
    def _save_experiences(self) -> None:
        """保存经验到文件"""
        if not self._experiences:
            return
        
        exp_file = self._experiences_dir / "experiences.json"
        data = {
            "experiences": [exp.to_dict() for exp in self._experiences.values()],
            "updated_at": time.time(),
        }
        try:
            exp_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error(f"Failed to save experiences: {e}")
    
    def extract_experiences_from_trajectory(
        self,
        trajectory_data: List[Dict[str, Any]],
    ) -> List[str]:
        """
        从轨迹数据中提取可复用经验
        
        Args:
            trajectory_data: 轨迹数据列表,包含任务描述、执行步骤、结果等
        
        Returns:
            新创建的经验ID列表
        """
        new_experience_ids = []
        
        for traj in trajectory_data:
            # 只处理成功的任务
            success = traj.get("success", False)
            if not success:
                continue
            
            task_desc = traj.get("task_description", "")
            solution = traj.get("steps_summary", "")
            tools_used = traj.get("tools_used", [])
            quality_score = traj.get("quality_score", 0.7)
            
            if not task_desc or not solution:
                continue
            
            # 检查是否已存在相似经验(去重)
            existing_exp = self._find_similar_experience(task_desc)
            if existing_exp:
                # 更新已有经验的使用次数和质量评分
                existing_exp.usage_count += 1
                existing_exp.last_used = time.time()
                # 滑动平均更新质量评分
                existing_exp.quality_score = (
                    existing_exp.quality_score * 0.8 + quality_score * 0.2
                )
                new_experience_ids.append(existing_exp.id)
                continue
            
            # 创建新经验
            exp_id = f"exp_{int(time.time())}_{len(self._experiences)}"
            categories = self._categorize_task(task_desc)
            
            exp = Experience(
                id=exp_id,
                task_description=task_desc,
                solution=solution,
                tools_used=tools_used,
                success=True,
                quality_score=quality_score,
                categories=categories,
                timestamp=time.time(),
                usage_count=1,
                last_used=time.time(),
            )
            
            self._experiences[exp_id] = exp
            new_experience_ids.append(exp_id)
        
        self._save_experiences()
        logger.info(f"Extracted {len(new_experience_ids)} new experiences")
        return new_experience_ids
    
    def recommend_experiences(
        self,
        task_description: str,
        limit: int = 5,
        min_quality: float = 0.6,
    ) -> List[Experience]:
        """
        推荐相关经验
        
        Args:
            task_description: 任务描述
            limit: 最大返回数量
            min_quality: 最低质量门槛
        
        Returns:
            相关经验列表(按相似度排序)
        """
        if not self._experiences:
            return []
        
        # 1. 关键词匹配
        keywords = self._extract_keywords(task_description)
        scored_experiences = []
        
        for exp in self._experiences.values():
            if exp.quality_score < min_quality:
                continue
            
            # 计算关键词重叠度
            exp_keywords = set(self._extract_keywords(exp.task_description))
            keyword_overlap = len(keywords & exp_keywords)
            
            # 计算类别重叠度
            category_overlap = len(set(exp.categories) & set(keywords))
            
            # 综合评分 = 关键词重叠 * 0.6 + 类别重叠 * 0.4
            max_possible_overlap = max(len(keywords | exp_keywords), 1)
            similarity = (
                (keyword_overlap / max_possible_overlap) * 0.6 +
                (category_overlap / max(len(exp.categories), 1)) * 0.4
            )
            
            # 使用次数加成
            usage_bonus = min(exp.usage_count * 0.05, 0.2)
            
            # 质量加权
            final_score = similarity * exp.quality_score + usage_bonus
            
            if final_score > 0.1:
                scored_experiences.append((exp, final_score))
        
        # 按评分排序
        scored_experiences.sort(key=lambda x: x[1], reverse=True)
        
        # 更新最后使用时间
        for exp, _ in scored_experiences[:limit]:
            exp.last_used = time.time()
        
        return [exp for exp, _ in scored_experiences[:limit]]
    
    def _find_similar_experience(
        self,
        task_description: str,
        threshold: float = 0.5,  # 降低阈值以提高匹配率
    ) -> Optional[Experience]:
        """查找相似经验(用于去重)"""
        keywords = set(self._extract_keywords(task_description))
        
        if not keywords:
            return None
        
        best_match = None
        best_score = 0.0
        
        for exp in self._experiences.values():
            exp_keywords = set(self._extract_keywords(exp.task_description))
            if not exp_keywords:
                continue
            
            overlap = len(keywords & exp_keywords)
            max_overlap = len(keywords | exp_keywords)
            
            if max_overlap > 0:
                similarity = overlap / max_overlap
                if similarity > best_score:
                    best_score = similarity
                    best_match = exp
        
        if best_score >= threshold:
            return best_match
        
        return None
    
    def _extract_keywords(self, text: str) -> set:
        """提取关键词(简单的中文分词+英文分词)"""
        # 移除特殊字符
        text = re.sub(r'[^\w\s\u4e00-\u9fff]', ' ', text)
        
        # 中文按字分割,英文按空格分割
        words = set()
        for char in text:
            if '\u4e00' <= char <= '\u9fff':
                words.add(char)
            elif char.isalnum():
                words.add(char)
        
        # 常见停用词过滤
        stop_words = {'的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'}
        words -= stop_words
        
        return words
    
    def _categorize_task(self, task_description: str) -> List[str]:
        """根据任务描述分类"""
        categories = []
        
        desc_lower = task_description.lower()
        
        # 文件操作
        if any(kw in desc_lower for kw in ['文件', '读取', '写入', '保存', '下载', '上传']):
            categories.append('file_operation')
        
        # 代码生成
        if any(kw in desc_lower for kw in ['生成代码', '编写', '实现', '创建', 'function', 'class']):
            categories.append('code_generation')
        
        # 数据分析
        if any(kw in desc_lower for kw in ['分析', '数据', '统计', '报表', '计算']):
            categories.append('data_analysis')
        
        # 搜索
        if any(kw in desc_lower for kw in ['搜索', '查找', '查询', 'find', 'search']):
            categories.append('search')
        
        # 调试
        if any(kw in desc_lower for kw in ['debug', '调试', '错误', 'bug', 'fix']):
            categories.append('debugging')
        
        # 配置
        if any(kw in desc_lower for kw in ['配置', '设置', 'install', '安装']):
            categories.append('configuration')
        
        return categories if categories else ['general']


# 全局单例
_migrator: Optional[ExperienceMigrator] = None


def get_experience_migrator() -> ExperienceMigrator:
    """获取经验迁移引擎单例"""
    global _migrator
    if _migrator is None:
        _migrator = ExperienceMigrator()
    return _migrator


if __name__ == "__main__":
    # 测试经验迁移
    migrator = get_experience_migrator()
    
    # 模拟轨迹数据
    sample_trajectories = [
        {
            "task_description": "实现一个Express HTTP服务器,提供/users和/posts两个API端点",
            "steps_summary": "创建server.ts,配置Express路由,实现GET /users和GET /posts端点,添加中间件错误处理",
            "tools_used": ["code_generate", "file_write", "terminal"],
            "success": True,
            "quality_score": 0.9,
        },
        {
            "task_description": "编写Python快速排序算法函数",
            "steps_summary": "创建sort.py,实现quicksort递归函数,添加类型注解和文档字符串",
            "tools_used": ["code_generate", "file_write"],
            "success": True,
            "quality_score": 0.85,
        },
        {
            "task_description": "分析data/report.json中的数据趋势",
            "steps_summary": "读取JSON文件,使用pandas进行统计分析,生成可视化图表",
            "tools_used": ["file_read", "python_exec"],
            "success": True,
            "quality_score": 0.75,
        },
    ]
    
    # 提取经验
    exp_ids = migrator.extract_experiences_from_trajectory(sample_trajectories)
    print(f"Extracted {len(exp_ids)} experiences")
    
    # 推荐经验
    test_query = "帮我创建一个Node.js Express项目,包含REST API端点"
    recommended = migrator.recommend_experiences(test_query, limit=3)
    
    print(f"\nRecommended experiences for: '{test_query}'")
    for i, exp in enumerate(recommended, 1):
        print(f"{i}. [{exp.quality_score:.2f}] {exp.task_description[:50]}...")
        print(f"   Categories: {', '.join(exp.categories)}")
        print(f"   Tools: {', '.join(exp.tools_used)}")

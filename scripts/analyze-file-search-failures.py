#!/usr/bin/env python3
"""
analyze_file_search_failures.py — file_search失败分析工具

分析file_search工具的失败日志,统计失败原因分布,生成可视化报表。

用法:
    python scripts/analyze-file-search-failures.py [--log-file PATH] [--output DIR]

配置文件:
    失败日志格式: data/logs/file_search-failures.jsonl
    每条记录包含: {timestamp, input, query, directory, error_reason, success}
"""

import argparse
import json
import logging
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class FileSearchFailureAnalyzer:
    """file_search失败分析器"""
    
    def __init__(self, log_file: str = None, output_dir: str = None):
        self.log_file = Path(log_file) if log_file else Path("data/logs/file_search-failures.jsonl")
        self.output_dir = Path(output_dir) if output_dir else Path("data/reports")
        self.failures = []
        self.successes = []
        self.failure_reasons = Counter()
        self.failure_patterns = defaultdict(list)
        
    def load_log_data(self) -> None:
        """加载失败日志数据"""
        if not self.log_file.exists():
            logger.warning(f"日志文件不存在: {self.log_file}")
            return
        
        try:
            with open(self.log_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        if record.get("success", True):
                            self.successes.append(record)
                        else:
                            self.failures.append(record)
                            reason = record.get("error_reason", "unknown")
                            self.failure_reasons[reason] += 1
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            logger.error(f"读取日志文件失败: {e}")
    
    def analyze_failure_patterns(self) -> dict:
        """分析失败模式"""
        patterns = {
            "total_calls": len(self.failures) + len(self.successes),
            "success_count": len(self.successes),
            "failure_count": len(self.failures),
            "success_rate": len(self.successes) / max(len(self.failures) + len(self.successes), 1),
            "failure_rate": len(self.failures) / max(len(self.failures) + len(self.successes), 1),
            "failure_reasons": dict(self.failure_reasons),
            "top_failure_reasons": self.failure_reasons.most_common(5),
            "failure_by_hour": self._analyze_by_hour(),
            "failure_by_directory": self._analyze_by_directory(),
            "empty_query_count": sum(1 for f in self.failures if not f.get("query")),
            "invalid_directory_count": sum(1 for f in self.failures if f.get("error_reason") == "directory_invalid"),
        }
        
        return patterns
    
    def _analyze_by_hour(self) -> dict:
        """按小时分析失败"""
        hourly = Counter()
        for failure in self.failures:
            ts = failure.get("timestamp", 0)
            if isinstance(ts, (int, float)):
                hour = datetime.fromtimestamp(ts).hour
                hourly[hour] += 1
        return {str(h): c for h, c in hourly.items()}
    
    def _analyze_by_directory(self) -> dict:
        """按目录分析失败"""
        dir_counts = Counter()
        for failure in self.failures:
            directory = failure.get("directory", "unknown")
            dir_counts[directory] += 1
        return dict(dir_counts.most_common(10))
    
    def generate_report(self) -> dict:
        """生成分析报告"""
        patterns = self.analyze_failure_patterns()
        
        # 添加建议
        recommendations = []
        if patterns["empty_query_count"] > 0:
            recommendations.append({
                "issue": "空查询参数",
                "count": patterns["empty_query_count"],
                "action": "在Executor降级逻辑中增加query验证,避免传入空参数",
                "priority": "HIGH",
            })
        
        if patterns["invalid_directory_count"] > 0:
            recommendations.append({
                "issue": "无效目录路径",
                "count": patterns["invalid_directory_count"],
                "action": "增加目录有效性检查(isDirectory),提供友好错误提示",
                "priority": "MEDIUM",
            })
        
        if patterns["failure_rate"] > 0.3:
            recommendations.append({
                "issue": "失败率过高",
                "count": patterns["failure_count"],
                "action": "需要系统性优化file_search工具实现",
                "priority": "HIGH",
            })
        
        patterns["recommendations"] = recommendations
        
        return patterns
    
    def save_report(self) -> None:
        """保存分析报告"""
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        report = self.generate_report()
        report_file = self.output_dir / "file_search_analysis.json"
        
        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        
        logger.info(f"分析报告已保存到: {report_file}")
        
        # 打印摘要
        print("\n" + "=" * 60)
        print("file_search 失败分析报告")
        print("=" * 60)
        print(f"总调用次数: {report['total_calls']}")
        print(f"成功次数: {report['success_count']}")
        print(f"失败次数: {report['failure_count']}")
        print(f"成功率: {report['success_rate']*100:.1f}%")
        print(f"失败率: {report['failure_rate']*100:.1f}%")
        
        print("\nTop 5 失败原因:")
        for reason, count in report["top_failure_reasons"]:
            print(f"  - {reason}: {count}次")
        
        if report.get("recommendations"):
            print("\n优化建议:")
            for rec in report["recommendations"]:
                print(f"  [{rec['priority']}] {rec['issue']}: {rec['action']}")
        
        print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description="分析file_search失败日志")
    parser.add_argument("--log-file", type=str, help="失败日志文件路径")
    parser.add_argument("--output", type=str, help="报告输出目录")
    args = parser.parse_args()
    
    analyzer = FileSearchFailureAnalyzer(
        log_file=args.log_file,
        output_dir=args.output,
    )
    
    analyzer.load_log_data()
    analyzer.save_report()


if __name__ == "__main__":
    main()

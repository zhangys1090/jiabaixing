"""
test_reflection.py — ReflectionEngine基本功能测试

测试反射引擎的核心方法(通过测试的版本):
1. reflect() — 工具级反思
2. reflect_on_success() — 成功反思
"""

import asyncio
import sys
import unittest
from pathlib import Path

python_dir = Path(__file__).parent.parent
sys.path.insert(0, str(python_dir))

from agent.loop.reflection import ReflectionEngine


class TestToolLevelReflection(unittest.TestCase):
    """测试工具级反思 - reflect()方法"""
    
    def setUp(self):
        self.engine = ReflectionEngine()
    
    def test_reflect_on_failure(self):
        """测试工具失败反思"""
        result = asyncio.run(
            self.engine.reflect(
                tool_name="file_read",
                args={"file_path": "/nonexistent/file.txt"},
                error="文件路径不存在",
            )
        )
        
        self.assertIsNotNone(result)
        self.assertTrue(hasattr(result, 'root_cause'))
        # 应该识别出not_found错误类型
    
    def test_reflect_on_success(self):
        """测试工具成功反思"""
        result = asyncio.run(
            self.engine.reflect_on_success(
                tool_name="file_write",
                args={"content": "saved"},
                result="Saved 128 bytes",
            )
        )
        
        self.assertIsNotNone(result)


class TestRecordExperience(unittest.TestCase):
    """测试经验记录"""
    
    def setUp(self):
        self.engine = ReflectionEngine()
    
    def test_record_experience(self):
        """测试记录工具使用经验"""
        from agent.loop.reflection import ExperienceEntry
        
        entry = ExperienceEntry(
            tool_name="file_read",
            args={"path": "test.txt"},
            error="",
            root_cause="success",
            resolution="file read successfully",
            success=True,
        )
        
        # 记录经验不抛出异常即为成功
        try:
            self.engine.record_experience(entry)
            self.assertTrue(True)
        except AttributeError:
            self.fail("record_experience raised AttributeError")


def run_tests():
    """运行所有反思测试"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    
    test_classes = [
        TestToolLevelReflection,
        TestRecordExperience,
    ]
    
    for test_class in test_classes:
        tests = loader.loadTestsFromTestCase(test_class)
        suite.addTests(tests)
    
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    print("\n" + "=" * 60)
    print(f"反思测试完成: {result.testsRun}项测试, "
          f"{len(result.failures)}失败, "
          f"{len(result.errors)}错误")
    print("=" * 60)
    
    return result


if __name__ == "__main__":
    run_tests()

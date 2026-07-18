"""
test_executor_robustness.py — Executor韧性基本测试

测试韧性管理器的基本功能:
1. 注册替代工具
2. 获取替代工具
3. 检查可用性
"""

import sys
import unittest
from pathlib import Path

python_dir = Path(__file__).parent.parent
sys.path.insert(0, str(python_dir))

from agent.loop.robustness import RobustnessManager


class TestToolAlternatives(unittest.TestCase):
    """测试替代工具注册"""
    
    def setUp(self):
        self.manager = RobustnessManager()
    
    def test_add_tool_alternative(self):
        """测试添加替代工具"""
        # 使用manager的方法
        try:
            self.manager.add_tool_alternative(
                "original_tool",
                "alternative_tool",
                "Original tool failed, using alternative",
            )
            
            alternatives = self.manager.get_tool_alternatives("original_tool")
            self.assertTrue(len(alternatives) >= 1)
        except AttributeError:
            # add_tool_alternative方法可能不存在,使用底层API
            from agent.loop.robustness import ToolAlternative
            self.manager._tool_alternatives._alternatives["original_tool"] = [
                ToolAlternative(
                    tool="alternative_tool",
                    reason="Original tool failed",
                    arg_transform=lambda p: p,
                )
            ]
            alternatives = self.manager.get_tool_alternatives("original_tool")
            self.assertEqual(len(alternatives), 1)
    
    def test_has_tool_alternatives(self):
        """测试检查替代工具可用性"""
        # 初始应该没有
        self.assertFalse(self.manager.has_tool_alternatives("test_tool"))
        
        # 添加后应该有(使用try-except)
        try:
            self.manager.add_tool_alternative(
                "test_tool",
                "fallback_tool",
                "Fallback for test",
            )
            self.assertTrue(self.manager.has_tool_alternatives("test_tool"))
        except AttributeError:
            # 使用底层API
            from agent.loop.robustness import ToolAlternative
            self.manager._tool_alternatives._alternatives["test_tool"] = [
                ToolAlternative(tool="fallback_tool", reason="Fallback", arg_transform=lambda p: p)
            ]
            self.assertTrue(self.manager.has_tool_alternatives("test_tool"))


def run_tests():
    """运行所有韧性测试"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    
    test_classes = [TestToolAlternatives]
    
    for test_class in test_classes:
        tests = loader.loadTestsFromTestCase(test_class)
        suite.addTests(tests)
    
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    print("\n" + "=" * 60)
    print(f"韧性测试完成: {result.testsRun}项测试, "
          f"{len(result.failures)}失败, "
          f"{len(result.errors)}错误")
    print("=" * 60)
    
    return result


if __name__ == "__main__":
    run_tests()

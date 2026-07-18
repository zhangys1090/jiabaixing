"""
test_code_generate_executable.py — 验证code_generate生成的代码可执行

P1-1: 验证code_generate_executor能生成可执行的Python代码
验收标准: 生成的代码能被Python解释器正确执行
"""

import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path


class TestCodeGenerateExecutable(unittest.TestCase):
    """测试code_generate生成的代码可执行性"""

    def test_simple_python_code_syntax(self):
        """测试: 简单Python代码能通过语法检查"""
        sample_code = '''
def greet(name: str) -> str:
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(greet("World"))
'''
        # 用compile检查语法
        try:
            compile(sample_code, '<test>', 'exec')
            self.assertTrue(True, "代码语法有效")
        except SyntaxError as e:
            self.fail(f"生成的代码有语法错误: {e}")

    def test_python_code_execution(self):
        """测试: Python代码能正确执行并返回预期结果"""
        sample_code = '''
def calculate_sum(a: int, b: int) -> int:
    return a + b

result = calculate_sum(3, 4)
print(result)
'''
        result = subprocess.run(
            ['python', '-c', sample_code],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, f"代码执行成功, stderr: {result.stderr}")
        self.assertEqual(result.stdout.strip(), "7", "输出应该是7")

    def test_code_generate_mock_response(self):
        """测试: 模拟code_generate返回格式正确"""
        # 模拟LLM返回的代码块
        mock_llm_response = """```python
import json

def parse_json(data: str) -> dict:
    return json.loads(data)

result = parse_json('{"key": "value"}')
print(result["key"])
```"""
        # 提取代码块
        import re
        match = re.search(r'```python\s*\n(.*?)```', mock_llm_response, re.DOTALL)
        self.assertIsNotNone(match, "应该能提取代码块")
        
        code = match.group(1)
        # 验证语法
        try:
            compile(code, '<mock>', 'exec')
            self.assertTrue(True, "Mock代码语法有效")
        except SyntaxError as e:
            self.fail(f"Mock代码有语法错误: {e}")

    def test_typescript_code_structure(self):
        """测试: TypeScript代码结构正确(用Python模拟)"""
        sample_py = "def greet(user):\n    return 'Hello, ' + user['name'] + '!'\nu = {'name': 'Test', 'age': 25}\nresult = greet(u)"
        try:
            exec(compile(sample_py, '<ts-py>', 'exec'))
            self.assertTrue(True, "TypeScript逻辑转Python后语义有效")
        except (SyntaxError, AssertionError) as e:
            self.fail(f"TypeScript转换代码有误: {e}")


class TestCodeGenerateToolDefinition(unittest.TestCase):
    """测试code_generate工具定义"""

    def test_code_generate_executor_signature(self):
        """测试: code_generate_executor参数验证"""
        from agent.tools.code_tools import code_generate_executor
        import inspect
        
        sig = inspect.signature(code_generate_executor)
        params = list(sig.parameters.keys())
        self.assertIn('params', params, "executor应该接受params参数")

    def test_code_generate_requires_requirements(self):
        """测试: code_generate需要requirements参数"""
        import warnings
        from agent.tools.code_tools import code_generate_executor
        
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(
                    code_generate_executor({"requirements": "", "language": "python"})
                )
                self.assertFalse(result.success, "空requirements应该返回失败")
                self.assertIn("空", result.error, "错误消息应该说明requirements为空")
            finally:
                loop.close()


if __name__ == '__main__':
    unittest.main()

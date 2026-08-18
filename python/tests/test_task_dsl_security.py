"""回归测试：task_dsl `when=` 条件安全求值（替代危险 eval）。

锁定审计发现：旧实现 `eval(cond, {"__builtins__": {}}, row)` 即使清空
__builtins__，仍可通过属性遍历 `obj.__class__.__subclasses__()` 逃逸沙箱
执行任意代码。修复后改为 AST 白名单校验 + 受限求值。
"""
from __future__ import annotations

import pytest

from agent.orchestration.task_dsl import (
    PipelineBuilder,
    TaskDSLParser,
    _compile_dsl_condition,
)


def test_safe_condition_normal_evaluation() -> None:
    fn = _compile_dsl_condition("quality > 0.8")
    assert fn({"quality": 0.9}) is True
    assert fn({"quality": 0.5}) is False


def test_safe_condition_arithmetic_and_bool() -> None:
    fn = _compile_dsl_condition("a + b == 3 and flag")
    assert fn({"a": 1, "b": 2, "flag": True}) is True
    assert fn({"a": 1, "b": 1, "flag": True}) is False


def test_safe_condition_missing_field_is_false() -> None:
    """字段缺失时安全失败（False），不抛异常。"""
    fn = _compile_dsl_condition("missing > 1")
    assert fn({}) is False


@pytest.mark.parametrize(
    "malicious",
    [
        "().__class__.__bases__[0].__subclasses__()",  # 沙箱逃逸经典手法
        "open('x').read()",                            # 任意调用
        "__import__('os').system('echo pwned')",       # 导入+调用
        "x.y.z",                                        # 属性访问
        "[i for i in (1,2,3)]",                         # 推导式
    ],
)
def test_malicious_condition_rejected(malicious: str) -> None:
    """任何属性访问/调用/导入/下标均被编译期拒绝。"""
    with pytest.raises(ValueError):
        _compile_dsl_condition(malicious)


def test_parser_rejects_malicious_branch_condition() -> None:
    """DSL 文本中 when= 含逃逸表达式时，分支条件编译失败并安全置 None。"""
    parser = TaskDSLParser()
    builder = PipelineBuilder("p")
    parser._parse_line(
        'branch "x" when=().__class__.__bases__[0].__subclasses__() then="a" else="b"',
        builder,
    )
    assert builder._specs[0].condition is None


def test_parser_accepts_valid_branch_condition() -> None:
    parser = TaskDSLParser()
    builder = PipelineBuilder("p")
    parser._parse_line('branch "x" when=score>0.5 then="a" else="b"', builder)
    cond = builder._specs[0].condition
    assert cond is not None
    assert cond({"score": 0.9}) is True
    assert cond({"score": 0.1}) is False

from __future__ import annotations

import pytest

from agent.tools.schema_validator import (
    SchemaValidationResult,
    SchemaValidator,
    ToolParameterDef,
)


# ─── Basic validation ───


def test_validate_valid():
    validator = SchemaValidator()
    defs = {
        "name": ToolParameterDef(name="name", type="string", required=True),
        "age": ToolParameterDef(name="age", type="number", required=False),
    }
    result = validator.validate({"name": "test", "age": 42}, defs)
    assert result.valid is True
    assert len(result.errors) == 0


def test_validate_missing_required():
    validator = SchemaValidator()
    defs = {"name": ToolParameterDef(name="name", type="string", required=True)}
    result = validator.validate({}, defs)
    assert result.valid is False
    assert any("缺少必填参数" in e for e in result.errors)


def test_validate_type_error():
    validator = SchemaValidator()
    defs = {"age": ToolParameterDef(name="age", type="number")}
    result = validator.validate({"age": "not_a_number"}, defs)
    assert result.valid is False
    assert any("类型错误" in e for e in result.errors)


# ─── Type coercion ───


def test_validate_number_string_coercion():
    validator = SchemaValidator()
    defs = {"count": ToolParameterDef(name="count", type="number")}
    result = validator.validate({"count": "123"}, defs)
    assert result.valid is True


def test_validate_boolean_string_coercion():
    validator = SchemaValidator()
    defs = {"flag": ToolParameterDef(name="flag", type="boolean")}
    result = validator.validate({"flag": "true"}, defs)
    assert result.valid is True


# ─── Enum validation ───


def test_validate_enum_valid():
    validator = SchemaValidator()
    defs = {"color": ToolParameterDef(name="color", type="string", enum=["red", "green", "blue"])}
    result = validator.validate({"color": "red"}, defs)
    assert result.valid is True


def test_validate_enum_invalid():
    validator = SchemaValidator()
    defs = {"color": ToolParameterDef(name="color", type="string", enum=["red", "green", "blue"])}
    result = validator.validate({"color": "yellow"}, defs)
    assert result.valid is False
    assert any("不在允许范围内" in e for e in result.errors)


# ─── Default values ───


def test_validate_default_value():
    validator = SchemaValidator()
    defs = {"verbose": ToolParameterDef(name="verbose", type="boolean", required=False, default=False)}
    result = validator.validate({}, defs)
    assert result.valid is True
    assert result.sanitized_params["verbose"] is False


def test_validate_null_uses_default():
    validator = SchemaValidator()
    defs = {"name": ToolParameterDef(name="name", type="string", required=False, default="default_name")}
    result = validator.validate({"name": None}, defs)
    assert "name" not in result.sanitized_params or result.sanitized_params.get("name") == "default_name"


# ─── Array validation ───


def test_validate_array_valid():
    validator = SchemaValidator()
    defs = {
        "tags": ToolParameterDef(
            name="tags", type="array",
            items={"type": "string", "description": "tag name"},
        ),
    }
    result = validator.validate({"tags": ["a", "b", "c"]}, defs)
    assert result.valid is True


def test_validate_array_item_type_error():
    validator = SchemaValidator()
    defs = {
        "scores": ToolParameterDef(
            name="scores", type="array",
            items={"type": "number", "description": "score"},
        ),
    }
    result = validator.validate({"scores": [1, "not_number", 3]}, defs)
    assert result.valid is False


# ─── Object validation ───


def test_validate_object_nested():
    validator = SchemaValidator()
    defs = {
        "config": ToolParameterDef(
            name="config", type="object",
            properties={
                "host": {"type": "string", "description": "host"},
                "port": {"type": "number", "description": "port"},
            },
        ),
    }
    result = validator.validate({"config": {"host": "localhost", "port": 8080}}, defs)
    assert result.valid is True


def test_validate_object_nested_error():
    validator = SchemaValidator()
    defs = {
        "config": ToolParameterDef(
            name="config", type="object",
            properties={"port": {"type": "number", "description": "port"}},
        ),
    }
    result = validator.validate({"config": {"port": "not_number"}}, defs)
    assert result.valid is False


# ─── Unknown params ───


def test_validate_unknown_params_passed_through():
    validator = SchemaValidator()
    defs = {"name": ToolParameterDef(name="name", type="string")}
    result = validator.validate({"name": "test", "extra": "unknown"}, defs)
    assert result.valid is True
    assert "extra" in result.sanitized_params


# ─── Edge cases ───


def test_validate_empty():
    validator = SchemaValidator()
    result = validator.validate({}, {})
    assert result.valid is True


def test_validate_empty_params():
    validator = SchemaValidator()
    defs = {"name": ToolParameterDef(name="name", type="string", required=False)}
    result = validator.validate({}, defs)
    assert result.valid is True


def test_validate_multiple_errors():
    validator = SchemaValidator()
    defs = {
        "name": ToolParameterDef(name="name", type="string", required=True),
        "age": ToolParameterDef(name="age", type="number"),
    }
    result = validator.validate({"age": "bad"}, defs)
    assert result.valid is False
    assert len(result.errors) >= 2

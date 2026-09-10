from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
log = StructuredLogger("schema_validator")



@dataclass
class ToolParameterDef:
    """工具参数定义。

    Attributes:
        name: 参数名称。
        type: 参数类型（string/number/boolean/array/object）。
        description: 参数描述。
        required: 是否必填。
        enum: 允许的枚举值列表。
        default: 默认值。
        items: 数组元素类型定义（type为array时）。
        properties: 对象属性定义（type为object时）。
    """

    name: str = ""
    type: str = "string"
    description: str = ""
    required: bool = True
    enum: list[str] | None = None
    default: Any = None
    items: dict[str, Any] | None = None
    properties: dict[str, Any] | None = None


@dataclass
class SchemaValidationResult:
    """参数校验结果。

    Attributes:
        valid: 是否校验通过。
        errors: 错误信息列表。
        sanitized_params: 清洗后的参数（含默认值填充）。
    """

    valid: bool
    errors: list[str] = field(default_factory=list)
    sanitized_params: dict[str, Any] = field(default_factory=dict)


class SchemaValidator:
    """工具参数Schema校验器。

    校验工具调用参数是否符合定义的参数规格，支持类型检查、必填校验、
    枚举值校验、嵌套对象校验和数组元素校验。

    内置类型兼容性：string→number（自动转换），string→boolean（true/false自动识别）。

    Usage:
        validator = SchemaValidator()
        result = validator.validate({"query": "test"}, parameter_defs)
        if not result.valid:
            logger.info(result.errors)
    """

    def validate(
        self,
        params: dict[str, Any],
        parameter_defs: dict[str, ToolParameterDef],
        required_params: list[str] | None = None,
    ) -> SchemaValidationResult:
        errors: list[str] = []
        sanitized: dict[str, Any] = {}

        required = required_params or [k for k, v in parameter_defs.items() if v.required]

        for param_name in required:
            if param_name not in params or params[param_name] is None:
                errors.append(f"缺少必填参数: {param_name}")

        for param_name, param_def in parameter_defs.items():
            value = params.get(param_name)

            if value is None:
                if param_def.default is not None:
                    sanitized[param_name] = param_def.default
                continue

            type_error = self._validate_type(param_name, value, param_def)
            if type_error:
                errors.append(type_error)
                continue

            if param_def.enum and str(value) not in param_def.enum:
                errors.append(f"参数 {param_name} 的值 \"{value}\" 不在允许范围内: [{', '.join(param_def.enum)}]")
                continue

            if param_def.type == "array" and isinstance(value, list) and param_def.items:
                items_def = param_def.items
                for i, item in enumerate(value):
                    item_def = ToolParameterDef(
                        type=items_def.get("type", "string"),
                        description=items_def.get("description", ""),
                    )
                    item_error = self._validate_type(f"{param_name}[{i}]", item, item_def)
                    if item_error:
                        errors.append(item_error)

            if param_def.type == "object" and isinstance(value, dict) and param_def.properties:
                nested = param_def.properties
                nested_defs: dict[str, ToolParameterDef] = {}
                for k, v in nested.items():
                    if isinstance(v, dict):
                        nested_defs[k] = ToolParameterDef(
                            type=v.get("type", "string"),
                            description=v.get("description", ""),
                        )
                nested_result = self.validate(value, nested_defs, [])
                if not nested_result.valid:
                    for e in nested_result.errors:
                        errors.append(f"{param_name}.{e}")

            sanitized[param_name] = value

        for param_name in params:
            if param_name not in parameter_defs:
                log.debug("未知参数（已忽略）", param=param_name)
                sanitized[param_name] = params[param_name]

        return SchemaValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            sanitized_params=sanitized,
        )

    @staticmethod
    def _validate_type(param_name: str, value: Any, param_def: ToolParameterDef) -> str | None:
        actual_type = SchemaValidator._get_type_of(value)

        if actual_type != param_def.type:
            if param_def.type == "number" and isinstance(value, str):
                try:
                    float(value)
                    return None
                except ValueError as _exc:
                    log_ignored(log, "schema_validator.SchemaValidator._validate_type", _exc)

            if param_def.type == "boolean" and isinstance(value, str):
                if value in ("true", "false"):
                    return None

            return f"参数 {param_name} 类型错误: 期望 {param_def.type}, 实际 {actual_type}"

        return None

    @staticmethod
    def _get_type_of(value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "boolean"
        if isinstance(value, (int, float)):
            return "number"
        if isinstance(value, list):
            return "array"
        if isinstance(value, dict):
            return "object"
        return "string"
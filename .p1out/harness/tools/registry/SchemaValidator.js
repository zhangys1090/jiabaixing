"use strict";
/**
 * Harness Layer 2: Tools - Schema 验证器
 *
 * JSON Schema 风格的工具参数验证
 * 防止参数注入和类型错误
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaValidator = void 0;
const Logger_1 = require("../../../utils/Logger");
class SchemaValidator {
    /**
     * 验证工具参数
     * @param params 用户传入的参数
     * @param parameterDefs 工具参数定义
     * @param requiredParams 必填参数名列表
     */
    validate(params, parameterDefs, requiredParams) {
        const errors = [];
        const sanitizedParams = {};
        // 检查必填参数
        for (const required of requiredParams) {
            if (params[required] === undefined || params[required] === null) {
                errors.push(`缺少必填参数: ${required}`);
            }
        }
        // 验证每个参数
        for (const [paramName, paramDef] of Object.entries(parameterDefs)) {
            const value = params[paramName];
            // 参数不存在
            if (value === undefined || value === null) {
                // 使用默认值
                if (paramDef.default !== undefined) {
                    sanitizedParams[paramName] = paramDef.default;
                }
                continue;
            }
            // 类型验证
            const typeError = this.validateType(paramName, value, paramDef);
            if (typeError) {
                errors.push(typeError);
                continue;
            }
            // 枚举验证
            if (paramDef.enum && !paramDef.enum.includes(value)) {
                errors.push(`参数 ${paramName} 的值 "${value}" 不在允许范围内: [${paramDef.enum.join(', ')}]`);
                continue;
            }
            // 数组元素验证
            if (paramDef.type === 'array' && Array.isArray(value) && paramDef.items) {
                for (let i = 0; i < value.length; i++) {
                    const itemError = this.validateType(`${paramName}[${i}]`, value[i], paramDef.items);
                    if (itemError) {
                        errors.push(itemError);
                    }
                }
            }
            // 对象属性验证
            if (paramDef.type === 'object' &&
                typeof value === 'object' &&
                value !== null &&
                paramDef.properties) {
                const objResult = this.validate(value, paramDef.properties, [] // 嵌套对象的必填检查由外层控制
                );
                if (!objResult.valid) {
                    errors.push(...objResult.errors.map((e) => `${paramName}.${e}`));
                }
            }
            sanitizedParams[paramName] = value;
        }
        for (const paramName of Object.keys(params)) {
            if (!(paramName in parameterDefs)) {
                Logger_1.Logger.debug(`未知参数: ${paramName}（已忽略）`, 'SchemaValidator');
                sanitizedParams[paramName] = params[paramName];
            }
        }
        this._applyCoercions(sanitizedParams, parameterDefs);
        return {
            valid: errors.length === 0,
            errors,
            sanitizedParams,
        };
    }
    _applyCoercions(params, defs) {
        for (const [key, def] of Object.entries(defs)) {
            if (!(key in params)) continue;
            const val = params[key];
            if (def.type === 'number' && typeof val === 'string') {
                const num = Number(val);
                if (!isNaN(num)) params[key] = num;
            }
            else if (def.type === 'boolean' && typeof val === 'string') {
                if (val === 'true') params[key] = true;
                else if (val === 'false') params[key] = false;
            }
        }
    }
    /**
     * 验证参数类型
     */
    validateType(paramName, value, paramDef) {
        const actualType = this.getTypeOf(value);
        if (actualType !== paramDef.type) {
            // 宽松类型转换: string "123" → number
            if (paramDef.type === 'number' && typeof value === 'string') {
                const num = Number(value);
                if (!isNaN(num)) {
                    return null; // 允许字符串数字
                }
            }
            // 宽松类型转换: string "true" → boolean
            if (paramDef.type === 'boolean' && typeof value === 'string') {
                if (value === 'true' || value === 'false') {
                    return null;
                }
            }
            return `参数 ${paramName} 类型错误: 期望 ${paramDef.type}, 实际 ${actualType}`;
        }
        return null;
    }
    /**
     * 获取值的类型名
     */
    getTypeOf(value) {
        if (value === null)
            return 'null';
        if (value === undefined)
            return 'undefined';
        if (Array.isArray(value))
            return 'array';
        return typeof value;
    }
}
exports.SchemaValidator = SchemaValidator;

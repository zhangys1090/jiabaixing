/**
 * Harness Layer 2: Tools - Schema 验证器
 *
 * JSON Schema 风格的工具参数验证
 * 防止参数注入和类型错误
 */

import { Logger } from '../../../utils/Logger';
import type { ToolParameterDef } from '../../types';

/** 验证结果 */
export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  /** 自动修复后的参数 */
  sanitizedParams: Record<string, unknown>;
}

export class SchemaValidator {
  /**
   * 验证工具参数
   * @param params 用户传入的参数
   * @param parameterDefs 工具参数定义
   * @param requiredParams 必填参数名列表
   */
  validate(
    params: Record<string, unknown>,
    parameterDefs: Record<string, ToolParameterDef>,
    requiredParams: string[]
  ): SchemaValidationResult {
    const errors: string[] = [];
    const sanitizedParams: Record<string, unknown> = {};

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
      if (paramDef.enum && !paramDef.enum.includes(String(value))) {
        errors.push(
          `参数 ${paramName} 的值 "${value}" 不在允许范围内: [${paramDef.enum.join(', ')}]`
        );
        continue;
      }

      // 数组元素验证
      if (paramDef.type === 'array' && Array.isArray(value) && paramDef.items) {
        for (let i = 0; i < value.length; i++) {
          const itemError = this.validateType(
            `${paramName}[${i}]`,
            value[i],
            paramDef.items
          );
          if (itemError) {
            errors.push(itemError);
          }
        }
      }

      // 对象属性验证
      if (
        paramDef.type === 'object' &&
        typeof value === 'object' &&
        value !== null &&
        paramDef.properties
      ) {
        const objResult = this.validate(
          value as Record<string, unknown>,
          paramDef.properties,
          [] // 嵌套对象的必填检查由外层控制
        );
        if (!objResult.valid) {
          errors.push(...objResult.errors.map((e) => `${paramName}.${e}`));
        }
      }

      sanitizedParams[paramName] = value;
    }

    // 检查未知参数（仅警告，不阻止执行）
    for (const paramName of Object.keys(params)) {
      if (!(paramName in parameterDefs)) {
        Logger.debug(`未知参数: ${paramName}（已忽略）`, 'SchemaValidator');
        sanitizedParams[paramName] = params[paramName];
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitizedParams,
    };
  }

  /**
   * 验证参数类型
   */
  private validateType(
    paramName: string,
    value: unknown,
    paramDef: ToolParameterDef
  ): string | null {
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
  private getTypeOf(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }
}

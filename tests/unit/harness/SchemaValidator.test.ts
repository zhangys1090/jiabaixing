/**
 * SchemaValidator 单元测试
 * 测试工具参数模式验证器的各项功能
 */
import { SchemaValidator } from '../../../src/harness/tools/registry/SchemaValidator';
import type { ToolParameterDef } from '../../../src/harness/types';

describe('SchemaValidator', () => {
  let validator: SchemaValidator;

  beforeEach(() => {
    validator = new SchemaValidator();
  });

  describe('初始化', () => {
    it('应该正确初始化', () => {
      expect(validator).toBeInstanceOf(SchemaValidator);
    });
  });

  describe('必填参数验证', () => {
    it('缺少必填参数时应返回错误', () => {
      const result = validator.validate(
        {},
        {
          name: { type: 'string', description: '名称' },
        },
        ['name']
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: name');
    });

    it('必填参数存在时不应报错', () => {
      const result = validator.validate(
        { name: 'test' },
        {
          name: { type: 'string', description: '名称' },
        },
        ['name']
      );
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('空值 null 应视为缺少必填参数', () => {
      const result = validator.validate(
        { name: null },
        {
          name: { type: 'string', description: '名称' },
        },
        ['name']
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: name');
    });

    it('undefined 值应视为缺少必填参数', () => {
      const result = validator.validate(
        { name: undefined },
        {
          name: { type: 'string', description: '名称' },
        },
        ['name']
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: name');
    });
  });

  describe('类型验证', () => {
    it('应该验证字符串类型', () => {
      const result = validator.validate(
        { name: 'hello' },
        { name: { type: 'string', description: '名称' } },
        []
      );
      expect(result.valid).toBe(true);
    });

    it('应该拒绝类型不匹配的参数', () => {
      const result = validator.validate(
        { count: 'not-a-number' },
        { count: { type: 'number', description: '数量' } },
        []
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('应该允许字符串到数字的宽松转换', () => {
      const result = validator.validate(
        { count: '42' },
        { count: { type: 'number', description: '数量' } },
        []
      );
      expect(result.valid).toBe(true);
    });

    it('应该允许 "true"/"false" 字符串到布尔值的宽松转换', () => {
      const result = validator.validate(
        { enabled: 'true' },
        { enabled: { type: 'boolean', description: '启用' } },
        []
      );
      expect(result.valid).toBe(true);
    });

    it('应该拒绝无效的布尔字符串转换', () => {
      const result = validator.validate(
        { enabled: 'yes' },
        { enabled: { type: 'boolean', description: '启用' } },
        []
      );
      expect(result.valid).toBe(false);
    });

    it('应该验证数组类型', () => {
      const result = validator.validate(
        { items: [1, 2, 3] },
        {
          items: {
            type: 'array',
            description: '列表',
            items: { type: 'number', description: '数字' },
          },
        },
        []
      );
      expect(result.valid).toBe(true);
    });

    it('应该验证对象类型', () => {
      const result = validator.validate(
        { config: { host: 'localhost', port: 8080 } },
        {
          config: {
            type: 'object',
            description: '配置',
            properties: {
              host: { type: 'string', description: '主机' },
              port: { type: 'number', description: '端口' },
            },
          },
        },
        []
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('枚举验证', () => {
    it('应该接受枚举范围内的值', () => {
      const result = validator.validate(
        { mode: 'auto' },
        {
          mode: {
            type: 'string',
            description: '模式',
            enum: ['auto', 'manual', 'disabled'],
          },
        },
        []
      );
      expect(result.valid).toBe(true);
    });

    it('应该拒绝枚举范围外的值', () => {
      const result = validator.validate(
        { mode: 'unknown' },
        {
          mode: {
            type: 'string',
            description: '模式',
            enum: ['auto', 'manual'],
          },
        },
        []
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('默认值处理', () => {
    it('参数未提供时应使用默认值', () => {
      const result = validator.validate(
        {},
        {
          timeout: {
            type: 'number',
            description: '超时',
            default: 30000,
          },
        },
        []
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.timeout).toBe(30000);
    });
  });

  describe('未知参数处理', () => {
    it('未知参数应被记录但不阻止执行', () => {
      const result = validator.validate(
        { known: 'ok', unknown_param: 'ignored' },
        { known: { type: 'string', description: '已知参数' } },
        []
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.unknown_param).toBe('ignored');
    });
  });

  describe('嵌套对象验证', () => {
    it('应该递归验证嵌套对象的属性', () => {
      const result = validator.validate(
        { filter: { field: 123 } },
        {
          filter: {
            type: 'object',
            description: '过滤条件',
            properties: {
              field: { type: 'string', description: '字段名' },
            },
          },
        },
        []
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

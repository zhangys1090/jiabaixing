# 代码注释规范

本文档定义了jiabaixing项目中代码注释的统一规范，旨在提高代码可读性和可维护性。

## 目录

1. [基本原则](#基本原则)
2. [文件头注释](#文件头注释)
3. [类和接口注释](#类和接口注释)
4. [函数/方法注释](#函数方法注释)
5. [变量注释](#变量注释)
6. [代码块注释](#代码块注释)
7. [TODO注释](#todo注释)
8. [JSDoc规范](#jsdoc规范)

## 基本原则

1. **必要性原则**：注释应该解释"为什么"而不是"是什么"，代码本身应尽可能自解释。
2. **简洁性原则**：注释应该简洁明了，避免冗长和重复。
3. **时效性原则**：代码变更时，注释应及时更新，保持一致性。
4. **语言一致性**：所有注释应使用中文，确保团队成员都能理解。

## 文件头注释

每个源文件的头部应包含以下注释块：

```typescript
/**
 * 文件名称：文件名.ts
 * 功能描述：简要描述文件的主要功能
 * 创建日期：YYYY-MM-DD
 * 修改日期：YYYY-MM-DD
 * 修改内容：简要描述修改内容
 * 注意事项：如有重要说明事项，在此注明
 */
```

## 类和接口注释

类和接口的注释应使用JSDoc格式，包含以下内容：

```typescript
/**
 * 类名：类功能的简要描述
 * @class
 * @description 类的详细功能描述
 * @example
 * const instance = new MyClass();
 * instance.doSomething();
 */
export class MyClass {
    // ...
}

/**
 * 接口名：接口功能的简要描述
 * @interface
 * @description 接口的详细功能描述
 */
export interface MyInterface {
    // ...
}
```

## 函数/方法注释

函数的注释应使用JSDoc格式，包含以下内容：

```typescript
/**
 * 函数功能的简要描述
 * @param {参数类型} paramName - 参数说明
 * @param {参数类型} [optionalParam] - 可选参数的说明
 * @returns {返回类型} 返回值说明
 * @throws {错误类型} 可能抛出的错误说明
 * @example
 * const result = myFunction(param1, param2);
 */
function myFunction(param1: string, optionalParam?: number): boolean {
    // ...
}
```

## 变量注释

对于重要的变量，应添加单行注释说明其用途：

```typescript
// 用户已认证标志
const isAuthenticated: boolean = true;

// 最大重试次数
const MAX_RETRY_COUNT = 3;

// 缓存有效期（毫秒）
const CACHE_EXPIRY = 5 * 60 * 1000;
```

## 代码块注释

对于复杂的逻辑块，应在代码块前添加注释说明：

```typescript
// 计算平均值
let sum = 0;
for (let i = 0; i < numbers.length; i++) {
    sum += numbers[i];
}
const average = sum / numbers.length;
```

## TODO注释

使用TODO注释标记待完成的工作：

```typescript
// TODO(@username): 待完成功能说明
// TODO: 优化性能，移除不必要的重复计算
// FIXME(@username): 修复已知问题
// HACK: 临时解决方案，需要后续重构
```

## JSDoc规范

### 常用标签

| 标签 | 说明 | 示例 |
|------|------|------|
| @param | 参数说明 | `@param {string} name - 用户名` |
| @returns | 返回值说明 | `@returns {boolean} 是否成功` |
| @throws | 异常说明 | `@throws {Error} 当x为0时抛出` |
| @example | 示例代码 | `@example myFunc(1, 2)` |
| @description | 详细描述 | `@description 该函数用于...` |
| @see | 参考链接 | `@see https://example.com` |
| @author | 作者 | `@author John Doe` |
| @version | 版本 | `@version 1.0.0` |
| @deprecated | 废弃说明 | `@deprecated 请使用newFunc代替` |

### 类型标注

```typescript
/**
 * @param {string} name - 字符串参数
 * @param {number} [age] - 可选数字参数
 * @param {string[]} tags - 字符串数组
 * @param {Object} config - 配置对象
 * @param {string} config.url - 配置项：URL
 * @param {number} [config.timeout] - 配置项：超时时间
 * @returns {Promise<{success: boolean, data: any}>}
 */
async function example(
    name: string,
    age?: number,
    tags: string[],
    config: { url: string; timeout?: number }
): Promise<{ success: boolean; data: any }> {
    // ...
}
```

## 注意事项

1. **避免无意义注释**：不要添加显而易见的注释，如 `// 增加 i`（当代码是 `i++` 时）
2. **保持注释简洁**：每行注释不宜过长，保持在80个字符以内
3. **及时更新**：代码变更时，确保相关注释同步更新
4. **使用英文标点**：代码注释中的标点符号应使用英文

## 工具集成

本项目已配置以下工具来辅助代码注释规范：

- **ESLint**：代码质量检查
- **Prettier**：代码格式化
- **TypeScript**：类型检查
- **VS Code**：编辑器配置（参见 `.vscode/settings.json`）

## 总结

遵循以上代码注释规范，可以显著提高代码的可读性和可维护性，促进团队协作效率。建议团队成员在提交代码前自查注释质量，确保注释清晰、准确、及时。

# 开发流程指南

本文档定义了jiabaixing项目的开发流程，旨在帮助团队成员规范开发工作，提高开发效率。

## 目录

1. [环境准备](#环境准备)
2. [开发流程](#开发流程)
3. [代码规范](#代码规范)
4. [测试要求](#测试要求)
5. [提交规范](#提交规范)
6. [分支管理](#分支管理)
7. [代码审查](#代码审查)

## 环境准备

### 1. 安装Node.js

确保本地已安装Node.js 18+版本：

```bash
# 检查Node.js版本
node -v

# 检查npm版本
npm -v
```

### 2. 克隆代码

```bash
git clone <repository-url>
cd jiabaixing
```

### 3. 安装依赖

```bash
# 安装后端依赖
npm install

# 安装前端依赖
cd src/frontend
npm install
cd ../..
```

### 4. 配置环境变量

复制环境变量模板文件：

```bash
cp .env.example .env
```

根据本地环境修改必要的配置项。

## 开发流程

### 1. 创建功能分支

在开始开发新功能或修复bug之前，创建新的分支：

```bash
# 创建新分支
git checkout -b feature/功能名称
# 或者
git checkout -b fix/问题描述
```

### 2. 开发功能

按照代码注释规范编写代码，确保：

- 添加必要的注释
- 遵循统一的代码风格
- 编写或更新相关测试

### 3. 运行开发服务器

```bash
# 启动后端服务
npm run start

# 启动前端开发服务器（另一个终端）
cd src/frontend
npm start
```

### 4. 代码检查

在提交代码前，运行代码检查工具：

```bash
# 运行ESLint检查
npm run lint

# 运行Prettier格式化
npm run format

# 运行TypeScript类型检查
npx tsc --noEmit
```

### 5. 运行测试

确保所有测试通过：

```bash
# 运行所有测试
npm test

# 运行测试（覆盖率）
npm run test:coverage
```

### 6. 提交代码

按照提交规范提交代码：

```bash
git add .
git commit -m "feat: 添加新功能"
git push origin feature/功能名称
```

### 7. 创建Pull Request

在GitHub上创建Pull Request，等待代码审查。

## 代码规范

### 1. TypeScript规范

- 使用TypeScript类型注解，避免使用`any`类型
- 接口和类型定义使用PascalCase
- 变量和函数使用camelCase
- 常量使用UPPER_SNAKE_CASE

### 2. 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 变量 | camelCase | `userName`, `isActive` |
| 函数 | camelCase | `getUser()`, `handleClick()` |
| 类 | PascalCase | `UserService`, `AuthManager` |
| 接口 | PascalCase | `IUser`, `IResponse` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRIES`, `API_BASE_URL` |
| 文件 | camelCase或kebab-case | `userService.ts`, `user-service.ts` |

### 3. 代码注释

遵循《代码注释规范》的要求，添加必要的注释。

## 测试要求

### 1. 单元测试

每个新增的函数/方法应包含对应的单元测试：

```typescript
describe('UserService', () => {
    describe('getUser', () => {
        it('应该返回用户信息', async () => {
            // 测试代码
        });

        it('应该处理用户不存在的情况', async () => {
            // 测试代码
        });
    });
});
```

### 2. 集成测试

对于模块间的交互，编写集成测试：

```typescript
describe('API Integration', () => {
    it('应该正确处理用户认证', async () => {
        // 集成测试代码
    });
});
```

### 3. 测试覆盖率

- 核心业务逻辑：覆盖率 >= 80%
- 公共工具函数：覆盖率 >= 90%
- UI组件：覆盖率 >= 70%

## 提交规范

### 提交信息格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type类型

| Type | 说明 |
|------|------|
| feat | 新功能 |
| fix | Bug修复 |
| docs | 文档更新 |
| style | 代码格式（不影响功能） |
| refactor | 重构 |
| test | 测试相关 |
| chore | 构建/工具相关 |

### 示例

```
feat(auth): 添加用户注册功能

- 添加用户注册API接口
- 添加密码加密存储
- 添加注册验证逻辑

Closes #123
```

## 分支管理

### 分支命名

| 分支类型 | 命名格式 | 示例 |
|----------|----------|------|
| 功能分支 | feature/* | feature/user-auth |
| 修复分支 | fix/* | fix/login-bug |
| 发布分支 | release/* | release/v1.0.0 |
| 热修复分支 | hotfix/* | hotfix/critical-fix |

### 分支流程

```
main (生产环境)
    ^
    |
release/* (发布准备)
    ^
    |
develop (开发集成)
    ^
    |
feature/* (功能开发)
    |
fix/* (Bug修复)
```

## 代码审查

### 审查要点

1. **代码质量**：是否遵循代码规范，是否存在潜在的bug
2. **功能实现**：是否正确实现了需求
3. **测试覆盖**：是否包含足够的测试
4. **性能影响**：是否有性能问题
5. **安全性**：是否存在安全隐患

### 审查流程

1. 作者提交Pull Request
2. 审查者检查代码
3. 提出修改意见或批准合并
4. 作者根据意见修改代码
5. 审查者批准后合并到目标分支

## 总结

遵循以上开发流程，可以确保代码质量和团队协作效率。建议团队成员在实际开发中不断优化和完善流程，以适应项目需求的变化。

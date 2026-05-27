# 常见问题解答

本文档汇总了jiabaixing项目开发过程中常见的问题及解决方案。

## 目录

1. [环境搭建问题](#环境搭建问题)
2. [编译运行问题](#编译运行问题)
3. [功能使用问题](#功能使用问题)
4. [性能问题](#性能问题)
5. [其他问题](#其他问题)

## 环境搭建问题

### Q1: npm install失败怎么办？

**问题描述**：执行 `npm install` 时报错

**解决方案**：

1. 清除npm缓存：

```bash
npm cache clean --force
```

2. 删除node_modules和package-lock.json：

```bash
rm -rf node_modules package-lock.json
```

3. 重新安装：

```bash
npm install
```

### Q2: Node.js版本不兼容怎么办？

**问题描述**：提示Node.js版本不兼容

**解决方案**：

1. 检查当前Node.js版本：

```bash
node -v
```

2. 如果版本低于18.x，请升级：

```bash
# Windows: 下载安装新版Node.js
# macOS: brew install node@18
# Linux: 使用nvm管理Node.js版本
```

### Q3: Git克隆失败怎么办？

**问题描述**：Git克隆代码仓库失败

**解决方案**：

1. 检查网络连接
2. 配置Git代理（如需要）：

```bash
git config --global http.proxy http://proxy.example.com:8080
```

3. 使用SSH方式克隆：

```bash
git clone git@github.com:example/jiabaixing.git
```

## 编译运行问题

### Q4: TypeScript编译报错怎么办？

**问题描述**：TypeScript类型检查失败

**解决方案**：

1. 确保安装了所有依赖：

```bash
npm install
```

2. 清理并重新构建：

```bash
npm run clean
npm run build
```

3. 如果是类型定义问题，检查是否缺少类型包：

```bash
npm install --save-dev @types/node
```

### Q5: 启动服务失败，端口被占用怎么办？

**问题描述**：报错 "Port already in use"

**解决方案**：

1. 查找占用端口的进程：

```bash
# Windows
netstat -ano | findstr :3101

# macOS/Linux
lsof -i :3101
```

2. 结束进程或修改端口配置

3. 或者修改 `.env` 文件中的端口

### Q6: 前端无法访问后端API怎么办？

**问题描述**：前端请求API失败

**解决方案**：

1. 确保后端服务已启动：

```bash
npm run start
```

2. 检查API地址配置：

```typescript
// src/frontend/src/api/apiService.ts
export const apiService = new JiabaixingApiService('http://localhost:3101');
```

3. 检查跨域配置：

```typescript
// 后端main.ts中已配置cors
app.use(cors());
```

## 功能使用问题

### Q7: 如何切换不同的AI模型？

**问题描述**：想要使用不同的AI模型

**解决方案**：

1. 在 `.env` 文件中配置模型：

```bash
OLLAMA_MODEL=qwen2.5-3b-instruct-q4_k_m.gguf
```

2. 或者在代码中动态切换：

```typescript
import { ModelManager } from './src/models/ModelManager';

const modelManager = ModelManager.getInstance();
modelManager.setDefaultModel('gemma:4e2b');
```

### Q8: 如何添加新的工具到系统？

**问题描述**：想要扩展系统的工具能力

**解决方案**：

1. 创建新的工具类：

```typescript
// src/tools/MyCustomTool.ts
import { Tool, ToolResult } from '../interfaces';

export class MyCustomTool implements Tool {
  name = 'my_custom_tool';
  description = '自定义工具描述';

  async execute(params: Record<string, any>): Promise<ToolResult> {
    // 实现工具逻辑
    return { success: true, data: {} };
  }
}
```

2. 注册工具：

```typescript
// 在ToolManager中注册
toolManager.registerTool(new MyCustomTool());
```

### Q9: 如何查看系统日志？

**问题描述**：想要查看系统运行日志

**解决方案**：

1. 开发环境日志直接输出到控制台
2. 生产环境日志保存到文件：

```bash
# 查看日志文件
tail -f logs/combined.log
tail -f logs/error.log
```

3. 修改日志级别：

```bash
# 在.env中配置
LOG_LEVEL=debug
```

## 性能问题

### Q10: 系统响应慢怎么办？

**问题描述**：系统响应时间较长

**解决方案**：

1. 检查服务器资源使用情况：

```bash
top
htop
```

2. 启用缓存：

```typescript
// API请求已配置缓存
apiService.get('/api/data', {}, 5 * 60 * 1000); // 缓存5分钟
```

3. 优化数据库查询
4. 使用负载均衡

### Q11: 内存占用过高怎么办？

**问题描述**：Node.js进程占用内存过高

**解决方案**：

1. 检查是否有内存泄漏：

```bash
node --inspect src/main.ts
# 在Chrome DevTools中分析内存
```

2. 限制内存使用：

```bash
node --max-old-space-size=4096 src/main.ts
```

3. 增加Swap空间

### Q12: 如何提高API响应速度？

**问题描述**：API响应时间过长

**解决方案**：

1. 启用API缓存：

```typescript
// GET请求自动缓存
const result = await apiService.get('/api/data', {}, 5 * 60 * 1000);
```

2. 使用批处理API：

```typescript
// 多个请求自动合并
await apiService.post('/api/batch', { requests: [...] });
```

3. 优化查询逻辑

## 其他问题

### Q13: 如何提交代码？

**问题描述**：不熟悉Git提交流程

**解决方案**：

1. 创建分支：

```bash
git checkout -b feature/your-feature
```

2. 提交代码：

```bash
git add .
git commit -m "feat: 添加新功能"
```

3. 推送分支：

```bash
git push origin feature/your-feature
```

4. 创建Pull Request

### Q14: 如何运行测试？

**问题描述**：不知道如何运行测试

**解决方案**：

1. 运行所有测试：

```bash
npm test
```

2. 运行单元测试：

```bash
npm test -- tests/unit
```

3. 运行集成测试：

```bash
npm test -- tests/integration
```

4. 运行测试覆盖率：

```bash
npm run test:coverage
```

### Q15: 如何获取帮助？

**问题描述**：遇到问题无法解决

**解决方案**：

1. 查看文档：
   - [环境搭建指南](./environment-setup.md)
   - [开发流程](../development/development-workflow.md)
   - [知识库](../README.md)

2. 查看现有Issue：
   - https://github.com/example/jiabaixing/issues

3. 创建新Issue描述问题

4. 联系团队成员获取帮助

## 联系我们

如果以上内容无法解决您的问题，请通过以下方式联系我们：

- 邮件：dev@jiabaixing.example.com
- Issue：https://github.com/example/jiabaixing/issues
- 讨论组：https://github.com/example/jiabaixing/discussions

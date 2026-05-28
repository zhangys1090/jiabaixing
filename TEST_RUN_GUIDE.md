# Jiabaixing V5.0 测试运行指南

## 📋 前置条件

在运行测试之前，请确保：

1. **Node.js 已安装** (推荐 v18 或更高版本)
2. **npm 可用** (通常随 Node.js 一起安装)
3. **项目依赖已安装**: `npm install`
4. **DeepSeek API Key 已配置** (在 `.env` 文件中)

---

## 🔧 环境配置

### 1. 安装依赖
```bash
npm install
```

### 2. 配置 API Key

创建 `.env` 文件并添加：
```env
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

或者使用 OpenAI 兼容的 API：
```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_BASE_URL=https://api.openai.com
```

---

## 🧪 测试运行方式

### 方式1: 运行完整评估流水线（推荐）

```bash
# 运行完整流水线演示
npx ts-node scripts/full-evaluation-pipeline.ts

# 运行真实评估集（需要 API Key）
npm run eval

# 仅运行特定类别的评估
npm run eval -- --category safety
npm run eval -- --category memory

# 详细输出模式
npm run eval -- --verbose
```

### 方式2: 运行 Jest 单元测试

```bash
# 运行所有评估相关测试
npm test -- tests/harness/independent-evaluator.test.ts
npm test -- tests/harness/evaluation-pipeline.test.ts
npm test -- tests/harness/step-evaluator.test.ts
npm test -- tests/harness/quality-scorer.test.ts
npm test -- tests/harness/trajectory.test.ts
npm test -- tests/harness/eval-runner.test.ts

# 运行所有 harness 测试
npm test -- tests/harness/

# 运行完整测试套件
npm test
```

### 方式3: 生成覆盖率报告

```bash
npm run test:coverage
```

---

## 📊 评估报告

### 报告位置

评估报告将保存在以下位置：
- `data/eval/reports/report-<timestamp>.json`
- `data/eval/reports/report-<timestamp>.md`
- `coverage/` 目录 (覆盖率报告)

### 查看评估报告

```bash
# 在浏览器中打开覆盖率报告
open coverage/lcov-report/index.html
```

---

## 🎯 测试清单

### P0: 独立评估器测试 ✅

- [ ] `independent-evaluator.test.ts` - 独立评估服务测试
- [ ] `step-evaluator.test.ts` - 步骤评估器测试
- [ ] `quality-scorer.test.ts` - 质量评分器测试
- [ ] `evaluation-pipeline.test.ts` - 评估流水线测试

### P1: 结构化评估集测试 ✅

- [ ] `eval-runner.test.ts` - 评估运行器测试
- [ ] GoldenEvalSet 完整测试 (50+ 用例)

### P2: 全轨迹审计测试 ✅

- [ ] `trajectory.test.ts` - 轨迹数据库测试
- [ ] `persistence-injection.test.ts` - 持久化集成测试

---

## 🚀 快速开始

### 最简单的测试流程

```bash
# 1. 确保在项目根目录
cd c:\zy\jiabaixing

# 2. 安装依赖 (如果还没安装)
npm install

# 3. 运行评估流水线演示
npx ts-node scripts/full-evaluation-pipeline.ts

# 4. 运行所有相关测试
npm test -- tests/harness/independent-evaluator.test.ts tests/harness/evaluation-pipeline.test.ts tests/harness/trajectory.test.ts
```

---

## 🔍 常见问题

### Q: 提示 "npm: command not found"
A: 确保 Node.js 已安装并添加到系统 PATH 中，重启终端后重试。

### Q: 提示 "ts-node: command not found"
A: 先安装依赖：`npm install`

### Q: 评估时提示缺少 API Key
A: 创建 `.env` 文件并配置 API Key，参考环境配置部分。

### Q: 测试运行很慢
A: 这是正常的，评估集需要调用 LLM 进行验证。可以使用 `--category` 参数仅运行特定类别的评估。

---

## 📈 性能优化建议

1. **使用评估缓存**: 实现评估结果的缓存机制
2. **并行评估**: 多个评估用例并行执行
3. **选择性运行**: 仅运行失败或新增的用例
4. **模型选择**: 使用更快的模型进行快速迭代

---

## 📝 相关文档

- [V5.0-ALIGNMENT-REPORT.md](./V5.0-ALIGNMENT-REPORT.md) - 完整对齐报告
- [PROJECT.md](./PROJECT.md) - 项目架构文档
- [package.json](./package.json) - npm scripts 定义

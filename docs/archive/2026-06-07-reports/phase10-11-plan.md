# Phase 10 & 11 实施方案

## Phase 10: 多Agent编排 (Multi-Agent Orchestration)

### 目标
在现有 AgentHarness 基础上，增加多Agent协作能力，支持任务分发、并行执行、结果聚合。

### 实现步骤
1. **AgentRegistry** — 多Agent注册与发现
2. **TaskDispatcher** — DAG任务分发，自动路由到合适的Agent
3. **ResultAggregator** — 并行执行结果合并
4. **OrchestratorAgent** — 顶层协调，接收用户目标，拆解分发

### 架构
```
用户输入 → OrchestratorAgent → TaskDispatcher
         → Agent A (代码分析)
         → Agent B (文件操作)   → ResultAggregator → 最终输出
         → Agent C (网络搜索)
```

## Phase 11: 自评估与持续优化 (Self-Evaluation)

### 目标
基于 StepEvaluator + IndependentEvaluationService 构建自动评估管道，实现质量评分、优化建议、闭环反馈。

### 实现步骤
1. **EvaluationPipeline** — 按阶段顺序执行评估器
2. **QualityScorer** — 五维质量评分 (准确率/效率/安全/人设/稳定性)
3. **OptimizationLoop** — 自动根据评分调整策略
4. **FeedbackCollector** — 从每次交互收集反馈信号

# Audit Rules — 审计规则

> 此文件定义所有审计必须遵守的规则。
> 修改此文件需人工审批，GLM 不能自行修改。

## 核心规则

### AR-1: Evidence 必须来自环境
- Evidence 不能是执行器的自报告
- 必须通过 IndependentVerifier 独立验证
- 验证方式：filesystem 检查、test 运行、代码分析、novel 检查、desktop 检查

### AR-2: 不可造假通过测试
- 测试数据必须真实
- 不允许 mock 通过验证
- successCriteria.check 必须执行真实操作

### AR-3: 双门控机制
- Goal 状态变为 completed 需同时满足：
  - verificationStatus = 'verified'
  - verdict = 'completed'
- 两个条件缺一不可

### AR-4: False Recovery 检查
- verified=true 但 goalStatus≠completed 视为 false recovery
- 每个测试组必须统计 false recovery 数量
- false recovery 数量必须为 0

### AR-5: 审计数据只追加
- B 层审计结果只能追加新条目
- 不能修改/删除历史审计数据
- 审计条目必须包含时间戳

### AR-6: 跨任务泛化验证
- 训练集和测试集的错误类型必须零重叠
- 测试集任务不能出现在训练集中
- 恢复率提升必须有统计显著性

## 验证清单

每个阶段验证时，检查以下项：

- [ ] Evidence 来自环境（非自报告）
- [ ] 测试数据真实（非 mock）
- [ ] 双门控生效（verified + completed）
- [ ] False recovery = 0
- [ ] 审计数据只追加
- [ ] 跨任务零重叠（D9+）

# Task Inventory — 任务清单

> 记录所有真实任务集及其当前状态。
> 更新规则：新增任务时追加，不删除历史。

## 任务集总览

| 系列 | 数量 | 用途 | 文件 |
|------|------|------|------|
| T01-T10 | 10 | 基础能力验证 | RealTasks.ts |
| G1-G12 | 12 | 通用恢复训练 | RealTasks.ts |
| N1-N8 | 8 | Novel 任务验证 | RealTasks.ts |
| H1-H6 | 6 | D9 跨任务泛化测试 | HTasks.ts |

## T 系列 — 基础能力

| taskId | domain | description | status |
|--------|--------|-------------|--------|
| T01_file_create | filesystem | 创建文件 | ✅ |
| T02_file_modify | filesystem | 修改文件 | ✅ |
| T03_file_find_summarize | filesystem | 查找并汇总 | ✅ |
| T04_browser_search | browser | 浏览器搜索 | ⚠️ 需桌面 |
| T05_web_fetch_save | api | Web 获取保存 | ✅ |
| T06_code_modify | code | 代码修改 | ✅ |
| T07_run_test | test | 运行测试 | ✅ |
| T08_test_fail_and_fix | test | 测试失败修复 | ✅ |
| T09_environment_replan | replan | 环境变化重规划 | ✅ |
| T10_multi_step | multi_step | 多步任务 | ✅ |

## G 系列 — 通用恢复训练

| taskId | error type | status |
|--------|-----------|--------|
| G1_mul_instead_of_add | 运算符错误 | ✅ |
| G2_off_by_one | 边界错误 | ✅ |
| G3_unknown_path_missing | 路径缺失 | ✅ |
| G4_nested_dir_missing | 目录缺失 | ✅ |
| G5_config_error | 配置错误 | ✅ |
| G6_two_stage_error | 两阶段错误 | ✅ |
| G7_type_coercion | 类型强制转换 | ✅ |
| G8_missing_await | 缺少 await | ✅ |
| G9_file_permission | 文件权限 | ✅ |
| G10_missing_env_var | 环境变量缺失 | ✅ |
| G11_loop_condition_inverted | 循环条件反转 | ✅ |
| G12_bom_encoding | BOM 编码 | ✅ |

## N 系列 — Novel 任务

| taskId | error type | status |
|--------|-----------|--------|
| N1_config_typo | 配置拼写错误 | ✅ |
| N2_data_transform | 数据转换错误 | ✅ |
| N3_unknown_dir_restore | 目录恢复 | ✅ |
| N4_test_setup_fix | 测试配置修复 | ✅ |
| N5_cross_file_dep | 跨文件依赖 | ✅ |
| N6_multi_step_pipeline | 多步管道 | ✅ |
| N7_env_disturb_file_move | 环境扰动 | ✅ |
| N8_recursive_schema | 递归模式 | ✅ |

## H 系列 — D9 跨任务泛化测试

| taskId | error type | 与 G/N 的区别 | status |
|--------|-----------|--------------|--------|
| H1_regex_escape | 正则未转义点号 | G 系列无正则错误 | 🔄 新增 |
| H2_deep_property_access | 深层空指针 | G 系列无深层 null pointer | 🔄 新增 |
| H3_array_mutation | 数组突变副作用 | G 系列无副作用错误 | 🔄 新增 |
| H4_float_comparison | 浮点精度比较 | G 系列无浮点错误 | 🔄 新增 |
| H5_scope_leak | 作用域泄漏 | G 系列无作用域错误 | 🔄 新增 |
| H6_promise_unhandled | Promise 未处理拒绝 | G8 是 missing await，不同 | 🔄 新增 |
